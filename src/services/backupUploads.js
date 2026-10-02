// Speiling av opplastede filer — bildene fra besøkene, dokumentene på lokasjonene, avatarene,
// og etter hvert sikkerhetsdatabladene i kjemikalieregisteret.
//
// Databasen sier at et avvik hadde tre bilder. Uten filene er den setningen verdiløs overfor et
// tilsyn. Derfor hjelper det ikke å kopiere databasen alene — bildene er halve dokumentasjonen,
// og de ligger på den samme ene disken.
//
// TRE EGENSKAPER SOM HENGER SAMMEN, og som er grunnen til at dette ser ut som det gjør:
//
// 1. Filnavnene er tidsstemplede og i praksis uforanderlige — en fil blir skrevet én gang og
//    aldri endret. Da trenger vi ikke sammenligne innhold, bare spørre «finnes nøkkelen?».
// 2. Bøtta har Bucket Lock, som nekter OVERSKRIVING. Å laste opp en fil som allerede ligger der
//    ville altså feilet. «Bare det som mangler» er derfor ikke en optimalisering her, det er et
//    krav.
// 3. Speilingen sletter aldri. Fjernes en fil lokalt, blir kopien liggende. Det er med vilje:
//    dette er en sikkerhetskopi, ikke en synkronisering. En feilaktig sletting lokalt skal
//    kunne hentes tilbake, ikke forplante seg.

import fs from "node:fs";
import path from "node:path";

const PREFIX = "uploads/";

// Innholdstype ut fra endelsen. Ikke for vår egen skyld — vi leser dem aldri gjennom nettleseren
// — men en kopi man må gjette filtypen på i en krisesituasjon er en dårligere kopi.
const TYPES = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".gif": "image/gif", ".heic": "image/heic", ".pdf": "application/pdf",
};

function contentTypeFor(file) {
  return TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
}

// Alle filer under katalogen, som stier relativt til den. Rekursiv fordi avatarene ligger i sin
// egen undermappe (se routes/auth.js) mens resten ligger i rota.
export function localFiles(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir, base = "") => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) out.push({ rel, full, size: fs.statSync(full).size });
    }
  };
  walk(root);
  return out;
}

// Enkel arbeiderpøl. Med tusenvis av filer er serielt for sakte, og «alle på én gang» ville
// åpnet tusenvis av filhåndtak og lesestrømmer på en instans med 512 MB.
async function inParallel(items, limit, worker) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(workers);
}

// Laster opp det som mangler. Returnerer tall, ikke kast: at én fil feiler skal ikke avlyse
// resten av natten — og slett ikke databasekopien, som er den viktigste delen.
export async function mirrorUploads(driver, { uploadsDir, maxPerRun = 5000, concurrency = 6 } = {}) {
  const local = localFiles(uploadsDir);
  if (local.length === 0) return { uploaded: 0, skipped: 0, failed: 0, remaining: 0, bytes: 0 };

  const remote = new Set((await driver.list(PREFIX)).map((o) => o.key));
  const missing = local.filter((f) => !remote.has(PREFIX + f.rel));

  // Taket finnes for den aller første kjøringen. Ligger det 40 000 bilder der fra før, skal ikke
  // natt nummer én prøve å ta alt i ett jafs — speilingen er inkrementell, så den tar igjen over
  // noen netter. Uten taket ville første kjøring kunnet gå inn i neste døgn.
  const batch = missing.slice(0, maxPerRun);

  let uploaded = 0;
  let failed = 0;
  let bytes = 0;
  const errors = [];

  await inParallel(batch, concurrency, async (file) => {
    try {
      await driver.put(PREFIX + file.rel, file.full, contentTypeFor(file.rel));
      uploaded++;
      bytes += file.size;
    } catch (err) {
      failed++;
      if (errors.length < 5) errors.push(`${file.rel}: ${err.message}`);
    }
  });

  return {
    uploaded,
    skipped: local.length - missing.length,
    failed,
    remaining: missing.length - batch.length,
    bytes,
    errors,
  };
}
