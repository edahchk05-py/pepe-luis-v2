import { readFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

// ── Knowledge ────────────────────────────────────────────────────────
// These files are GENERATED from index.html by scripts/build-knowledge.mjs
// (npm run knowledge). The website is the source of truth; do not edit them.
const KNOWLEDGE = readFileSync(join(process.cwd(), "data", "knowledge.md"), "utf-8");
const REVIEWS = readFileSync(join(process.cwd(), "data", "knowledge-reviews.md"), "utf-8");
const FACTS = JSON.parse(readFileSync(join(process.cwd(), "data", "site-facts.json"), "utf-8"));

// ── Gemini configuration ─────────────────────────────────────────────
// Model IDs and thinking levels checked against Google's docs and the live API
// on 2026-10-05. Tried in order: the first answers everything; the second is
// used only when the first fails (no answer, server error, rate limit, unreadable
// output). Replies are 60–130 tokens, so the output caps are generous; the
// fallback's is higher because its thinking tokens count against it.
const MODELS = [
  { id: "gemini-3.5-flash-lite", thinkingLevel: "minimal", maxAttempts: 3, maxOutputTokens: 500 },
  { id: "gemini-3.8-flash", thinkingLevel: "low", maxAttempts: 2, maxOutputTokens: 700 },
];

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// What each request may carry.
const MAX_HISTORY_MESSAGES = 12; // booking details travel separately, so trimming never loses them
const MAX_MESSAGE_CHARS = 600; // one guest message
const MAX_STORED_REPLY_CHARS = 1500; // one earlier assistant message, as sent back by the browser

// Retry timing. A failed attempt usually comes back in well under a second.
const BACKOFF_BASE_MS = 400; // 400ms, then 800ms, plus jitter
const BACKOFF_MAX_MS = 1600;
const BACKOFF_JITTER_MS = 250;
const MAX_HONORED_RETRY_DELAY_MS = 2000; // longer server-requested waits → switch model instead
// A model that has sent nothing after 6 seconds is treated as stalled and the
// next model is asked. A model that HAS started answering is left to finish (up
// to the hard limit), so a slow but real answer is never thrown away and asked twice.
const FIRST_BYTE_TIMEOUT_MS = 6000;
const ATTEMPT_HARD_LIMIT_MS = 14000;
const TOTAL_BUDGET_MS = 22000; // the function itself is capped at 30s in vercel.json

// Visitor rate limit. Counted per IP address inside each running server instance,
// so it is a first line of defence against a script hammering the endpoint, not a
// guarantee: instances restart and can multiply under load.
const RATE_LIMIT = {
  perMinute: Number(process.env.CHAT_RATE_PER_MINUTE) || 12,
  perDay: Number(process.env.CHAT_RATE_PER_DAY) || 300,
};

const IS_DEBUG = process.env.VERCEL_ENV !== "production" || process.env.CHAT_DEBUG === "1";

// ── Structured output ────────────────────────────────────────────────
const STAGES = ["none", "collecting", "awaiting_confirmation", "confirmed", "cancelled"];
const LANGUAGES = ["fr", "en", "ar", "other"];

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    language: { type: "string", enum: LANGUAGES },
    reply: { type: "string" },
    reservation: {
      type: "object",
      properties: {
        stage: { type: "string", enum: STAGES },
        guests: { type: ["integer", "null"] },
        date: { type: ["string", "null"] },
        time: { type: ["string", "null"] },
        name: { type: ["string", "null"] },
        phone: { type: ["string", "null"] },
        note: { type: ["string", "null"] },
      },
      required: ["stage", "guests", "date", "time", "name", "phone", "note"],
    },
  },
  required: ["language", "reply", "reservation"],
};

// Ways of asking Gemini for JSON. The first is the one the live generateContent
// API accepted when probed on 2026-10-05 ("responseFormat" was rejected). If the
// API ever rejects the current one, the next is used and remembered for the life
// of this server instance. The prompt also describes the format, so even the
// last mode produces parseable output.
const STRUCTURED_MODES = ["responseJsonSchema", "responseFormat", "jsonMimeOnly", "promptOnly"];
const structuredModeFor = new Map(); // model id → index into STRUCTURED_MODES

function applyStructuredMode(generationConfig, mode) {
  if (mode === "responseFormat") {
    generationConfig.responseFormat = { text: { mimeType: "application/json", schema: RESPONSE_SCHEMA } };
  } else if (mode === "responseJsonSchema") {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseJsonSchema = RESPONSE_SCHEMA;
  } else if (mode === "jsonMimeOnly") {
    generationConfig.responseMimeType = "application/json";
  }
}

