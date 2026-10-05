// Local tests for the concierge logic. Run from the repo root.
// No real network and no real key: fetch is replaced with a scripted fake.
const FAKE_KEY = "AIzaFAKE_KEY_FOR_TESTS_ONLY_0123456789abc";
process.env.GEMINI_API_KEY = FAKE_KEY;
process.env.VERCEL_ENV = "production";

const mod = await import(process.cwd() + "/api/chat.js");
const handler = mod.default;
const T = mod.__test;

const LITE = "gemini-3.5-flash-lite";
const FLASH = "gemini-3.8-flash";
const realLog = console.log.bind(console);
let failed = 0;
function check(name, cond, detail = "") {
  if (!cond) failed++;
  realLog(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

// ── Part A: deterministic reservation rules ──────────────────────────
const now = { date: "2026-10-05", time: "21:10" }; // a Monday evening
const full = { guests: 4, date: "2026-10-06", time: "20:00", name: "Edah Cheikh", phone: "+212 6 12 34 56 78", note: null };
const out = (language, reply, reservation) => ({ language, reply, reservation });

let r = T.resolveTurn(out("en", "Lovely. For which date?", { stage: "collecting", guests: 4, date: null, time: null, name: null, phone: null, note: null }), null, now);
check("A1 collecting with gaps → model's question kept", r.ok && r.reply === "Lovely. For which date?" && r.reservation.stage === "collecting" && !r.handoff);

r = T.resolveTurn(out("en", "", { stage: "awaiting_confirmation", ...full }), { stage: "collecting", ...full, phone: null }, now);
check("A2 all details → server-written summary, no WhatsApp yet", r.reservation.stage === "awaiting_confirmation" && !r.handoff && r.reply.includes("• 4 people") && /Tomorrow — Tuesday,? 6 October 2026/.test(r.reply) && r.reply.includes("• 20:00") && r.reply.includes("• Edah Cheikh") && r.reply.includes("+212 6 12 34 56 78") && r.reply.endsWith("Would you like me to send this to Pepe Luis via WhatsApp?"));
realLog("\n" + r.reply + "\n");

r = T.resolveTurn(out("en", "", { stage: "confirmed", ...full }), null, now);
check("A3 'confirmed' with no summary shown before → summary instead, NO handoff", r.reservation.stage === "awaiting_confirmation" && !r.handoff && r.override === "confirm_without_summary" && r.reply.includes("Would you like me to send"));

r = T.resolveTurn(out("en", "", { stage: "confirmed", ...full }), { stage: "awaiting_confirmation", ...full }, now);
const waText = r.handoff ? decodeURIComponent(r.handoff.url.split("?text=")[1]) : "";
check("A4 summary shown, then yes → WhatsApp handoff", r.reservation.stage === "confirmed" && r.handoff?.url.startsWith("https://wa.me/212619536933?text=") && r.handoff.label === "Send on WhatsApp" && r.reply.startsWith("Great. Tap the button below"));
check("A4 WhatsApp message carries the exact details, in French", waText.includes("• Nom : Edah Cheikh") && waText.includes("• Personnes : 4") && waText.includes("• Date : mardi 6 octobre 2026") && waText.includes("• Heure : 20:00") && waText.includes("• Téléphone : +212 6 12 34 56 78"));
realLog("\n" + waText + "\n");

r = T.resolveTurn(out("en", "", { stage: "confirmed", ...full, guests: 5 }), { stage: "awaiting_confirmation", ...full }, now);
check("A5 'yes' but a detail differs from the summary shown → new summary, NO handoff", !r.handoff && r.reservation.stage === "awaiting_confirmation" && r.reply.includes("• 5 people"));

r = T.resolveTurn(out("fr", "", { stage: "awaiting_confirmation", ...full, phone: null }), null, now);
check("A6 summary requested with phone missing → asks for the phone", r.reservation.stage === "collecting" && r.reply === "À quel numéro de téléphone peut-on vous joindre ?" && !r.handoff);

r = T.resolveTurn(out("en", "", { stage: "awaiting_confirmation", ...full, time: "10:00" }), null, now);
check("A7 time before opening → explains hours, no summary", r.reservation.stage === "collecting" && r.reservation.time === null && r.reply.startsWith("We're open from 12:00 to midnight"));

r = T.resolveTurn(out("en", "", { stage: "awaiting_confirmation", ...full, date: "2026-10-05", time: "20:00" }), null, now);
check("A7 today at a time already past → says so", r.reservation.stage === "collecting" && r.reply.startsWith("That time has already passed today"));

r = T.resolveTurn(out("en", "", { stage: "awaiting_confirmation", ...full, date: "2026-10-05", time: "22:30" }), null, now);
check("A7 today, later tonight → accepted, labelled Today", r.reservation.stage === "awaiting_confirmation" && /Today — Monday,? 5 October 2026/.test(r.reply));

r = T.resolveTurn(out("en", "", { stage: "awaiting_confirmation", ...full, date: "2026-10-01" }), null, now);
check("A8 date in the past → asks for another day", r.reservation.stage === "collecting" && r.reply.startsWith("That date has already passed"));

r = T.resolveTurn(out("en", "", { stage: "awaiting_confirmation", ...full, date: "2026-02-30" }), null, now);
check("A8 impossible date → rejected", r.reservation.stage === "collecting" && r.reservation.date === null);

r = T.resolveTurn(out("en", "Here is your booking: 4 people, tomorrow 20:00, Edah Cheikh, +212 6 12 34 56 78. Shall I send it?", { stage: "awaiting_confirmation", ...full }), null, now);
check("A9 model wrote its own recap → dropped, only one summary shown", (r.reply.match(/Edah Cheikh/g) || []).length === 1 && r.reply.startsWith("Perfect. Here's your reservation request:"));

r = T.resolveTurn(out("en", "Yes, the Paella Negra for two is 320 dhs.", { stage: "awaiting_confirmation", ...full }), { stage: "awaiting_confirmation", ...full }, now);
check("A10 side question at confirmation → answer, then the summary again", r.reply.startsWith("Yes, the Paella Negra for two is 320 dhs.\n\nHere's your reservation request:") && !r.handoff);

r = T.resolveTurn(out("en", "", { stage: "confirmed", ...full }), { stage: "confirmed", ...full }, now);
check("A11 already handed off → no second button, no second summary", !r.handoff && r.override === "already_sent" && r.reply.startsWith("Your request is ready"));

r = T.resolveTurn(out("en", "Yes, we have three paellas.", { stage: "none", guests: null, date: null, time: null, name: null, phone: null, note: null }), { stage: "collecting", guests: 4, date: "2026-10-06", time: null, name: null, phone: null, note: null }, now);
check("A12 side question mid-booking → details kept", r.reservation.stage === "collecting" && r.reservation.guests === 4 && r.reservation.date === "2026-10-06" && r.reply === "Yes, we have three paellas.");

r = T.resolveTurn(out("en", "", { stage: "confirmed", guests: null, date: null, time: null, name: null, phone: null, note: null }), { stage: "awaiting_confirmation", ...full }, now);
check("A12 'yes' with the model returning empty fields → details carried, handoff", Boolean(r.handoff) && r.reservation.guests === 4);

r = T.resolveTurn(out("en", "No problem, the request is cancelled.", { stage: "cancelled", guests: null, date: null, time: null, name: null, phone: null, note: null }), { stage: "awaiting_confirmation", ...full }, now);
check("A12 guest cancels → nothing carried, no handoff", r.reservation.stage === "cancelled" && r.reservation.guests === null && !r.handoff);

r = T.resolveTurn(out("fr", "", { stage: "awaiting_confirmation", ...full, guests: 1, note: "Anniversaire" }), null, now);
check("A13 French summary", r.reply.startsWith("Parfait. Voici votre demande de réservation :") && r.reply.includes("• 1 personne") && r.reply.includes("Demain — mardi 6 octobre 2026") && r.reply.includes("• Note : Anniversaire") && r.reply.endsWith("Souhaitez-vous que je l'envoie à Pepe Luis via WhatsApp ?"));
r = T.resolveTurn(out("ar", "", { stage: "awaiting_confirmation", ...full }), null, now);
check("A13 Arabic summary, western digits", r.reply.includes("عدد الأشخاص: 4") && r.reply.includes("2026") && r.reply.includes("20:00") && r.reply.endsWith("عبر واتساب؟"));
realLog("\n" + r.reply + "\n");

r = T.resolveTurn(out("klingon", "Hi", { stage: "none" }), null, now);
check("A14 unknown language code → safe default", r.ok && r.language === "fr");
r = T.resolveTurn(out("en", "", { stage: "none" }), null, now);
check("A15 empty reply → rejected so the attempt is retried", r.ok === false);
r = T.resolveTurn(out("en", "", { stage: "collecting", guests: 4, date: null, time: null, name: null, phone: null, note: null }), null, now);
check("A15 empty reply while collecting → asks for the next missing detail", r.reply === "For which date?");
r = T.resolveTurn(out("ar", "نحن مفت\u05D5\u05D7ون من 12:00", { stage: "none" }), null, now);
check("A15 Arabic reply with stray Hebrew letters → rejected so the attempt is retried", r.ok === false);
r = T.resolveTurn(out("ar", "نحن مفتوحون من 12:00 إلى منتصف الليل. Paella Negra 😊", { stage: "none" }), null, now);
check("A15 clean Arabic reply with a Latin dish name and emoji → accepted", r.ok === true);
r = T.resolveTurn(out("en", "ok", { stage: "collecting", ...full, phone: "12345" }), null, now);
check("A16 too-short phone number not accepted", r.reservation.phone === null && r.reservation.stage === "collecting");

// Language detection and checks
const D = T.detectLanguage;
check("A18 detects English, French, Arabic", D("Table for 3 tomorrow at 10am please") === "en" && D("Quels plats de poisson vous conseillez ?") === "fr" && D("ما هي أوقات العمل عندكم؟") === "ar");
check("A18 English question naming French dishes is still English", D("How much is the Salade de Fruits de Mer?") === "en" && D("Do you have Loup Grillé à l'Espeto?") === "en");
check("A18 short or mixed messages are not guessed", D("8pm") === null && D("Edah, 0612345678") === null && D("oui") === null && D("hello") === null && D("Can I réserver pour 4 people tomorrow?") === null);
r = T.resolveTurn(out("en", "Nous sommes ouverts à partir de 12h00. Souhaitez-vous réserver pour 12h00 ou une autre heure ?", { stage: "collecting", guests: 3, date: "2026-10-06", time: null, name: null, phone: null, note: null }), null, now, "Table for 3 tomorrow at 10am please");
check("A18 French reply to an English guest → sent back for another attempt, with a correction", r.ok === false && /Write "reply" in English/.test(r.retryHint) && r.usable?.reply.startsWith("Nous sommes"));
r = T.resolveTurn(out("fr", "Bonjour ! Nous sommes ouverts de 12h à minuit.", { stage: "none" }), null, now, "What are your opening hours?");
check("A18 model mislabels an English guest as French → correction requested", r.ok === false && /Set "language" to "en"/.test(r.retryHint));
r = T.resolveTurn(out("fr", "", { stage: "awaiting_confirmation", ...full }), null, now, "Yes that is all correct, please go ahead and book it for me");
check("A18 server-written summary follows the guest's language even if the model mislabels it", r.ok === true && r.language === "en" && r.reply.startsWith("Perfect. Here's your reservation request:"));
r = T.resolveTurn(out("en", "We don't have churros, but we do have Tarta de Queso Vasco and Crema Catalana for 50 dhs.", { stage: "none" }), null, now, "Do you have churros?");
check("A18 correct English reply passes", r.ok === true);

// Invalid time at any stage is explained immediately
r = T.resolveTurn(out("en", "Could you tell me your name and phone number?", { stage: "collecting", guests: 2, date: "2026-10-05", time: "20:00", name: null, phone: null, note: null }), null, now, "Book a table for 2 tonight at 8pm");
check("A19 'tonight at 8pm' when it is already 21:10 → told it has passed, not silently dropped", r.reply.startsWith("That time has already passed today") && r.reservation.time === null && r.reservation.guests === 2 && r.reservation.stage === "collecting");

// The model's own questions are removed before the summary
r = T.resolveTurn(out("fr", "C'est noté, je change pour 7 personnes. Souhaitez-vous envoyer cette modification à Pepe Luis sur WhatsApp ?", { stage: "awaiting_confirmation", ...full, guests: 7 }), { stage: "awaiting_confirmation", ...full }, now, "finalement on sera 7");
check("A20 correction at confirmation → acknowledgement kept, only one confirmation question", r.reply.startsWith("C'est noté, je change pour 7 personnes.\n\nVoici votre demande de réservation :") && (r.reply.match(/\?/g) || []).length === 1 && r.reply.includes("• 7 personnes"));

// Date context
const ctx = T.buildDateContext(now);
check("A17 date context: today, tomorrow and Friday resolved", /NOW in Casablanca: Monday,? 5 October 2026, 21:10/.test(ctx) && ctx.includes("2026-10-05 Monday = TODAY") && ctx.includes("2026-10-06 Tuesday = TOMORROW") && ctx.includes("2026-10-09 Friday") && ctx.includes("2026-10-19 Monday"));
const live = T.casablancaNow();
check("A17 live Casablanca clock is well formed", /^\d{4}-\d{2}-\d{2}$/.test(live.date) && /^\d{2}:\d{2}$/.test(live.time), `${live.date} ${live.time}`);
check("A17 month/year rollover", T.addDays("2026-12-31", 1) === "2027-01-01" && T.addDays("2028-02-28", 1) === "2028-02-29");

// ── Part B: the HTTP handler with a mocked Gemini ────────────────────
let calls, logs = [];
for (const level of ["log", "warn", "error"]) console[level] = (...a) => logs.push(a.join(" "));

const gem = (obj) => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: typeof obj === "string" ? obj : JSON.stringify(obj) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4000, candidatesTokenCount: 40 } } });
const err = (code, status, message) => ({ status: code, body: { error: { code, status, message } } });
function install(script) {
  calls = [];
  const q = { [LITE]: [...(script[LITE] ?? [])], [FLASH]: [...(script[FLASH] ?? [])] };
  globalThis.fetch = async (url, init = {}) => {
    const model = /models\/([^:?]+)/.exec(url)[1];
    const sent = JSON.parse(init.body);
    calls.push({ model, url, headers: init.headers, system: sent.system_instruction.parts[0].text, contents: sent.contents, gc: sent.generationConfig });
    const next = q[model].shift();
    if (!next) throw new Error("unexpected call to " + model);
    return new Response(JSON.stringify(next.body), { status: next.status });
  };
}
async function post(messages) {
  const res = { statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ method: "POST", body: { messages }, query: {} }, res);
  return res;
}
const none = { stage: "none", guests: null, date: null, time: null, name: null, phone: null, note: null };

