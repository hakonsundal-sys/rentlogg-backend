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
import { configuredDriver } from "./backupStorage.js";
import { mirrorUploads } from "./backupUploads.js";
import { sendEmail } from "./mailer.js";

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
// Klokkeslettet er med, og det er ikke pynt: bøtta har en Bucket Lock på 30 dager (satt
// 2026-10-02), og en lås hindrer OVERSKRIVING like mye som sletting. Med bare dato i navnet
// ville en kjøring nummer to samme døgn — en omstart klokka tre som nullstiller vakten i
// scheduler.js, eller en manuell kjøring — forsøkt å skrive over gårsdagens... dagens objekt, og
// blitt avvist av låsen. Resultatet hadde vært en feilrad og en varsel-e-post for noe som i
// virkeligheten gikk helt fint. Hver kjøring får sitt eget objekt i stedet; 90-dagersregelen
// rydder dem bort uansett hvor mange det ble.
//
// Datoen står fortsatt først, fordi det er den man leter etter under press («den fra før
// importen gikk galt») og fordi det gir riktig sortering på navn alene.
export function backupFileName(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Oslo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `rentlogg-${get("year")}-${get("month")}-${get("day")}T${get("hour")}${get("minute")}.sqlite.gz`;
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

// ── Hele runden: kopier, verifiser, last opp, skriv ned at det skjedde ──────────────────────


const recordStart = db.prepare(
  "INSERT INTO backup_runs (started_at, status) VALUES (datetime('now'), 'running')"
);
const recordDone = db.prepare(
  `UPDATE backup_runs SET finished_at = datetime('now'), status = ?, object_key = ?,
     bytes = ?, tables = ?, error = ?, files_uploaded = ?, files_remaining = ? WHERE id = ?`
);

// Alderen på siste VELLYKKEDE kopi, i timer. Null betyr at det aldri har gått bra.
// Dette er tallet som faktisk betyr noe: at jobben kjørte i natt hjelper ingen hvis den feilet.
export function hoursSinceLastGoodBackup() {
  const row = db
    .prepare("SELECT finished_at FROM backup_runs WHERE status = 'ok' ORDER BY id DESC LIMIT 1")
    .get();
  if (!row?.finished_at) return null;
  const then = Date.parse(`${row.finished_at.replace(" ", "T")}Z`);
  return (Date.now() - then) / 3_600_000;
}

// Et varsel som ikke kan stoppe selve jobben: at vi ikke fikk sendt e-post skal aldri være
// grunnen til at en vellykket kopi rapporteres som mislykket.
async function alert(subject, body) {
  const to = process.env.BACKUP_ALERT_EMAIL;
  if (!to) return;
  try {
    await sendEmail({ to, subject, html: `<pre style="font:13px/1.5 monospace">${body}</pre>` });
  } catch (err) {
    console.error("Klarte ikke sende backup-varsel:", err.message);
  }
}

export async function runBackup({ now = new Date() } = {}) {
  // Oppsettet leses INNENFOR try-blokken, ikke før den. BACKUP_TARGET=s3 med en manglende nøkkel
  // kaster allerede i configuredDriver(), og gjorde man det utenfor ville nettopp den feilen —
  // den mest sannsynlige av alle, en skrivefeil i Render-panelet — vært den ene som verken ble
  // ført i historikken eller varslet om. Feilkonfigurert backup må feile like høylytt som ødelagt
  // backup.
  const runId = recordStart.run().lastInsertRowid;
  let made = null;
  let driver = null;
  try {
    driver = configuredDriver();
    if (!driver) {
      // Ikke en feil: en utvikler som kjører lokalt skal ikke tvinges til å sette opp lagring.
      // I produksjon er fraværet derimot alvorlig, og det er /health som avslører det — derfor
      // ryddes raden bort her, så den ikke teller som en kjøring som «skjedde».
      db.prepare("DELETE FROM backup_runs WHERE id = ?").run(runId);
      return { skipped: true, reason: "BACKUP_TARGET er ikke satt" };
    }
    made = await createVerifiedBackup({ now });
    const key = `db/${path.basename(made.path)}`;
    await driver.put(key, made.path, "application/gzip");
    console.log(`Sikkerhetskopi lastet opp: ${key} (${made.gzBytes} bytes) -> ${driver.name}`);

    // Bildene ETTER databasen, og med egen feilhåndtering. Rekkefølgen er et valg: databasen er
    // den delen som ikke kan gjenskapes fra noe annet, så den skal være i havn før vi bruker tid
    // på tusenvis av filer. Og en speiling som feiler skal ikke gjøre en vellykket databasekopi
    // om til en mislykket kjøring — den skal rapporteres, ikke overskygge.
    let mirror = { uploaded: 0, remaining: 0, failed: 0, errors: [] };
    try {
      mirror = await mirrorUploads(driver, {
        uploadsDir: process.env.UPLOADS_DIR || "uploads",
        maxPerRun: Number(process.env.BACKUP_MAX_FILES_PER_RUN ?? 5000),
      });
      console.log(
        `Bildespeiling: ${mirror.uploaded} lastet opp, ${mirror.skipped} fantes fra før, ` +
          `${mirror.failed} feilet, ${mirror.remaining} igjen til neste kjøring`
      );
    } catch (err) {
      console.error("Bildespeilingen feilet:", err);
      mirror.failed = -1;
      mirror.errors = [err.message];
    }

    recordDone.run("ok", key, made.gzBytes, made.tables, null, mirror.uploaded, mirror.remaining, runId);

    // Varsles separat, nettopp fordi kjøringen står som vellykket: uten dette ville en speiling
    // som feiler hver natt vært helt usynlig bak en grønn databasekopi.
    if (mirror.failed !== 0) {
      await alert(
        "Rentlogg: bildespeilingen feilet (databasekopien gikk bra)",
        `Tidspunkt: ${new Date().toISOString()}\nFeilet: ${mirror.failed}\n` +
          `Lastet opp: ${mirror.uploaded}, igjen: ${mirror.remaining}\n\n${(mirror.errors || []).join("\n")}`
      );
    }
    return { ok: true, key, bytes: made.gzBytes, mirror };
  } catch (err) {
    recordDone.run("failed", null, null, null, String(err.message).slice(0, 500), null, null, runId);
    console.error("Sikkerhetskopiering feilet:", err);
    await alert(
      "Rentlogg: sikkerhetskopieringen feilet",
      `Tidspunkt: ${new Date().toISOString()}\nMål: ${driver?.name ?? "(kunne ikke leses — sjekk BACKUP_*-variablene)"}\n\n${err.stack || err.message}`
    );
    return { ok: false, error: err.message };
  } finally {
    if (made?.workDir) fs.rmSync(made.workDir, { recursive: true, force: true });
  }
}
