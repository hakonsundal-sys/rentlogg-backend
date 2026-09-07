import QRCode from "qrcode";
import crypto from "node:crypto";

export function newQrToken() {
  return crypto.randomBytes(12).toString("hex");
}

function escapeXml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]
  ));
}

// Bakes the site name and the raw manual-entry fallback code into the QR image itself, rather
// than only showing them as surrounding app UI — a printed/downloaded copy needs to be
// self-contained (posted on a wall, it's just the image, no app chrome around it), and the
// manual code is the fallback if a cleaner's camera can't scan it. SVG (via qrcode's own SVG
// renderer, composed with plain <text> elements) needs no new dependency and no native image
// library, unlike compositing text onto a raster PNG would.
export async function qrLabelSvgDataUrl(checkInUrl, siteName, manualCode) {
  const qrSize = 320;
  const width = qrSize + 40;
  const height = qrSize + 90;
  const qrSvg = await QRCode.toString(checkInUrl, { type: "svg", margin: 1, width: qrSize });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" fill="#ffffff"/>
<text x="${width / 2}" y="32" text-anchor="middle" font-family="Arial, sans-serif" font-size="20" font-weight="700" fill="#1a1a1a">${escapeXml(siteName)}</text>
<g transform="translate(20, 50)">${qrSvg}</g>
<text x="${width / 2}" y="${qrSize + 76}" text-anchor="middle" font-family="Arial, sans-serif" font-size="13" fill="#555555">Manuell kode: ${escapeXml(manualCode)}</text>
</svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf-8").toString("base64")}`;
}
