import Anthropic from "@anthropic-ai/sdk";

// On-demand translation of renholdsplan text (room names, task labels, and the alternatives a
// flervalg task offers) for cleaners who don't read Norwegian.
//
// NOTHING HERE IS PERSISTED, AND THAT IS THE POINT. The Norwegian text stays the record: it is
// what the cleaner signs off, what the customer's report shows, and what a tilsyn traces back. A
// machine translation is a reading aid on the cleaner's own screen and must never become the
// documentation — so it is never written to the database, never returned by the report routes,
// and never accepted back from the client as a value to store.
//
// The cache below is in memory only. It survives repeated taps within a running server and dies
// on restart, which keeps "we store no translations" literally true.

// Keyed by language + the exact Norwegian source string, not by room or site: renholdsplaner
// repeat the same handful of phrases ("Tømme søppel", "Støvsuge gulv") across every site, so a
// per-string cache pays for itself immediately and the second cleaner at any site that day
// usually needs no API call at all.
const cache = new Map();
const MAX_CACHE_ENTRIES = 5000;

// Model calls get unreliable with very long lists, and a single renholdsplan can carry a few
// hundred strings, so translate in batches.
const BATCH_SIZE = 60;
// A renholdsplan line is a short phrase. Anything longer is not plan text and is left alone
// rather than burning tokens on it.
const MAX_SOURCE_CHARS = 300;

const LANGUAGE_NAMES = {
  en: "English",
  lt: "Lithuanian",
  lv: "Latvian",
  ru: "Russian",
};

export function isTranslatableLanguage(language) {
  return Object.prototype.hasOwnProperty.call(LANGUAGE_NAMES, language);
}

export function isTranslationConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

function cacheKey(language, text) {
  return `${language}\u0000${text}`;
}

function rememberTranslation(language, source, translation) {
  // Crude bound rather than a real LRU: this only exists to stop a long-running server from
  // growing without limit, and the working set (one company's plan vocabulary) is far smaller
  // than the cap.
  if (cache.size >= MAX_CACHE_ENTRIES) {
    for (const key of cache.keys()) {
      cache.delete(key);
      if (cache.size < MAX_CACHE_ENTRIES * 0.9) break;
    }
  }
  cache.set(cacheKey(language, source), translation);
}

const TRANSLATE_TOOL = {
  name: "submit_translations",
  description: "Submit the translated cleaning-plan lines, one per input index.",
  input_schema: {
    type: "object",
    properties: {
      translations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "integer", description: "The index of the source line being translated." },
            text: { type: "string", description: "The translated line." },
          },
          required: ["index", "text"],
        },
      },
    },
    required: ["translations"],
  },
};

function promptFor(language, batch) {
  const numbered = batch.map((text, i) => `${i}. ${text}`).join("\n");
  return (
    `These are lines from a Norwegian cleaning plan (renholdsplan): room names, cleaning tasks, ` +
    `and the alternatives a task can offer. They are read on a phone by a cleaner who does not ` +
    `read Norwegian, while they are doing the work.\n\n` +
    `Translate each line into ${LANGUAGE_NAMES[language]}.\n\n` +
    `Rules:\n` +
    `- Keep it short. These are labels, not sentences — a label that grows into a paragraph is ` +
    `useless on a phone.\n` +
    `- Use the plain words a cleaner would actually use, not formal or bureaucratic vocabulary.\n` +
    `- Keep product names, brand names, room numbers and codes exactly as they are ` +
    `(e.g. "Zalo", "Rom 204", "HC-WC").\n` +
    `- If a line is already in the target language, or is just a number or a code, return it ` +
    `unchanged.\n` +
    `- Translate every line, and return exactly one entry per index.\n\n` +
    `Lines:\n${numbered}`
  );
}

async function translateBatch(anthropic, language, batch) {
  const message = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 4096,
    tools: [TRANSLATE_TOOL],
    tool_choice: { type: "tool", name: "submit_translations" },
    messages: [{ role: "user", content: promptFor(language, batch) }],
  });

  const block = message.content.find((c) => c.type === "tool_use");
  if (!block?.input?.translations) return;

  for (const entry of block.input.translations) {
    const source = batch[entry.index];
    // An out-of-range index, or an empty translation, means that line simply doesn't get
    // translated this round — the UI then shows the Norwegian alone, which is unhelpful but
    // never wrong.
    if (source === undefined || typeof entry.text !== "string" || !entry.text.trim()) continue;
    rememberTranslation(language, source, entry.text.trim());
  }
}

/**
 * Translates the given Norwegian strings, using the in-memory cache where possible.
 * Returns a plain object mapping source text -> translation. Sources that could not be
 * translated are simply absent, so the caller renders the Norwegian alone.
 */
export async function translatePlanTexts(texts, language) {
  if (!isTranslatableLanguage(language)) return {};

  const sources = [...new Set(texts.map((t) => (typeof t === "string" ? t.trim() : "")))]
    .filter((t) => t && t.length <= MAX_SOURCE_CHARS);

  const missing = sources.filter((t) => !cache.has(cacheKey(language, t)));

  if (missing.length > 0) {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
      // Sequential on purpose: one cleaner tapping this is one request, and firing a dozen
      // parallel model calls per tap is a good way to hit a rate limit on a busy morning.
      await translateBatch(anthropic, language, missing.slice(i, i + BATCH_SIZE));
    }
  }

  const out = {};
  for (const source of sources) {
    const hit = cache.get(cacheKey(language, source));
    if (hit) out[source] = hit;
  }
  return out;
}