// ── System prompt ────────────────────────────────────────────────────
// Kept short: the server enforces the confirmation step, opening hours, past
// dates and the reply language itself (see resolveTurn), so the prompt only
// has to describe them once.
const SYSTEM_PROMPT = `You are the virtual concierge of Pepe Luis, a Spanish restaurant, marisquería and brasserie in Casablanca, chatting with guests on its website. Be an excellent maître d': warm, quick, natural, 1 to 3 short sentences. List dishes only when asked, at most 8 per reply (the full menu is under "Voir le Menu" on the site).

Return ONE JSON object only:
{"language":"fr|en|ar|other","reply":"...","reservation":{"stage":"none|collecting|awaiting_confirmation|confirmed|cancelled","guests":<integer|null>,"date":<"YYYY-MM-DD"|null>,"time":<"HH:MM"|null>,"name":<string|null>,"phone":<string|null>,"note":<string|null>}}

LANGUAGE
- "language" is the language of the guest's LATEST message ("ar" = Arabic or Darija); write "reply" in it. English → English, French → French, Arabic → Arabic. Never default to French because the menu or earlier messages are French.
- No language of its own (a number, a name, "ok"): keep the guest's previous language, otherwise French. Mixed message: understand it and follow the dominant language.
- Dish names stay exactly as on the menu in every language ("Paella Negra", never "Paella Noire"). An Arabic reply is written in Arabic script (never transliterated into Latin letters); only dish names, numbers and "Pepe Luis" stay in Latin letters.

FACTS
- Say only what the KNOWLEDGE below states; it is the restaurant's website and your only source. Anything else you do not know: say so and give the phone number. Never invent or assume a dish, price, ingredient or cooking method. A dish that is not listed is not on the menu: say so and offer the closest real ones.
- Give prices exactly, with their unit (per piece, per 100g, per person, for 2 or 4), in dirhams (dhs). 5% service is not included.
- "Parillada de Pescados" and "Parillada Mixta" each exist twice at different prices (Assortiments and Grillades): give both and name the section. "Paella aux Fruits de Mer" (per person, Plats & Cazuelas) is not the Paellas section (for 2 or 4).
- Address: give it exactly as the KNOWLEDGE shows it (it is a Google Maps location code; the site gives no street name, so never add a street, district or landmark), then the Directions link and the phone number.
- Portions: say a dish is "to share", or for a number of people, only when the KNOWLEDGE says so ("(to share)" or a number of people). Otherwise give just its price (Friture Mixte: 250 dhs, nothing more about portions).
- Delivery, takeaway and Click & Collect: the site says nothing about them. Never say the restaurant offers them, and never say it does not. Say that this information is not available and give the phone number.
- Not on the site: wine or alcohol, parking, terrace, allergens, halal or vegetarian guarantees, payment methods, delivery areas, private events.
- Fish and seafood are not vegetarian and most of the menu is seafood: say so. Suggest a dish to a vegetarian only if its name and description contain no meat, fish or seafood, and say to confirm with the restaurant.
- You cannot see availability, confirm a booking, take orders or pre-order dishes; never offer to. For orders give the phone number.
- Reviews, when shown below, are guests' opinions, not promises; otherwise give the Google rating.
- Harmless off-topic question: one short friendly sentence, then back to Pepe Luis.

RESERVATIONS
You prepare a reservation REQUEST; the guest sends it on WhatsApp and the restaurant confirms it, never you.
- Needed: guests, date, time, name, phone. "note" only if the guest mentions an occasion, an allergy or a wish; never ask for it.
- Start as soon as the guest wants to book, in any language; never ask "would you like to book?".
- Keep everything already given, in any order; never ask twice; accept corrections. Ask only for what is missing, at most two things per message, in this order: guests, date, time, then name and phone together.
- Side question during a booking: answer it, then ask for the next missing detail in the same reply.
- date: YYYY-MM-DD read from the CALENDAR below, never computed. time: 24-hour HH:MM ("8pm", "20h" → "20:00"); a vague time ("evening", "le soir") is not a time: leave it null and ask for the hour.
- Open every day 12:00 to midnight. Refuse a time before 12:00, or a date or time already past (see NOW): explain kindly and ask for another.
- phone: the digits as the guest wrote them.
Stages:
- "none": no booking in progress. "collecting": something is missing; your reply asks for it.
- "awaiting_confirmation": all five are known and the guest has not yet agreed to them. Do NOT summarise and do NOT ask for confirmation: the system does both. "reply" is "" unless the guest just asked a question (then only its answer).
- "confirmed": ONLY if the previous assistant message was the summary AND the guest now clearly says yes (yes, oui, ok, d'accord, نعم, واخا). "reply" is "". If the guest changes a detail instead, use "awaiting_confirmation" with the new details.
- "cancelled": the guest gave up.
Always fill every field you know (null otherwise). After a request has been prepared, go back to "none" unless the guest wants a change.`;

// Unchanging text first, so every request starts with the same prefix.
const STATIC_INSTRUCTION = SYSTEM_PROMPT + "\n\n---\n\nKNOWLEDGE\n\n" + KNOWLEDGE;

// Guests' reviews are only added when the conversation turns to reviews or ratings.
const REVIEWS_HINT = /avis|review|opinion|rating|rated|étoile|etoile|star|témoignage|temoignage|testimon|commentaire|google|recommand|say about|disent|تقييم|آراء|رأي/i;

const DAY_MS = 86400000;
const pad2 = (n) => String(n).padStart(2, "0");

