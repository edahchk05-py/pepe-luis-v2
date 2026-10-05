import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { join } from "path";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Load restaurant knowledge base once at module level
const knowledgeBase = readFileSync(
  join(process.cwd(), "data", "pepe-luis.md"),
  "utf-8"
);

const SYSTEM_PROMPT = `Tu es le concierge virtuel de Pepe Luis, un restaurant espagnol authentique à Casablanca.

Tu réponds UNIQUEMENT avec les informations vérifiées ci-dessous. Si tu ne connais pas la réponse, dis-le honnêtement et propose de contacter le restaurant directement au +212 6 19 53 69 33.

Tu détectes automatiquement la langue du client (français, anglais, arabe) et tu réponds dans la même langue. Par défaut, tu réponds en français.

Tu es chaleureux, élégant et professionnel — à l'image du restaurant.

Pour les réservations, tu collectes ces informations dans la conversation, naturellement :
1. Prénom et nom
2. Numéro de téléphone
3. Date souhaitée
4. Heure souhaitée
5. Nombre de personnes
6. Note particulière (allergies, occasion spéciale, etc.) — optionnel

Une fois toutes les informations collectées, tu présentes un récapitulatif et tu proposes un bouton WhatsApp pour finaliser la demande.

IMPORTANT : Tu n'inventes jamais d'information. Tu ne confirmes pas de réservation toi-même — tu expliques que la réservation sera confirmée par le restaurant via WhatsApp.

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

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: recentMessages,
    });

    const content = response.content[0];
    if (content.type !== "text") {
      throw new Error("Unexpected response type");
    }

    return res.status(200).json({ message: content.text });
  } catch (error) {
    console.error("Claude API error:", error);
    return res.status(500).json({
      error: "Service temporarily unavailable. Please try again.",
    });
  }
}
