import { readFileSync } from "fs";
import { join } from "path";

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

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { messages } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "Invalid messages format" });
  }

  // Limit conversation history to last 20 messages to control costs
  const recentMessages = messages.slice(-20);

  // Convert to Gemini format (user/model roles)
  const geminiContents = recentMessages.map((msg) => ({
    role: msg.role === "assistant" ? "model" : "user",
    parts: [{ text: msg.content }],
  }));

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: SYSTEM_PROMPT }],
          },
          contents: geminiContents,
          generationConfig: {
            maxOutputTokens: 1024,
            temperature: 0.7,
          },
        }),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      console.error("Gemini API error:", err);
      return res.status(500).json({ error: "Service temporarily unavailable." });
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      throw new Error("Empty response from Gemini");
    }

    return res.status(200).json({ message: text });
  } catch (error) {
    console.error("Gemini API error:", error);
    return res.status(500).json({
      error: "Service temporarily unavailable. Please try again.",
    });
  }
}
