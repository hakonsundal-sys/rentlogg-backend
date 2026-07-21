import QRCode from "qrcode";
import crypto from "node:crypto";

export function newQrToken() {
  return crypto.randomBytes(12).toString("hex");
}

export async function qrPngDataUrl(checkInUrl) {
  return QRCode.toDataURL(checkInUrl, { margin: 1, width: 320 });
}
