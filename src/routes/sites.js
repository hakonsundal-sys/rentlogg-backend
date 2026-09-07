import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { newQrToken, qrLabelSvgDataUrl } from "../utils/qrcode.js";
import { findRunForSiteDate, todayInOslo } from "../services/schedule.js";
import { safeOriginalName } from "../utils/uploads.js";

export const sitesRouter = Router();

const docUpload = multer({
  storage: multer.diskStorage({
    destination: process.env.UPLOADS_DIR || "uploads/",
    filename: (req, file, cb) => cb(null, `${Date.now()}-${safeOriginalName(file.originalname)}`),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

function scopeSitesForUser(user) {
  if (user.role === "customer") {
    return db.prepare("SELECT * FROM sites WHERE client_id = ? ORDER BY name").all(user.client_id);
  }
  // company_id is null for a role with no company (only super_admin) — WHERE company_id = ?
  // against null naturally matches nothing, so that role sees no operational sites by default
  // rather than needing its own special-cased branch.
  return db.prepare("SELECT * FROM sites WHERE company_id = ? ORDER BY name").all(user.company_id);
}

// Shared ownership check reused across every :id-scoped route below — fetches the site once and
// applies whichever scoping rule matches the caller's role: customer is scoped to their own
// client's sites, every staff role is scoped to their own company's sites.
function getSiteScoped(siteId, user) {
  const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(siteId);
  if (!site) return { status: 404, error: "Not found" };
  if (user.role === "customer" && site.client_id !== user.client_id) return { status: 403, error: "Not allowed" };
  if (user.role !== "customer" && site.company_id !== user.company_id) return { status: 403, error: "Not allowed" };
  return { site };
}

sitesRouter.get("/", requireAuth, (req, res) => {
  res.json(scopeSitesForUser(req.user));
});

sitesRouter.post("/", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { name, client_id, department_id, address, checklist_template_id, latitude, longitude, gps_radius_meters, room_count, report_recipients } = req.body;
  if (!name || !client_id) return res.status(400).json({ error: "name and client_id are required" });

  const client = db.prepare("SELECT company_id FROM clients WHERE id = ?").get(client_id);
  if (!client || client.company_id !== req.user.company_id) {
    return res.status(400).json({ error: "Ukjent kunde" });
  }
  if (department_id) {
    const department = db.prepare("SELECT company_id FROM departments WHERE id = ?").get(department_id);
    if (!department || department.company_id !== req.user.company_id) {
      return res.status(400).json({ error: "Ukjent avdeling" });
    }
  }
  if (checklist_template_id) {
    const template = db.prepare("SELECT company_id FROM checklist_templates WHERE id = ?").get(checklist_template_id);
    if (!template || template.company_id !== req.user.company_id) {
      return res.status(400).json({ error: "Ukjent sjekklistemal" });
    }
  }

  const qr_token = newQrToken();
  const info = db
    .prepare(
      `INSERT INTO sites (name, client_id, department_id, company_id, address, checklist_template_id, qr_token, latitude, longitude, gps_radius_meters, room_count, report_recipients)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(name, client_id, department_id || null, req.user.company_id, address || null, checklist_template_id || null, qr_token, latitude || null, longitude || null, gps_radius_meters || 150, room_count || 0, report_recipients || null);

  res.status(201).json({ id: info.lastInsertRowid, qr_token });
});

const SITE_PATCH_FIELDS = ["name", "client_id", "department_id", "address", "checklist_template_id", "latitude", "longitude", "gps_radius_meters", "room_count", "report_recipients"];

sitesRouter.patch("/:id", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { site, status, error } = getSiteScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ error });

  const fields = SITE_PATCH_FIELDS.filter((f) => f in req.body);
  if (fields.length === 0) return res.status(400).json({ error: "No valid fields to update" });

  if (req.body.client_id) {
    const client = db.prepare("SELECT company_id FROM clients WHERE id = ?").get(req.body.client_id);
    if (!client || client.company_id !== req.user.company_id) {
      return res.status(400).json({ error: "Ukjent kunde" });
    }
  }
  if (req.body.checklist_template_id) {
    const template = db.prepare("SELECT company_id FROM checklist_templates WHERE id = ?").get(req.body.checklist_template_id);
    if (!template || template.company_id !== req.user.company_id) {
      return res.status(400).json({ error: "Ukjent sjekklistemal" });
    }
  }
  if (req.body.department_id) {
    const department = db.prepare("SELECT company_id FROM departments WHERE id = ?").get(req.body.department_id);
    if (!department || department.company_id !== req.user.company_id) {
      return res.status(400).json({ error: "Ukjent avdeling" });
    }
  }

  const setClause = fields.map((f) => `${f} = ?`).join(", ");
  const values = fields.map((f) => req.body[f]);
  db.prepare(`UPDATE sites SET ${setClause} WHERE id = ?`).run(...values, site.id);

  res.json(db.prepare("SELECT * FROM sites WHERE id = ?").get(site.id));
});

sitesRouter.delete("/:id", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { site, status, error } = getSiteScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ error });

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
    db.prepare("DELETE FROM site_documents WHERE site_id = ?").run(siteId);

    db.prepare("DELETE FROM sites WHERE id = ?").run(siteId);
  });

  deleteCascade(req.params.id);
  res.json({ ok: true });
});

// --- Recurring weekly schedule ---

sitesRouter.get("/:id/schedule", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { status, error } = getSiteScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ error });

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
  const { status: scopeStatus, error: scopeError } = getSiteScoped(req.params.id, req.user);
  if (scopeError) return res.status(scopeStatus).json({ error: scopeError });

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
  const { status, error } = getSiteScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ error });

  db.prepare("DELETE FROM site_schedules WHERE site_id = ? AND weekday = ?").run(req.params.id, req.params.weekday);
  res.json({ ok: true });
});

// --- Documents (floor plans, PDFs, etc.), visibility-scoped by role ---

// Staff (admin/manager/cleaner) see 'staff'/'both'; customer sees 'customer'/'both' and only
// for their own client's site — same scoping every other customer-facing route already uses.
sitesRouter.get("/:id/documents", requireAuth, (req, res) => {
  const { site, status, error } = getSiteScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ error });

  const visibleTo = req.user.role === "customer" ? ["customer", "both"] : ["staff", "both"];
  const docs = db
    .prepare(
      `SELECT * FROM site_documents WHERE site_id = ? AND visibility IN (${visibleTo.map(() => "?").join(",")}) ORDER BY created_at DESC`
    )
    .all(site.id, ...visibleTo);
  res.json(docs);
});

sitesRouter.post("/:id/documents", requireAuth, requireRole("admin", "manager"), docUpload.single("file"), (req, res) => {
  const { site, status, error } = getSiteScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ error });
  if (!req.file) return res.status(400).json({ error: "Ingen fil valgt." });

  const name = (req.body.name || req.file.originalname || "Dokument").trim();
  const visibility = ["staff", "customer", "both"].includes(req.body.visibility) ? req.body.visibility : "both";
  const info = db
    .prepare("INSERT INTO site_documents (site_id, name, file_path, visibility) VALUES (?, ?, ?, ?)")
    .run(site.id, name, path.join("uploads", req.file.filename), visibility);

  res.status(201).json({ id: info.lastInsertRowid, name, file_path: req.file.filename, visibility });
});

sitesRouter.delete("/:id/documents/:docId", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { status: scopeStatus, error: scopeError } = getSiteScoped(req.params.id, req.user);
  if (scopeError) return res.status(scopeStatus).json({ error: scopeError });

  const doc = db.prepare("SELECT * FROM site_documents WHERE id = ? AND site_id = ?").get(req.params.docId, req.params.id);
  if (!doc) return res.status(404).json({ error: "Not found" });

  const uploadsDir = process.env.UPLOADS_DIR || "uploads";
  fs.rmSync(path.join(uploadsDir, path.basename(doc.file_path)), { force: true });
  db.prepare("DELETE FROM site_documents WHERE id = ?").run(doc.id);
  res.json({ ok: true });
});

// Returns a scannable QR image (data URL) that encodes the check-in link for this site.
sitesRouter.get("/:id/qr", requireAuth, requireRole("admin", "manager"), async (req, res) => {
  const { site, status, error } = getSiteScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ error });

  const baseUrl = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:4000";
  const checkInUrl = `${baseUrl}/checkin/${site.qr_token}`;
  try {
    const dataUrl = await qrLabelSvgDataUrl(checkInUrl, site.name, site.qr_token);
    res.json({ checkInUrl, qrImage: dataUrl });
  } catch (err) {
    console.error("QR generation error:", err);
    res.status(500).json({ error: "Kunne ikke generere QR-kode." });
  }
});

// Called when a cleaner scans the QR code. Reuses today's run for this site if one already
// exists (whether completed or not — mirrors findOrCreateTodayRoomRun's behavior for rooms),
// so re-scanning the same site later the same day never creates a second checklist. Only a
// genuinely new day creates a new run, pre-filled from the site's template. Also does a basic
// GPS distance check if coordinates are provided.
sitesRouter.post("/checkin/:qrToken", requireAuth, requireRole("cleaner"), (req, res) => {
  const site = db.prepare("SELECT * FROM sites WHERE qr_token = ?").get(req.params.qrToken);
  // Same "unknown QR code" message for a genuinely unknown token and one belonging to another
  // company — a cleaner scanning a foreign QR shouldn't learn that a matching site exists.
  if (!site || site.company_id !== req.user.company_id) return res.status(404).json({ error: "Unknown QR code" });

  const { latitude, longitude } = req.body;
  let gps_verified = 0;
  if (latitude != null && longitude != null && site.latitude != null && site.longitude != null) {
    gps_verified = haversineMeters(latitude, longitude, site.latitude, site.longitude) <= site.gps_radius_meters ? 1 : 0;
  }

  const existing = findRunForSiteDate(site.id, todayInOslo());
  if (existing) {
    return res.json({ runId: existing.id, site, gps_verified: !!existing.gps_verified });
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
