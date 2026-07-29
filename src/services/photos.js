import fs from "node:fs";
import path from "node:path";
import { ZipArchive } from "archiver";
import { db } from "../db.js";
import { toOsloDateStr } from "./schedule.js";

// A "checklist report" spans one or more site-level checklist_runs. Their photos live in two
// places: flat run-level photos (photos.run_id) and, for room-enabled sites, each room's photos
// for that same Oslo calendar day (photos.room_run_id) — the same day-matching approach used
// by the run detail endpoint. This gathers both so a photo download always matches what the
// report's UI shows, not just the flat legacy set.
export function gatherReportPhotos(runs) {
  if (runs.length === 0) return [];

  const runIds = runs.map((r) => r.id);
  const flatPhotos = db
    .prepare(`SELECT * FROM photos WHERE run_id IN (${runIds.map(() => "?").join(",")})`)
    .all(...runIds);

  const siteIds = [...new Set(runs.map((r) => r.site_id))];
  const roomIdsBySite = new Map(
    siteIds.map((siteId) => [siteId, db.prepare("SELECT id FROM rooms WHERE site_id = ?").all(siteId).map((r) => r.id)])
  );

  const roomRunCandidatesStmt = db.prepare(
    `SELECT id, started_at FROM room_runs
     WHERE room_id = ? AND date(started_at) BETWEEN date(?, '-1 day') AND date(?, '+1 day')`
  );
  const roomPhotosStmt = db.prepare("SELECT * FROM photos WHERE room_run_id = ?");

  const roomPhotos = [];
  for (const run of runs) {
    const dateStr = toOsloDateStr(run.started_at);
    for (const roomId of roomIdsBySite.get(run.site_id) || []) {
      const match = roomRunCandidatesStmt
        .all(roomId, dateStr, dateStr)
        .find((c) => toOsloDateStr(c.started_at) === dateStr);
      if (match) roomPhotos.push(...roomPhotosStmt.all(match.id));
    }
  }

  const seen = new Set();
  return [...flatPhotos, ...roomPhotos].filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
}

export function streamPhotosZip(res, photos, zipFilename) {
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename=${zipFilename}`);

  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on("error", (err) => {
    console.error("Zip stream error:", err);
    res.destroy(err);
  });
  archive.pipe(res);

  const uploadsDir = process.env.UPLOADS_DIR || "uploads";
  const usedNames = new Set();
  photos.forEach((photo) => {
    const absolutePath = path.join(uploadsDir, path.basename(photo.file_path));
    if (!fs.existsSync(absolutePath)) return;
    let name = path.basename(photo.file_path);
    while (usedNames.has(name)) name = `${Date.now()}-${name}`;
    usedNames.add(name);
    archive.file(absolutePath, { name });
  });

  archive.finalize();
}
