// Bygger et hygienekurs i samme form som tools/pptx-til-leksjon leverer: lysbilder som PNG plus
// manus.no.json, klart for last-opp.js. Skrevet for hånd fordi det ikke finnes noen PowerPoint å
// kjøre gjennom ennå — innholdet er vanlig næringsmiddelhygiene, og Håkon må lese det før noen
// tildeles kurset.
import sharp from "file:///C:/Users/hawko/Downloads/rentlogg-backend/rentlogg-backend/node_modules/sharp/dist/index.mjs";
import fs from "node:fs";
import path from "node:path";

const OUT = path.dirname(new URL(import.meta.url).pathname.slice(1));

const SLIDES = [
  {
    title: "Hvorfor hygiene",
    points: ["Vi vasker der det lages mat", "Bakterier følger hender, kluter og sko", "Jobben vår er å stoppe dem"],
    narration:
      "Vi vasker på steder der det lages mat. Bakterier ser du ikke, men de følger med hender, kluter og sko fra ett sted til et neste. " +
      "Jobben vår er å stoppe dem før de kommer dit maten er. Det er derfor vi gjør ting i en bestemt rekkefølge, og ikke bare så fort som mulig.",
  },
  {
    title: "Vask hendene",
    points: ["Før du starter", "Etter pause og etter toalett", "Når du går fra urent til rent"],
    narration:
      "Vask hendene før du starter, etter hver pause og alltid etter toalettbesøk. Vask dem også når du går fra et urent område til et rent. " +
      "Bruk såpe og varmt vann, og tørk med papir. Hansker erstatter ikke håndvask — skitne hansker sprer like godt som skitne hender.",
  },
  {
    title: "Arbeidstøy",
    points: ["Rent tøy hver dag", "Hår inn under lue", "Ingen ringer, klokke eller smykker"],
    narration:
      "Bruk rent arbeidstøy hver dag. Har du vært på et skittent område, bytt før du går videre. " +
      "Hår skal inn under lue eller hårnett. Ta av ringer, klokke og smykker før du starter — det samler seg smuss under dem, og de kan falle av i maten. " +
      "Arbeidstøyet blir igjen på jobb, det skal ikke brukes hjem.",
  },
  {
    title: "Rene kluter og soner",
    points: ["Egen klut og mopp per sone", "Aldri fra toalett til produksjon", "Bytt når den er skitten"],
    narration:
      "Bruk egen klut og egen mopp for hver sone. En klut som har vært på et toalett skal aldri brukes på en benk eller i produksjonen. " +
      "Bytt kluten når den er skitten, ikke når den er helt svart. En skitten klut flytter smuss rundt i stedet for å ta det bort. " +
      "Følg fargekodene der de finnes.",
  },
  {
    title: "Kjemi og dosering",
    points: ["Bruk det som står i planen", "Riktig dose, ikke mer", "Bland aldri to midler"],
    narration:
      "Bruk det middelet som står i renholdsplanen for det rommet. Dosér riktig — mer såpe gir ikke renere resultat, det gir bare rester som blir liggende igjen. " +
      "Bland aldri to midler sammen; noen kombinasjoner blir farlig gass. La middelet få virke den tiden det skal før du tørker av.",
  },
  {
    title: "Si fra",
    points: ["Meld avvik i appen", "Ta bilde", "Det er en del av jobben"],
    narration:
      "Ser du noe som ikke er som det skal — en ødelagt list, en lekkasje, spor etter skadedyr — så meld det som avvik i appen og ta et bilde. " +
      "Det er ikke å klage, det er en del av jobben. Kunden får se at vi oppdaget det, og noen kan gjøre noe med det før det blir større.",
  },
];

function svg(slide, index) {
  const points = slide.points
    .map((p, i) => `
      <circle cx="140" cy="${418 + i * 96}" r="9" fill="#f97316"/>
      <text x="180" y="${430 + i * 96}" font-family="Segoe UI, Arial" font-size="42" fill="#3f3f46">${p}</text>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900">
    <rect width="1600" height="900" fill="#ffffff"/>
    <rect x="0" y="0" width="1600" height="16" fill="#f97316"/>
    <text x="120" y="210" font-family="Segoe UI, Arial" font-size="76" font-weight="bold" fill="#18181b">${slide.title}</text>
    <rect x="120" y="262" width="120" height="7" fill="#f97316"/>
    ${points}
    <text x="120" y="836" font-family="Segoe UI, Arial" font-size="30" fill="#a1a1aa">Hygiene i næringsmiddelproduksjon &#183; ${index + 1} av ${SLIDES.length}</text>
    <text x="1480" y="836" font-family="Segoe UI, Arial" font-size="30" font-weight="bold" fill="#f97316" text-anchor="end">OKV</text>
  </svg>`;
}

fs.mkdirSync(path.join(OUT, "bilder"), { recursive: true });
const manus = [];
for (let i = 0; i < SLIDES.length; i++) {
  const name = `slide-${String(i + 1).padStart(2, "0")}.png`;
  await sharp(Buffer.from(svg(SLIDES[i], i))).png().toFile(path.join(OUT, "bilder", name));
  manus.push({ index: i + 1, image: `bilder/${name}`, narration: SLIDES[i].narration });
}
fs.writeFileSync(path.join(OUT, "manus.no.json"), `${JSON.stringify(manus, null, 2)}\n`, "utf8");
// Samme fil som eksporter.ps1 ville lagt igjen, så manus.js kan oversette videre herfra.
fs.writeFileSync(
  path.join(OUT, "manus.json"),
  `${JSON.stringify({ title: "Hygiene i næringsmiddelproduksjon", source: "skrevet for hånd", slides: manus.map((m, i) => ({ ...m, title: SLIDES[i].title, raw: SLIDES[i].narration })) }, null, 2)}\n`,
  "utf8"
);
console.log(`${manus.length} lysbilder skrevet til ${OUT}`);
