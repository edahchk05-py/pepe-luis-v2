import { readFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

// Load restaurant knowledge base once at module level
const knowledgeBase = readFileSync(
  join(process.cwd(), "data", "pepe-luis.md"),
  "utf-8"
);

const SYSTEM_PROMPT = `Tu es le concierge virtuel de Pepe Luis, un restaurant espagnol authentique à Casablanca. Tu es rapide, efficace, chaleureux et élégant.

Tu détectes automatiquement la langue du client (français, anglais, arabe, darija) et tu réponds dans la même langue. Par défaut, tu réponds en français.

RÈGLE ABSOLUE — INTENTION DE RÉSERVATION :
Si le client dit n'importe laquelle de ces choses (ou un équivalent), tu DÉMARRES IMMÉDIATEMENT la collecte de réservation sans hésiter, sans demander de confirmation :
- "book", "réserver", "réservation", "table", "je veux réserver", "résa", "place", "je veux venir", "on vient", "on sera", "prendre une table", "حجز", "نجي", "داكشي", ou toute variation
Tu ne demandes PAS "Souhaitez-vous réserver ?" — tu commences directement par collecter les infos.

COLLECTE DE RÉSERVATION (dans cet ordre, une question à la fois) :
1. Prénom et nom
2. Numéro de téléphone
3. Date souhaitée
4. Heure souhaitée (rappel : ouvert 12h–minuit, 7j/7)
5. Nombre de personnes
6. Note particulière (allergies, occasion spéciale…) — optionnel, propose-le en dernier

Une fois toutes les infos collectées : présente un récapitulatif clair, puis génère la phrase RESERVATION_READY: suivi du message WhatsApp pré-rempli en français.

Tu ne confirmes JAMAIS la réservation toi-même — tu expliques qu'elle sera confirmée par le restaurant via WhatsApp.

POUR TOUTE AUTRE QUESTION : réponds UNIQUEMENT avec les informations vérifiées ci-dessous. Si tu ne sais pas, propose de contacter le restaurant au +212 6 19 53 69 33.

Tu n'inventes jamais d'information.

---

INFORMATIONS VÉRIFIÉES PEPE LUIS :

${knowledgeBase}`;

// ── Gemini configuration ─────────────────────────────────────────────
// Model IDs and thinking levels checked against Google's docs on 2026-10-05:
//   gemini-3.8-flash      → current stable Flash; lowest thinking level is "low"
//   gemini-3.5-flash-lite → stable lightweight model; lowest level is "minimal"
// Tried in order: the first is the primary, the rest are fallbacks.
const MODELS = [
  { id: "gemini-3.8-flash", thinkingLevel: "low", maxAttempts: 3 },
  { id: "gemini-3.5-flash-lite", thinkingLevel: "minimal", maxAttempts: 2 },
];

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_HISTORY_TURNS = 20;
const MAX_OUTPUT_TOKENS = 1024;

// Retry timing. A failed attempt usually comes back in well under a second,
// so the worst case of all five attempts failing is roughly 3–4 seconds.
const BACKOFF_BASE_MS = 400; // 400ms, then 800ms, plus jitter
const BACKOFF_MAX_MS = 1600;
const BACKOFF_JITTER_MS = 250;
const MAX_HONORED_RETRY_DELAY_MS = 2000; // longer server-requested waits → switch model instead
const ATTEMPT_TIMEOUT_MS = 8000;
const TOTAL_BUDGET_MS = 22000; // the function itself is capped at 30s in vercel.json

const IS_DEBUG =
  process.env.VERCEL_ENV !== "production" || process.env.CHAT_DEBUG === "1";

// ── Helpers ──────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Strip anything that could be the API key before text is logged or returned.
function redact(value) {
  let out = String(value ?? "");
  const key = process.env.GEMINI_API_KEY;
  if (key) out = out.split(key).join("[REDACTED]");
  return out.replace(/AIza[0-9A-Za-z_-]{20,}/g, "[REDACTED]").slice(0, 600);
}

// One structured log line per event. Never includes the key or message text
// (customers type names and phone numbers into this chat).
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
async function callGemini(model, contents, { useThinking, timeoutMs, maxOutputTokens }) {
  const started = Date.now();
  const generationConfig = {
    maxOutputTokens: maxOutputTokens ?? MAX_OUTPUT_TOKENS,
    temperature: 0.7,
  };
  if (useThinking && model.thinkingLevel) {
    generationConfig.thinkingConfig = { thinkingLevel: model.thinkingLevel };
  }

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
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
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
      return {
        kind: "ok",
        httpStatus: 200,
        text,
        finishReason,
        usage: body?.usageMetadata ?? null,
        ms,
      };
    }
    if (blockReason || ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION"].includes(finishReason)) {
      return {
        kind: "blocked",
        httpStatus: 200,
        geminiStatus: blockReason ?? finishReason,
        geminiMessage: "Response blocked by Gemini",
        ms,
      };
    }
    return {
      kind: "empty",
      httpStatus: 200,
      geminiStatus: finishReason ?? "NO_TEXT",
      geminiMessage: "Gemini returned no text",
      ms,
    };
  } catch (err) {
    const ms = Date.now() - started;
    if (err?.name === "AbortError") {
      return {
        kind: "timeout",
        httpStatus: null,
        geminiStatus: "CLIENT_TIMEOUT",
        geminiMessage: `No response within ${timeoutMs}ms`,
        ms,
      };
    }
    return {
      kind: "network",
      httpStatus: null,
      geminiStatus: "NETWORK_ERROR",
      geminiMessage: redact(err?.message),
      ms,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Primary with retry/backoff, then fallback. Returns { ok, ... } and a trail
// describing every attempt.
async function generateReply(contents, requestId) {
  const started = Date.now();
  const trail = [];
  let totalAttempts = 0;

  for (let modelIndex = 0; modelIndex < MODELS.length; modelIndex++) {
    const model = MODELS[modelIndex];
    let useThinking = true;
    let attempt = 0;

    while (attempt < model.maxAttempts) {
      const remaining = TOTAL_BUDGET_MS - (Date.now() - started);
      if (remaining < 1500) {
        log("error", "gemini_budget_exhausted", { requestId, model: model.id, totalAttempts });
        return { ok: false, trail, totalAttempts, ms: Date.now() - started };
      }

      attempt++;
      totalAttempts++;
      const result = await callGemini(model, contents, {
        useThinking,
        timeoutMs: Math.min(ATTEMPT_TIMEOUT_MS, remaining - 500),
      });

      const entry = {
        model: model.id,
        role: modelIndex === 0 ? "primary" : "fallback",
        attempt,
        kind: result.kind,
        httpStatus: result.httpStatus,
        geminiStatus: result.geminiStatus ?? null,
        geminiMessage: result.geminiMessage ?? null,
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
          ms: Date.now() - started,
          finishReason: result.finishReason,
          promptTokens: result.usage?.promptTokenCount ?? null,
          outputTokens: result.usage?.candidatesTokenCount ?? null,
          thoughtTokens: result.usage?.thoughtsTokenCount ?? null,
        });
        return {
          ok: true,
          text: result.text,
          model: model.id,
          usedFallback: modelIndex > 0,
          trail,
          totalAttempts,
          ms: Date.now() - started,
        };
      }

      log("warn", "gemini_attempt_failed", {
        requestId,
        ...entry,
        retryDelayMs: result.retryDelayMs ?? null,
      });

      // Wrong key / no permission, or content blocked: another attempt cannot help.
      if (result.kind === "auth" || result.kind === "blocked") {
        return { ok: false, fatal: result.kind, trail, totalAttempts, ms: Date.now() - started };
      }

      // If the model rejects the thinking setting, drop it once and retry the same model.
      if (result.kind === "bad_request" && useThinking && /thinking/i.test(result.geminiMessage ?? "")) {
        useThinking = false;
        attempt--;
        continue;
      }

      // Same-model retries won't fix these: move to the next model now.
      if (["model_unavailable", "bad_request", "other", "timeout"].includes(result.kind)) break;
      if (result.kind === "rate_limited" && (result.retryDelayMs ?? 0) > MAX_HONORED_RETRY_DELAY_MS) break;

      // transient / rate_limited / empty / network → back off, then retry.
      if (attempt < model.maxAttempts) {
        const exponential = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
        const wait = Math.max(exponential, result.retryDelayMs ?? 0) + Math.random() * BACKOFF_JITTER_MS;
        await sleep(wait);
      }
    }
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
  if (!keyConfigured) {
    return res.status(200).json({ ok: false, keyConfigured, models: [], requestId });
  }
  const probe = req.query?.probe === "1";

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
        const result = await callGemini(model, [{ role: "user", parts: [{ text: "Bonjour" }] }], {
          useThinking: true,
          timeoutMs: ATTEMPT_TIMEOUT_MS,
          maxOutputTokens: 200,
        });
        info.probe = {
          ok: result.kind === "ok",
          kind: result.kind,
          httpStatus: result.httpStatus,
          status: result.geminiStatus ?? null,
          message: result.kind === "ok" ? null : result.geminiMessage,
          replyChars: result.text ? result.text.length : 0,
          thoughtTokens: result.usage?.thoughtsTokenCount ?? null,
          ms: result.ms,
        };
      }
      return info;
    })
  );

  const ok = models.every((m) => m.exists && m.supportsGenerateContent && (!probe || m.probe.ok));
  log("info", "health_check", { requestId, probe, ok, models: models.map((m) => ({ id: m.id, exists: m.exists, httpStatus: m.httpStatus, probe: m.probe?.kind ?? null })) });
  return res.status(200).json({ ok, keyConfigured, models, requestId });
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

    const result = await generateReply(contents, requestId);

    if (result.ok) {
      return res.status(200).json({
        ok: true,
        message: result.text,
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
    log("error", "gemini_request_failed", {
      requestId,
      totalAttempts: result.totalAttempts,
      ms: result.ms,
      trail: result.trail,
    });

    if (result.fatal === "auth") {
      return sendError(res, 502, "AI_AUTH_FAILED", { requestId, trail: result.trail });
    }
    if (result.fatal === "blocked") {
      return sendError(res, 422, "AI_BLOCKED", { requestId, trail: result.trail });
    }
    const temporary = kinds.some((k) => ["transient", "rate_limited", "timeout", "network", "empty"].includes(k));
    if (temporary || !kinds.length) {
      const reason = kinds.includes("rate_limited")
        ? "rate_limited"
        : kinds.includes("timeout")
          ? "timeout"
          : "overloaded";
      return sendError(res, 503, "AI_BUSY", { requestId, retryable: true, reason, trail: result.trail, retryAfterSec: 10 });
    }
    return sendError(res, 502, "AI_UPSTREAM_ERROR", { requestId, trail: result.trail });
  } catch (err) {
    log("error", "handler_crash", { requestId, message: redact(err?.message) });
    return sendError(res, 500, "INTERNAL_ERROR", { requestId });
  }
}