install({ [LITE]: [gem({ language: "en", reply: "Hello! How can I help?", reservation: none })] });
let res = await post([{ role: "user", content: "hello" }]);
let c = calls[0];
check("B1 primary is Flash-Lite with minimal thinking", c.model === LITE && c.gc.thinkingConfig.thinkingLevel === "minimal");
check("B1 key in header only", c.headers["x-goog-api-key"] === FAKE_KEY && !c.url.includes("key="));
check("B1 JSON schema requested", c.gc.responseMimeType === "application/json" && c.gc.responseJsonSchema.required.includes("reservation"));
check("B1 system prompt carries today's date, the calendar and the generated knowledge", /NOW in Casablanca: \w+,? \d+ \w+ 20\d\d, \d\d:\d\d/.test(c.system) && c.system.includes("= TOMORROW") && c.system.includes("Paella Negra — Paella noire aux fruits de mer — 320 dhs") && c.system.includes("H9Q6+F2Q") && c.system.includes("no reservation in progress"));
check("B1 unchanging text first, date and state last", c.system.indexOf("### Boissons") < c.system.indexOf("NOW in Casablanca") && c.system.indexOf("NOW in Casablanca") < c.system.indexOf("RESERVATION STATE BEFORE THIS MESSAGE"));
check("B1 old invented dishes are gone from the prompt", !/Croquetas de Jam|Churros|Tortilla Espa|Entrecôte|Paella Valenciana|Crème Catalane/.test(c.system));
check("B1 response shape", res.statusCode === 200 && res.body.message === "Hello! How can I help?" && res.body.language === "en" && res.body.reservation.stage === "none" && res.body.handoff === null && res.body.meta.model === LITE);

