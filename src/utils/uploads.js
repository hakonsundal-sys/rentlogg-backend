import sharp from "sharp";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

// Multer's disk storage does a bare path.join(destination, filename) with no sanitization of its
// own (confirmed by reading node_modules/multer/storage/disk.js) — file.originalname is
// attacker-controlled multipart form data, so a name containing "/" or "\" segments (e.g.
// "../../../etc/whatever") could otherwise escape the uploads directory. Stripping every path
// separator collapses the name to one literal segment, so no ".." sequence can function as a
// directory traversal, regardless of platform (Linux in production, Windows in local dev).
export function safeOriginalName(originalname) {
  return String(originalname).replace(/[/\\]/g, "_");
}

// Every DELETE route that removes a photo/document row also owns the file on disk — this is
// the one place that turns a stored file_path back into an absolute path so every call site
// unlinks it the same way (uploads/:id/photos/:photoId already did this inline; the bulk-delete
// cascades in sites.js/rooms.js/checklists.js/deviations.js previously only deleted the DB rows
// and silently orphaned the files, which stayed fetchable forever through /uploads).
export function removeUploadedFile(filePath) {
  if (!filePath) return;
  const uploadsDir = process.env.UPLOADS_DIR || "uploads";
  fsSync.rmSync(path.join(uploadsDir, path.basename(filePath)), { force: true });
}

// multer forwards a fileFilter's cb(error) straight into Express's error chain as that exact
// error object (not wrapped as a MulterError) — this lets server.js's error handler tell "wrong
// file type" apart from a genuinely unexpected error and answer with a clean 400 instead of 500.
export class UploadRejectedError extends Error {}

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"]);
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

// multer's fileFilter runs before the file ever touches disk. Rejecting anything outside a
// known-safe image type here (not just trusting the client-sent mimetype, which is spoofable —
// the extension check is the one that actually matters, since express.static/res.sendFile
// derive Content-Type from the stored file's extension) closes off uploading e.g. an .html or
// .svg file that would otherwise get served back with an executable content-type.
export function imageFileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext) || !IMAGE_MIME_TYPES.has(file.mimetype)) {
    return cb(new UploadRejectedError("Bare bildefiler (JPG, PNG, WEBP, HEIC) er tillatt."));
  }
  cb(null, true);
}

const DOCUMENT_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ".pdf"]);
const DOCUMENT_MIME_TYPES = new Set([...IMAGE_MIME_TYPES, "application/pdf"]);

// Site documents (floor plans, contracts) are the one upload type that legitimately needs PDF
// on top of images — everything else in the app only ever uploads photos.
export function documentFileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!DOCUMENT_EXTENSIONS.has(ext) || !DOCUMENT_MIME_TYPES.has(file.mimetype)) {
    return cb(new UploadRejectedError("Bare bilder eller PDF er tillatt."));
  }
  cb(null, true);
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
