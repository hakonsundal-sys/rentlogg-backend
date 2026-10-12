// Se hva en rapport blir, uten å sende den til noen.
//
// Dagsrapporten og Sjekk det-digesten er det eneste av systemet en kunde leser hver dag, og det
// eneste vi ikke kunne se på før det lå i innboksen deres. Dette skriptet rendrer de SAMME
// funksjonene som e-posten bruker — `buildReportBody` og `digestHtml` — til én HTML-fil du kan
// åpne i en nettleser.
//
// Det sender ingenting og skriver ingenting til basen. Basen åpnes read-only.
//
//   node tools/forhandsvis-rapport.mjs                      oppdiktet besøk + digest
//   node tools/forhandsvis-rapport.mjs --besok 4821         et ekte besøk fra DB_FILE
//   node tools/forhandsvis-rapport.mjs --digest 1 --dato 2026-10-08
//   node tools/forhandsvis-rapport.mjs --ut /tmp/rapport.html
//
// Standardkjøringen er den som er verdt mest: testdataene nedenfor treffer med vilje alt som er
// vondt å få satt opp i en ekte base — en oppgave som IKKE er gjort, en måling utenfor grense og
// en innenfor, et hygienetrinn med kontakttid, et flervalg, et notat, et avvik med svar og frist,
// en virtuell dag uten besøksnummer, og en bakdatert innsjekk.
//
// Nederst kjøres fire regresjonsvakter mot det rendrede resultatet. De er der fordi hver av dem
// har vært en ekte feil:
//   * bildebytene lå inne TO ganger (47 kB mot 32 kB for tre bilder — Gmail klipper rundt 100 kB)
//   * `display:flex` ignoreres av Outlook, så statusen falt ned under oppgavenavnet
//   * «Besøk null» på en virtuell dag
//   * gamle hardkodede farger fra tiden før src/brand.js
//
// MERK: dette er ingen Outlook-test. Den eneste måten å vite hvordan Word-motoren tegner noe, er
// å sende en e-post til en Outlook-konto og se på den.

import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

import { buildReportBody } from "../src/services/runReport.js";
import { mailShell } from "../src/brand.js";

function arg(navn, fallback = null) {
  const i = process.argv.indexOf(`--${navn}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}

const utFil = arg("ut", "rapport-forhandsvisning.html");
const besokId = arg("besok");
const digestFirma = arg("digest");

// ---------------------------------------------------------------------------- plassholderbilder
// Ekte opplastinger ligger ikke nødvendigvis på maskinen din, og uten bilder ser man ikke om
// bilderaden brytes riktig — som er nettopp det som var feil. Tre tydelige plassholdere lages i
// en midlertidig mappe, UPLOADS_DIR peker dit mens vi rendrer, og mappa slettes etterpå.
async function lagPlassholdere(mappe) {
  const specs = [
    ["foto-1.jpg", "#cdd7e6", "#8da3bf", "Skjærebord"],
    ["foto-2.jpg", "#d6cfe8", "#a497c9", "Gulv og sluk"],
    ["foto-3.jpg", "#cfe0d4", "#95bda2", "Transportbånd"],
  ];
  for (const [navn, a, b, tekst] of specs) {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>` +
      `<rect width="600" height="600" fill="url(#g)"/>` +
      `<text x="300" y="312" text-anchor="middle" font-family="Arial" font-size="38" fill="#fff" opacity="0.92">${tekst}</text>` +
      `<text x="300" y="356" text-anchor="middle" font-family="Arial" font-size="22" fill="#fff" opacity="0.7">plassholder</text>` +
      `</svg>`;
    await sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toFile(path.join(mappe, navn));
  }
  return specs.map(([n]) => n);
}