// Fallback order
install({ [LITE]: [err(503, "UNAVAILABLE", "busy"), err(503, "UNAVAILABLE", "busy"), err(503, "UNAVAILABLE", "busy")], [FLASH]: [gem({ language: "fr", reply: "Bonjour !", reservation: none })] });
res = await post([{ role: "user", content: "Bonjour" }]);
check("B2 Lite overloaded → 3.8 Flash answers with thinking=low", res.body.meta.model === FLASH && res.body.meta.usedFallback && calls[3].gc.thinkingConfig.thinkingLevel === "low", calls.map((x) => (x.model === LITE ? "L" : "F")).join(""));

// Unparseable output is retried, never shown to the guest
install({ [LITE]: [gem("Sure! Here you go: not json"), gem({ language: "en", reply: "Hi", reservation: none })] });
res = await post([{ role: "user", content: "hello" }]);
check("B3 non-JSON model output → retried, guest sees clean reply", res.statusCode === 200 && res.body.message === "Hi" && calls.length === 2);
install({ [LITE]: [gem("```json\n" + JSON.stringify({ language: "en", reply: "Fenced", reservation: none }) + "\n```")] });
res = await post([{ role: "user", content: "hello" }]);
check("B3 JSON wrapped in a code fence is still read", res.body.message === "Fenced");

