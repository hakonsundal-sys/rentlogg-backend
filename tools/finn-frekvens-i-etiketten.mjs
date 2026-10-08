// Finn oppgaver der frekvensen står i ETIKETTEN, men ikke i planen.
//
// Bakgrunnen: importen fra renholdsplanene kunne bare lagre én plan per rom (se
// tools/README.md og minnets notat om Vest-importen). Oppgaver med avvikende frekvens fikk
// derfor et suffiks på navnet i stedet — «Reoler (1x/mnd)», «Garderobeskap (kun tirsdag)» —
// og ingen egen plan.
//
// Konsekvensen er at `isItemDueOn` returnerer true for dem: ingen egen plan betyr «ingen
// ekstra begrensning», ikke «sjelden». En oppgave som skal gjøres én gang i måneden kommer
// opp HVER dag rommet er due, og renholderen får beskjed om å gjøre den hver dag.
//
// Siden den gang har oppgaver fått fem planmoduser av sin egen. Dette skriptet finner
// tilfellene; det RETTER INGENTING. Les lista, bestem hva hver gruppe skal bli, og kjør
// rettingen som et eget, bevisst steg.
//
//   DB_FILE=... node tools/finn-frekvens-i-etiketten.mjs
//   DB_FILE=... node tools/finn-frekvens-i-etiketten.mjs --full   (hver enkelt oppgave)

// Leser .env som serveren gjør. Uten dette må hver variabel settes på kommandolinja,
// og et verktøy man må huske fem miljøvariabler til, blir ikke brukt når det haster.
import "dotenv/config";
import Database from "better-sqlite3";

const dbFile = process.env.DB_FILE || "./data/rentlogg.db";
const full = process.argv.includes("--full");
const db = new Database(dbFile, { readonly: true });

// Suffiksene importen faktisk brukte. Hold lista konservativ: et treff her skal bety «noen
// skrev en frekvens i navnet», ikke «navnet inneholder tilfeldigvis et tall».
const MØNSTRE = [
  { navn: "månedlig", re: /\((?:1x\/mnd|1 x\/mnd|månedlig|en gang i måneden)\)/i },
  { navn: "flere i måneden", re: /\((\d+)x\/mnd\)/i },
  // «kun» må følges av en UKEDAG. «(kun utvendig)» og «(kun utvendig vask)» beskriver omfang,
  // ikke frekvens — de skal gjøres like ofte som resten av rommet, bare mindre grundig. Tre
  // slike ble feilmeldt første gang dette kjørte mot produksjon.
  { navn: "ukentlig/bestemt dag", re: /\(kun (?:man|tirs|ons|tors|fre|lør|søn)[a-zæøå]*(?:\s*\+\s*[a-zæøå]+)*\)/i },
  { navn: "ved behov", re: /\(ved behov\)/i },
  { navn: "sjeldnere enn månedlig", re: /\((?:1x\/år|årlig|kvartal|halvår)[^)]*\)/i },
  { navn: "annen frekvens i navnet", re: /\(\s*\d+\s*x\s*\/\s*(uke|mnd|år)[^)]*\)/i },
];

// En oppgave «har egen plan» hvis noen av de fem modusene er satt. Er ingen satt, arver den
// rommets plan — og det er nettopp det som er feil når navnet lover noe annet.
const oppgaver = db
  .prepare(
    `SELECT i.id, i.label, i.interval_days, i.monthly_weekday, i.monthly_occurrence,
            r.id AS room_id, r.name AS room_name,
            r.interval_days AS room_interval, r.monthly_weekday AS room_monthly,
            (SELECT COUNT(*) FROM room_schedules rs WHERE rs.room_id = r.id) AS room_weekdays,
            s.id AS site_id, s.name AS site_name, c.name AS company_name,
            (SELECT COUNT(*) FROM room_checklist_item_weekdays w WHERE w.item_id = i.id) AS n_weekdays,
            (SELECT COUNT(*) FROM room_checklist_item_months m WHERE m.item_id = i.id) AS n_months
       FROM room_checklist_items i
       JOIN rooms r ON r.id = i.room_id
       JOIN sites s ON s.id = r.site_id
       JOIN companies c ON c.id = s.company_id
      ORDER BY c.name, s.name, r.name, i.sort_order`
  )
  .all();

const harEgenPlan = (o) =>
  o.interval_days != null || o.monthly_weekday != null || o.n_weekdays > 0 || o.n_months > 0;

const treff = [];
for (const o of oppgaver) {
  const m = MØNSTRE.find((p) => p.re.test(o.label));
  if (!m) continue;
  if (harEgenPlan(o)) continue; // navnet lover noe, OG planen holder det — i orden
  treff.push({ ...o, gruppe: m.navn });
}

console.log(`Base: ${dbFile}`);
console.log(`Oppgaver totalt: ${oppgaver.length}`);
console.log(`Frekvens i navnet UTEN egen plan: ${treff.length}\n`);

if (treff.length === 0) {
  console.log("Ingenting å rette.");
  process.exit(0);
}

const perGruppe = new Map();
for (const t of treff) perGruppe.set(t.gruppe, (perGruppe.get(t.gruppe) || 0) + 1);
console.log("Per gruppe:");
for (const [g, n] of [...perGruppe].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${g}`);
}

const perLokasjon = new Map();
for (const t of treff) {
  const k = `${t.company_name} · ${t.site_name}`;
  perLokasjon.set(k, (perLokasjon.get(k) || 0) + 1);
}
console.log("\nPer lokasjon:");
for (const [k, n] of [...perLokasjon].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${k}`);
}

// Hvor ofte vises de i praksis? En oppgave i et rom uten romplan vises aldri; en i et rom med
// fem dager i uka vises fem ganger i uka. Det er det tallet som sier hvor vondt det gjør.
// Rommets plan avgjør hvor ofte oppgaven faktisk dukker opp: ukedager teller direkte,
// intervall gir ca. 7/N dager i uka, månedsmodus ca. 0,25.
const synligeDagerPerUke = (t) => {
  if (t.room_weekdays > 0) return t.room_weekdays;
  if (t.room_interval != null) return Math.round((7 / t.room_interval) * 10) / 10;
  if (t.room_monthly != null) return 0.25;
  return 0;
};
const verst = treff
  .map((t) => ({ ...t, dager: synligeDagerPerUke(t) }))
  .sort((a, b) => b.dager - a.dager)
  .slice(0, 15);
console.log("\nVises oftest (dager per uke renholderen ser dem):");
for (const t of verst) {
  console.log(`  ${String(t.dager)}x/uke  ${t.site_name} · ${t.room_name} · ${t.label}  [id ${t.id}]`);
}

if (full) {
  console.log("\n--- alle treff ---");
  for (const t of treff) {
    console.log(`${t.id}\t${t.gruppe}\t${t.company_name}\t${t.site_name}\t${t.room_name}\t${t.label}`);
  }
} else {
  console.log("\n(--full lister hver enkelt oppgave)");
}
