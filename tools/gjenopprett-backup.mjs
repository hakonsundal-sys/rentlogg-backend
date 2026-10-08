// Hent en sikkerhetskopi tilbake.
//
// Dette er halve grunnen til at sikkerhetskopieringen finnes. En kopi ingen har gjenopprettet er
// ikke en sikkerhetskopi, det er en antakelse — og antakelsen ryker alltid på den verste mulige
// dagen. Kjør dette skriptet av og til når ingenting er galt, slik at du har gjort det før.
//
// Bruk:
//   node tools/gjenopprett-backup.mjs --list
//   node tools/gjenopprett-backup.mjs --ut gjenopprettet.sqlite
//   node tools/gjenopprett-backup.mjs --noekkel db/rentlogg-2026-10-01.sqlite.gz --ut i-gaar.sqlite
//
// Miljøvariablene er de samme som serveren bruker (BACKUP_TARGET, BACKUP_S3_*). Skriptet rører
// ALDRI den databasen som er i drift: det skriver til fila du oppgir, og nekter å skrive over en
// som finnes. Å bytte inn den gjenopprettede fila er en manuell handling, med vilje.

// Leser .env som serveren gjør. Uten dette må hver variabel settes på kommandolinja,
// og et verktøy man må huske fem miljøvariabler til, blir ikke brukt når det haster.
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import Database from "better-sqlite3";
import { configuredDriver } from "../src/services/backupStorage.js";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const driver = configuredDriver();
if (!driver) {
  console.error("BACKUP_TARGET er ikke satt. Sett den (og BACKUP_S3_*) slik serveren har dem.");
  process.exit(1);
}

const objects = (await driver.list("db/")).sort((a, b) => (a.key < b.key ? 1 : -1));
if (objects.length === 0) {
  console.error(`Ingen sikkerhetskopier i ${driver.name}. Det er i seg selv et funn.`);
  process.exit(1);
}

if (process.argv.includes("--list")) {
  console.log(`Sikkerhetskopier i ${driver.name}, nyeste først:\n`);
  for (const o of objects) {
    console.log(`  ${o.key}  ${(o.size / 1024).toFixed(0)} kB  ${o.modified?.toISOString?.() ?? ""}`);
  }
  process.exit(0);
}

const key = arg("noekkel", objects[0].key);
const out = arg("ut");
if (!out) {
  console.error("Mangler --ut <fil>. (Eller bruk --list for å se hva som finnes.)");
  process.exit(1);
}
if (fs.existsSync(out)) {
  console.error(`${out} finnes allerede. Velg et annet navn — dette skriptet skriver ikke over.`);
  process.exit(1);
}

console.log(`Henter ${key} fra ${driver.name} …`);
const work = fs.mkdtempSync(path.join(os.tmpdir(), "rentlogg-restore-"));
try {
  const gz = path.join(work, "backup.gz");
  await driver.get(key, gz);
  fs.writeFileSync(out, zlib.gunzipSync(fs.readFileSync(gz)));

  // Samme kontroll som da kopien ble laget. En fil kan ha blitt ødelagt i lagring eller
  // overføring siden den gang, og det skal man få vite nå og ikke etter at den er satt i drift.
  const db = new Database(out, { readonly: true });
  const integrity = db.pragma("integrity_check", { simple: true });
  const tabeller = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n;
  const oppsummering = [
    ["lokasjoner", "sites"],
    ["rom", "rooms"],
    ["besøk", "room_runs"],
    ["avvik", "deviations"],
    ["brukere", "users"],
  ]
    .map(([navn, tabell]) => {
      try {
        return `${navn}: ${db.prepare(`SELECT count(*) AS n FROM ${tabell}`).get().n}`;
      } catch {
        return `${navn}: (mangler)`;
      }
    })
    .join(", ");
  const sisteBesøk = (() => {
    try {
      return db.prepare("SELECT max(started_at) AS d FROM room_runs").get().d ?? "ingen";
    } catch {
      return "ukjent";
    }
  })();
  db.close();

  console.log(`\nSkrevet til ${out}`);
  console.log(`Integritet: ${integrity}`);
  console.log(`Tabeller: ${tabeller}`);
  console.log(`Innhold: ${oppsummering}`);
  console.log(`Siste besøk i kopien: ${sisteBesøk}`);
  if (integrity !== "ok" || tabeller === 0) {
    console.error("\nDENNE KOPIEN ER IKKE I ORDEN. Prøv en eldre nøkkel med --noekkel.");
    process.exit(1);
  }
  console.log(
    "\nFor å ta den i bruk: stopp tjenesten, flytt den gamle fila til side (ikke slett den), " +
      "legg denne på plass som DB_FILE, og start igjen. Husk at -wal og -shm ved siden av den " +
      "gamle fila også må flyttes vekk."
  );
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