// Full two-step confirmation through the handler, echoing state like the browser does.
// "Tomorrow at 20:00" is always a valid future slot, whatever time the test runs.
const tomorrow = T.addDays(T.casablancaNow().date, 1);
const details = { guests: 4, date: tomorrow, time: "20:00", name: "Edah Cheikh", phone: "0612345678", note: null };
const history = [{ role: "user", content: "Table for 4 tomorrow at 8pm, Edah Cheikh, 0612345678" }];
install({ [LITE]: [gem({ language: "en", reply: "", reservation: { stage: "confirmed", ...details } })] }); // model jumps the gun
res = await post(history);
check("B4 model says 'confirmed' on the first message → guest gets a summary, no WhatsApp", res.body.handoff === null && res.body.reservation.stage === "awaiting_confirmation" && res.body.message.includes("Would you like me to send this"));
history.push({ role: "assistant", content: res.body.message, reservation: res.body.reservation }, { role: "user", content: "yes please" });
install({ [LITE]: [gem({ language: "en", reply: "", reservation: { stage: "confirmed", ...details } })] });
res = await post(history);
check("B4 guest confirms → WhatsApp handoff appears", res.body.handoff?.url.startsWith("https://wa.me/212619536933?text=") && res.body.reservation.stage === "confirmed");
check("B4 the model was told the summary had been shown", calls[0].system.includes("stage=awaiting_confirmation") && calls[0].system.includes("WAS the summary asking the guest to confirm"));
check("B4 handoff payload does not leak the raw message field", !("message" in res.body.handoff));

