// Turns the raw slide text eksporter.ps1 pulled out of a PowerPoint into spoken narration — first
// in plain Norwegian, then translated into the languages OKV's cleaners actually read.
//
// Writes one file per language and stops there, on purpose. The narration is what a person will
// hear and then sign for, so it gets read by a human before any audio is made of it — the same
// rule transform.js follows next door: the printout is the point of the step.
//
//   node tools/pptx-til-leksjon/manus.js leksjon --sprak no,lt,ru
//
// ESM, not CommonJS: this repo's package.json sets "type": "module".
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

// Strips a byte-order mark before parsing: PowerShell and Notepad both write one, and JSON.parse
// rejects the file outright if it is there.
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
}

const LANGUAGE_NAMES = {
  no: "Norwegian (bokmål)",
  en: "English",
  lt: "Lithuanian",
  lv: "Latvian",
  ru: "Russian",
};

const [dir, ...rest] = process.argv.slice(2);
if (!dir) {
  console.error("Bruk: node tools/pptx-til-leksjon/manus.js <mappe> [--sprak no,lt,ru]");
  process.exit(1);
}

const languagesArg = rest.includes("--sprak") ? rest[rest.indexOf("--sprak") + 1] : "no";
const languages = languagesArg.split(",").map((l) => l.trim()).filter(Boolean);
for (const lang of languages) {
  if (!LANGUAGE_NAMES[lang]) {
    console.error(`Ukjent språk: ${lang}. Gyldige: ${Object.keys(LANGUAGE_NAMES).join(", ")}`);
    process.exit(1);
  }
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY mangler i .env — den trengs for å skrive og oversette manuset.");
  process.exit(1);
}

const source = readJson(path.join(dir, "manus.json"));
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const NARRATION_TOOL = {
  name: "submit_narration",
  description: "Leverer ferdig manus, ett innslag per lysbilde, i samme rekkefølge som de kom inn.",
  input_schema: {
    type: "object",
    properties: {
      slides: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "integer", description: "Lysbildenummeret dette manuset hører til." },
            narration: { type: "string", description: "Det som skal leses opp for dette lysbildet." },
          },
          required: ["index", "narration"],
        },
      },
    },
    required: ["slides"],
  },
};

// One call, for a chosen set of slides. `only` narrows it to the slides that need redoing, so the
// untranslated-slide retry below doesn't pay for the nine that came back fine.
async function askModel(language, slides) {
  const isSource = language === "no";
  const instruction = isSource
    ? "Write the spoken narration for each slide of a cleaning-company training lesson, in plain " +
      "Norwegian bokmål. The audience is professional cleaners, many of whom are not native " +
      "Norwegian speakers: use short sentences, everyday words, and the imperative where something " +
      "must actually be done. Two to four sentences per slide. Say what the slide shows — never " +
      "read bullet points aloud verbatim, and never add rules or facts that are not in the source."
    : `Translate the spoken narration below into ${LANGUAGE_NAMES[language]}. EVERY sentence of ` +
      `every slide must come back in ${LANGUAGE_NAMES[language]} — never leave a sentence, or a ` +
      "whole slide, in the Norwegian it arrived in. Keep it simple and spoken, the way a colleague " +
      "would explain it on the floor — not a formal written register. Keep every instruction exactly " +
      "as strict or as loose as the original: this is training people sign for. Do not add or remove " +
      "anything. Proper nouns (place names, product names) stay as they are.";

  const message = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 8192,
    tools: [NARRATION_TOOL],
    tool_choice: { type: "tool", name: "submit_narration" },
    messages: [
      {
        role: "user",
        content: `${instruction}\n\nLesson: ${source.title}\n\n${JSON.stringify(slides, null, 2)}`,
      },
    ],
  });

  const result = message.content.find((block) => block.type === "tool_use")?.input;
  if (!result?.slides) throw new Error(`Fikk ikke manus tilbake for ${language}.`);
  return new Map(result.slides.map((s) => [s.index, String(s.narration || "").trim()]));
}

async function writeNarration(language) {
  const isSource = language === "no";
  const input = source.slides.map((slide) => ({
    index: slide.index,
    title: slide.title,
    text: isSource ? slide.raw : norwegian.get(slide.index),
  }));

  const byIndex = await askModel(language, input);

  // Caught on a real deck 2026-09-23: one slide in ten came back verbatim in Norwegian while the
  // other nine translated fine. Nothing downstream would have noticed — it would simply have been
  // read aloud in the wrong language to someone who does not speak it. Cheap to detect, so detect
  // it: retry just the slides that did not move, then say so plainly if they still have not.
  if (!isSource) {
    const untouched = input.filter((s) => byIndex.get(s.index) === s.text);
    if (untouched.length > 0) {
      process.stdout.write(`(${untouched.length} uoversatt, prøver igjen) `);
      const retry = await askModel(language, untouched);
      for (const [index, text] of retry) byIndex.set(index, text);
    }
    const stillUntouched = input.filter((s) => byIndex.get(s.index) === s.text).map((s) => s.index);
    if (stillUntouched.length > 0) {
      console.warn(`\n  ⚠ lysbilde ${stillUntouched.join(", ")} kom tilbake på norsk — oversett for hånd.`);
    }
  }

  const out = source.slides.map((slide) => ({
    index: slide.index,
    image: slide.image,
    narration: byIndex.get(slide.index) || "",
  }));

  const missing = out.filter((s) => !s.narration).map((s) => s.index);
  if (missing.length) console.warn(`  ⚠ mangler manus for lysbilde ${missing.join(", ")} — fyll inn for hånd.`);

  fs.writeFileSync(path.join(dir, `manus.${language}.json`), `${JSON.stringify(out, null, 2)}\n`, "utf8");
  return out;
}

// Norwegian is written first and every other language is translated from it, not from the raw
// slide text: the tightening step is where "three bullet points" becomes something a person can
// actually say, and doing that independently per language would give five lessons that quietly
// say different things.
const norwegian = new Map();
if (!languages.includes("no")) languages.unshift("no");

for (const language of languages) {
  process.stdout.write(`${language} … `);
  const out = await writeNarration(language);
  if (language === "no") out.forEach((s) => norwegian.set(s.index, s.narration));
  console.log(`${out.length} lysbilder → manus.${language}.json`);
}

console.log(
  "\nLes gjennom manus.<språk>.json før du lager tale av det. Det er dette de ansatte hører\n" +
  "og signerer på, og det er billigere å rette her enn etter at lyden er laget."
);
