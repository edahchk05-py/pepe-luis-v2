import { readFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

// ── Knowledge ────────────────────────────────────────────────────────
// Both files are GENERATED from index.html by scripts/build-knowledge.mjs
// (npm run knowledge). The website is the source of truth; do not edit them.
const KNOWLEDGE = readFileSync(join(process.cwd(), "data", "knowledge.md"), "utf-8");
const FACTS = JSON.parse(readFileSync(join(process.cwd(), "data", "site-facts.json"), "utf-8"));

// ── Gemini configuration ─────────────────────────────────────────────
// Model IDs and thinking levels checked against Google's docs and the live API
// on 2026-10-05. Tried in order: the first is the primary, the rest are fallbacks.
const MODELS = [
  { id: "gemini-3.5-flash-lite", thinkingLevel: "minimal", maxAttempts: 3 },
  { id: "gemini-3.8-flash", thinkingLevel: "low", maxAttempts: 2 },
];

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_HISTORY_TURNS = 30;
const MAX_OUTPUT_TOKENS = 1024;

// Retry timing. A failed attempt usually comes back in well under a second.
const BACKOFF_BASE_MS = 400; // 400ms, then 800ms, plus jitter
const BACKOFF_MAX_MS = 1600;
const BACKOFF_JITTER_MS = 250;
const MAX_HONORED_RETRY_DELAY_MS = 2000; // longer server-requested waits → switch model instead
const ATTEMPT_TIMEOUT_MS = 8000;
const TOTAL_BUDGET_MS = 22000; // the function itself is capped at 30s in vercel.json

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
const SYSTEM_PROMPT = `You are the virtual concierge of Pepe Luis, a Spanish restaurant, marisquería and brasserie in Casablanca. You talk with guests on the restaurant's website. You sound like an excellent maître d': warm, quick, refined, natural. Short sentences. No corporate tone, no walls of text. Usually 1 to 4 sentences; use a short list only when the guest asks for several dishes or prices.

OUTPUT FORMAT
Return exactly one JSON object and nothing else:
{"language":"fr|en|ar|other","reply":"...","reservation":{"stage":"none|collecting|awaiting_confirmation|confirmed|cancelled","guests":<integer or null>,"date":"YYYY-MM-DD" or null,"time":"HH:MM" or null,"name":<string or null>,"phone":<string or null>,"note":<string or null>}}

LANGUAGE
- "language" is the language of the guest's LATEST message: "fr" French, "en" English, "ar" Arabic or Moroccan Darija (in Arabic or Latin letters), "other" anything else.
- Write "reply" in that same language. English message, English reply. French message, French reply. Arabic message, Arabic reply. Darija message, Darija reply in the script the guest used. Any other language, reply in it.
- Never fall back to French because this prompt, the menu, or earlier messages are in French.
- If the latest message has no language of its own (a number, a name, a phone number, "ok", an emoji), continue in the language of the guest's previous messages. Only if there are none, use French.
- Mixed messages ("Can I réserver pour 4 people tomorrow?"): understand the intent; reply in the language that dominates the message.
- Keep dish names exactly as written on the menu, in every language: write "Paella Negra", never "Paella Noire" or "Black Paella"; never translate "Pulpo a la Gallega". You may explain a dish in the guest's language.
- In Arabic replies use Arabic letters only, plus Latin letters for dish names, phone numbers and "Pepe Luis".

KNOWLEDGE RULES
- Everything you state about Pepe Luis (dishes, prices, hours, address, services) must come from the VERIFIED KNOWLEDGE below. It is the restaurant's current website content and the only source you have.
- If a dish, price or fact is not in the knowledge, you do not know it. Never invent, never guess, never add "typical" Spanish dishes. If asked for a dish that is not on the menu, say it is not on the menu and offer the closest real ones.
- Quote prices exactly, with their unit (per piece, per 100g, per person, for 2 or for 4 people). A 5% service charge is not included, as the menu notes.
- "Parillada de Pescados" and "Parillada Mixta" each appear twice, at different prices, in two sections (Assortiments and Grillades). When asked about them, give both versions and say which section each belongs to.
- "Paella aux Fruits de Mer" (per person, in Plats & Cazuelas) is a different listing from the Paellas section (priced for 2 or for 4 people). Be precise about which one you mean.
- When the knowledge does not cover something (wine or alcohol, parking, terrace, allergens, vegetarian or halal guarantees, payment methods, delivery areas, private events, dress code, children's menu...), say plainly that you don't have that information and give the restaurant's phone number. For dietary questions you may point to menu items whose written description fits, and add that ingredients should be confirmed with the restaurant.
- Recommendations: suggest only real menu items, with prices, and give reasons taken from the menu descriptions or the site's own words.
- Describe a dish only with what its own menu line, or the site's text about that specific dish, says. Do not attach a cooking method, ingredient or origin to a dish unless the knowledge says it for that dish (for example, do not say a dish is "cooked over a wood fire" just because the restaurant has wood-fire cooking).
- Customer reviews in the knowledge are guests' opinions. You may mention them as reviews, never as promises.
- Unrelated but harmless questions (a sum, a joke, small talk): answer in one short friendly sentence, then bring it back to Pepe Luis. Do not write long off-topic answers.
- You cannot see table availability. You never confirm a booking yourself.
- You cannot take food, delivery or click & collect orders. If asked, say which services exist and give the phone number to order.
- Fish, tuna, shellfish and seafood are not vegetarian. This is a seafood restaurant: be honest that most of the menu is fish and seafood. Mention a dish as possibly suitable for a vegetarian only if neither its name nor its description contains meat, fish or seafood, and say it should be confirmed with the restaurant.

RESERVATIONS
You help the guest prepare a reservation REQUEST. The guest then sends it to the restaurant on WhatsApp, and the restaurant confirms it. You do not confirm it.

Details needed: guests (number of people), date, time, name, phone. Optional: note (occasion, allergy, seating wish), only if the guest brings one up. Do not ask for a note.

How to run it:
- Start as soon as the guest shows any intent to book ("book", "réserver", "une table pour 4", "on vient ce soir", "حجز", "بغيت نحجز", "bghit n7jez"...). Never ask "would you like to book?".
- Take everything the guest already gave, in any order, in one message or across several. Never ask again for something you already have.
- Ask only for what is missing, at most two things per message, in a natural order: people, date, time, then name and phone. Name and phone may be asked together; never ask for the time, the name and the phone all in one message. It must feel like a conversation, not a form.
- Accept corrections at any moment ("actually make it 5", "plutôt 21h").
- If the guest asks something else in the middle, answer it, then in the same reply ask for the next missing detail, keeping everything already given.
- You cannot pre-order food or add dishes to a reservation. Never offer to. If the guest asks for something specific (a dish, an occasion, a seating wish), put it in "note".
- date: write it as YYYY-MM-DD using the CALENDAR given after the knowledge. Never compute dates yourself.
- time: 24-hour HH:MM. "8pm", "20h", "8 du soir" all mean "20:00". A vague time ("evening", "ce soir", "lunch", "le soir") is not a time: keep time null and ask for the hour.
- The restaurant is open every day from 12:00 to midnight. Do not accept a time before 12:00, or a date or time that is already past (compare with NOW, given after the knowledge): explain kindly and ask for another.
- phone: copy the digits as the guest wrote them.

"reservation.stage":
- "none": no reservation in progress.
- "collecting": a reservation is in progress and at least one of the five details is missing. Your reply asks for what is missing.
- "awaiting_confirmation": all five details are known and the guest has not yet said yes to exactly this set. IMPORTANT: at this stage do NOT write the summary and do NOT ask for confirmation. The system adds the summary and the confirmation question itself. Your "reply" must be an empty string, unless the guest just asked a question, in which case "reply" contains only the answer to it.
- "confirmed": ONLY when the previous assistant message was the summary asking for confirmation AND the guest's latest message clearly says yes (yes, oui, ok, d'accord, go ahead, send it, نعم, واخا, wakha...). At this stage "reply" must be an empty string; the system adds the WhatsApp button and the closing message. If the guest changes a detail instead of saying yes, use "awaiting_confirmation" with the updated details.
- "cancelled": the guest gave up on the reservation.
At every stage, fill in every reservation field you know and use null for the others. Once a request has been prepared (after "confirmed"), go back to "none" unless the guest wants to change it.`;

const STATIC_INSTRUCTION = SYSTEM_PROMPT + "\n\n---\n\nVERIFIED KNOWLEDGE (the restaurant's website content). The current date and the reservation state follow after it.\n\n" + KNOWLEDGE;

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

function buildDateContext(now) {
  const lines = [
    `NOW in Casablanca: ${formatDate(now.date, "en-GB")}, ${now.time} (24-hour clock).`,
    "CALENDAR — use this to turn what the guest says into a date. Do not compute dates yourself.",
  ];
  for (let i = 0; i < 15; i++) {
    const iso = addDays(now.date, i);
    const weekday = formatDate(iso, "en-GB", { weekday: "long" });
    const tag =
      i === 0
        ? ' = TODAY ("aujourd\'hui", "ce soir", "tonight", "this evening", "اليوم")'
        : i === 1
          ? ' = TOMORROW ("demain", "غدا", "ghedda")'
          : "";
    lines.push(`${iso} ${weekday}${tag}`);
  }
  lines.push(
    'A weekday name ("Friday", "vendredi", "الجمعة") means its first occurrence after today in this list. "Next week" plus a weekday means the occurrence in the following week.',
    "If today is that weekday and the guest might mean today, ask which one.",
    'For a calendar date ("25 décembre", "Oct 12") use its next occurrence from today.',
    `If the guest asks for today at a time that is already past (it is ${now.time} now), say so and ask for another time or day.`
  );
  return lines.join("\n");
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

function buildSystemInstruction(now, prev) {
  // The unchanging part comes first so identical requests share a prefix; the
  // date and the reservation state, which change, come last.
  return [STATIC_INSTRUCTION, buildDateContext(now), buildStateContext(prev)].join("\n\n---\n\n");
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

// Browser history → Gemini "contents": valid turns only, consecutive turns of
// the same role merged, trimmed to the recent window, starting on a user turn.
function toGeminiContents(messages) {
  const turns = [];
  for (const msg of messages) {
    if (!msg || typeof msg.content !== "string") continue;
    const text = msg.content.trim();
    if (!text) continue;
    const role = msg.role === "assistant" ? "model" : "user";
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.parts[0].text += "\n" + text;
    else turns.push({ role, parts: [{ text }] });
  }
  const recent = turns.slice(-MAX_HISTORY_TURNS);
  while (recent.length && recent[0].role !== "user") recent.shift();
  return recent;
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

// One request to one model. Always resolves with a result object.
async function callGemini(model, systemInstruction, contents, { useThinking, structuredMode, timeoutMs }) {
  const started = Date.now();
  const generationConfig = { maxOutputTokens: MAX_OUTPUT_TOKENS };
  if (useThinking && model.thinkingLevel) {
    generationConfig.thinkingConfig = { thinkingLevel: model.thinkingLevel };
  }
  applyStructuredMode(generationConfig, structuredMode);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${API_BASE}/${model.id}:generateContent`, {
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

    const raw = await response.text();
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    const ms = Date.now() - started;

    if (!response.ok) {
      return {
        kind: classifyHttpError(response.status, body),
        httpStatus: response.status,
        geminiStatus: body?.error?.status ?? null,
        geminiMessage: redact(body?.error?.message ?? raw),
        retryDelayMs: parseRetryDelayMs(response, body),
        ms,
      };
    }

    const blockReason = body?.promptFeedback?.blockReason;
    const candidate = body?.candidates?.[0];
    const finishReason = candidate?.finishReason ?? null;
    const text = (candidate?.content?.parts ?? [])
      .filter((part) => typeof part.text === "string" && !part.thought)
      .map((part) => part.text)
      .join("")
      .trim();

    if (text) {
      const output = parseModelJson(text);
      if (!output || typeof output.reply !== "string") {
        return { kind: "bad_output", httpStatus: 200, geminiStatus: finishReason ?? "UNPARSEABLE", geminiMessage: "Model output was not the expected JSON", ms };
      }
      return { kind: "ok", httpStatus: 200, output, finishReason, usage: body?.usageMetadata ?? null, ms };
    }
    if (blockReason || ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION"].includes(finishReason)) {
      return { kind: "blocked", httpStatus: 200, geminiStatus: blockReason ?? finishReason, geminiMessage: "Response blocked by Gemini", ms };
    }
    return { kind: "empty", httpStatus: 200, geminiStatus: finishReason ?? "NO_TEXT", geminiMessage: "Gemini returned no text", ms };
  } catch (err) {
    const ms = Date.now() - started;
    if (err?.name === "AbortError") {
      return { kind: "timeout", httpStatus: null, geminiStatus: "CLIENT_TIMEOUT", geminiMessage: `No response within ${timeoutMs}ms`, ms };
    }
    return { kind: "network", httpStatus: null, geminiStatus: "NETWORK_ERROR", geminiMessage: redact(err?.message), ms };
  } finally {
    clearTimeout(timer);
  }
}

// Primary with retry/backoff, then fallback. `accept` turns the model's JSON
// into a final answer, or rejects it so the attempt is retried.
async function generateReply(systemInstruction, contents, requestId, accept, modelList = MODELS) {
  const started = Date.now();
  const trail = [];
  let totalAttempts = 0;
  let correction = ""; // added to the instruction after an answer in the wrong language
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
        timeoutMs: Math.min(ATTEMPT_TIMEOUT_MS, remaining - 500),
      });

      let turn = null;
      if (result.kind === "ok") {
        turn = accept(result.output);
        if (!turn.ok) {
          if (turn.usable) usable = { turn: turn.usable, model: model.id, usedFallback: modelIndex > 0, structuredMode };
          if (turn.retryHint) correction = "\n\n---\n\nCORRECTION FOR THIS ATTEMPT: " + turn.retryHint;
          result = { ...result, kind: "bad_output", geminiStatus: turn.retryHint ? "WRONG_LANGUAGE" : "REJECTED", geminiMessage: turn.retryHint ? "Reply failed the language check" : "Model output failed validation" };
        }
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
        ms: result.ms,
      };
      trail.push(entry);

      if (result.kind === "ok") {
        log("info", "gemini_ok", {
          requestId,
          model: model.id,
          role: entry.role,
          attempt,
          totalAttempts,
          structuredMode,
          ms: Date.now() - started,
          finishReason: result.finishReason,
          promptTokens: result.usage?.promptTokenCount ?? null,
          outputTokens: result.usage?.candidatesTokenCount ?? null,
          thoughtTokens: result.usage?.thoughtsTokenCount ?? null,
        });
        return { ok: true, turn, model: model.id, usedFallback: modelIndex > 0, structuredMode, trail, totalAttempts, ms: Date.now() - started };
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

// GET /api/chat          → do the configured models exist for this key? (metadata only)
// GET /api/chat?probe=1  → one tiny real generation per model, no retries
async function handleHealth(req, res, requestId) {
  const keyConfigured = Boolean(process.env.GEMINI_API_KEY);
  const knowledge = { menuItems: FACTS.menu.items, sharingPlatters: FACTS.menu.sharingPlatters, menuFingerprint: FACTS.menu.fingerprint };
  if (!keyConfigured) {
    return res.status(200).json({ ok: false, keyConfigured, models: [], knowledge, requestId });
  }
  const probe = req.query?.probe === "1";
  const now = casablancaNow();

  const models = await Promise.all(
    MODELS.map(async (model, index) => {
      const info = { id: model.id, role: index === 0 ? "primary" : "fallback", thinkingLevel: model.thinkingLevel };
      try {
        const response = await fetch(`${API_BASE}/${model.id}`, {
          headers: { "x-goog-api-key": process.env.GEMINI_API_KEY },
          signal: AbortSignal.timeout(6000),
        });
        const body = await response.json().catch(() => null);
        info.exists = response.ok;
        info.httpStatus = response.status;
        if (response.ok) {
          info.displayName = body?.displayName ?? null;
          info.supportsGenerateContent = (body?.supportedGenerationMethods ?? []).includes("generateContent");
        } else {
          info.status = body?.error?.status ?? null;
          info.message = redact(body?.error?.message);
        }
      } catch (err) {
        info.exists = null;
        info.status = err?.name === "TimeoutError" ? "CLIENT_TIMEOUT" : "NETWORK_ERROR";
      }

      if (probe) {
        // Diagnostics: ?t=<ms> sets the timeout (max 25s); ?plain=1 sends a tiny
        // prompt with no JSON schema; ?think=0 leaves the thinking setting out.
        const plain = req.query?.plain === "1";
        const timeoutMs = Math.min(Math.max(Number(req.query?.t) || ATTEMPT_TIMEOUT_MS, 2000), 25000);
        const structuredMode = plain ? "promptOnly" : STRUCTURED_MODES[structuredModeFor.get(model.id) ?? 0];
        const system = plain
          ? 'Reply with this JSON only: {"language":"fr","reply":"Bonjour","reservation":{"stage":"none"}}'
          : buildSystemInstruction(now, null);
        const result = await callGemini(model, system, [{ role: "user", parts: [{ text: "Bonjour" }] }], {
          useThinking: req.query?.think !== "0",
          structuredMode,
          timeoutMs,
        });
        info.probe = {
          ok: result.kind === "ok",
          kind: result.kind,
          httpStatus: result.httpStatus,
          status: result.geminiStatus ?? null,
          message: result.kind === "ok" ? null : result.geminiMessage ?? null,
          structuredMode,
          plain,
          timeoutMs,
          outputTokens: result.usage?.candidatesTokenCount ?? null,
          promptTokens: result.usage?.promptTokenCount ?? null,
          ms: result.ms,
        };
      }
      return info;
    })
  );

  const ok = models.every((m) => m.exists && m.supportsGenerateContent && (!probe || m.probe.ok));
  log("info", "health_check", { requestId, probe, ok, models: models.map((m) => ({ id: m.id, exists: m.exists, httpStatus: m.httpStatus, probe: m.probe?.kind ?? null, structuredMode: m.probe?.structuredMode ?? null })) });
  return res.status(200).json({ ok, keyConfigured, today: now, models, knowledge, requestId });
}

export default async function handler(req, res) {
  const requestId = randomUUID().slice(0, 8);
  res.setHeader("Cache-Control", "no-store");

  try {
    if (req.method === "GET") return await handleHealth(req, res, requestId);
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

    const now = casablancaNow();
    const prev = previousReservation(messages, now);
    const systemInstruction = buildSystemInstruction(now, prev);

    const guestText = contents[contents.length - 1].parts[0].text;
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
export const __test = { detectLanguage, resolveTurn, normalizeReservation, buildDateContext, buildSystemInstruction, casablancaNow, toGeminiContents, previousReservation, parseModelJson, summaryText, whatsappHandoff, addDays };
