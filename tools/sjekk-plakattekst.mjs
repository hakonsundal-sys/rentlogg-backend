// Holder plakatteksten i backend i takt med frontendens locale-filer.
//
// Hvorfor dette finnes: den trykte QR-plakaten bruker nøyaktig de samme setningene som
// «Kom i gang»-kortet i appen (cleaner.onboarding.title og step1-3). Appen leser dem fra
// src/locales/<kode>.json i frontend-repoet; plakaten lages i backend, som ikke kan lese de
// filene — repoene deployes hver for seg. Kopien i src/utils/posterText.json er derfor avledet,
// ikke original, og uten en port driver de to fra hverandre uten at noen merker det: teksten i
// appen endres, plakaten på veggen fortsetter å si det gamle.
//
// Bruk:  node tools/sjekk-plakattekst.mjs           exit 1 hvis de er i utakt
//        node tools/sjekk-plakattekst.mjs --fiks    skriver posterText.json på nytt fra locale-filene
//
// Hopper over med exit 0 hvis frontend-repoet ikke ligger ved siden av (Render har det ikke).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SUPPORTED_LANGUAGES } from "../src/utils/languages.js";

const HER = path.dirname(fileURLToPath(import.meta.url));
const FASIT = path.join(HER, "..", "src", "utils", "posterText.json");
const LOCALES = path.join(HER, "..", "..", "rentlogg-frontend", "src", "locales");
const FIKS = process.argv.includes("--fiks");

if (!fs.existsSync(LOCALES)) {
  console.log(`Hopper over: fant ikke ${LOCALES} (frontend-repoet ligger ikke ved siden av).`);
  process.exit(0);
}

// Locale-strengene er nummererte ("1. Skann QR-koden ..."), men plakaten setter dem i en <ol>
// som nummererer selv. Uten dette ville arket sagt "1. 1. Skann ...".
const utenNummer = (s) => String(s).replace(/^\s*\d+\.\s*/, "");

const fraLocales = {};
const mangler = [];
for (const kode of SUPPORTED_LANGUAGES) {
  const fil = path.join(LOCALES, `${kode}.json`);
  if (!fs.existsSync(fil)) { mangler.push(`${kode}.json finnes ikke`); continue; }
  const json = JSON.parse(fs.readFileSync(fil, "utf8"));
  const title = json["cleaner.onboarding.title"];
  const steps = [1, 2, 3].map((n) => json[`cleaner.onboarding.step${n}`]);
  if (!title || steps.some((s) => !s)) { mangler.push(`${kode}: mangler cleaner.onboarding.title/step1-3`); continue; }
  fraLocales[kode] = { title, steps: steps.map(utenNummer) };
}
if (mangler.length) {
  console.error("FEIL — kildeteksten er ufullstendig:");
  mangler.forEach((m) => console.error("  " + m));
  process.exit(1);
}

const naa = JSON.parse(fs.readFileSync(FASIT, "utf8"));
const avvik = [];
for (const kode of SUPPORTED_LANGUAGES) {
  const a = naa[kode];
  const b = fraLocales[kode];
  if (!a) { avvik.push(`${kode}: mangler helt i posterText.json`); continue; }
  if (a.title !== b.title) avvik.push(`${kode}.title: «${a.title}» vs locale «${b.title}»`);
  b.steps.forEach((s, i) => {
    if (a.steps?.[i] !== s) avvik.push(`${kode}.steps[${i}]: «${a.steps?.[i]}» vs locale «${s}»`);
  });
}
// Et språk som ligger igjen i kopien etter at det er fjernet fra appen, er også utakt.
for (const kode of Object.keys(naa)) {
  if (kode !== "_" && !SUPPORTED_LANGUAGES.includes(kode)) avvik.push(`${kode}: finnes i posterText.json, men ikke i SUPPORTED_LANGUAGES`);
}

if (avvik.length === 0) {
  console.log(`OK — plakatteksten er i takt med locale-filene (${SUPPORTED_LANGUAGES.length} språk).`);
  process.exit(0);
}

if (FIKS) {
  const ut = { _: naa._ };
  for (const kode of SUPPORTED_LANGUAGES) ut[kode] = fraLocales[kode];
  fs.writeFileSync(FASIT, JSON.stringify(ut, null, 2) + "\n");
  console.log(`Skrev posterText.json på nytt fra locale-filene (${avvik.length} avvik rettet).`);
  process.exit(0);
}

console.error(`FEIL — plakatteksten og locale-filene er i utakt (${avvik.length}):\n`);
avvik.forEach((a) => console.error("  " + a));
console.error("\nKjør `node tools/sjekk-plakattekst.mjs --fiks` for å skrive kopien på nytt.");
process.exit(1);
