import { Router } from "express";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { newQrToken, qrPngDataUrl } from "../utils/qrcode.js";

export const sitesRouter = Router();

function scopeSitesForUser(user) {
  if (user.role === "customer") {
    return db.prepare("SELECT * FROM sites WHERE client_id = ? ORDER BY name").all(user.client_id);
  }
  return db.prepare("SELECT * FROM sites ORDER BY name").all();
}

sitesRouter.get("/", requireAuth, (req, res) => {
  res.json(scopeSitesForUser(req.user));
});

sitesRouter.post("/", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { name, client_id, address, checklist_template_id, latitude, longitude, gps_radius_meters, room_count } = req.body;
  if (!name || !client_id) return res.status(400).json({ error: "name and client_id are required" });

  const qr_token = newQrToken();
  const info = db
    .prepare(
      `INSERT INTO sites (name, client_id, address, checklist_template_id, qr_token, latitude, longitude, gps_radius_meters, room_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(name, client_id, address || null, checklist_template_id || null, qr_token, latitude || null, longitude || null, gps_radius_meters || 150, room_count || 0);

  res.status(201).json({ id: info.lastInsertRowid, qr_token });
});

const SITE_PATCH_FIELDS = ["name", "client_id", "address", "checklist_template_id", "latitude", "longitude", "gps_radius_meters", "room_count"];

sitesRouter.patch("/:id", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const fields = SITE_PATCH_FIELDS.filter((f) => f in req.body);
  if (fields.length === 0) return res.status(400).json({ error: "No valid fields to update" });

  const setClause = fields.map((f) => `${f} = ?`).join(", ");
  const values = fields.map((f) => req.body[f]);
  const info = db.prepare(`UPDATE sites SET ${setClause} WHERE id = ?`).run(...values, req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: "Not found" });

  res.json(db.prepare("SELECT * FROM sites WHERE id = ?").get(req.params.id));
});

sitesRouter.delete("/:id", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const site = db.prepare("SELECT id FROM sites WHERE id = ?").get(req.params.id);
  if (!site) return res.status(404).json({ error: "Not found" });

  const deleteCascade = db.transaction((siteId) => {
    const runIds = db.prepare("SELECT id FROM checklist_runs WHERE site_id = ?").all(siteId).map((r) => r.id);
    const deviationIds = db.prepare("SELECT id FROM deviations WHERE site_id = ?").all(siteId).map((d) => d.id);

    if (runIds.length) {
      const placeholders = runIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM photos WHERE run_id IN (${placeholders})`).run(...runIds);
      db.prepare(`DELETE FROM checklist_run_items WHERE run_id IN (${placeholders})`).run(...runIds);
    }
    if (deviationIds.length) {
      const placeholders = deviationIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM photos WHERE deviation_id IN (${placeholders})`).run(...deviationIds);
    }
    db.prepare("DELETE FROM deviations WHERE site_id = ?").run(siteId);
    db.prepare("DELETE FROM checklist_runs WHERE site_id = ?").run(siteId);
    db.prepare("DELETE FROM site_schedules WHERE site_id = ?").run(siteId);

    const roomIds = db.prepare("SELECT id FROM rooms WHERE site_id = ?").all(siteId).map((r) => r.id);
    if (roomIds.length) {
      const roomPlaceholders = roomIds.map(() => "?").join(",");
      const roomRunIds = db
        .prepare(`SELECT id FROM room_runs WHERE room_id IN (${roomPlaceholders})`)
        .all(...roomIds)
        .map((r) => r.id);
      if (roomRunIds.length) {
        const runPlaceholders = roomRunIds.map(() => "?").join(",");
        db.prepare(`DELETE FROM photos WHERE room_run_id IN (${runPlaceholders})`).run(...roomRunIds);
        db.prepare(`DELETE FROM room_run_items WHERE room_run_id IN (${runPlaceholders})`).run(...roomRunIds);
      }
      db.prepare(`DELETE FROM room_runs WHERE room_id IN (${roomPlaceholders})`).run(...roomIds);
      db.prepare(`DELETE FROM room_schedules WHERE room_id IN (${roomPlaceholders})`).run(...roomIds);
      db.prepare(`DELETE FROM room_checklist_items WHERE room_id IN (${roomPlaceholders})`).run(...roomIds);
    }
    db.prepare("DELETE FROM rooms WHERE site_id = ?").run(siteId);

    db.prepare("DELETE FROM sites WHERE id = ?").run(siteId);
  });

  deleteCascade(req.params.id);
  res.json({ ok: true });
});

// --- Recurring weekly schedule ---

sitesRouter.get("/:id/schedule", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const rows = db
    .prepare(
      `SELECT sch.id, sch.weekday, sch.assigned_cleaner_id, u.name AS assigned_cleaner_name
       FROM site_schedules sch
       LEFT JOIN users u ON u.id = sch.assigned_cleaner_id
       WHERE sch.site_id = ?
       ORDER BY sch.weekday`
    )
    .all(req.params.id);
  res.json(rows);
});

sitesRouter.post("/:id/schedule", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { weekday, assigned_cleaner_id } = req.body;
  if (weekday === undefined || weekday === null || weekday < 0 || weekday > 6) {
    return res.status(400).json({ error: "weekday (0-6) is required" });
  }

  db.prepare(
    `INSERT INTO site_schedules (site_id, weekday, assigned_cleaner_id) VALUES (?, ?, ?)
     ON CONFLICT(site_id, weekday) DO UPDATE SET assigned_cleaner_id = excluded.assigned_cleaner_id`
  ).run(req.params.id, weekday, assigned_cleaner_id || null);

  const row = db
    .prepare(
      `SELECT sch.id, sch.weekday, sch.assigned_cleaner_id, u.name AS assigned_cleaner_name
       FROM site_schedules sch LEFT JOIN users u ON u.id = sch.assigned_cleaner_id
       WHERE sch.site_id = ? AND sch.weekday = ?`
    )
    .get(req.params.id, weekday);
  res.status(201).json(row);
});

sitesRouter.delete("/:id/schedule/:weekday", requireAuth, requireRole("admin", "manager"), (req, res) => {
  db.prepare("DELETE FROM site_schedules WHERE site_id = ? AND weekday = ?").run(req.params.id, req.params.weekday);
  res.json({ ok: true });
});

// Returns a scannable QR image (data URL) that encodes the check-in link for this site.
sitesRouter.get("/:id/qr", requireAuth, requireRole("admin", "manager"), async (req, res) => {
  const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(req.params.id);
  if (!site) return res.status(404).json({ error: "Not found" });

  const baseUrl = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:4000";
  const checkInUrl = `${baseUrl}/checkin/${site.qr_token}`;
  const dataUrl = await qrPngDataUrl(checkInUrl);
  res.json({ checkInUrl, qrImage: dataUrl });
});

// Called when a cleaner scans the QR code. Creates a checklist run pre-filled
// from the site's template, and does a basic GPS distance check if coordinates are provided.
sitesRouter.post("/checkin/:qrToken", requireAuth, requireRole("cleaner"), (req, res) => {
  const site = db.prepare("SELECT * FROM sites WHERE qr_token = ?").get(req.params.qrToken);
  if (!site) return res.status(404).json({ error: "Unknown QR code" });

  const { latitude, longitude } = req.body;
  let gps_verified = 0;
  if (latitude != null && longitude != null && site.latitude != null && site.longitude != null) {
    gps_verified = haversineMeters(latitude, longitude, site.latitude, site.longitude) <= site.gps_radius_meters ? 1 : 0;
  }

  const runInfo = db
    .prepare("INSERT INTO checklist_runs (site_id, cleaner_id, gps_verified, latitude, longitude) VALUES (?, ?, ?, ?, ?)")
    .run(site.id, req.user.id, gps_verified, latitude || null, longitude || null);

  const templateItems = site.checklist_template_id
    ? db.prepare("SELECT * FROM checklist_template_items WHERE template_id = ? ORDER BY sort_order").all(site.checklist_template_id)
    : [];

  const insertItem = db.prepare("INSERT INTO checklist_run_items (run_id, label, sort_order) VALUES (?, ?, ?)");
  templateItems.forEach((item, i) => insertItem.run(runInfo.lastInsertRowid, item.label, i));

  res.status(201).json({ runId: runInfo.lastInsertRowid, site, gps_verified: !!gps_verified });
});

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
