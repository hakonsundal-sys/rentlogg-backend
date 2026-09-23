// Uploads a finished lesson — slide images, narration audio and narration text — into a course in
// Rentlogg, one language per run.
//
//   node tools/pptx-til-leksjon/last-opp.js leksjon --kurs 4 --sprak no \
//     --api https://rentlogg-backend.onrender.com --epost deg@okv-gruppen.no --passord ...
//
// Hits POST /training/courses/:id/slides, which replaces that language's slides as a unit. If the
// course already had slides in any language, the upload bumps the course version, and everyone who
// signed the older version shows up in the matrix as "signert på en eldre versjon" — so re-uploading
// a lesson because of a typo is not free. Fix the text first, then upload once.
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";

// Strips a byte-order mark before parsing: PowerShell and Notepad both write one, and JSON.parse
// rejects the file outright if it is there.
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
}

const [dir, ...rest] = process.argv.slice(2);
const flag = (name, fallback) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : fallback);

const courseId = flag("--kurs");
const language = flag("--sprak", "no");
const api = flag("--api", "http://localhost:4000");
const email = flag("--epost", process.env.RENTLOGG_EMAIL);
const password = flag("--passord", process.env.RENTLOGG_PASSWORD);

if (!dir || !courseId || !email || !password) {
  console.error(
    "Bruk: node tools/pptx-til-leksjon/last-opp.js <mappe> --kurs <id> [--sprak no] " +
    "[--api <url>] --epost <admin-e-post> --passord <passord>"
  );
  process.exit(1);
}

const manus = readJson(path.join(dir, `manus.${language}.json`));

const loginRes = await fetch(`${api}/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
});
if (!loginRes.ok) {
  console.error(`Innlogging feilet (${loginRes.status}).`);
  process.exit(1);
}
const { token, user } = await loginRes.json();
if (!user.modules?.includes("training")) {
  console.error("Opplæringsmodulen er ikke aktivert for dette firmaet — superbruker må skru den på først.");
  process.exit(1);
}

const form = new FormData();
form.append("language", language);
form.append("slides", JSON.stringify(manus.map((s) => ({ narration_text: s.narration }))));

let images = 0;
let audios = 0;
for (let i = 0; i < manus.length; i++) {
  const slide = manus[i];
  const imagePath = path.join(dir, slide.image);
  if (fs.existsSync(imagePath)) {
    form.append(`image_${i}`, new Blob([fs.readFileSync(imagePath)], { type: "image/png" }), path.basename(imagePath));
    images++;
  } else {
    console.warn(`  ⚠ mangler bilde for lysbilde ${slide.index}`);
  }

  const audioPath = path.join(dir, "lyd", language, `slide-${String(slide.index).padStart(2, "0")}.mp3`);
  if (fs.existsSync(audioPath)) {
    form.append(`audio_${i}`, new Blob([fs.readFileSync(audioPath)], { type: "audio/mpeg" }), path.basename(audioPath));
    audios++;
  }
}

// A lesson with no audio still works — the app shows the slide with its narration written out
// underneath, which is also what someone without headphones ends up reading anyway.
if (audios === 0) console.warn("Ingen lydfiler funnet — leksjonen blir lysbilder med tekst.");

const res = await fetch(`${api}/training/courses/${courseId}/slides`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
  body: form,
});
const body = await res.json();
if (!res.ok) {
  console.error(`Opplasting feilet (${res.status}):`, body.error || body);
  process.exit(1);
}

console.log(
  `Lastet opp ${manus.length} lysbilder (${images} bilder, ${audios} lydfiler) på ${language}.\n` +
  `Kurs: ${body.title} — versjon ${body.version}\n` +
  `Språk nå: ${body.languages.map((l) => `${l.language} (${l.slides})`).join(", ")}`
);
