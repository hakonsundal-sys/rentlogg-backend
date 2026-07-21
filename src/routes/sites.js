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
  const { name, client_id, address, checklist_template_id, latitude, longitude, gps_radius_meters } = req.body;
  if (!name || !client_id) return res.status(400).json({ error: "name and client_id are required" });

  const qr_token = newQrToken();
  const info = db
    .prepare(
      `INSERT INTO sites (name, client_id, address, checklist_template_id, qr_token, latitude, longitude, gps_radius_meters)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(name, client_id, address || null, checklist_template_id || null, qr_token, latitude || null, longitude || null, gps_radius_meters || 150);

  res.status(201).json({ id: info.lastInsertRowid, qr_token });
});

// Returns a scannable QR image (data URL) that encodes the check-in link for this site.
sitesRouter.get("/:id/qr", requireAuth, requireRole("admin", "manager"), async (req, res) => {
  const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(req.params.id);
  if (!site) return res.status(404).json({ error: "Not found" });

  const checkInUrl = `${process.env.PUBLIC_BASE_URL}/checkin/${site.qr_token}`;
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
