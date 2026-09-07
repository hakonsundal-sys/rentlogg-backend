import sharp from "sharp";
import fs from "node:fs/promises";

// Multer's disk storage does a bare path.join(destination, filename) with no sanitization of its
// own (confirmed by reading node_modules/multer/storage/disk.js) — file.originalname is
// attacker-controlled multipart form data, so a name containing "/" or "\" segments (e.g.
// "../../../etc/whatever") could otherwise escape the uploads directory. Stripping every path
// separator collapses the name to one literal segment, so no ".." sequence can function as a
// directory traversal, regardless of platform (Linux in production, Windows in local dev).
export function safeOriginalName(originalname) {
  return String(originalname).replace(/[/\\]/g, "_");
}

// Phone cameras routinely save a photo with its pixel data in the sensor's native orientation
// plus an EXIF "Orientation" tag telling a viewer how to rotate it for display. Browsers honor
// that tag (so an uploaded photo looks right in the app), but pdfkit's doc.image() draws the raw
// pixel data as-is and ignores it — the exact "looks fine in the app, sideways in the PDF report"
// bug this fixes. Baking the rotation into the pixel data once, right after upload, fixes it for
// every consumer (PDF, thumbnails, zip downloads) instead of patching each renderer separately.
// sharp can't read and write the same path in one pipeline, hence the write-to-temp-then-rename.
export async function normalizeImageOrientation(absolutePath) {
  const tempPath = `${absolutePath}.rotated`;
  try {
    await sharp(absolutePath).rotate().toFile(tempPath);
    await fs.rename(tempPath, absolutePath);
  } catch (err) {
    // Best-effort: an unsupported format or already-corrupt file should never block the upload
    // itself, just leave the original bytes in place.
    await fs.rm(tempPath, { force: true });
    console.error("Kunne ikke normalisere bilderetning:", err.message);
  }
}