// ---------------------------------------------------------------------------- testdata
// Formene er getRunDetail sin og buildChecklistDigest sin. Endrer de seg, skal dette brekke —
// det er halve poenget med å ha dem her og ikke i en fixture-fil ingen leser.
const TEST_BESOK = {
  id: 4821,
  site_name: "Nordvik Foods AS",
  site_address: "Havnegata 14, 7010 Trondheim",
  client_name: "Nordvik Foods",
  cleaner_name: "Turid Hagen",
  started_at: "2026-10-08 06:31:00",
  completed_at: "2026-10-08 09:04:00",
  signed_initials: "TH",
  backdated: false,
  rooms: [
    {
      name: "Skjærerom 1",
      responsible: "company",
      note: "Sluket i hjørnet lukter. Spylt ekstra, bør ses på av vaktmester.",
      photos: [{ file_path: "foto-1.jpg" }, { file_path: "foto-2.jpg" }],
      items: [
        { label: "Gulv og sluk", done: true, step_type: "clean" },
        {
          label: "Skjærebord",
          done: true,
          step_type: "disinfect",
          concentration: "1 %",
          contact_seconds: 600,
          contact_started_at: "2026-10-08 07:12:00",
        },
        { label: "ATP-måling, skjærebord", done: true, measure_unit: "RLU", measured_value: 318, measure_label: "grense 150", verdict: "fail" },
        {
          label: "Såpe i dispenser",
          done: true,
          options: [
            { label: "Klorbasert", selected: false },
            { label: "Alkalisk", selected: true },
          ],
        },
        { label: "Vegger over 2 m", done: false },
      ],
    },
    {
      name: "Pakkeri",
      responsible: "company",
      note: null,
      photos: [{ file_path: "foto-3.jpg" }],
      items: [
        { label: "Transportbånd", done: true },
        { label: "Gulv", done: true },
        { label: "Pallerom", done: true, measure_unit: "°C", measured_value: 3.4, measure_label: "maks 4", verdict: "pass" },
      ],
    },
  ],
  deviations: [
    {
      id: 991,
      room_name: "Kjølerom 2",
      room_responsible: "company",
      room_task_label: "Gulv og sluk",
      priority: "high",
      description: "Kondens i taket drypper ned på pallene under. Ikke renholdsrelatert.",
      reported_by_initials: "TH",
      due_date: "2026-10-10",
      photos: [],
      reply_text: "Varslet teknisk. Vifte byttes fredag.",
      replied_by_initials: "BL",
    },
  ],
};

const TEST_DIGEST = {
  date: "2026-10-08",
  planned: [
    { name: "Åpning kjøkken", done: true },
    { name: "Temperaturkontroll kjøl", done: true },
    { name: "Stenging kjøkken", done: false },
    { name: "Brannvernrunde (ukentlig)", done: true },
  ],
  submissions: [{}, {}, {}],
  deviations: [
    {
      checklist_name: "Stenging kjøkken",
      label: "Fettfilter rengjort",
      comment: "Filteret er tett, rekker ikke i kveld. Meldt til Ola.",
      user_name: "Sofie Hippsley",
      followup_at: null,
      followup_by_name: null,
      measure_unit: null,
      measured_value: null,
    },
    {
      checklist_name: "Temperaturkontroll kjøl",
      label: "Kjøl 2",
      comment: "Over grensen hele morgenen.",
      user_name: "Ola Nordmann",
      followup_at: "2026-10-08 14:02:00",
      followup_by_name: "Birthe Larsen",
      measure_unit: "°C",
      measured_value: 7.1,
    },
  ],
  openTotal: 3,
};

// ---------------------------------------------------------------------------- kjør
const arbeid = fs.mkdtempSync(path.join(os.tmpdir(), "rentlogg-forhandsvis-"));
const ruter = [];

try {
  await lagPlassholdere(arbeid);
  process.env.UPLOADS_DIR = arbeid;

  if (besokId) {
    // Ekte besøk. db.js importeres først her, slik at standardkjøringen ikke trenger en base.
    const { getRunDetail } = await import("../src/services/runDetail.js");
    const detail = getRunDetail(Number(besokId));
    if (!detail) {
      console.error(`Fant ingen besøk med id ${besokId} i ${process.env.DB_FILE || "./data/rentlogg.db"}.`);
      process.exit(1);
    }
    ruter.push([`Besøk ${besokId} — ${detail.site_name}`, mailShell(await buildReportBody(detail))]);
  } else if (digestFirma) {
    const { db } = await import("../src/db.js");
    const { buildChecklistDigest, digestHtml } = await import("../src/services/checklistDigest.js");
    const firma = db.prepare("SELECT name FROM companies WHERE id = ?").get(Number(digestFirma));
    if (!firma) {
      console.error(`Fant ingen firma med id ${digestFirma}.`);
      process.exit(1);
    }
    const dato = arg("dato", new Date().toISOString().slice(0, 10));
    ruter.push([`Digest — ${firma.name} ${dato}`, digestHtml(firma.name, buildChecklistDigest(Number(digestFirma), dato))]);
  } else {
    const { digestHtml } = await import("../src/services/checklistDigest.js");
    ruter.push(
      ["Besøksrapport", mailShell(await buildReportBody(TEST_BESOK))],
      ["Sjekk det-digest", digestHtml("OKV Næringsmiddelservice AS", TEST_DIGEST)],
      // Virtuell dag: getVirtualDayDetail gir id = null, og rapporten skal da utelate
      // besøksnummeret i stedet for å skrive «Besøk null».
      [
        "Virtuell dag — ingen id, ikke ferdigstilt",
        mailShell(await buildReportBody({ ...TEST_BESOK, id: null, completed_at: null, signed_initials: null })),
      ],
      // Bakdatert innsjekk MÅ si fra om seg selv: datoen rapporten står under er ikke dagen
      // renholderen faktisk var der.
      ["Bakdatert innsjekk", mailShell(await buildReportBody({ ...TEST_BESOK, backdated: true }))],
      // Et besøk uten bilder og uten avvik er det vanligste tilfellet, og det som lettest blir
      // stygt når man bare har designet det fulle.
      [
        "Uten bilder og uten avvik",
        mailShell(
          await buildReportBody({
            ...TEST_BESOK,
            deviations: [],
            rooms: TEST_BESOK.rooms.map((r) => ({ ...r, photos: [], note: null })),
          })
        ),
      ]
    );
  }
} finally {
  fs.rmSync(arbeid, { recursive: true, force: true });
}

