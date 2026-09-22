// Sjekker at hver relative import i et git-tre faktisk peker på en fil som ligger i SAMME tre.
//
// Hvorfor dette finnes: `node --check` er bare en syntakssjekk av én fil om gangen. Den sier OK til
// `import { x } from "../modules.js"` uten å bry seg om at modules.js ikke er sjekket inn. I ESM er
// en import som ikke kan resolves en hard krasj ved oppstart — altså hele backend nede på Render,
// ikke en enkeltrute som feiler. Med flere parallelle Claude-økter i samme arbeidstre er det lett
// gjort: én økt committer en fil som importerer en fil en annen økt ennå ikke har lagt inn.
//
// Bruk:  node tools/sjekk-importer.mjs [ref]      (ref er default HEAD)
// Exit 0 = alt resolver, exit 1 = minst én import peker i løse lufta.

import { execFileSync } from "node:child_process";

const ref = process.argv[2] || "HEAD";
const git = (...args) => execFileSync("git", args, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });

const filesInTree = new Set(
  git("ls-tree", "-r", "--name-only", ref).split("\n").map((l) => l.trim()).filter(Boolean)
);

const jsFiles = [...filesInTree].filter(
  (f) => /\.(js|mjs|cjs)$/.test(f) && f.startsWith("src/") && !f.includes("node_modules/")
);

// Fanger `from "./x.js"`, bar `import "./x.js"` og dynamisk `import("./x.js")`. Bevisst enkel:
// den skal ta det vanlige tilfellet uten å dra inn en parser som dependency.
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](\.[^"']*)["']/g;

const dirnameOf = (p) => p.slice(0, p.lastIndexOf("/"));

function resolveRelative(fromFile, spec) {
  const parts = (dirnameOf(fromFile) + "/" + spec).split("/");
  const out = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  const base = out.join("/");
  // Node ville prøvd flere endelser; vi gjør det samme, så en manglende .js-endelse i koden ikke
  // rapporteres som en manglende fil.
  for (const cand of [base, base + ".js", base + ".mjs", base + "/index.js"]) {
    if (filesInTree.has(cand)) return cand;
  }
  return null;
}

const missing = [];
for (const file of jsFiles) {
  const source = git("show", `${ref}:${file}`);
  for (const m of source.matchAll(IMPORT_RE)) {
    const spec = m[1];
    if (resolveRelative(file, spec) === null) {
      const line = source.slice(0, m.index).split("\n").length;
      missing.push({ file, line, spec });
    }
  }
}

if (missing.length === 0) {
  console.log(`OK — alle relative importer i ${ref} peker på filer som finnes i samme tre (${jsFiles.length} filer sjekket).`);
  process.exit(0);
}

console.error(`FEIL — ${missing.length} import(er) i ${ref} peker på filer som IKKE ligger i treet.`);
console.error("Backend vil krasje ved oppstart på Render hvis dette pushes.\n");
for (const { file, line, spec } of missing) {
  console.error(`  ${file}:${line}  ->  ${spec}`);
}
console.error("\nSannsynlig årsak: filen finnes lokalt, men er ikke sjekket inn (git status viser den som ??).");
process.exit(1);