// Structured-output format ladder
install({ [LITE]: [err(400, "INVALID_ARGUMENT", 'Invalid JSON payload received. Unknown name "responseJsonSchema" at \'generation_config\': Cannot find field.'), gem({ language: "en", reply: "Hi", reservation: none })] });
res = await post([{ role: "user", content: "hello" }]);
check("B5 API rejects the JSON format field → next format used, same request succeeds", res.statusCode === 200 && !calls[1].gc.responseJsonSchema && calls[1].gc.responseFormat?.text?.mimeType === "application/json" && res.body.meta.attempts === 2);
install({ [LITE]: [gem({ language: "en", reply: "Hi again", reservation: none })] });
res = await post([{ role: "user", content: "hello" }]);
check("B5 working format remembered for the next request", calls.length === 1 && Boolean(calls[0].gc.responseFormat));

// Wrong-language answers: corrected on the next attempt; never turned into an error
install({ [LITE]: [gem({ language: "en", reply: "Nous sommes ouverts de 12h00 à minuit, tous les jours. Souhaitez-vous réserver ?", reservation: none }), gem({ language: "en", reply: "We're open every day from 12:00 to midnight.", reservation: none })] });
res = await post([{ role: "user", content: "What are your opening hours please?" }]);
check("B7 French answer to an English guest → retried with a correction → English answer", res.statusCode === 200 && res.body.message.startsWith("We're open") && calls.length === 2 && !calls[0].system.includes("CORRECTION FOR THIS ATTEMPT") && /CORRECTION FOR THIS ATTEMPT: .*Write "reply" in English/.test(calls[1].system));
const wrong = gem({ language: "en", reply: "Nous sommes ouverts de 12h00 à minuit, tous les jours. Souhaitez-vous réserver ?", reservation: none });
install({ [LITE]: [wrong, wrong, wrong], [FLASH]: [wrong, wrong] });
res = await post([{ role: "user", content: "What are your opening hours please?" }]);
check("B7 every attempt in the wrong language → guest still gets an answer, not an error", res.statusCode === 200 && res.body.message.startsWith("Nous sommes ouverts") && calls.length === 5);

// Privacy of logs
const all = logs.join("\n");
check("B6 logs never contain the key, names, phone numbers or message text", !all.includes(FAKE_KEY) && !all.includes("Edah") && !all.includes("0612345678") && !all.includes("yes please"));
check("B6 logs record the reservation stage transitions", /"evt":"turn".*"stageBefore":"awaiting_confirmation".*"stageAfter":"confirmed".*"handoff":true/.test(all));

realLog(`\n${failed === 0 ? "ALL PASSED" : failed + " FAILED"}`);
process.exit(failed ? 1 : 0);
