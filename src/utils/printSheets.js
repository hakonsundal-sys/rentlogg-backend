// Two sheets meant to leave the screen: the QR poster that gets taped up at a site, and the room
// list someone carries around or hangs in the cleaners' room. Both are complete A4 HTML documents
// rather than generated PDFs — pdfkit would mean rebuilding this layout in drawing commands, and
// the browser's own print dialog already produces a PDF from HTML. The routes serve them with a
// content type the browser renders, so "download" is Ctrl+P.
import QRCode from "qrcode";

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Date#getDay() order (0 = søndag), the app's convention everywhere — see WEEKDAYS in
// LokasjonerPage. Printed Monday-first, because that is how a work week reads on paper.
const KORT = ["søn", "man", "tir", "ons", "tor", "fre", "lør"];
const MANED = ["jan", "feb", "mar", "apr", "mai", "jun", "jul", "aug", "sep", "okt", "nov", "des"];
const ukeOrden = (d) => (d + 6) % 7;

// "man–fre" rather than "man, tir, ons, tor, fre": five listed days crowd out the exceptions,
// which are the only part of a plan anyone actually needs to read twice.
export function describeDays(weekdays) {
  if (!weekdays?.length) return "";
  const sorted = [...new Set(weekdays)].sort((a, b) => ukeOrden(a) - ukeOrden(b));
  const erUkedager = sorted.length === 5 && [1, 2, 3, 4, 5].every((d) => sorted.includes(d));
  if (erUkedager) return "man–fre";
  return sorted.map((d) => KORT[d]).join(", ");
}

export function describeSchedule({ weekdays, interval_days, monthly_weekday, monthly_occurrence, months }) {
  const deler = [];
  const dager = describeDays(weekdays);
  if (dager) deler.push(dager);
  if (!dager && monthly_weekday != null) deler.push(`${monthly_occurrence}. ${KORT[monthly_weekday]} i md.`);
  if (!dager && interval_days) deler.push(`hver ${interval_days}. dag`);
  if (months?.length) deler.push([...months].sort((a, b) => a - b).map((m) => MANED[m - 1]).join(", "));
  return deler.join(" · ");
}

const MERKE = `<svg width="22" height="22" viewBox="0 0 32 32" fill="none" stroke="#6d28d9"
     stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
  <path d="M5 7.5h12"/><path d="M5 15h9"/><path d="M5 22.5h7"/><path d="m17.5 19.6 3.6 3.6L29 15"/>
</svg>`;

// A sheet exactly as tall as the page rounds up past it in some print engines and produces a
// blank trailing page, so the QR poster's frame stops a millimetre short.
const BASIS_CSS = `
  @page { size: A4 portrait; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #e9e9ee; }
  body { font-family: "Segoe UI", Calibri, Arial, sans-serif; color: #18181b; }
  @media print { html, body { background: #fff; } .skjerm { display: none; } }
  .skjerm { max-width: 210mm; margin: 14px auto 30px; padding: 11px 15px; background: #fff8e6;
            border: 1px solid #e8d9a8; color: #5a4a20; font-size: 13px; }`;

const hintBoks = (tekst) => `<div class="skjerm">${tekst} Denne gule boksen blir ikke med på utskriften.</div>`;

// ---------------------------------------------------------------- QR-plakat

// The five languages the app itself speaks. The step texts are the app's own strings, copied
// from the frontend's src/locales/<code>.json under cleaner.onboarding.{title,step1..3} — the two
// repos deploy separately, so the backend cannot read those files. If a string changes there,
// change it here too; nothing enforces it.
export const POSTER_TEXT = {
  no: { name: "Norsk", title: "Kom i gang", steps: ["Skann QR-koden ved lokasjonen", "Huk av rom og oppgaver etter hvert som du gjør dem", "Skriv navnet ditt og trykk «Fullfør»"] },
  en: { name: "English", title: "Getting started", steps: ["Scan the QR code at the location", "Tick off rooms and tasks as you do them", "Enter your name and tap “Complete”"] },
  lt: { name: "Lietuvių", title: "Kaip pradėti", steps: ["Nuskaitykite QR kodą objekte", "Žymėkite patalpas ir užduotis, kai jas atliekate", "Įveskite savo vardą ir spustelėkite „Užbaigti“"] },
  lv: { name: "Latviešu", title: "Kā sākt", steps: ["Noskenējiet QR kodu objektā", "Atzīmējiet telpas un uzdevumus, kad tos paveicat", "Ievadiet savu vārdu un nospiediet “Pabeigt”"] },
  ru: { name: "Русский", title: "Как начать", steps: ["Отсканируйте QR-код на объекте", "Отмечайте помещения и задачи по мере выполнения", "Введите своё имя и нажмите «Завершить»"] },
};

