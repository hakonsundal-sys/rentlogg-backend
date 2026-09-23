// Sjekker at hver SQL-spørring i et git-tre bare rører tabeller som faktisk finnes i SAMME tre.
//
// Søsterskript til sjekk-importer.mjs, og finnes av samme grunn: `node --check` ser bare syntaks,
// og sjekk-importer.mjs ser bare *filer*. Ingen av dem oppdager at en fil spør etter en tabell som
// aldri ble committet. Det er den samme fella én etasje ned — én økt committer en sporet rutefil,
// mens tabellene den bruker ligger igjen i en annen økts uncommittede schema.sql, og ruta kaster
// «no such table» i produksjon. Verifisert 2026-09-23: routes/uploads.js i arbeidstreet spurte
// etter fire training-tabeller som ikke var committet, og sjekk-importer.mjs sa blankt OK.
//
// Bruk:  node tools/sjekk-tabeller.mjs [ref]      (ref er default HEAD)
// Exit 0 = alle tabeller finnes, exit 1 = minst én spørring peker på en tabell som ikke er der.

import { execFileSync } from "node:child_process";

const ref = process.argv[2] || "HEAD";
const git = (...args) => execFileSync("git", args, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });

const filesInTree = git("ls-tree", "-r", "--name-only", ref).split("\n").map((l) => l.trim()).filter(Boolean);
const jsFiles = filesInTree.filter((f) => /\.(js|mjs)$/.test(f) && f.startsWith("src/") && !f.includes("node_modules/"));

// Plukker ut strengliteraler ved å gå gjennom kildekoden tegn for tegn. Bevisst en scanner og ikke
// et regex: et regex som skal håndtere escapede anførselstegn blir en vegg av backslasher som ikke
// overlever å bli skrevet til fil, og den feilen er stille — regexet slutter bare å matche, og
// porten sier «OK» til alt. En scanner kan leses høyt.
//
// Vi leser bare strenger, aldri rå filtekst, ellers ville en kommentar som nevner
// «SELECT ... FROM training_records» blitt rapportert som en ekte spørring.
function stringLiterals(src) {
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    // Hopp over kommentarer, så en apostrof i norsk prosa ikke starter en falsk streng.
    if (ch === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (ch === "/" && src[i + 1] === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i++; continue; }

    if (ch !== "`" && ch !== "'" && ch !== '"') continue;

    const quote = ch;
    const start = i;
    i++;
    let value = "";
    while (i < src.length) {
      if (src[i] === "\\") { i += 2; continue; }            // escapet tegn: hopp over begge
      if (src[i] === quote) break;
      if (quote !== "`" && src[i] === "\n") break;           // ' og " kan ikke gå over linjeskift
      value += src[i];
      i++;
    }
    out.push({ value, index: start });
  }
  return out;
}

const LOOKS_LIKE_SQL = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|CREATE\s+INDEX)\b/i;

const sources = new Map(jsFiles.map((f) => [f, git("show", `${ref}:${f}`)]));
const sqlPerFile = new Map();
for (const [file, src] of sources) {
  sqlPerFile.set(file, stringLiterals(src).filter((s) => LOOKS_LIKE_SQL.test(s.value)));
}

// SQLite gir disse gratis; de står aldri i schema.sql.
const known = new Set(["sqlite_master", "sqlite_sequence", "sqlite_temp_master"]);

// Tabellene skjemaet definerer.
const schemaFile = filesInTree.find((f) => f.endsWith("src/schema.sql"));
const schemaSql = schemaFile ? git("show", `${ref}:${schemaFile}`) : "";
for (const m of schemaSql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)/gi)) known.add(m[1]);

// Tabeller koden lager selv underveis: db.js sine migrasjoner bygger midlertidige *_new-tabeller og
// døper dem om, og en spørring kan definere sin egen CTE. Begge deler er ekte navn som aldri står i
// schema.sql, så de må regnes som kjente før vi begynner å klage.
for (const found of sqlPerFile.values()) {
  for (const s of found) {
    for (const c of s.value.matchAll(/CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)/gi)) known.add(c[1]);
    for (const c of s.value.matchAll(/ALTER\s+TABLE\s+"?(\w+)"?\s+RENAME\s+TO\s+"?(\w+)/gi)) known.add(c[2]);
    for (const c of s.value.matchAll(/\bWITH\s+(?:RECURSIVE\s+)?(\w+)\s+AS\s*\(/gi)) known.add(c[1]);
    for (const c of s.value.matchAll(/,\s*(\w+)\s+AS\s*\(\s*SELECT/gi)) known.add(c[1]);
  }
}

// Hvor en tabell faktisk refereres. Et interpolert navn (`FROM ${t}`) matcher ikke \w og hoppes
// over av seg selv, og det samme gjør en avledet tabell (`FROM (SELECT ...)`).
const REFS = [
  /\bFROM\s+"?(\w+)/gi,
  /\bJOIN\s+"?(\w+)/gi,
  /\bINSERT\s+INTO\s+"?(\w+)/gi,
  /\bUPDATE\s+"?(\w+)/gi,
  /\bALTER\s+TABLE\s+"?(\w+)/gi,
  /\bCREATE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\w+\s+ON\s+"?(\w+)/gi,
];
// Nøkkelord som kan stå der et tabellnavn ellers ville stått.
const NOT_A_TABLE = new Set(["select", "set", "values", "pragma"]);

const missing = [];
for (const [file, found] of sqlPerFile) {
  for (const s of found) {
    for (const re of REFS) {
      for (const r of s.value.matchAll(re)) {
        const name = r[1];
        if (NOT_A_TABLE.has(name.toLowerCase()) || known.has(name)) continue;
        const line = sources.get(file).slice(0, s.index).split("\n").length;
        missing.push({ file, line, name });
      }
    }
  }
}

const unique = [...new Map(missing.map((r) => [`${r.file}:${r.name}`, r])).values()];

if (unique.length === 0) {
  console.log(`OK — alle tabeller i ${ref} sine spørringer finnes i samme tre (${jsFiles.length} filer, ${known.size} kjente tabeller).`);
  process.exit(0);
}

console.error(`FEIL — ${unique.length} spørring(er) i ${ref} peker på tabeller som IKKE finnes i treets schema.sql.`);
console.error("Rutene kaster «no such table» i produksjon hvis dette pushes.\n");
for (const { file, line, name } of unique) console.error(`  ${file}:${line}  ->  ${name}`);
console.error("\nSannsynlig årsak: tabellen ligger i en annen økts uncommittede schema.sql.");
process.exit(1);
