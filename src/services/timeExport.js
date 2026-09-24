import { ZipArchive } from "archiver";
import PDFDocument from "pdfkit";

// Excel- og PDF-eksport av timelista. Mobile Worker offers both from its "Mer" menu, and they are
// read by different people: the spreadsheet by whoever moves hours into payroll, the PDF by whoever
// wants a month on paper to sign or file.
//
// No new dependency for either — archiver and pdfkit are already in the project (the site-document
// zip and the training certificate). An .xlsx is a zip of XML parts, which is exactly what archiver
// is for; writing it by hand is a few dozen lines and avoids adding a library for one route.

// --- Excel ---------------------------------------------------------------------------------------

function escapeXml(value) {
  return [...String(value ?? "")]
    // Excel refuses to open the whole file over a single control character, and those do turn up
    // in pasted notes. Filtered by code point rather than by a regex literal, so no amount of
    // escaping between here and the file can quietly turn the class into something else.
    .filter((ch) => {
      const code = ch.codePointAt(0);
      return code > 31 || code === 9 || code === 10 || code === 13;
    })
    .map((ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[ch] ?? ch))
    .join("");
}

function columnName(index) {
  let name = "";
  let n = index;
  while (n >= 0) {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  }
  return name;
}

// A number written as a number, everything else as an inline string. Inline rather than a shared
// strings table: it makes the file bigger and the code far shorter, and a month of hours is a few
// hundred kilobytes either way.
function cellXml(value, rowIndex, colIndex) {
  const ref = `${columnName(colIndex)}${rowIndex + 1}`;
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`;
  }
  const text = String(value ?? "");
  if (!text) return `<c r="${ref}"/>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}

function sheetXml(rows) {
  const body = rows
    .map((row, r) => `<row r="${r + 1}">${row.map((v, c) => cellXml(v, r, c)).join("")}</row>`)
    .join("");
  // The header row is frozen, because a timesheet is scrolled and a column you cannot name is
  // useless.
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${body}</sheetData></worksheet>`;
}

// Streams a single-sheet .xlsx straight to the response. `rows` is an array of arrays; a cell that
// is a JS number lands as a number in Excel, so the hour columns can be summed there without
// anybody having to re-type them.
export function sendXlsx(res, { filename, sheetName = "Timer", rows }) {
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename=${filename}`);

  const zip = new ZipArchive({ zlib: { level: 9 } });
  zip.on("error", (err) => {
    console.error("xlsx zip error:", err);
    if (!res.headersSent) res.status(500).json({ code: "export_failed", error: "Kunne ikke lage Excel-filen." });
  });
  zip.pipe(res);

  zip.append(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    { name: "[Content_Types].xml" }
  );
  zip.append(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    { name: "_rels/.rels" }
  );
  zip.append(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    { name: "xl/workbook.xml" }
  );
  zip.append(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    { name: "xl/_rels/workbook.xml.rels" }
  );
  zip.append(sheetXml(rows), { name: "xl/worksheets/sheet1.xml" });
  zip.finalize();
}

// --- PDF -----------------------------------------------------------------------------------------

// Landscape, because a timesheet is wide. Columns are laid out proportionally to the widths the
// caller gives, so the hour columns stay narrow and the names get room.
export function sendTimesheetPdf(res, { filename, title, subtitle, columns, rows, totals }) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=${filename}`);

  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 28 });
  doc.pipe(res);

  const left = doc.page.margins.left;
  const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const weightTotal = columns.reduce((sum, c) => sum + (c.width || 1), 0);
  const widths = columns.map((c) => ((c.width || 1) / weightTotal) * usable);

  function header() {
    doc.font("Helvetica-Bold").fontSize(14).fillColor("#111").text(title, left, doc.page.margins.top);
    doc.font("Helvetica").fontSize(9).fillColor("#666").text(subtitle, { continued: false });
    doc.moveDown(0.6);
    drawRow(columns.map((c) => c.label), { bold: true, background: "#f0f0f0" });
  }

  function drawRow(values, { bold = false, background = null } = {}) {
    const y = doc.y;
    const height = 16;
    // A page break has to redraw the header, or page four is a wall of unlabelled numbers.
    if (y + height > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      header();
      return drawRow(values, { bold, background });
    }
    if (background) doc.rect(left, y - 2, usable, height).fill(background);
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8).fillColor("#111");
    let x = left;
    values.forEach((value, i) => {
      doc.text(String(value ?? ""), x + 3, y + 2, {
        width: widths[i] - 6,
        align: columns[i].align || "left",
        lineBreak: false,
        ellipsis: true,
      });
      x += widths[i];
    });
    doc.y = y + height;
    return undefined;
  }

  header();
  for (const row of rows) drawRow(row);
  if (totals) {
    doc.moveDown(0.2);
    drawRow(totals, { bold: true, background: "#f0f0f0" });
  }

  doc.end();
}