export const POSTER_LANGUAGES = Object.keys(POSTER_TEXT);
// Norwegian and English by default: Norwegian because that is the office language, English
// because it is the one a cleaner who reads none of the others is most likely to get through.
export const DEFAULT_POSTER_LANGUAGES = ["no", "en"];

// Accepts the stored comma-separated string, an array, or nothing at all. Anything unusable falls
// back to the default rather than printing a poster with no instructions on it.
export function normalizePosterLanguages(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(",");
  const rene = [...new Set(list.map((c) => String(c).trim().toLowerCase()).filter((c) => POSTER_LANGUAGES.includes(c)))];
  return rene.length ? rene.slice(0, 3) : DEFAULT_POSTER_LANGUAGES;
}

export async function qrPosterHtml({ siteName, address, companyName, manualCode, checkInUrl, languages }) {
  // Q (25%) rather than the default M: these sheets get taped to a wall in a production hall and
  // will be scanned wet, smudged and at an angle long before anyone reprints them.
  let qr = await QRCode.toString(checkInUrl, { type: "svg", errorCorrectionLevel: "Q", margin: 0 });
  qr = qr.replace(/<\?xml[^>]*\?>/g, "").replace(/<svg /, '<svg style="width:100%;height:100%;display:block" ');

  // A long name would otherwise push the QR down the page; shrink the type instead of wrapping.
  const tittelPt = siteName.length > 30 ? 20 : siteName.length > 22 ? 24 : 28;

  // Three columns is where 11pt stops fitting across the box; past that the instructions get
  // smaller rather than the poster getting taller, since the QR must keep its size.
  const valgte = normalizePosterLanguages(languages);
  const tekstPt = valgte.length >= 3 ? 9.5 : 11;
  const kolonne = (kode) => {
    const t = POSTER_TEXT[kode];
    return `
      <div style="flex:1; min-width:0">
        <div style="font-size:9.5pt; font-weight:700; letter-spacing:.09em; text-transform:uppercase; color:#6d28d9; margin-bottom:7px">${escapeHtml(t.title)}</div>
        <ol style="margin:0; padding-left:17px; font-size:${tekstPt}pt; line-height:1.55; color:#3f3f46">
          ${t.steps.map((s) => `<li style="margin-bottom:3px">${escapeHtml(s)}</li>`).join("\n          ")}
        </ol>
      </div>`;
  };

  return `<!DOCTYPE html>
<html lang="nb">
<head>
<meta charset="utf-8">
<title>QR — ${escapeHtml(siteName)}</title>
<style>${BASIS_CSS}
  .ark { width: 210mm; height: 296mm; overflow: hidden; margin: 0 auto; background: #fff;
         padding: 19mm 18mm 15mm; display: flex; flex-direction: column; }
  @media screen { .ark { box-shadow: 0 2px 14px rgba(0,0,0,.18); margin-top: 22px; } }
</style>
</head>
<body>

<div class="ark">
  <div style="display:flex; align-items:center; gap:9px; padding-bottom:9px; border-bottom:2.5px solid #6d28d9">
    ${MERKE}
    <span style="font-size:15.5pt; font-weight:700; letter-spacing:-.015em">Rentlogg</span>
    <span style="margin-left:auto; font-size:10pt; color:#71717a">${escapeHtml(companyName)}</span>
  </div>

  <div style="margin-top:13mm; text-align:center">
    <div style="font-size:${tittelPt}pt; font-weight:700; line-height:1.12; letter-spacing:-.02em">${escapeHtml(siteName)}</div>
    ${address ? `<div style="font-size:11.5pt; color:#71717a; margin-top:5px">${escapeHtml(address)}</div>` : ""}
  </div>

  <!-- The white frame is the QR's quiet zone. Without it a scanner has nothing to lock onto,
       which is the usual reason a printed code "doesn't work". -->
  <div style="margin:11mm auto 0; width:108mm; height:108mm; padding:7mm;
              background:#fff; border:1.5px solid #d4d4d8; border-radius:4mm">
    ${qr}
  </div>

  <div style="text-align:center; margin-top:7mm">
    <div style="font-size:9.5pt; letter-spacing:.09em; text-transform:uppercase; color:#71717a">Manuell kode</div>
    <div style="font-family:Consolas,'Courier New',monospace; font-size:16pt; font-weight:700;
                letter-spacing:.13em; margin-top:3px">${escapeHtml(manualCode)}</div>
  </div>

  <div style="margin-top:auto; padding-top:8mm">
    <div style="display:flex; gap:13mm; padding:6mm 7mm; background:#f5f3ff; border-radius:3mm">
      ${valgte.map(kolonne).join("\n      ")}
    </div>
    <div style="text-align:center; font-size:9.5pt; color:#a1a1aa; margin-top:5mm">rentlogg.no</div>
  </div>
</div>

${hintBoks("Skriv ut med <strong>Ctrl+P</strong> &rarr; A4, skalering <strong>100 %</strong> (ikke «tilpass til side», det krymper QR-koden).")}

</body>
</html>
`;
}