function casablancaNow(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Casablanca",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

const isoToUtc = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
const addDays = (iso, days) => new Date(isoToUtc(iso) + days * DAY_MS).toISOString().slice(0, 10);

function formatDate(iso, locale, options = { weekday: "long", day: "numeric", month: "long", year: "numeric" }) {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC", numberingSystem: "latn" }).format(new Date(isoToUtc(iso)));
}

// Today's date and the next two weeks, so "tomorrow", "ce soir" or "vendredi"
// are looked up rather than calculated by the model.
function buildDateContext(now) {
  const days = [];
  for (let i = 0; i < 14; i++) {
    const iso = addDays(now.date, i);
    const weekday = formatDate(iso, "en-GB", { weekday: "short" });
    days.push(`${iso} ${weekday}${i === 0 ? " = today" : i === 1 ? " = tomorrow" : ""}`);
  }
  return [
    `NOW in Casablanca: ${formatDate(now.date, "en-GB", { weekday: "long" })} ${now.date}, ${now.time} (24-hour clock).`,
    `CALENDAR: ${days.join(" · ")}`,
    'A weekday name means its first date after today; "next week" plus a weekday means the following one; if today is that weekday, ask which. For any other date use its next occurrence.',
  ].join("\n");
}

function buildStateContext(prev) {
  if (!prev || prev.stage === "none") return "RESERVATION STATE BEFORE THIS MESSAGE: no reservation in progress.";
  const show = (v) => (v === null || v === undefined ? "unknown" : JSON.stringify(v));
  return [
    "RESERVATION STATE BEFORE THIS MESSAGE (keep every known detail unless the guest changes it):",
    `stage=${prev.stage}, guests=${show(prev.guests)}, date=${show(prev.date)}, time=${show(prev.time)}, name=${show(prev.name)}, phone=${show(prev.phone)}, note=${show(prev.note)}`,
    prev.stage === "awaiting_confirmation"
      ? "The previous assistant message WAS the summary asking the guest to confirm. A clear yes now means stage \"confirmed\"."
      : prev.stage === "confirmed"
        ? "The WhatsApp request for these details has already been prepared. Use stage \"none\" unless the guest wants to change it or book again."
        : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildSystemInstruction(now, prev, guestText = "") {
  const parts = [STATIC_INSTRUCTION];
  if (REVIEWS && REVIEWS_HINT.test(guestText)) parts.push(REVIEWS.trim());
  parts.push(buildDateContext(now), buildStateContext(prev));
  return parts.join("\n\n---\n\n");
}

// ── Reservation logic (deterministic, server-side) ───────────────────
const cleanString = (v, max) => (typeof v === "string" ? v.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || null : null);
const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

// Turns whatever came back (from the model, or from the browser's saved state)
// into a clean reservation object. Invalid values become null and are reported.
function normalizeReservation(raw, now) {
  const r = raw && typeof raw === "object" ? raw : {};
  const out = { stage: STAGES.includes(r.stage) ? r.stage : "none", guests: null, date: null, time: null, name: null, phone: null, note: null };
  const issues = [];

  const guests = typeof r.guests === "string" && /^\d+$/.test(r.guests) ? Number(r.guests) : r.guests;
  if (Number.isInteger(guests) && guests >= 1 && guests <= 500) out.guests = guests;

  if (typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
    const ms = isoToUtc(r.date);
    const real = !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === r.date;
    if (!real) issues.push("date_invalid");
    else if (now && r.date < now.date) issues.push("date_past");
    else if (now && r.date > addDays(now.date, 366)) issues.push("date_invalid");
    else out.date = r.date;
  }

  const timeMatch = typeof r.time === "string" ? /^(\d{1,2}):(\d{2})$/.exec(r.time.trim()) : null;
  if (timeMatch && Number(timeMatch[1]) <= 23 && Number(timeMatch[2]) <= 59) {
    const time = `${pad2(timeMatch[1])}:${timeMatch[2]}`;
    // Opening hours come from the website. A closing time of 00:00 means midnight.
    const opens = toMinutes(FACTS.hours.opens);
    const closes = toMinutes(FACTS.hours.closes) || 24 * 60;
    const t = toMinutes(time);
    if (t < opens || t >= closes) issues.push("time_closed");
    else if (now && out.date === now.date && t <= toMinutes(now.time)) issues.push("time_past");
    else out.time = time;
  }

  out.name = cleanString(r.name, 80);
  const phone = cleanString(r.phone, 30);
  if (phone) {
    const digits = phone.replace(/\D/g, "");
    if (digits.length >= 8 && digits.length <= 15) out.phone = phone;
    else issues.push("phone_invalid");
  }
  out.note = cleanString(r.note, 200);
  return { reservation: out, issues };
}

const REQUIRED_FIELDS = ["guests", "date", "time", "name", "phone"];
const missingFields = (r) => REQUIRED_FIELDS.filter((f) => r[f] === null);
const sameDetails = (a, b) =>
  Boolean(a && b) &&
  a.guests === b.guests &&
  a.date === b.date &&
  a.time === b.time &&
  (a.name ?? "").toLowerCase() === (b.name ?? "").toLowerCase() &&
  (a.phone ?? "").replace(/\D/g, "") === (b.phone ?? "").replace(/\D/g, "");

const LOCALES = { fr: "fr-FR", en: "en-GB", ar: "ar-MA" };
const TEXT = {
  fr: {
    today: "Aujourd'hui",
    tomorrow: "Demain",
    people: (n) => (n === 1 ? "1 personne" : `${n} personnes`),
    summaryLead: "Parfait. Voici votre demande de réservation :",
    summaryLeadAfterAnswer: "Voici votre demande de réservation :",
    notePrefix: "Note : ",
    confirmQuestion: "Souhaitez-vous que je l'envoie à Pepe Luis via WhatsApp ?",
    handoff: "Très bien. Appuyez sur le bouton ci-dessous : WhatsApp s'ouvre avec votre demande déjà rédigée, il ne reste qu'à l'envoyer. Pepe Luis vous confirmera la table par WhatsApp.",
    button: "Envoyer sur WhatsApp",
    alreadySent: "Votre demande est prête : il suffit de l'envoyer avec le bouton WhatsApp ci-dessus. Puis-je vous aider pour autre chose ?",
    ask: {
      guests: "Pour combien de personnes ?",
      date: "Pour quelle date ?",
      time: "À quelle heure souhaitez-vous venir ?",
      name: "À quel nom dois-je noter la réservation ?",
      phone: "À quel numéro de téléphone peut-on vous joindre ?",
    },
    issue: {
      time_closed: "Nous sommes ouverts de 12h à minuit. À quelle heure souhaitez-vous venir ?",
      time_past: "Cette heure est déjà passée aujourd'hui. Quelle autre heure, ou quel autre jour, vous conviendrait ?",
      date_past: "Cette date est déjà passée. Pour quel jour souhaitez-vous réserver ?",
      date_invalid: "Je n'ai pas bien saisi la date. Pour quel jour souhaitez-vous réserver ?",
      phone_invalid: "Ce numéro semble incomplet. À quel numéro de téléphone peut-on vous joindre ?",
    },
  },
  en: {
    today: "Today",
    tomorrow: "Tomorrow",
    people: (n) => (n === 1 ? "1 person" : `${n} people`),
    summaryLead: "Perfect. Here's your reservation request:",
    summaryLeadAfterAnswer: "Here's your reservation request:",
    notePrefix: "Note: ",
    confirmQuestion: "Would you like me to send this to Pepe Luis via WhatsApp?",
    handoff: "Great. Tap the button below: WhatsApp opens with your request already written, you only need to press send. Pepe Luis will confirm your table on WhatsApp.",
    button: "Send on WhatsApp",
    alreadySent: "Your request is ready: just send it with the WhatsApp button above. Can I help with anything else?",
    ask: {
      guests: "How many people will you be?",
      date: "For which date?",
      time: "What time would you like to come?",
      name: "What name should I put the reservation under?",
      phone: "What phone number can the restaurant reach you on?",
    },
    issue: {
      time_closed: "We're open from 12:00 to midnight. What time would you like to come?",
      time_past: "That time has already passed today. What other time, or which other day, would suit you?",
      date_past: "That date has already passed. Which day would you like to book?",
      date_invalid: "I didn't quite catch the date. Which day would you like to book?",
      phone_invalid: "That number looks incomplete. What phone number can the restaurant reach you on?",
    },
  },
  ar: {
    today: "اليوم",
    tomorrow: "غداً",
    people: (n) => `عدد الأشخاص: ${n}`,
    summaryLead: "ممتاز. هذا طلب الحجز الخاص بك:",
    summaryLeadAfterAnswer: "هذا طلب الحجز الخاص بك:",
    notePrefix: "ملاحظة: ",
    confirmQuestion: "هل تريد أن أرسله إلى Pepe Luis عبر واتساب؟",
    handoff: "ممتاز. اضغط على الزر أدناه: سيفتح واتساب وطلبك مكتوب مسبقاً، يكفي أن تضغط على إرسال. سيؤكد لك Pepe Luis الحجز عبر واتساب.",
    button: "إرسال عبر واتساب",
    alreadySent: "طلبك جاهز: يكفي إرساله عبر زر واتساب أعلاه. هل أستطيع مساعدتك في شيء آخر؟",
    ask: {
      guests: "كم عدد الأشخاص؟",
      date: "لأي تاريخ تريد الحجز؟",
      time: "في أي ساعة تريد الحضور؟",
      name: "بأي اسم أسجل الحجز؟",
      phone: "ما هو رقم الهاتف الذي يمكن الاتصال بك عليه؟",
    },
    issue: {
      time_closed: "نحن مفتوحون من 12:00 إلى منتصف الليل. في أي ساعة تريد الحضور؟",
      time_past: "هذه الساعة قد مضت اليوم. أي ساعة أخرى أو أي يوم آخر يناسبك؟",
      date_past: "هذا التاريخ قد مضى. لأي يوم تريد الحجز؟",
      date_invalid: "لم أفهم التاريخ جيداً. لأي يوم تريد الحجز؟",
      phone_invalid: "يبدو أن الرقم غير مكتمل. ما هو رقم الهاتف الذي يمكن الاتصال بك عليه؟",
    },
  },
};
const textFor = (language) => TEXT[language] ?? TEXT.en;

function dateLabel(iso, language, now) {
  const t = textFor(language);
  const full = formatDate(iso, LOCALES[language] ?? LOCALES.en);
  if (iso === now.date) return `${t.today} — ${full}`;
  if (iso === addDays(now.date, 1)) return `${t.tomorrow} — ${full}`;
  return full.charAt(0).toUpperCase() + full.slice(1);
}

function summaryText(r, language, now, lead) {
  const t = textFor(language);
  const rows = [t.people(r.guests), dateLabel(r.date, language, now), r.time, r.name, r.phone];
  if (r.note) rows.push(t.notePrefix + r.note);
  const answer = lead ? lead + "\n\n" : "";
  return `${answer}${lead ? t.summaryLeadAfterAnswer : t.summaryLead}\n\n${rows.map((row) => "• " + row).join("\n")}\n\n${t.confirmQuestion}`;
}

// The message the guest sends to the restaurant. Always French: it is read by the restaurant.
function whatsappHandoff(r, language) {
  const rows = [`• Nom : ${r.name}`, `• Personnes : ${r.guests}`, `• Date : ${formatDate(r.date, "fr-FR")}`, `• Heure : ${r.time}`, `• Téléphone : ${r.phone}`];
  if (r.note) rows.push(`• Note : ${r.note}`);
  const message = `Bonjour Pepe Luis, je souhaite réserver une table.\n\n${rows.join("\n")}\n\nMerci de me confirmer la réservation.`;
  return {
    type: "whatsapp",
    url: `https://wa.me/${FACTS.whatsappNumber}?text=${encodeURIComponent(message)}`,
    label: textFor(language).button,
    message,
  };
}

// True when the model wrote its own recap although the system adds one.
function looksLikeSummary(reply, r) {
  if (!reply) return false;
  const digits = reply.replace(/\D/g, "");
  const phoneDigits = (r.phone ?? "").replace(/\D/g, "");
  if (phoneDigits.length >= 8 && digits.includes(phoneDigits)) return true;
  return Boolean(r.name && r.time) && reply.toLowerCase().includes(r.name.toLowerCase()) && reply.includes(r.time);
}

// Rough language detection, used only to catch a reply written in the wrong
// language. Returns "ar", "fr", "en", or null when the text is too short or mixed
// to be sure. Words shared by French and English ("table", "menu") are left out.
const FR_WORDS = /(?<![\p{L}'’])(je|j|tu|vous|nous|on|est|sont|êtes|avez|avons|une|des|les|du|au|aux|pour|avec|dans|sur|et|ou|où|que|qui|quoi|quel|quels|quelle|quelles|combien|bonjour|bonsoir|merci|salut|voudrais|souhaite|souhaitez|réserver|réservation|personnes|demain|ce|soir|aujourd|heure|votre|vos|notre|nos|mais|pas|plaît|oui|non|très|bien|ouvert|ouverts|plats|carte)(?![\p{L}])/giu;
const EN_WORDS = /(?<![\p{L}'’])(i|you|we|they|the|is|are|am|do|does|did|have|has|what|which|where|when|how|much|many|would|could|can|like|please|your|our|my|for|with|and|or|not|this|that|there|it|at|to|of|hello|hi|hey|thanks|thank|book|booking|people|tomorrow|tonight|today|evening|open|opening|hours|located|yes|no|any|some|options|recommend)(?![\p{L}])/giu;
function detectLanguage(text) {
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  if (letters < 2) return null;
  const arabic = (text.match(/[\u0600-\u06FF\u0750-\u077F]/g) ?? []).length;
  if (arabic / letters > 0.5) return "ar";
  if (arabic / letters > 0.1) return null; // mixed scripts: do not guess
  const fr = (text.match(FR_WORDS) ?? []).length + (text.match(/[éèêàùçôîû]/gi) ?? []).length * 0.5;
  const en = (text.match(EN_WORDS) ?? []).length;
  if (fr >= 2 && fr >= en * 2) return "fr";
  if (en >= 2 && en >= fr * 2) return "en";
  return null;
}
const LANGUAGE_NAMES = { fr: "French", en: "English", ar: "Arabic" };
// Share of a text's letters that are Arabic script (0 when it has no letters).
function arabicShare(text) {
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  return letters ? (text.match(/[\u0600-\u06FF\u0750-\u077F]/g) ?? []).length / letters : 0;
}

// Letters from scripts that have no place in a French, English or Arabic reply.
const FOREIGN_SCRIPT = /[\u0590-\u05FF\u0400-\u04FF\u0900-\u097F\u0E00-\u0E7F\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/;

// Applies the rules the model is not trusted with: complete details before a
// summary, a summary before a confirmation, and a confirmation before WhatsApp.
function resolveTurn(modelOutput, prev, now, guestText = "") {
  let language = LANGUAGES.includes(modelOutput.language) ? modelOutput.language : "fr";
  const modelReply = typeof modelOutput.reply === "string" ? modelOutput.reply.trim() : "";

  // Language checks. A failed check asks for another attempt with a correction;
  // if every attempt fails the last answer is still used (see generateReply).
  let retryHint = null;
  const guestLanguage = detectLanguage(guestText);
  const replyLanguage = detectLanguage(modelReply);
  if (guestLanguage && language !== guestLanguage) {
    retryHint = `The guest's latest message is in ${LANGUAGE_NAMES[guestLanguage]}. Set "language" to "${guestLanguage}" and write "reply" in ${LANGUAGE_NAMES[guestLanguage]}.`;
    language = guestLanguage; // server-written texts (summary, questions) use the guest's language regardless
  } else if (replyLanguage && LANGUAGE_NAMES[language] && replyLanguage !== language) {
    retryHint = `Your "reply" was written in ${LANGUAGE_NAMES[replyLanguage]} but the guest is writing in ${LANGUAGE_NAMES[language]}. Write "reply" in ${LANGUAGE_NAMES[language]}.`;
  } else if (guestLanguage === "ar" && modelReply && arabicShare(modelReply) < 0.3) {
    // The guest wrote in Arabic script; a reply spelled out in Latin letters is not acceptable.
    retryHint = 'The guest wrote in Arabic script. Write "reply" in Arabic script, not transliterated into Latin letters.';
  } else if (language !== "other" && FOREIGN_SCRIPT.test(modelReply)) {
    retryHint = `Your "reply" contained letters from the wrong alphabet. Write it again cleanly in ${LANGUAGE_NAMES[language] ?? "the guest's language"}.`;
  }

  const t = textFor(language);
  const { reservation, issues } = normalizeReservation(modelOutput.reservation, now);
  const modelStage = reservation.stage;
  let reply = modelReply;
  let handoff = null;
  let override = null;

  // A booking in progress is never silently dropped: details the guest already
  // gave stay, unless the model replaced them or the guest cancelled.
  const inProgress = prev?.stage === "collecting" || (prev?.stage === "awaiting_confirmation" && reservation.stage !== "none");
  if (inProgress && reservation.stage !== "cancelled") {
    for (const field of [...REQUIRED_FIELDS, "note"]) {
      const invalidated = issues.some((issue) => issue.startsWith(field));
      if (reservation[field] === null && prev[field] !== null && !invalidated) reservation[field] = prev[field];
    }
    if (reservation.stage === "none") {
      // Only reached when the previous stage was "collecting".
      reservation.stage = "collecting";
      override = "kept_in_progress";
    }
  }
  const missing = missingFields(reservation);

  const alreadySent = prev?.stage === "confirmed" && sameDetails(prev, reservation) && !missing.length;
  const wantsSummaryOrSend = reservation.stage === "awaiting_confirmation" || reservation.stage === "confirmed";

  const active = reservation.stage === "collecting" || wantsSummaryOrSend;

  if (active && issues.length && !alreadySent) {
    // The guest gave a time or date that cannot work (closed, already past…):
    // say so right away instead of quietly dropping it.
    reservation.stage = "collecting";
    override = `issue:${issues[0]}`;
    reply = t.issue[issues[0]];
  } else if (wantsSummaryOrSend && alreadySent) {
    // This exact request already has its WhatsApp button: do not summarise or send again.
    reservation.stage = "confirmed";
    override = "already_sent";
    if (!reply || looksLikeSummary(reply, reservation)) reply = t.alreadySent;
  } else if (wantsSummaryOrSend && missing.length) {
    // The model moved on with a detail missing or invalid: ask for it instead.
    reservation.stage = "collecting";
    override = issues.length ? `issue:${issues[0]}` : `missing:${missing[0]}`;
    reply = issues.length ? t.issue[issues[0]] : t.ask[missing[0]];
  } else if (reservation.stage === "collecting" && !missing.length) {
    // Everything is known: the next step is always the summary.
    reservation.stage = "awaiting_confirmation";
    override = override ?? "complete_to_summary";
  }

  if (!alreadySent && reservation.stage === "confirmed") {
    if (prev?.stage === "awaiting_confirmation" && sameDetails(prev, reservation)) {
      handoff = whatsappHandoff(reservation, language);
      reply = t.handoff;
    } else {
      // "Confirmed" without the guest having seen this exact summary.
      reservation.stage = "awaiting_confirmation";
      override = "confirm_without_summary";
      reply = "";
    }
  }

  if (!alreadySent && reservation.stage === "awaiting_confirmation") {
    // Keep what the model said before the summary (an answer, an acknowledgement),
    // but not its own questions: the summary ends with the one question that matters.
    const lead = looksLikeSummary(reply, reservation)
      ? ""
      : reply
          .split(/(?<=[.!?؟])\s+/)
          .filter((sentence) => !/[?؟]\s*$/.test(sentence))
          .join(" ")
          .trim();
    reply = summaryText(reservation, language, now, lead);
  }

  // Never send an empty bubble.
  if (!reply) {
    if (reservation.stage === "collecting" && missing.length) reply = t.ask[missing[0]];
    else return { ok: false };
  }

  const turn = { ok: true, language, reply, reservation, handoff, modelStage, override, missing };
  // Server-written replies are already in the right language; only the model's own text can be wrong.
  const modelTextShown = reply.includes(modelReply) && modelReply.length > 0;
  if (retryHint && modelTextShown) return { ok: false, retryHint, usable: turn };
  return turn;
}

// ── Helpers ──────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Strip anything that could be the API key before text is logged or returned.
function redact(value) {
  let out = String(value ?? "");
  const key = process.env.GEMINI_API_KEY;
  if (key) out = out.split(key).join("[REDACTED]");
  return out.replace(/AIza[0-9A-Za-z_-]{20,}/g, "[REDACTED]").slice(0, 600);
}

// One structured log line per event. Never includes the key, message text or
// reservation details (guests type names and phone numbers into this chat).
function log(level, event, fields) {
  const line = JSON.stringify({ evt: event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// Browser history → Gemini "contents": the most recent messages only, each capped
// in length, consecutive turns of the same role merged, starting on a user turn.
function toGeminiContents(messages) {
  const turns = [];
  for (const msg of messages.slice(-MAX_HISTORY_MESSAGES)) {
    if (!msg || typeof msg.content !== "string") continue;
    const role = msg.role === "assistant" ? "model" : "user";
    const text = msg.content.trim().slice(0, role === "user" ? MAX_MESSAGE_CHARS : MAX_STORED_REPLY_CHARS);
    if (!text) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.parts[0].text += "\n" + text;
    else turns.push({ role, parts: [{ text }] });
  }
  while (turns.length && turns[0].role !== "user") turns.shift();
  return turns;
}

// Per-visitor rate limit (see RATE_LIMIT above).
const visitors = new Map(); // visitor → { dayStart, dayCount, recent: [timestamps] }

function visitorId(req) {
  const headers = req.headers ?? {};
  const raw = headers["x-vercel-forwarded-for"] ?? headers["x-real-ip"] ?? headers["x-forwarded-for"] ?? "";
  return String(Array.isArray(raw) ? raw[0] : raw).split(",")[0].trim() || "unknown";
}

function checkRateLimit(id, nowMs = Date.now()) {
  let visitor = visitors.get(id);
  if (!visitor || nowMs - visitor.dayStart >= DAY_MS) visitor = { dayStart: nowMs, dayCount: 0, recent: [] };
  visitor.recent = visitor.recent.filter((t) => nowMs - t < 60000);
  visitors.set(id, visitor);

  if (visitor.dayCount >= RATE_LIMIT.perDay) {
    return { allowed: false, scope: "day", retryAfterSec: Math.ceil((visitor.dayStart + DAY_MS - nowMs) / 1000) };
  }
  if (visitor.recent.length >= RATE_LIMIT.perMinute) {
    return { allowed: false, scope: "minute", retryAfterSec: Math.max(1, Math.ceil((visitor.recent[0] + 60000 - nowMs) / 1000)) };
  }
  visitor.recent.push(nowMs);
  visitor.dayCount++;

  if (visitors.size > 5000) {
    for (const [key, value] of visitors) {
      if (nowMs - value.dayStart >= DAY_MS || visitors.size > 4000) visitors.delete(key);
      if (visitors.size <= 4000) break;
    }
  }
  return { allowed: true };
}

// The reservation state the browser saved with the last assistant message.
function previousReservation(messages, now) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === "assistant" && msg.reservation && typeof msg.reservation === "object") {
      return normalizeReservation(msg.reservation, now).reservation;
    }
  }
  return null;
}

function parseModelJson(text) {
  let raw = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseRetryDelayMs(response, errorBody) {
  const header = Number(response.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return header * 1000;
  const details = errorBody?.error?.details;
  if (Array.isArray(details)) {
    for (const d of details) {
      const match = /^(\d+(?:\.\d+)?)s$/.exec(d?.retryDelay ?? "");
      if (match) return Math.ceil(Number(match[1]) * 1000);
    }
  }
  return null;
}

function classifyHttpError(httpStatus, errorBody) {
  const details = JSON.stringify(errorBody?.error?.details ?? "");
  if (httpStatus === 401 || httpStatus === 403) return "auth";
  if (httpStatus === 400 && details.includes("API_KEY_INVALID")) return "auth";
  if (httpStatus === 429) return "rate_limited";
  if ([409, 500, 502, 503, 504].includes(httpStatus)) return "transient";
  if (httpStatus === 404) return "model_unavailable";
  if (httpStatus === 400) return "bad_request";
  return "other";
}

// One request to one model, read as a stream so we can tell "has not started
// answering" (stalled) apart from "is answering, slowly". Always resolves with a
// result object.
async function callGemini(model, systemInstruction, contents, { useThinking, structuredMode, firstByteTimeoutMs, hardLimitMs }) {
  const started = Date.now();
  const generationConfig = { maxOutputTokens: model.maxOutputTokens };
  if (useThinking && model.thinkingLevel) {
    generationConfig.thinkingConfig = { thinkingLevel: model.thinkingLevel };
  }
  applyStructuredMode(generationConfig, structuredMode);

  const controller = new AbortController();
  let firstByteMs = null;
  let abortedBecause = null;
  const stallTimer = setTimeout(() => {
    abortedBecause = "stalled";
    controller.abort();
  }, firstByteTimeoutMs);
  const hardTimer = setTimeout(() => {
    abortedBecause = abortedBecause ?? "too_slow";
    controller.abort();
  }, hardLimitMs);

  try {
    const response = await fetch(`${API_BASE}/${model.id}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemInstruction }] },
        contents,
        generationConfig,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const raw = await response.text();
      let body = null;
      try {
        body = JSON.parse(raw);
        if (Array.isArray(body)) body = body[0];
      } catch {
        body = null;
      }
      return {
        kind: classifyHttpError(response.status, body),
        httpStatus: response.status,
        geminiStatus: body?.error?.status ?? null,
        geminiMessage: redact(body?.error?.message ?? raw),
        retryDelayMs: parseRetryDelayMs(response, body),
        ms: Date.now() - started,
      };
    }

    // Read the stream. The stall timer stops at the first piece of the answer.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstByteMs === null && value?.length) {
        firstByteMs = Date.now() - started;
        clearTimeout(stallTimer);
      }
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
    const ms = Date.now() - started;

    let text = "";
    let finishReason = null;
    let usage = null;
    let blockReason = null;
    let streamError = null;
    for (const block of raw.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (event.error) streamError = event.error;
      blockReason = blockReason ?? event.promptFeedback?.blockReason ?? null;
      const candidate = event.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if (typeof part.text === "string" && !part.thought) text += part.text;
      }
      if (candidate?.finishReason) finishReason = candidate.finishReason;
      if (event.usageMetadata) usage = event.usageMetadata;
    }
    text = text.trim();

    if (streamError) {
      const httpStatus = Number(streamError.code) || 500;
      return {
        kind: classifyHttpError(httpStatus, { error: streamError }),
        httpStatus,
        geminiStatus: streamError.status ?? null,
        geminiMessage: redact(streamError.message),
        retryDelayMs: null,
        ms,
      };
    }
    if (text) {
      const output = parseModelJson(text);
      if (!output || typeof output.reply !== "string") {
        return { kind: "bad_output", httpStatus: 200, geminiStatus: finishReason ?? "UNPARSEABLE", geminiMessage: "Model output was not the expected JSON", finishReason, usage, firstByteMs, ms };
      }
      return { kind: "ok", httpStatus: 200, output, finishReason, usage, firstByteMs, ms };
    }
    if (blockReason || ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION"].includes(finishReason)) {
      return { kind: "blocked", httpStatus: 200, geminiStatus: blockReason ?? finishReason, geminiMessage: "Response blocked by Gemini", ms };
    }
    return { kind: "empty", httpStatus: 200, geminiStatus: finishReason ?? "NO_TEXT", geminiMessage: "Gemini returned no text", ms };
  } catch (err) {
    const ms = Date.now() - started;
    if (err?.name === "AbortError" || abortedBecause) {
      const stalled = abortedBecause !== "too_slow";
      return {
        kind: "timeout",
        httpStatus: null,
        geminiStatus: stalled ? "STALLED" : "TOO_SLOW",
        geminiMessage: stalled ? `Nothing received within ${firstByteTimeoutMs}ms` : `Answer started after ${firstByteMs}ms but was not finished within ${hardLimitMs}ms`,
        firstByteMs,
        ms,
      };
    }
    return { kind: "network", httpStatus: null, geminiStatus: "NETWORK_ERROR", geminiMessage: redact(err?.message), ms };
  } finally {
    clearTimeout(stallTimer);
    clearTimeout(hardTimer);
  }
}

const usageSummary = (usage) => ({
  promptTokens: usage?.promptTokenCount ?? null,
  cachedTokens: usage?.cachedContentTokenCount ?? 0,
  outputTokens: usage?.candidatesTokenCount ?? null,
  thoughtTokens: usage?.thoughtsTokenCount ?? 0,
});

// Primary with retry/backoff, then fallback. `accept` turns the model's JSON
// into a final answer, or rejects it so the attempt is retried.
async function generateReply(systemInstruction, contents, requestId, accept, modelList = MODELS) {
  const started = Date.now();
  const trail = [];
  let totalAttempts = 0;
  let correction = ""; // added to the instruction after an answer that failed a check
  let usable = null; // an answer that failed a quality check but is better than an error

  for (let modelIndex = 0; modelIndex < modelList.length; modelIndex++) {
    const model = modelList[modelIndex];
    let useThinking = true;
    let attempt = 0;
    let formatDowngrades = 0;

    while (attempt < model.maxAttempts) {
      const remaining = TOTAL_BUDGET_MS - (Date.now() - started);
      if (remaining < 1500) {
        log("error", "gemini_budget_exhausted", { requestId, model: model.id, totalAttempts });
        if (usable) return { ok: true, ...usable, imperfect: true, trail, totalAttempts, ms: Date.now() - started };
        return { ok: false, trail, totalAttempts, ms: Date.now() - started };
      }

      attempt++;
      totalAttempts++;
      const modeIndex = structuredModeFor.get(model.id) ?? 0;
      const structuredMode = STRUCTURED_MODES[modeIndex];
      let result = await callGemini(model, systemInstruction + correction, contents, {
        useThinking,
        structuredMode,
        firstByteTimeoutMs: Math.min(FIRST_BYTE_TIMEOUT_MS, remaining - 500),
        hardLimitMs: Math.min(ATTEMPT_HARD_LIMIT_MS, remaining - 500),
      });

      let turn = null;
      if (result.kind === "ok") {
        turn = accept(result.output);
        if (!turn.ok) {
          if (turn.usable) usable = { turn: turn.usable, model: model.id, usedFallback: modelIndex > 0, structuredMode, usage: usageSummary(result.usage), firstByteMs: result.firstByteMs, modelMs: result.ms };
          if (turn.retryHint) correction = "\n\n---\n\nCORRECTION FOR THIS ATTEMPT: " + turn.retryHint;
          result = { ...result, kind: "bad_output", geminiStatus: turn.retryHint ? "WRONG_LANGUAGE" : "REJECTED", geminiMessage: turn.retryHint ? "Reply failed the language check" : "Model output failed validation" };
        }
      } else if (result.kind === "bad_output" && result.finishReason === "MAX_TOKENS") {
        correction = "\n\n---\n\nCORRECTION FOR THIS ATTEMPT: your previous reply was too long and was cut off. Answer in at most 4 short lines.";
      }

      const entry = {
        model: model.id,
        role: modelIndex === 0 ? "primary" : "fallback",
        attempt,
        kind: result.kind,
        httpStatus: result.httpStatus,
        geminiStatus: result.geminiStatus ?? null,
        geminiMessage: result.geminiMessage ?? null,
        structuredMode,
        firstByteMs: result.firstByteMs ?? null,
        ms: result.ms,
      };
      trail.push(entry);

      if (result.kind === "ok") {
        const usage = usageSummary(result.usage);
        log("info", "gemini_ok", {
          requestId,
          model: model.id,
          role: entry.role,
          attempt,
          totalAttempts,
          structuredMode,
          ms: Date.now() - started,
          firstByteMs: result.firstByteMs,
          finishReason: result.finishReason,
          ...usage,
        });
        return { ok: true, turn, model: model.id, usedFallback: modelIndex > 0, structuredMode, usage, firstByteMs: result.firstByteMs, modelMs: result.ms, trail, totalAttempts, ms: Date.now() - started };
      }

      log("warn", "gemini_attempt_failed", { requestId, ...entry, retryDelayMs: result.retryDelayMs ?? null });

      // Wrong key / no permission, or content blocked: another attempt cannot help.
      if (result.kind === "auth" || result.kind === "blocked") {
        return { ok: false, fatal: result.kind, trail, totalAttempts, ms: Date.now() - started };
      }

      if (result.kind === "bad_request") {
        const message = result.geminiMessage ?? "";
        // The model rejects the thinking setting: drop it once and retry the same model.
        if (useThinking && /thinking/i.test(message)) {
          useThinking = false;
          attempt--;
          continue;
        }
        // The API rejects this way of requesting JSON: step down to the next one.
        if (modeIndex < STRUCTURED_MODES.length - 1 && formatDowngrades < STRUCTURED_MODES.length && /response_?format|response_?json_?schema|response_?mime_?type|schema|unknown name|cannot find field|invalid json payload/i.test(message)) {
          structuredModeFor.set(model.id, modeIndex + 1);
          formatDowngrades++;
          attempt--;
          continue;
        }
      }

      // Same-model retries won't fix these: move to the next model now.
      if (["model_unavailable", "bad_request", "other", "timeout"].includes(result.kind)) break;
      if (result.kind === "rate_limited" && (result.retryDelayMs ?? 0) > MAX_HONORED_RETRY_DELAY_MS) break;

      // transient / rate_limited / empty / bad_output / network → back off, then retry.
      if (attempt < model.maxAttempts) {
        const exponential = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
        const wait = Math.max(exponential, result.retryDelayMs ?? 0) + Math.random() * BACKOFF_JITTER_MS;
        await sleep(wait);
      }
    }
  }

  if (usable) {
    log("warn", "gemini_used_imperfect_answer", { requestId, model: usable.model, totalAttempts });
    return { ok: true, ...usable, imperfect: true, trail, totalAttempts, ms: Date.now() - started };
  }
  return { ok: false, trail, totalAttempts, ms: Date.now() - started };
}

// ── HTTP layer ───────────────────────────────────────────────────────
const PUBLIC_MESSAGES = {
  INVALID_REQUEST: "The request was not valid.",
  METHOD_NOT_ALLOWED: "Method not allowed.",
  RATE_LIMITED: "Too many messages. Please wait a moment.",
  AI_NOT_CONFIGURED: "The assistant is not configured.",
  AI_AUTH_FAILED: "The assistant could not authenticate with the AI provider.",
  AI_BUSY: "The assistant is temporarily unavailable. Please try again in a moment.",
  AI_BLOCKED: "The assistant could not answer this message.",
  AI_UPSTREAM_ERROR: "The AI provider rejected the request.",
  INTERNAL_ERROR: "Unexpected server error.",
};

function sendError(res, httpStatus, code, { requestId, retryable = false, reason = null, trail = null, retryAfterSec = null } = {}) {
  if (retryAfterSec) res.setHeader("Retry-After", String(retryAfterSec));
  const last = trail?.[trail.length - 1];
  const error = { code, retryable, reason, message: PUBLIC_MESSAGES[code] };
  // Safe to expose: which model and which status. No provider message text in production.
  if (last) error.upstream = { model: last.model, httpStatus: last.httpStatus, status: last.geminiStatus };
  if (IS_DEBUG && trail) error.debug = trail;
  return res.status(httpStatus).json({ ok: false, error, requestId });
}

// GET /api/chat → what is configured. It calls nothing and spends nothing.
function handleStatus(res, requestId) {
  const keyConfigured = Boolean(process.env.GEMINI_API_KEY);
  return res.status(200).json({
    ok: keyConfigured,
    keyConfigured,
    today: casablancaNow(),
    models: MODELS.map((model, index) => ({ id: model.id, role: index === 0 ? "primary" : "fallback", thinkingLevel: model.thinkingLevel, maxOutputTokens: model.maxOutputTokens })),
    limits: { historyMessages: MAX_HISTORY_MESSAGES, messageChars: MAX_MESSAGE_CHARS, firstByteTimeoutMs: FIRST_BYTE_TIMEOUT_MS, ratePerMinute: RATE_LIMIT.perMinute, ratePerDay: RATE_LIMIT.perDay },
    knowledge: { menuItems: FACTS.menu.items, sharingPlatters: FACTS.menu.sharingPlatters, menuFingerprint: FACTS.menu.fingerprint },
    requestId,
  });
}

export default async function handler(req, res) {
  const requestId = randomUUID().slice(0, 8);
  res.setHeader("Cache-Control", "no-store");

  try {
    if (req.method === "GET") return handleStatus(res, requestId);
    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return sendError(res, 405, "METHOD_NOT_ALLOWED", { requestId });
    }

    if (!process.env.GEMINI_API_KEY) {
      log("error", "gemini_key_missing", { requestId });
      return sendError(res, 500, "AI_NOT_CONFIGURED", { requestId });
    }

    let messages;
    try {
      messages = req.body?.messages;
    } catch {
      messages = null; // body was not valid JSON
    }
    if (!Array.isArray(messages)) {
      return sendError(res, 400, "INVALID_REQUEST", { requestId, reason: "messages_missing" });
    }

    const contents = toGeminiContents(messages);
    if (!contents.length || contents[contents.length - 1].role !== "user") {
      return sendError(res, 400, "INVALID_REQUEST", { requestId, reason: "no_user_message" });
    }

    const limit = checkRateLimit(visitorId(req));
    if (!limit.allowed) {
      log("warn", "rate_limited", { requestId, scope: limit.scope, retryAfterSec: limit.retryAfterSec });
      return sendError(res, 429, "RATE_LIMITED", { requestId, retryable: true, reason: `per_${limit.scope}`, retryAfterSec: limit.retryAfterSec });
    }

    const now = casablancaNow();
    const prev = previousReservation(messages, now);
    const guestText = contents[contents.length - 1].parts[0].text;
    const systemInstruction = buildSystemInstruction(now, prev, guestText);

    const result = await generateReply(systemInstruction, contents, requestId, (output) => resolveTurn(output, prev, now, guestText));

    if (result.ok) {
      const turn = result.turn;
      log("info", "turn", {
        requestId,
        language: turn.language,
        stageBefore: prev?.stage ?? "none",
        modelStage: turn.modelStage,
        stageAfter: turn.reservation.stage,
        serverOverride: turn.override,
        missing: turn.missing,
        handoff: Boolean(turn.handoff),
        historyTurns: contents.length,
      });
      return res.status(200).json({
        ok: true,
        message: turn.reply,
        language: turn.language,
        reservation: turn.reservation,
        handoff: turn.handoff ? { type: turn.handoff.type, url: turn.handoff.url, label: turn.handoff.label } : null,
        meta: {
          model: result.model,
          usedFallback: result.usedFallback,
          attempts: result.totalAttempts,
          ms: result.ms,
          firstByteMs: result.firstByteMs ?? null,
          usage: result.usage ?? null,
        },
        requestId,
      });
    }

    const kinds = result.trail.map((t) => t.kind);
    log("error", "gemini_request_failed", { requestId, totalAttempts: result.totalAttempts, ms: result.ms, trail: result.trail });

    if (result.fatal === "auth") {
      return sendError(res, 502, "AI_AUTH_FAILED", { requestId, trail: result.trail });
    }
    if (result.fatal === "blocked") {
      return sendError(res, 422, "AI_BLOCKED", { requestId, trail: result.trail });
    }
    const temporary = kinds.some((k) => ["transient", "rate_limited", "timeout", "network", "empty", "bad_output"].includes(k));
    if (temporary || !kinds.length) {
      const reason = kinds.includes("rate_limited") ? "rate_limited" : kinds.includes("timeout") ? "timeout" : "overloaded";
      return sendError(res, 503, "AI_BUSY", { requestId, retryable: true, reason, trail: result.trail, retryAfterSec: 10 });
    }
    return sendError(res, 502, "AI_UPSTREAM_ERROR", { requestId, trail: result.trail });
  } catch (err) {
    log("error", "handler_crash", { requestId, message: redact(err?.message) });
    return sendError(res, 500, "INTERNAL_ERROR", { requestId });
  }
}

// Exported for local tests only.
export const __test = { checkRateLimit, visitors, RATE_LIMIT, detectLanguage, resolveTurn, normalizeReservation, buildDateContext, buildSystemInstruction, casablancaNow, toGeminiContents, previousReservation, parseModelJson, summaryText, whatsappHandoff, addDays };
