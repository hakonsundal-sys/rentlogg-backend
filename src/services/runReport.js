import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import sharp from "sharp";

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

// Renders a section/deviation's photos to <img> tags, dropping any that came back null (missing
// file, or a format sharp couldn't decode) rather than leaving a gap in the layout.
async function photosHtmlFor(photos, boxSize) {
  if (!photos?.length) return "";
  const uris = (await Promise.all(photos.map((p) => photoDataUri(p.file_path)))).filter(Boolean);
  if (!uris.length) return "";
  return `<div style="padding:10px 14px;border:1px solid #ddd;border-top:none;display:flex;flex-wrap:wrap;gap:8px;">
    ${uris.map((uri) => `<a href="${uri}" target="_blank"><img src="${uri}" alt="" style="width:${boxSize}px;height:${boxSize}px;object-fit:cover;border-radius:4px;border:1px solid #ddd;"></a>`).join("")}
  </div>`;
}

// Split from buildReportHtml so the daily-digest email can concatenate multiple visits' bodies
// into one <html> shell instead of nesting complete documents inside each other. Async because
// photoDataUri now goes through sharp (resize + re-encode) rather than a plain sync file read —
// see its own comment for why.
export async function buildReportBody(detail) {
  const sections = buildSections(detail);
  const isMixed = isMixedResponsibility(detail.rooms);

  const sectionsHtml = (await Promise.all(sections.map(async (section, sIdx) => {
      const num = sIdx + 1;
      const itemsHtml = section.items
        .map((item, iIdx) => `
          <div style="padding:8px 14px;border:1px solid #ddd;border-top:none;font-size:13px;display:flex;justify-content:space-between;gap:12px;">
            <span>${num}.${iIdx + 1} ${escapeHtml(item.label)}</span>
            <span style="white-space:nowrap;font-weight:600;color:${item.done ? "#0a7a2f" : "#c0392b"};">${item.done ? "✓ Utført" : "✗ Ikke utført"}</span>
          </div>`)
        .join("");

      const photosHtml = await photosHtmlFor(section.photos, 180);

      const noteHtml = section.note?.trim()
        ? `<div style="padding:10px 14px;border:1px solid #ddd;border-top:none;font-size:13px;background:#fafafa;white-space:pre-wrap;"><strong>Notat:</strong> ${escapeHtml(section.note)}</div>`
        : "";

      return `
        <div style="background:#efefef;padding:10px 14px;font-weight:700;font-size:15px;border:1px solid #ddd;margin-top:22px;">${num}. ${escapeHtml(section.title)}</div>
        ${itemsHtml || `<div style="padding:10px 14px;border:1px solid #ddd;border-top:none;font-size:13px;color:#777;">Ingen oppgaver registrert.</div>`}
        ${photosHtml}
        ${noteHtml}`;
    })))
    .join("");

  const deviationsHtml = detail.deviations?.length
    ? `
      <div style="background:#fdecea;padding:10px 14px;font-weight:700;font-size:15px;border:1px solid #f1b0b7;margin-top:26px;color:#611a15;">Avvik</div>
      ${(await Promise.all(detail.deviations.map(async (d) => `
          <div style="padding:12px 14px;border:1px solid #f1b0b7;border-top:none;font-size:13px;">
            <div style="font-weight:600;">${d.room_name ? escapeHtml(d.room_name + (isMixed ? responsibleSuffix(d.room_responsible) : "")) + (d.room_task_label ? " · " + escapeHtml(d.room_task_label) : "") : "Generelt"}
              <span style="font-weight:400;color:#777;"> — ${PRIORITY_LABELS[d.priority] || d.priority}</span>
            </div>
            <div style="margin-top:4px;">${escapeHtml(d.description)}</div>
            ${d.reported_by_initials ? `<div style="margin-top:4px;color:#777;">Meldt av: ${escapeHtml(d.reported_by_initials)}</div>` : ""}
            ${await photosHtmlFor(d.photos, 140)}
            ${d.reply_text ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid #f1b0b7;color:#333;">Svar: ${escapeHtml(d.reply_text)} — ${escapeHtml(d.replied_by_initials)}</div>` : ""}
          </div>`)))
        .join("")}`
    : "";

  return `<div style="max-width:760px;margin:0 auto;">
    <h1 style="font-size:26px;margin:0 0 4px;">Renholdsrapport</h1>
    <div style="font-size:14px;color:#555;margin-bottom:20px;">
      ${escapeHtml(detail.site_name)}${detail.site_address ? " — " + escapeHtml(detail.site_address) : ""}${detail.client_name ? " · " + escapeHtml(detail.client_name) : ""}
    </div>

    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:8px;">
      <tr>
        <td style="padding:3px 12px 3px 0;color:#555;width:110px;">Besøk-nr:</td>
        <td style="padding:3px 0;font-weight:700;">${detail.id}</td>
        <td style="padding:3px 12px 3px 24px;color:#555;width:100px;">Renholder:</td>
        <td style="padding:3px 0;font-weight:700;">${escapeHtml(detail.cleaner_name)}</td>
      </tr>
      <tr>
        <td style="padding:3px 12px 3px 0;color:#555;">Registrert:</td>
        <td style="padding:3px 0;">${detail.started_at.slice(0, 16)}</td>
        <td style="padding:3px 12px 3px 24px;color:#555;">Status:</td>
        <td style="padding:3px 0;">${escapeHtml(formatStatus(detail))}</td>
      </tr>
    </table>

    ${sectionsHtml}
    ${deviationsHtml}
  </div>`;
}

export async function buildReportHtml(detail) {
  return `<!doctype html>
<html lang="no">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Renholdsrapport — ${escapeHtml(detail.site_name)}</title>
</head>
<body style="margin:0;padding:24px;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;">
  ${await buildReportBody(detail)}
</body>
</html>`;
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