// ---------------------------------------------------------------- Romliste

export function roomSheetHtml({ siteName, companyName, rooms, date = new Date() }) {
  const antall = rooms.reduce((sum, r) => sum + r.items.length, 0);
  const dato = date.toLocaleDateString("nb-NO", { day: "numeric", month: "long", year: "numeric" });

  const blokk = (rom, nr) => {
    const romPlan = describeSchedule(rom);
    return `
  <section>
    <h2>
      <span class="nr">${nr}</span>
      <span class="navn">${escapeHtml(rom.name)}</span>
      <span class="dager">${escapeHtml(romPlan || "ingen plan")}</span>
      <span class="ant">${rom.items.length}</span>
    </h2>
    <ol>
      ${rom.items
        .map((o) => {
          // A day is only worth printing on a task when it differs from the room it sits in.
          // Repeating "man–fre" on every line buries the exceptions, which are the only part
          // anyone needs to read twice.
          const plan = describeSchedule({ weekdays: o.weekly_days, months: o.months, interval_days: o.interval_days, monthly_weekday: o.monthly_weekday, monthly_occurrence: o.monthly_occurrence });
          const avvik = plan && plan !== romPlan ? `<em>${escapeHtml(plan)}</em>` : "";
          return `<li><span class="boks"></span><span class="tekst">${escapeHtml(o.label)}</span>${avvik}</li>`;
        })
        .join("\n      ")}
    </ol>
  </section>`;
  };

  return `<!DOCTYPE html>
<html lang="nb">
<head>
<meta charset="utf-8">
<title>Romliste — ${escapeHtml(siteName)}</title>
<style>${BASIS_CSS}
  @page { margin: 14mm 13mm 12mm; }
  body { font-size: 9.5pt; background: #fff; }
  .ark { max-width: 184mm; margin: 0 auto; }
  @media screen { .ark { padding: 14mm 13mm; } }

  header { display: flex; align-items: center; gap: 8px; padding-bottom: 7px;
           border-bottom: 2.5px solid #6d28d9; margin-bottom: 9px; }
  header .merke { font-size: 13pt; font-weight: 700; letter-spacing: -.015em; }
  header .sted { margin-left: auto; font-size: 10pt; color: #52525b; }
  header .sted b { color: #18181b; }
  .sum { font-size: 8.5pt; color: #71717a; margin-bottom: 9px; }

  /* Two columns: this list runs to four sparse pages in one column and half the sheet stays
     empty. Rooms never split across a column break — half a room is worse than a short column. */
  .kolonner { column-count: 2; column-gap: 9mm; }
  section { break-inside: avoid; margin-bottom: 7px; }

  h2 { display: flex; align-items: baseline; gap: 5px; margin: 0 0 3px; font-size: 10pt;
       border-bottom: 1px solid #d4d4d8; padding-bottom: 2px; }
  h2 .nr { font-size: 7.5pt; font-weight: 700; color: #fff; background: #6d28d9; border-radius: 3px;
           padding: 1px 4px; min-width: 15px; text-align: center; }
  h2 .navn { font-weight: 700; }
  h2 .dager { font-size: 8pt; font-weight: 400; color: #6d28d9; }
  h2 .ant { margin-left: auto; font-size: 8pt; font-weight: 400; color: #a1a1aa; }

  ol { margin: 0; padding: 0; list-style: none; }
  li { display: flex; align-items: center; gap: 5px; padding: 1.5px 0; line-height: 1.3; break-inside: avoid; }
  li .boks { flex: 0 0 auto; width: 8px; height: 8px; border: 1px solid #a1a1aa; border-radius: 2px; }
  li .tekst { min-width: 0; }
  li em { font-style: normal; margin-left: auto; padding-left: 6px; font-size: 8pt; color: #6d28d9; white-space: nowrap; }

  footer { margin-top: 10px; padding-top: 6px; border-top: 1px solid #e4e4e7;
           font-size: 8pt; color: #a1a1aa; display: flex; }
  footer span:last-child { margin-left: auto; }
</style>
</head>
<body>

<div class="ark">
  <header>
    ${MERKE}
    <span class="merke">Rentlogg</span>
    <span class="sted"><b>${escapeHtml(siteName)}</b></span>
  </header>

  <div class="sum">${rooms.length} rom &middot; ${antall} oppgaver &middot; dager st&aring;r bare p&aring; oppgaver som avviker fra rommets egen plan</div>

  <div class="kolonner">${rooms.map((r, i) => blokk(r, i + 1)).join("\n")}
  </div>

  <footer>
    <span>${escapeHtml(companyName)}</span>
    <span>Hentet fra Rentlogg ${escapeHtml(dato)}</span>
  </footer>
</div>

${hintBoks("Skriv ut med <strong>Ctrl+P</strong> &rarr; A4.")}

</body>
</html>
`;
}
