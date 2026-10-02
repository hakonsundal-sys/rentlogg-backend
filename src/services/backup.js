// Sikkerhetskopi av databasen.
//
// Hvorfor dette finnes: fram til 2026-10-02 fantes OKVs renholdsdokumentasjon i nøyaktig én kopi
// — SQLite-fila på Renders persistente disk. Render tar et disk-snapshot i døgnet, men deres egen
// dokumentasjon sier rett ut at man IKKE skal gjenopprette et disk-snapshot for en database som
// kjører på disken: snapshotet kan være tatt midt i en skriving, og databasen kan komme tilbake
// korrupt. For et produkt hvis hele verdi er at dokumentasjonen finnes når et tilsyn spør, var
// det ikke godt nok.
//
// Dette er halve løsningen — den som lager en kopi det går an å stole på. Å få kopien VEKK fra
// maskinen er den andre halvdelen (se uploadBackup når lagringsmålet er valgt). En kopi som blir
// liggende på samme disk beskytter mot at vi sletter noe selv, og mot ingenting annet.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import Database from "better-sqlite3";
import { db } from "../db.js";

// VACUUM INTO er den eneste riktige måten å kopiere en SQLite-database som er i bruk.
//
// Å kopiere fila med fs.copyFile() er feil og feiler stille: vi kjører i WAL-modus, så en del av
// de nyeste skrivingene ligger i -wal-fila og ikke i .db-fila ennå. En rå filkopi får med seg en
// database uten de siste transaksjonene, eller — verre — en halvskrevet side. VACUUM INTO tar en
// lesetransaksjon, og skriver ut en komplett og konsistent database med WAL-innholdet innbakt.
// Den defragmenterer på kjøpet, så kopien er som regel mindre enn originalen.
//
// Destinasjonen må ikke finnes fra før; SQLite nekter å skrive over.
export function snapshotDatabase(destPath) {
  if (fs.existsSync(destPath)) fs.rmSync(destPath);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  db.prepare("VACUUM INTO ?").run(destPath);
  return fs.statSync(destPath).size;
}

// En sikkerhetskopi ingen har sjekket er ikke en sikkerhetskopi — den er en antakelse. Verre enn
// ingen kopi, fordi den gir falsk trygghet helt til dagen du trenger den.
//
// Så kopien åpnes og kontrolleres før den sendes noe sted. integrity_check leser gjennom hele
// databasen og verifiserer sidene; foreign_key_check fanger opp referanser som peker i tomme
// luften. Svarer noen av dem noe annet enn «ok», skal kopien kastes og noen varsles — ikke lastes
// opp som om alt var i orden.
// Alt pakkes inn: en tilstrekkelig ødelagt fil får SQLite til å kaste i stedet for å svare, og
// da skal den rapporteres på samme form som en fil som svarer «not ok». Den som varsler skal
// slippe å kjenne forskjellen — begge deler betyr «ikke stol på denne kopien».
export function verifySnapshot(snapshotPath) {
  let copy;
  try {
    copy = new Database(snapshotPath, { readonly: true });
    const integrity = copy.pragma("integrity_check", { simple: true });
    const brokenRefs = copy.pragma("foreign_key_check");
    const tables = copy
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'")
      .get().n;
    return {
      ok: integrity === "ok" && brokenRefs.length === 0 && tables > 0,
      integrity,
      brokenRefs: brokenRefs.length,
      tables,
    };
  } catch (err) {
    return { ok: false, integrity: err.message, brokenRefs: 0, tables: 0 };
  } finally {
    copy?.close();
  }
}

// Gzip før opplasting. En SQLite-fil er for det meste tekst og mye tomrom, så den komprimerer
// kraftig — det er både billigere lagring og kortere overføring fra en 512 MB-instans.
export async function gzipFile(sourcePath, destPath) {
  await pipeline(
    fs.createReadStream(sourcePath),
    zlib.createGzip({ level: 9 }),
    fs.createWriteStream(destPath)
  );
  return fs.statSync(destPath).size;
}

// Filnavnet bærer datoen fordi det er det eneste som betyr noe når man leter etter en kopi under
// press: «den fra før importen gikk galt». Oslo-dato, ikke UTC, av samme grunn som alt annet
// datostemplet i dette systemet.
export function backupFileName(now = new Date()) {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo" }).format(now);
  return `rentlogg-${date}.sqlite.gz`;
}

// Hele den lokale halvdelen: konsistent kopi → kontroll → komprimering. Returnerer stien til den
// ferdige fila, som den som kaller har ansvar for å laste opp og deretter rydde bort.
//
// Mellomlagring i os.tmpdir() med vilje, ikke på /var/data: den disken er den vi betaler for og
// den vi forsøker å redde. Å doble databasestørrelsen der hver natt ville spist av plassen til
// bildene, og i verste fall fylt disken — altså selv forårsaket avbruddet kopien skal verne mot.
export async function createVerifiedBackup({ tmpDir = os.tmpdir(), now = new Date() } = {}) {
  const work = fs.mkdtempSync(path.join(tmpDir, "rentlogg-backup-"));
  const rawPath = path.join(work, "snapshot.sqlite");
  const gzPath = path.join(work, backupFileName(now));

  try {
    const rawBytes = snapshotDatabase(rawPath);
    const check = verifySnapshot(rawPath);
    if (!check.ok) {
      throw new Error(
        `Sikkerhetskopien strøk kontrollen: integrity=${check.integrity}, ` +
          `brutte referanser=${check.brokenRefs}, tabeller=${check.tables}`
      );
    }
    const gzBytes = await gzipFile(rawPath, gzPath);
    fs.rmSync(rawPath);
    return { path: gzPath, workDir: work, rawBytes, gzBytes, tables: check.tables };
  } catch (err) {
    fs.rmSync(work, { recursive: true, force: true });
    throw err;
  }
}
