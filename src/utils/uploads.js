// Multer's disk storage does a bare path.join(destination, filename) with no sanitization of its
// own (confirmed by reading node_modules/multer/storage/disk.js) — file.originalname is
// attacker-controlled multipart form data, so a name containing "/" or "\" segments (e.g.
// "../../../etc/whatever") could otherwise escape the uploads directory. Stripping every path
// separator collapses the name to one literal segment, so no ".." sequence can function as a
// directory traversal, regardless of platform (Linux in production, Windows in local dev).
export function safeOriginalName(originalname) {
  return String(originalname).replace(/[/\\]/g, "_");
}
