import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { BRAND as B, MAIL_FONT, mailShell } from "../brand.js";

const PRIORITY_LABELS = { low: "Lav", medium: "Middels", high: "Høy" };

// The HTML report is opened both as a logged-in browser tab (RunDetailModal's "Vis rapport") and
// baked into the daily-digest email sent to whoever's on a site's recipient list — neither has
// any way to carry the auth token /uploads now requires (an email client fetching an <img src>
// certainly can't, and isn't logged in at all), so a plain /uploads URL here would render as a
// broken image for both. Embedding the actual bytes sidesteps needing any token at all.
//
// Always resizes and re-encodes to JPEG via sharp, for two reasons found 2026-09-16 investigating
// a digest that reached recipients with no images at all: (1) an unresized phone photo is easily
// 2-4MB, and a visit with several rooms' worth of them inlined as base64 routinely produced a
// 7MB+ HTML email — Gmail (and most clients) clip a message's displayed content around ~100KB,
// so everything past that, images included, never rendered. (2) uploads allow HEIC/HEIF (the
// default format on iPhones), which was previously embedded as `data:image/heic;base64,...` —
// almost no email client or browser renders that inline at all, independent of size. Re-encoding
// to a capped, compressed JPEG here fixes both at once, for every consumer of buildReportBody
// (the email digest and "Vis rapport"); the original full-resolution file on disk is untouched,
// so the in-app room photo view and the "Last ned alle bilder" zip are unaffected.
async function photoDataUri(filePath) {
  const absolutePath = path.join(process.env.UPLOADS_DIR || "uploads", path.basename(filePath));
  try {
    const buffer = await sharp(absolutePath)
      .rotate()
      .resize(1200, 1200, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 72 })
      .toBuffer();
    return `data:image/jpeg;base64,${buffer.toString("base64")}`;
  } catch {
    return null; // file missing on disk, or an unsupported/corrupt image — skip it rather than break the whole report
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// Room-enabled sites report per room (their real structure); flat/legacy sites fall back to a
// single "Sjekkliste" section built from the run's own items/photos — same fallback shape the
// rest of the app already uses wherever rooms vs. flat is a branch point.
// Only label rooms by who's responsible when the site actually mixes both (e.g. one zone OKV
// cleans, one the customer cleans themselves) — otherwise every title would carry a pointless
// "(Renholder)" suffix. Mixed sites can also have two rooms sharing a name across the two zones
// (each side's own "Kontor", say), so the suffix doubles as disambiguation — used for both the
// per-room sections below and any deviation reported against one of these rooms.
function isMixedResponsibility(rooms) {
  return rooms?.length > 0 && rooms.some((r) => r.responsible === "customer") && rooms.some((r) => r.responsible !== "customer");
}

function responsibleSuffix(responsible) {
  return ` (${responsible === "customer" ? "Kunde" : "Renholder"})`;
}

// A flervalg task (see room_run_item_options) only means something in a report if it says which
// alternatives were actually ticked — "✓ Utført" alone hides the very thing the task documents,
// e.g. which soap was used that day. Returns null for an ordinary task.
function chosenOptionsText(item) {
  if (!item.options?.length) return null;
  const chosen = item.options.filter((o) => o.selected).map((o) => o.label);
  return chosen.length ? chosen.join(", ") : "ingen valgt";
}

// En måleoppgave sier ingenting i en rapport uten selve tallet og grensen den ble målt mot —
// "✓ Utført" på en ATP-prøve er akkurat den opplysningen et tilsyn ikke er ute etter.
// Grensen leses fra run-itemet, altså den som gjaldt da prøven ble tatt, ikke dagens.
// Returnerer null for en vanlig oppgave.
function measurementText(item) {
  if (!item.measure_unit) return null;
  if (item.measured_value === null || item.measured_value === undefined) {
    return { text: `Måling: ikke registrert${item.measure_label ? ` (${item.measure_label})` : ""}`, ok: null };
  }
  const grense = item.measure_label ? ` (${item.measure_label})` : "";
  const dom = item.verdict === "fail" ? " — utenfor grense" : item.verdict === "pass" ? " — innenfor" : "";
  return {
    text: `Måling: ${item.measured_value} ${item.measure_unit}${grense}${dom}`,
    ok: item.verdict === "fail" ? false : item.verdict === "pass" ? true : null,
  };
}

const STEP_LABELS = {
  residue: "Fjerne rester",
  clean: "Rengjøre",
  rinse: "Skylle",
  disinfect: "Desinfisere",
  control: "Kontroll",
};

// Hygienetrinnet, konsentrasjonen og kontakttiden på én linje. Kontakttiden rapporteres med
// starttidspunktet, ikke bare som «10 min» — det er forskjellen på å dokumentere at midlet sto
// lenge nok og å påstå at det gjorde det. Returnerer null for en vanlig oppgave.
function stepText(item) {
  if (!item.step_type) return null;
  const parts = [STEP_LABELS[item.step_type] || item.step_type];
  if (item.concentration) parts.push(item.concentration);
  if (item.contact_seconds) {
    const mins = Math.round(item.contact_seconds / 60);
    const varighet = mins >= 1 ? `${mins} min` : `${item.contact_seconds} sek`;
    parts.push(
      item.contact_started_at
        ? `kontakttid ${varighet}, startet ${item.contact_started_at.slice(11, 16)}`
        : `kontakttid ${varighet} (ikke startet)`
    );
  }
  return parts.join(" · ");
}

function buildSections(detail) {
  if (detail.rooms?.length > 0) {
    const isMixed = isMixedResponsibility(detail.rooms);
    return detail.rooms.map((room) => ({
      title: isMixed ? `${room.name}${responsibleSuffix(room.responsible)}` : room.name,
      items: room.items, photos: room.photos, note: room.note,
    }));
  }
  return [{ title: "Sjekkliste", items: detail.items, photos: detail.photos, note: detail.note }];
}

function formatStatus(detail) {
  const base = detail.completed_at
    ? `Ferdigstilt ${detail.completed_at.slice(0, 16)}${detail.signed_initials ? ` av ${detail.signed_initials}` : ""}`
    : "Pågår";
  // The date this run is filed under is real (see checklists.js's backdated check-in), but the
  // check-in itself wasn't made that day — the report has to say so wherever it shows a date, not
  // just quietly pass it off as an ordinary same-day visit.
  return detail.backdated ? `${base} (sjekket inn i etterkant)` : base;
}

// Renders a section/deviation's photos as a table row, dropping any that came back null (missing
// file, or a format sharp couldn't decode) rather than leaving a gap in the layout.
//
// To ting ble rettet her 2026-10-09, begge målt og begge verre enn de ser ut:
//
// 1. BILDET LÅ INNE TO GANGER. Hver uri sto både i `<img src>` og i `<a href>` rundt det, så
//    base64-bytene ble sendt dobbelt. En rapport med tre bilder gikk fra 47 kB til 32 kB bare av
//    å droppe lenken. Gmail klipper en melding rundt 100 kB og alt under klippet forsvinner —
//    det er nøyaktig feilen fra 2026-09-16, og halve nyttelasten var en lenke som uansett bare
//    peker på en `data:`-URI de fleste e-postklienter nekter å åpne.
// 2. `display:flex` VIRKER IKKE I OUTLOOK. Outlook på Windows rendrer med Word-motoren og
//    ignorerer både flex og grid, så bilderaden ble én kolonne. Tabellceller virker overalt.
async function photosHtmlFor(photos, boxSize) {
  if (!photos?.length) return "";
  const uris = (await Promise.all(photos.map((p) => photoDataUri(p.file_path)))).filter(Boolean);
  if (!uris.length) return "";
  // Bildene står som vanlige inline-bilder i ÉN celle, ikke som hver sin tabellcelle. En rad med
  // tabellceller kan ikke brytes: tre bilder à 150px blir 474px, bredere enn en 375px telefon,
  // og da klippes raden i stedet for å gå over to linjer. Inline-bilder brytes av seg selv, i
  // Outlook også — det er den eldste teknikken i e-post, og den er eldre enn problemet.
  const imgs = uris
    .map(
      (uri) =>
        `<img src="${uri}" width="${boxSize}" height="${boxSize}" alt="" ` +
        `style="width:${boxSize}px;height:${boxSize}px;object-fit:cover;margin:0 8px 8px 0;` +
        `border:1px solid ${B.line};border-radius:6px;vertical-align:top;">`
    )
    .join("");
  return `<tr><td style="padding:12px 16px 4px;border-top:1px solid ${B.line};font-size:0;line-height:0;">${imgs}</td></tr>`;
}

// Avsenderlåsen: en violett strek over dokumenttittelen. Loggstreken fra landingssiden, redusert
// til det eneste en e-postklient garantert tegner — en fylt tabellcelle.
function lockup(label) {
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin-bottom:22px;">
    <tr><td style="width:34px;height:4px;background:${B.brand};font-size:0;line-height:0;">&nbsp;</td></tr>
    <tr><td style="padding-top:9px;font:700 12px/1 ${MAIL_FONT};letter-spacing:0.14em;color:${B.brand};">${label}</td></tr>
  </table>`;
}

// Tallene side om side. En tabell med én celle per tall, ikke grid.
function numberRow(cells) {
  const tds = cells
    .map(
      (c) => `<td style="padding:0 34px 0 0;vertical-align:top;">
        <div style="font:400 11px/1.4 ${MAIL_FONT};color:${B.muted};">${escapeHtml(c.label)}</div>
        <div style="font:700 26px/1.2 ${MAIL_FONT};color:${c.color || B.ink};padding-top:2px;">${escapeHtml(String(c.value))}</div>
      </td>`
    )
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:18px 0 26px;"><tr>${tds}</tr></table>`;
}

// Split from buildReportHtml so the daily-digest email can concatenate multiple visits' bodies
// into one <html> shell instead of nesting complete documents inside each other. Async because
// photoDataUri now goes through sharp (resize + re-encode) rather than a plain sync file read —
// see its own comment for why.
export async function buildReportBody(detail) {
  const sections = buildSections(detail);
  const isMixed = isMixedResponsibility(detail.rooms);

  let doneItems = 0;
  let totalItems = 0;

  const sectionsHtml = (await Promise.all(sections.map(async (section, sIdx) => {
      const num = sIdx + 1;
      const sectionDone = section.items.filter((i) => i.done).length;
      doneItems += sectionDone;
      totalItems += section.items.length;

      // Oppgaveraden er en tabell med to kolonner, ikke flex: navnet flyter, statusen står fast
      // til høyre. Med flex falt statusen ned under navnet i Outlook.
      const itemsHtml = section.items
        .map((item, iIdx) => {
          const chosen = chosenOptionsText(item);
          const measure = measurementText(item);
          const measureColor = measure
            ? measure.ok === false ? B.dangerText : measure.ok === true ? B.okText : B.muted
            : null;
          const step = stepText(item);
          const sub = (text) => `<br><span style="font-size:12px;color:${B.muted};">${escapeHtml(text)}</span>`;
          return `
          <tr><td style="padding:9px 16px;border-top:1px solid ${B.lineSoft};">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
              <tr>
                <td style="font:400 13px/1.45 ${MAIL_FONT};color:${B.ink};">
                  <span style="color:${B.muted};">${num}.${iIdx + 1}</span> ${escapeHtml(item.label)}${step ? sub(step) : ""}${chosen ? sub(`Valgt: ${chosen}`) : ""}${measure ? `<br><span style="font-size:12px;font-weight:700;color:${measureColor};">${escapeHtml(measure.text)}</span>` : ""}
                </td>
                <td align="right" style="white-space:nowrap;padding-left:14px;font:700 12px/1.45 ${MAIL_FONT};color:${item.done ? B.okText : B.dangerText};">
                  ${item.done ? "Utført" : "Ikke utført"}
                </td>
              </tr>
            </table>
          </td></tr>`;
        })
        .join("");

      const photosHtml = await photosHtmlFor(section.photos, 150);

      const noteHtml = section.note?.trim()
        ? `<tr><td style="padding:11px 16px;border-top:1px solid ${B.lineSoft};background:${B.ground};font:400 13px/1.5 ${MAIL_FONT};color:${B.ink2};white-space:pre-wrap;"><strong style="color:${B.ink};">Notat:</strong> ${escapeHtml(section.note)}</td></tr>`
        : "";

      return `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border:1px solid ${B.line};border-radius:10px;margin-top:16px;">
          <tr><td style="padding:11px 16px;background:${B.ground};border-bottom:1px solid ${B.line};">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;"><tr>
              <td style="font:700 14px/1.3 ${MAIL_FONT};color:${B.ink};">${escapeHtml(section.title)}</td>
              <td align="right" style="font:400 12px/1.3 ${MAIL_FONT};color:${B.muted};white-space:nowrap;">${sectionDone} av ${section.items.length}</td>
            </tr></table>
          </td></tr>
          ${itemsHtml || `<tr><td style="padding:12px 16px;font:400 13px/1.5 ${MAIL_FONT};color:${B.muted};">Ingen oppgaver registrert.</td></tr>`}
          ${photosHtml}
          ${noteHtml}
        </table>`;
    })))
    .join("");

  // Avvikene er et eget spor, ikke enda en seksjon. Venstrekanten er det eneste rammetrikset
  // Outlook tegner pålitelig.
  const deviationsHtml = detail.deviations?.length
    ? `<div style="font:700 16px/1.3 ${MAIL_FONT};color:${B.ink};margin:30px 0 0;">Avvik</div>
      ${(await Promise.all(detail.deviations.map(async (d) => `
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border:1px solid ${B.line};border-left:3px solid ${B.danger};margin-top:10px;">
            <tr><td style="padding:13px 16px;font:400 13px/1.5 ${MAIL_FONT};color:${B.ink};">
              <div style="font-weight:700;">${d.room_name ? escapeHtml(d.room_name + (isMixed ? responsibleSuffix(d.room_responsible) : "")) + (d.room_task_label ? " &middot; " + escapeHtml(d.room_task_label) : "") : "Generelt"}</div>
              <div style="padding-top:4px;">${escapeHtml(d.description)}</div>
              <div style="padding-top:6px;font-size:12px;color:${B.muted};">
                ${escapeHtml(PRIORITY_LABELS[d.priority] || d.priority)}${d.reported_by_initials ? ` &middot; meldt av ${escapeHtml(d.reported_by_initials)}` : ""}${d.due_date ? ` &middot; frist ${escapeHtml(d.due_date)}` : ""}
              </div>
              ${d.reply_text ? `<div style="margin-top:9px;padding:9px 11px;background:${B.ground};font-size:12.5px;color:${B.ink2};"><strong style="color:${B.ink};">Svar:</strong> ${escapeHtml(d.reply_text)}${d.replied_by_initials ? ` &mdash; ${escapeHtml(d.replied_by_initials)}` : ""}</div>` : ""}
            </td></tr>
            ${await photosHtmlFor(d.photos, 120)}
          </table>`)))
        .join("")}`
    : "";

  // Alt den gamle firekolonnetabellen bar, på én linje: besøksnummer, registrert, ferdigstilt,
  // signatur. `detail.id` er null for en virtuell dag (se getVirtualDayDetail), så den utelates
  // da i stedet for å skrive «Besøk null». formatStatus bærer «sjekket inn i etterkant», som MÅ
  // bli med — den sier at datoen rapporten står under ikke er dagen renholderen var der.
  // Bare FØRSTE tegn gjøres lite. `.toLowerCase()` på hele strengen gjorde «av TH» til «av th»
  // — signaturen er initialer, og initialer i små bokstaver er ikke lenger den samme signaturen.
  const status = formatStatus(detail);
  const meta = [
    detail.id ? `Besøk ${detail.id}` : null,
    `registrert ${escapeHtml(detail.started_at.slice(11, 16))}`,
    escapeHtml(status.charAt(0).toLowerCase() + status.slice(1)),
  ]
    .filter(Boolean)
    .join(" &middot; ");

  return `<div style="max-width:620px;margin:0 auto;font:400 15px/1.6 ${MAIL_FONT};color:${B.ink};">
  ${lockup("RENHOLDSRAPPORT")}
  <div style="font:700 25px/1.2 ${MAIL_FONT};letter-spacing:-0.02em;color:${B.ink};">${escapeHtml(detail.site_name)}</div>
  <div style="font:400 14px/1.5 ${MAIL_FONT};color:${B.ink2};padding-top:5px;">
    ${escapeHtml(detail.started_at.slice(0, 10))} &middot; ${escapeHtml(detail.cleaner_name)}${detail.site_address ? `<br>${escapeHtml(detail.site_address)}` : ""}${detail.client_name ? ` &middot; ${escapeHtml(detail.client_name)}` : ""}
  </div>
  <div style="font:400 12.5px/1.6 ${MAIL_FONT};color:${B.muted};padding-top:3px;">${meta}</div>

  ${numberRow([
    { label: sections.length === 1 ? "Seksjon" : "Rom", value: sections.length },
    { label: "Oppgaver", value: `${doneItems} / ${totalItems}`, color: doneItems === totalItems ? B.okText : B.warnText },
    { label: "Avvik", value: detail.deviations?.length || 0, color: detail.deviations?.length ? B.dangerText : B.ink },
  ])}

  ${sectionsHtml}
  ${deviationsHtml}

  <div style="margin-top:30px;padding-top:16px;border-top:1px solid ${B.line};font:400 12px/1.6 ${MAIL_FONT};color:${B.muted};">
    Rapport fra Rentlogg. Mottakere endres av en administrator under Lokasjoner.
  </div>
</div>`;
}

export async function buildReportHtml(detail) {
  // Samme skall som e-posten får (se brand.js), pluss en <title> — denne åpnes også som en
  // nettlesertab fra «Vis rapport», og en fane uten tittel er vond å finne igjen.
  return mailShell(await buildReportBody(detail)).replace(
    "</head>",
    `<title>Renholdsrapport — ${escapeHtml(detail.site_name)}</title></head>`
  );
}

// PDFKit's doc.image() does NOT advance doc.y the way doc.text() does, so anything drawn
// afterward (via moveDown/text/another image) lands back at the same y — silently overlapping
// the image instead of flowing below it. This lays photos out in explicit rows and moves doc.y
// past the tallest row itself, so the rest of the document keeps flowing correctly.
function drawPhotoGrid(doc, photos, uploadsDir, boxSize) {
  if (!photos?.length) return;
  const gap = 10;
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const perRow = Math.max(1, Math.floor((contentWidth + gap) / (boxSize + gap)));
  const startX = doc.page.margins.left;
  let col = 0;
  let rowY = doc.y;

  photos.forEach((photo) => {
    const absolutePath = path.join(uploadsDir, path.basename(photo.file_path));
    if (!fs.existsSync(absolutePath)) return;
    if (col === 0 && rowY > doc.page.height - doc.page.margins.bottom - boxSize) {
      doc.addPage();
      rowY = doc.y;
    }
    try {
      // pdfkit's doc.image() only decodes JPEG/PNG — a WebP or HEIC upload (both allowed by the
      // image upload filter) throws here. Skip that one photo rather than let it take down the
      // whole PDF (previously uncaught, so one such photo among many would fail the entire
      // download with no report at all).
      doc.image(absolutePath, startX + col * (boxSize + gap), rowY, { fit: [boxSize, boxSize] });
    } catch (err) {
      console.error("Kunne ikke tegne bilde i PDF:", err.message);
    }
    col++;
    if (col >= perRow) {
      col = 0;
      rowY += boxSize + gap;
    }
  });

  if (col !== 0) rowY += boxSize + gap;
  doc.x = startX;
  doc.y = rowY;
}

export function buildReportPdf(detail, res) {
  const sections = buildSections(detail);
  const isMixed = isMixedResponsibility(detail.rooms);
  const uploadsDir = process.env.UPLOADS_DIR || "uploads";

  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);

  doc.fontSize(20).fillColor("black").text("Renholdsrapport");
  doc.fontSize(11).fillColor("gray").text(
    `${detail.site_name}${detail.site_address ? " — " + detail.site_address : ""}${detail.client_name ? " · " + detail.client_name : ""}`
  );
  doc.moveDown(0.5);
  doc.fontSize(10).fillColor("black").text(`Besøk-nr: ${detail.id}    Renholder: ${detail.cleaner_name}`);
  doc.text(`Registrert: ${detail.started_at.slice(0, 16)}    Status: ${formatStatus(detail)}`);
  doc.moveDown();

  sections.forEach((section, sIdx) => {
    const num = sIdx + 1;
    if (doc.y > doc.page.height - 120) doc.addPage();
    doc.fontSize(13).fillColor("black").text(`${num}. ${section.title}`, { underline: true });
    doc.moveDown(0.3);

    if (section.items.length === 0) {
      doc.fontSize(10).fillColor("gray").text("Ingen oppgaver registrert.");
    }
    section.items.forEach((item, iIdx) => {
      if (doc.y > doc.page.height - 80) doc.addPage();
      doc.fontSize(10).fillColor("black").text(`${num}.${iIdx + 1} ${item.label}`, { continued: true });
      doc.fillColor(item.done ? "green" : "red").text(item.done ? "  ✓ Utført" : "  ✗ Ikke utført");
      const chosen = chosenOptionsText(item);
      if (chosen) doc.fontSize(9).fillColor("gray").text(`    Valgt: ${chosen}`);
      const step = stepText(item);
      if (step) doc.fontSize(9).fillColor("gray").text(`    ${step}`);
      const measure = measurementText(item);
      if (measure) {
        doc.fontSize(9)
          .fillColor(measure.ok === false ? "red" : measure.ok === true ? "green" : "gray")
          .text(`    ${measure.text}`);
      }
    });

    if (section.photos?.length) {
      doc.moveDown(0.3);
      drawPhotoGrid(doc, section.photos, uploadsDir, 150);
    }
    if (section.note?.trim()) {
      doc.moveDown(0.3);
      if (doc.y > doc.page.height - 80) doc.addPage();
      doc.fontSize(10).fillColor("black").text("Notat:", { continued: true }).fillColor("gray").text(` ${section.note}`);
    }
    doc.moveDown();
  });

  if (detail.deviations?.length > 0) {
    if (doc.y > doc.page.height - 120) doc.addPage();
    doc.fontSize(13).fillColor("red").text("Avvik", { underline: true });
    doc.moveDown(0.3);
    detail.deviations.forEach((d) => {
      if (doc.y > doc.page.height - 100) doc.addPage();
      const where = d.room_name ? `${d.room_name}${isMixed ? responsibleSuffix(d.room_responsible) : ""}${d.room_task_label ? " · " + d.room_task_label : ""}` : "Generelt";
      doc.fontSize(10).fillColor("black").text(`${where} — ${PRIORITY_LABELS[d.priority] || d.priority}`);
      doc.fontSize(10).fillColor("black").text(d.description);
      if (d.photos?.length) {
        doc.moveDown(0.3);
        drawPhotoGrid(doc, d.photos, uploadsDir, 130);
      }
      if (d.reply_text) doc.fontSize(9).fillColor("gray").text(`Svar: ${d.reply_text} — ${d.replied_by_initials}`);
      doc.moveDown(0.5);
    });
  }

  doc.end();
}
