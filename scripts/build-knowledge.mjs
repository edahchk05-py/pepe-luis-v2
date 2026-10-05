// Builds the AI concierge's knowledge from the website itself.
//
//   npm run knowledge          → regenerate data/knowledge.md, data/knowledge-reviews.md, data/site-facts.json
//   npm run knowledge:check    → fail if those files are out of date with index.html
//
// Source of truth: index.html. Nothing here is typed by hand: every dish, price,
// hour and phone number is read out of the page markup. If the markup changes in
// a way this script does not understand, it stops with an error instead of guessing.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "node-html-parser";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "index.html");
const OUT_MD = join(ROOT, "data", "knowledge.md");
const OUT_REVIEWS = join(ROOT, "data", "knowledge-reviews.md");
const OUT_JSON = join(ROOT, "data", "site-facts.json");
const CHECK_ONLY = process.argv.includes("--check");

const html = readFileSync(SOURCE, "utf8");
const root = parse(html);

// ── helpers ──────────────────────────────────────────────────────────
const norm = (s) => String(s ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
const text = (el) => (el ? norm(el.text) : "");
// Text that belongs to the element itself, not to its child elements.
const ownText = (el) => norm(el.childNodes.filter((n) => n.nodeType === 3).map((n) => n.text).join(" "));
const hasClass = (el, cls) => (el.getAttribute?.("class") ?? "").split(/\s+/).includes(cls);
const stripQuotes = (s) => norm(s).replace(/^["'“”«»\s]+|["'“”«»\s]+$/g, "");

function must(value, what) {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) {
    throw new Error(`build-knowledge: could not find ${what} in index.html. The page markup changed; update the script, do not fill this in by hand.`);
  }
  return value;
}

// English variant from a data-en attribute, only when the attribute is well formed.
function en(el) {
  const v = el?.getAttribute?.("data-en");
  if (typeof v !== "string") return null;
  const cleaned = stripQuotes(v);
  return cleaned && !/[<>]|data-fr=|class=/.test(cleaned) ? cleaned : null;
}

// ── menu ─────────────────────────────────────────────────────────────
const overlay = must(root.querySelector("#menu-overlay"), "the menu panel (#menu-overlay)");

const tabs = new Map();
for (const tab of overlay.querySelectorAll(".mo-tab")) {
  tabs.set(tab.getAttribute("data-tab"), { fr: text(tab), en: en(tab) });
}
must([...tabs.keys()], "menu tabs (.mo-tab)");

// Prices are kept exactly as the site prints them: bare numbers, with the unit
// where the site gives one ("10 / pièce", "45 / 100g"). The menu header states
// that prices are in dirhams.
const price = (raw) => norm(raw);

const sections = [];
const canonicalItems = []; // section|name|description|raw price — used to compare with the live page
const canonicalShares = [];

for (const sectionEl of overlay.querySelectorAll(".mo-section")) {
  const key = must(sectionEl.getAttribute("id"), "a menu section id").replace(/^mo-/, "");
  const tab = must(tabs.get(key), `the tab for menu section "${key}"`);
  const section = { key, fr: tab.fr, en: tab.en, entries: [] };

  const walk = (el) => {
    for (const child of el.childNodes) {
      if (child.nodeType !== 1) continue;

      if (hasClass(child, "mo-item")) {
        const nameEl = must(child.querySelector(".mo-name"), `a dish name in "${key}"`);
        const descEl = nameEl.querySelector(".mo-fr");
        const rawPrice = must(text(child.querySelector(".mo-price")), `a price for "${text(nameEl)}"`);
        const name = must(ownText(nameEl), `dish name text in "${key}"`);
        const description = descEl ? text(descEl) : "";
        section.entries.push({ type: "item", name, nameEn: en(nameEl), description, price: price(rawPrice) });
        canonicalItems.push([`mo-${key}`, name, description, rawPrice].join("|"));
      } else if (hasClass(child, "mo-share-item")) {
        const name = must(text(child.querySelector(".mo-share-name")), `a sharing platter name in "${key}"`);
        const description = text(child.querySelector(".mo-share-desc"));
        const priceEl = must(child.querySelector(".mo-share-price"), `a price for "${name}"`);
        const minEl = priceEl.querySelector(".mo-share-min");
        const base = must(ownText(priceEl), `price text for "${name}"`);
        section.entries.push({ type: "share", name, description, price: minEl ? `${base} (${text(minEl)})` : base });
        canonicalShares.push([`mo-${key}`, name, description, text(priceEl)].join("|"));
      } else if (hasClass(child, "mo-note") || hasClass(child, "mo-accomp")) {
        section.entries.push({ type: "note", fr: text(child), en: en(child) });
      } else if (hasClass(child, "mo-sub-heading") || hasClass(child, "mo-paella-size") || hasClass(child, "mo-caviar-title")) {
        section.entries.push({ type: "heading", fr: text(child), en: en(child) });
      } else {
        walk(child);
      }
    }
  };
  walk(sectionEl);
  must(section.entries.filter((e) => e.type === "item" || e.type === "share"), `any dishes in menu section "${key}"`);
  sections.push(section);
}

// Self-check: the DOM walk must account for every item present in the raw HTML.
const menuHtml = html.slice(html.indexOf('<div id="menu-overlay"'), html.indexOf("<!-- /menu-overlay -->"));
const rawItemCount = (menuHtml.match(/class="mo-item"/g) ?? []).length;
const rawShareCount = (menuHtml.match(/class="mo-share-item"/g) ?? []).length;
if (canonicalItems.length !== rawItemCount || canonicalShares.length !== rawShareCount) {
  throw new Error(`build-knowledge: extracted ${canonicalItems.length} items / ${canonicalShares.length} platters but the HTML contains ${rawItemCount} / ${rawShareCount}.`);
}
const menuFingerprint = createHash("sha256").update(canonicalItems.concat(canonicalShares).join("\n")).digest("hex");

// ── restaurant information ───────────────────────────────────────────
const visit = must(root.querySelector("#visit"), "the Find Us block (#visit)");
const vgroups = visit.querySelectorAll(".vgroup").map((g) => ({
  label: text(g.querySelector(".vlabel [data-fr]")) || text(g.querySelector(".vlabel")),
  labelAttr: g.querySelector(".vlabel")?.getAttribute("data-fr") ?? g.querySelector(".vlabel [data-fr]")?.getAttribute("data-fr") ?? "",
  valueEl: g.querySelector(".vval"),
}));
const group = (frLabel) => must(vgroups.find((g) => norm(g.labelAttr) === frLabel), `the "${frLabel}" row in Find Us`).valueEl;

const address = must(text(group("Adresse")), "the address");
const hoursEl = group("Horaires");
const hoursDays = must(hoursEl.querySelector(".hrs-day"), "the opening days");
const hoursRange = must(text(hoursEl.querySelectorAll(".hrs span").find((s) => !hasClass(s, "hrs-day"))), "the opening hours");
const hoursMatch = must(/^(\d{1,2})h(\d{2})\s*[–-]\s*(\d{1,2})h(\d{2})$/.exec(hoursRange), `opening hours in the form "12h00 – 00h00" (found "${hoursRange}")`);
const pad = (n) => String(n).padStart(2, "0");
const opens = `${pad(hoursMatch[1])}:${hoursMatch[2]}`;
const closes = `${pad(hoursMatch[3])}:${hoursMatch[4]}`;

const contactEl = group("Réservations");
const telLink = must(contactEl.querySelector('a[href^="tel:"]'), "the phone link");
const phoneLocal = text(telLink);
const phoneE164 = must(/^tel:(\+\d{8,15})$/.exec(telLink.getAttribute("href"))?.[1], "an international phone number in the tel: link");
const instaLink = must(contactEl.querySelector('a[href*="instagram.com"]'), "the Instagram link");
const servicesEl = group("Services");
const services = must(text(servicesEl), "the services line");

const waLink = must(visit.querySelector('a[href*="wa.me/"]'), "the WhatsApp link");
const whatsappNumber = must(/wa\.me\/(\d{8,15})/.exec(waLink.getAttribute("href"))?.[1], "the WhatsApp number");
const mapsLink = must(visit.querySelector('a[href*="google.com/maps/dir"]'), "the Google Maps directions link").getAttribute("href");

const tagline = must(text(root.querySelector(".hero-eye")), "the hero tagline");
const heroSub = must(root.querySelector(".hero-sub"), "the hero description");
const aboutLead = must(root.querySelector(".about-text .sec-lead"), "the About paragraph");
const footerBlurb = must(root.querySelector(".f-brand p"), "the footer description");

const ratingValue = must(text(root.querySelector("#g-trust-rating")), "the Google rating");
const ratingCount = must(text(root.querySelector("#g-trust-count")), "the Google review count");

// Highlights: the "trust strip" and the "numbers" band, exactly as displayed.
const highlights = [];
for (const label of root.querySelectorAll(".trust .trust-label")) {
  const strong = label.querySelector("strong");
  const span = label.querySelector("span");
  if (!strong || !span) continue; // the rating row is handled above
  highlights.push({ fr: `${text(strong)} — ${text(span)}`, en: en(strong) && en(span) ? `${en(strong)} — ${en(span)}` : null });
}
for (const item of root.querySelectorAll(".numbers .num-item")) {
  const big = item.querySelector(".num-big");
  const lbl = item.querySelector(".num-lbl");
  if (!big || !lbl || /^\d\.\d$/.test(text(big))) continue; // skip the rating tile
  highlights.push({ fr: text(lbl), en: en(lbl) });
}
must(highlights, "the highlights (trust strip / numbers band)");

const starters = must(root.querySelector(".starters-text"), "the free starter platter block");
const startersQuote = stripQuotes(text(starters.querySelector(".pull-quote")));
const startersLead = must(starters.querySelector(".sec-lead"), "the starter platter description");

const paella = must(root.querySelector(".paella-text"), "the signature dish block");
const paellaTitle = norm(text(paella.querySelector(".sec-title")).replace(/\s*—.*$/, ""));
const paellaEyebrow = paella.querySelector(".eyebrow");
const paellaQuote = stripQuotes(text(paella.querySelector(".paella-quote")));
const paellaLead = must(paella.querySelector(".sec-lead"), "the signature dish description");
const paellaTags = paella.querySelectorAll(".ptag").map((t) => text(t));

const reviews = root.querySelectorAll(".reviews-grid .rcard").map((card) => ({
  quote: stripQuotes(text(card.querySelector(".rcard-text"))),
  author: text(card.querySelector(".rcard-name")),
  meta: text(card.querySelector(".rcard-meta")),
})).filter((r) => r.quote && r.author);

// ── render ───────────────────────────────────────────────────────────
// Compact on purpose: this text is sent to the AI with every message. It keeps
// every fact and every menu line, in the site's own (French) wording. The site's
// English duplicates are left out (the AI translates), except section names.
const lines = [];
const out = (s = "") => lines.push(s);
const unique = (list) => [...new Set(list)];

out("PEPE LUIS — VERIFIED KNOWLEDGE (generated from the restaurant's website; wording as on the site: French, dish names often Spanish)");
out("");
out("RESTAURANT");
out(`Name: Pepe Luis — ${tagline}`);
out(`Hours: ${text(hoursDays)}, ${hoursRange} (every day, ${opens} to ${closes === "00:00" ? "midnight" : closes})`);
out(`Address as shown on the site (a Google Maps location code; the site gives no street name): ${address}`);
out(`Directions: ${mapsLink}`);
out(`Phone: ${phoneLocal} (${phoneE164}) · WhatsApp: +${whatsappNumber} · Instagram: ${text(instaLink)}`);
out("Reservations: by phone or WhatsApp");
out(`Services: ${services}`);
out(`Highlights: ${unique(highlights.map((h) => h.fr)).join(" · ")}`);
out(`Google rating: ${ratingValue} / 5 — ${ratingCount}`);
out(`About: ${text(heroSub)} ${text(aboutLead)}`);
out(`Free starter platter: ${text(startersLead)}`);
out(`Signature dish — ${paellaTitle}: ${text(paellaLead)}`);
out("");
out(`MENU — complete: ${sections.length} sections, ${canonicalItems.length} priced items, ${canonicalShares.length} sharing platters. A dish not listed here is not on the menu. Each line: name — description — price. Every price is in Moroccan dirhams (dhs), as printed on the site.`);
for (const section of sections) {
  out("");
  out(`[${section.fr}${section.en && section.en !== section.fr ? ` | EN: ${section.en}` : ""}]`);
  for (const e of section.entries) {
    if (e.type === "heading") out(`· ${e.fr} ·`);
    else if (e.type === "note") out(`(note) ${e.fr}`);
    else if (e.type === "item") out(`${e.name}${e.description ? ` — ${e.description}` : ""} — ${e.price}`);
    else out(`${e.name} (to share)${e.description ? ` — ${e.description}` : ""} — ${e.price}`);
  }
}
const markdown = lines.join("\n").trimEnd() + "\n";

// Customer reviews are only sent when a guest asks about reviews or ratings.
const reviewsText = reviews.length
  ? "CUSTOMER REVIEWS quoted on the website (guests' opinions, not promises from the restaurant):\n" +
    reviews.map((r) => `"${r.quote}" — ${r.author}${r.meta ? `, ${r.meta}` : ""}`).join("\n") +
    "\n"
  : "";

const facts = {
  _comment: "Generated from index.html by scripts/build-knowledge.mjs. Do not edit by hand.",
  phoneLocal,
  phoneE164,
  whatsappNumber,
  hours: { opens, closes, days: text(hoursDays) },
  address,
  mapsLink,
  menu: { items: canonicalItems.length, sharingPlatters: canonicalShares.length, sections: sections.length, fingerprint: menuFingerprint },
};
const json = JSON.stringify(facts, null, 2) + "\n";

const outputs = [
  [OUT_MD, markdown],
  [OUT_REVIEWS, reviewsText],
  [OUT_JSON, json],
];

if (CHECK_ONLY) {
  const current = outputs.every(([file, content]) => existsSync(file) && readFileSync(file, "utf8") === content);
  if (!current) {
    console.error("Knowledge is OUT OF DATE with index.html. Run: npm run knowledge");
    process.exit(1);
  }
  console.log(`Knowledge is up to date (${canonicalItems.length} items, ${canonicalShares.length} platters).`);
} else {
  for (const [file, content] of outputs) writeFileSync(file, content);
  console.log(`Wrote data/knowledge.md (${markdown.length} chars), data/knowledge-reviews.md (${reviewsText.length} chars) and data/site-facts.json`);
  console.log(`Menu: ${sections.length} sections, ${canonicalItems.length} items, ${canonicalShares.length} sharing platters`);
  console.log(`Menu fingerprint: ${menuFingerprint}`);
}
