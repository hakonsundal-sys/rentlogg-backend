import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";

const PRIORITY_LABELS = { low: "Lav", medium: "Middels", high: "Høy" };

function publicBaseUrl() {
  return process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:4000";
}

function photoUrl(filePath) {
  const filename = filePath.split(/[\\/]/).pop();
  return `${publicBaseUrl()}/uploads/${filename}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// Room-enabled sites report per room (their real structure); flat/legacy sites fall back to a
// single "Sjekkliste" section built from the run's own items/photos — same fallback shape the
// rest of the app already uses wherever rooms vs. flat is a branch point.
function buildSections(detail) {
  if (detail.rooms?.length > 0) {
    return detail.rooms.map((room) => ({ title: room.name, items: room.items, photos: room.photos }));
  }
  return [{ title: "Sjekkliste", items: detail.items, photos: detail.photos }];
}

function formatStatus(detail) {
  if (detail.completed_at) {
    return `Ferdigstilt ${detail.completed_at.slice(0, 16)}${detail.signed_initials ? ` av ${detail.signed_initials}` : ""}`;
  }
  return "Pågår";
}

export function buildReportHtml(detail) {
  const sections = buildSections(detail);

  const sectionsHtml = sections
    .map((section, sIdx) => {
      const num = sIdx + 1;
      const itemsHtml = section.items
        .map((item, iIdx) => `
          <div style="padding:8px 14px;border:1px solid #ddd;border-top:none;font-size:13px;display:flex;justify-content:space-between;gap:12px;">
            <span>${num}.${iIdx + 1} ${escapeHtml(item.label)}</span>
            <span style="white-space:nowrap;font-weight:600;color:${item.done ? "#0a7a2f" : "#c0392b"};">${item.done ? "✓ Utført" : "✗ Ikke utført"}</span>
          </div>`)
        .join("");

      const photosHtml = section.photos?.length
        ? `<div style="padding:10px 14px;border:1px solid #ddd;border-top:none;display:flex;flex-wrap:wrap;gap:8px;">
             ${section.photos.map((p) => `<a href="${photoUrl(p.file_path)}" target="_blank"><img src="${photoUrl(p.file_path)}" alt="" style="width:180px;height:180px;object-fit:cover;border-radius:4px;border:1px solid #ddd;"></a>`).join("")}
           </div>`
        : "";

      return `
        <div style="background:#efefef;padding:10px 14px;font-weight:700;font-size:15px;border:1px solid #ddd;margin-top:22px;">${num}. ${escapeHtml(section.title)}</div>
        ${itemsHtml || `<div style="padding:10px 14px;border:1px solid #ddd;border-top:none;font-size:13px;color:#777;">Ingen oppgaver registrert.</div>`}
        ${photosHtml}`;
    })
    .join("");

  const deviationsHtml = detail.deviations?.length
    ? `
      <div style="background:#fdecea;padding:10px 14px;font-weight:700;font-size:15px;border:1px solid #f1b0b7;margin-top:26px;color:#611a15;">Avvik</div>
      ${detail.deviations
        .map((d) => `
          <div style="padding:12px 14px;border:1px solid #f1b0b7;border-top:none;font-size:13px;">
            <div style="font-weight:600;">${d.room_name ? escapeHtml(d.room_name) + (d.room_task_label ? " · " + escapeHtml(d.room_task_label) : "") : "Generelt"}
              <span style="font-weight:400;color:#777;"> — ${PRIORITY_LABELS[d.priority] || d.priority}</span>
            </div>
            <div style="margin-top:4px;">${escapeHtml(d.description)}</div>
            ${d.reported_by_initials ? `<div style="margin-top:4px;color:#777;">Meldt av: ${escapeHtml(d.reported_by_initials)}</div>` : ""}
            ${d.photos?.length ? `
              <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:8px;">
                ${d.photos.map((p) => `<a href="${photoUrl(p.file_path)}" target="_blank"><img src="${photoUrl(p.file_path)}" alt="" style="width:140px;height:140px;object-fit:cover;border-radius:4px;border:1px solid #f1b0b7;"></a>`).join("")}
              </div>` : ""}
            ${d.reply_text ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid #f1b0b7;color:#333;">Svar: ${escapeHtml(d.reply_text)} — ${escapeHtml(d.replied_by_initials)}</div>` : ""}
          </div>`)
        .join("")}`
    : "";

  return `<!doctype html>
<html lang="no">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Renholdsrapport — ${escapeHtml(detail.site_name)}</title>
</head>
<body style="margin:0;padding:24px;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;">
  <div style="max-width:760px;margin:0 auto;">
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
  </div>
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
    doc.image(absolutePath, startX + col * (boxSize + gap), rowY, { fit: [boxSize, boxSize] });
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
    doc.moveDown();
  });

  if (detail.deviations?.length > 0) {
    if (doc.y > doc.page.height - 120) doc.addPage();
    doc.fontSize(13).fillColor("red").text("Avvik", { underline: true });
    doc.moveDown(0.3);
    detail.deviations.forEach((d) => {
      if (doc.y > doc.page.height - 100) doc.addPage();
      const where = d.room_name ? `${d.room_name}${d.room_task_label ? " · " + d.room_task_label : ""}` : "Generelt";
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