const side = `<!doctype html>
<html lang="nb"><head><meta charset="utf-8"><title>Rentlogg — rapportforhåndsvisning</title>
<style>
 body{margin:0;background:#f4f3f8;color:#17151f;font:15px/1.6 system-ui,"Segoe UI",sans-serif;}
 h1{font-size:21px;margin:0;padding:20px 26px;background:#fff;border-bottom:1px solid #e7e3f2;letter-spacing:-0.02em;}
 h1 span{font-weight:400;color:#6e6a7a;font-size:14px;}
 main{padding:22px 26px 60px;display:grid;grid-template-columns:repeat(auto-fit,minmax(440px,1fr));gap:18px;}
 .c{background:#fff;border:1px solid #e7e3f2;border-radius:13px;overflow:hidden;}
 .cap{padding:10px 15px;border-bottom:1px solid #e7e3f2;font-size:13px;font-weight:650;
      display:flex;justify-content:space-between;gap:12px;}
 .cap em{font-style:normal;font-weight:400;color:#6e6a7a;font-size:12px;white-space:nowrap;}
 iframe{width:100%;height:840px;border:0;display:block;background:#fff;}
</style></head>
<body>
<h1>Rapportforhåndsvisning <span>— samme funksjoner som e-posten bruker. Ingenting er sendt.</span></h1>
<main>
${ruter
  .map(
    ([tittel, html]) =>
      `<div class="c"><div class="cap"><span>${tittel}</span><em>${Math.round(html.length / 1024)} kB</em></div>` +
      `<iframe sandbox="allow-same-origin" srcdoc="${html.replace(/"/g, "&quot;")}"></iframe></div>`
  )
  .join("\n")}
</main></body></html>`;

fs.writeFileSync(utFil, side);
console.log(`Skrevet: ${path.resolve(utFil)}`);
console.log(`${ruter.length} rapport(er). Åpne fila i en nettleser.\n`);

// ---------------------------------------------------------------------------- regresjonsvakter
const alt = ruter.map(([, h]) => h).join("");
const bilder = (alt.match(/<img /g) || []).length;
const innleiringer = (alt.match(/data:image\/jpeg;base64/g) || []).length;
const GAMLE_FARGER = ["#c0392b", "#0a7a2f", "#a1a1aa", "#efefef", "#18181b", "#1a1a1a", "#f1b0b7", "#fdecea", "#611a15"];
const funnetGammel = GAMLE_FARGER.filter((c) => alt.includes(c));

const vakter = [
  [innleiringer === bilder, `bildebytene ligger inne én gang per bilde (${innleiringer} for ${bilder})`],
  [!alt.includes("display:flex"), "ingen display:flex (Outlook ignorerer den)"],
  [!alt.includes("Besøk null"), "ingen «Besøk null» på virtuell dag"],
  [funnetGammel.length === 0, `ingen farger utenfor src/brand.js${funnetGammel.length ? ` — fant ${funnetGammel.join(", ")}` : ""}`],
];

let feil = 0;
for (const [ok, tekst] of vakter) {
  console.log(`  ${ok ? "OK  " : "FEIL"}  ${tekst}`);
  if (!ok) feil++;
}
process.exit(feil ? 1 : 0);
