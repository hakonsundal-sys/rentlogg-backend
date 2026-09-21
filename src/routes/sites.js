import { Router } from "express";
import multer from "multer";
import path from "node:path";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { newQrToken, qrLabelSvgDataUrl } from "../utils/qrcode.js";
import { findRunForSiteDate, todayInOslo } from "../services/schedule.js";
import { safeOriginalName, normalizeImageOrientation, documentFileFilter, removeUploadedFile } from "../utils/uploads.js";

export const sitesRouter = Router();

const docUpload = multer({
  storage: multer.diskStorage({
    destination: process.env.UPLOADS_DIR || "uploads/",
    filename: (req, file, cb) => cb(null, `${Date.now()}-${safeOriginalName(file.originalname)}`),
  }),
  fileFilter: documentFileFilter,
  limits: { fileSize: 20 * 1024 * 1024 },
});

const siteHasCustomerRoomsStmt = db.prepare("SELECT 1 FROM rooms WHERE site_id = ? AND responsible = 'customer' LIMIT 1");

function scopeSitesForUser(user) {
  if (user.role === "customer") {
    const sites = db.prepare("SELECT * FROM sites WHERE client_id = ? ORDER BY name").all(user.client_id);
    // Lets the customer portal show a direct "fill out today's checklist" shortcut only on sites
    // where that's actually possible — most customer sites have no rooms marked responsible, and
    // showing the shortcut there would just open an empty, nothing-to-do checklist.
    return sites.map((site) => ({ ...site, has_customer_rooms: !!siteHasCustomerRoomsStmt.get(site.id) }));
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
  if (!site) return { status: 404, code: "not_found", error: "Not found" };
  if (user.role === "customer" && site.client_id !== user.client_id) return { status: 403, code: "not_allowed", error: "Not allowed" };
  if (user.role !== "customer" && site.company_id !== user.company_id) return { status: 403, code: "not_allowed", error: "Not allowed" };
  return { site };
}

sitesRouter.get("/", requireAuth, (req, res) => {
  res.json(scopeSitesForUser(req.user));
});

// null/omitted = use the scheduler's default hour; anything else must be a real hour.
function isValidSendHour(value) {
  return value == null || (Number.isInteger(value) && value >= 0 && value <= 23);
}

sitesRouter.post("/", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { name, client_id, department_id, address, checklist_template_id, latitude, longitude, gps_radius_meters, room_count, report_recipients, report_send_hour } = req.body;
  if (!name || !client_id) return res.status(400).json({ code: "name_and_client_required", error: "name and client_id are required" });
  if (!isValidSendHour(report_send_hour)) return res.status(400).json({ code: "invalid_report_hour", error: "report_send_hour må være et heltall 0–23" });

  const client = db.prepare("SELECT company_id FROM clients WHERE id = ?").get(client_id);
  if (!client || client.company_id !== req.user.company_id) {
    return res.status(400).json({ code: "unknown_client", error: "Ukjent kunde" });
  }
  if (department_id) {
    const department = db.prepare("SELECT company_id FROM departments WHERE id = ?").get(department_id);
    if (!department || department.company_id !== req.user.company_id) {
      return res.status(400).json({ code: "unknown_department", error: "Ukjent avdeling" });
    }
  }
  if (checklist_template_id) {
    const template = db.prepare("SELECT company_id FROM checklist_templates WHERE id = ?").get(checklist_template_id);
    if (!template || template.company_id !== req.user.company_id) {
      return res.status(400).json({ code: "unknown_checklist_template", error: "Ukjent sjekklistemal" });
    }
  }

  const qr_token = newQrToken();
  const info = db
    .prepare(
      `INSERT INTO sites (name, client_id, department_id, company_id, address, checklist_template_id, qr_token, latitude, longitude, gps_radius_meters, room_count, report_recipients, report_send_hour)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(name, client_id, department_id || null, req.user.company_id, address || null, checklist_template_id || null, qr_token, latitude || null, longitude || null, gps_radius_meters || 150, room_count || 0, report_recipients || null, report_send_hour ?? null);

  res.status(201).json({ id: info.lastInsertRowid, qr_token });
});

const SITE_PATCH_FIELDS = ["name", "client_id", "department_id", "address", "checklist_template_id", "latitude", "longitude", "gps_radius_meters", "room_count", "report_recipients", "report_send_hour"];

sitesRouter.patch("/:id", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { site, status, code, error } = getSiteScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ code, error });

  if ("report_send_hour" in req.body && !isValidSendHour(req.body.report_send_hour)) {
    return res.status(400).json({ code: "invalid_report_hour", error: "report_send_hour må være et heltall 0–23" });
  }

  const fields = SITE_PATCH_FIELDS.filter((f) => f in req.body);
  if (fields.length === 0) return res.status(400).json({ code: "no_valid_fields", error: "No valid fields to update" });

  if (req.body.client_id) {
    const client = db.prepare("SELECT company_id FROM clients WHERE id = ?").get(req.body.client_id);
    if (!client || client.company_id !== req.user.company_id) {
      return res.status(400).json({ code: "unknown_client", error: "Ukjent kunde" });
    }
  }
  if (req.body.checklist_template_id) {
    const template = db.prepare("SELECT company_id FROM checklist_templates WHERE id = ?").get(req.body.checklist_template_id);
    if (!template || template.company_id !== req.user.company_id) {
      return res.status(400).json({ code: "unknown_checklist_template", error: "Ukjent sjekklistemal" });
    }
  }
  if (req.body.department_id) {
    const department = db.prepare("SELECT company_id FROM departments WHERE id = ?").get(req.body.department_id);
    if (!department || department.company_id !== req.user.company_id) {
      return res.status(400).json({ code: "unknown_department", error: "Ukjent avdeling" });
    }
  }

  const setClause = fields.map((f) => `${f} = ?`).join(", ");
  const values = fields.map((f) => req.body[f]);
  db.prepare(`UPDATE sites SET ${setClause} WHERE id = ?`).run(...values, site.id);

  res.json(db.prepare("SELECT * FROM sites WHERE id = ?").get(site.id));
});

sitesRouter.delete("/:id", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { site, status, code, error } = getSiteScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ code, error });

  // Collected up front so every underlying file (not just the DB rows) is actually removed —
  // previously this cascade deleted photos/site_documents rows but left the files themselves on
  // disk, orphaned forever (and, before the /uploads auth fix, still fetchable by anyone).
  const filesToRemove = [];

  const deleteCascade = db.transaction((siteId) => {
    const runIds = db.prepare("SELECT id FROM checklist_runs WHERE site_id = ?").all(siteId).map((r) => r.id);
    const deviationIds = db.prepare("SELECT id FROM deviations WHERE site_id = ?").all(siteId).map((d) => d.id);

    if (runIds.length) {
      const placeholders = runIds.map(() => "?").join(",");
      filesToRemove.push(
        ...db.prepare(`SELECT file_path FROM photos WHERE run_id IN (${placeholders})`).all(...runIds).map((p) => p.file_path)
      );
      db.prepare(`DELETE FROM photos WHERE run_id IN (${placeholders})`).run(...runIds);
      db.prepare(`DELETE FROM checklist_run_items WHERE run_id IN (${placeholders})`).run(...runIds);
    }
    if (deviationIds.length) {
      const placeholders = deviationIds.map(() => "?").join(",");
      filesToRemove.push(
        ...db.prepare(`SELECT file_path FROM photos WHERE deviation_id IN (${placeholders})`).all(...deviationIds).map((p) => p.file_path)
      );
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
        filesToRemove.push(
          ...db.prepare(`SELECT file_path FROM photos WHERE room_run_id IN (${runPlaceholders})`).all(...roomRunIds).map((p) => p.file_path)
        );
        db.prepare(`DELETE FROM photos WHERE room_run_id IN (${runPlaceholders})`).run(...roomRunIds);
        db.prepare(
          `DELETE FROM room_run_item_options WHERE run_item_id IN
             (SELECT id FROM room_run_items WHERE room_run_id IN (${runPlaceholders}))`
        ).run(...roomRunIds);
        db.prepare(`DELETE FROM room_run_items WHERE room_run_id IN (${runPlaceholders})`).run(...roomRunIds);
      }
      db.prepare(`DELETE FROM room_runs WHERE room_id IN (${roomPlaceholders})`).run(...roomIds);
      db.prepare(`DELETE FROM room_schedules WHERE room_id IN (${roomPlaceholders})`).run(...roomIds);
      db.prepare(
        `DELETE FROM room_checklist_item_options WHERE item_id IN
           (SELECT id FROM room_checklist_items WHERE room_id IN (${roomPlaceholders}))`
      ).run(...roomIds);
      db.prepare(
        `DELETE FROM room_checklist_item_weekdays WHERE item_id IN
           (SELECT id FROM room_checklist_items WHERE room_id IN (${roomPlaceholders}))`
      ).run(...roomIds);
      db.prepare(`DELETE FROM room_checklist_items WHERE room_id IN (${roomPlaceholders})`).run(...roomIds);
    }
    db.prepare("DELETE FROM rooms WHERE site_id = ?").run(siteId);

    filesToRemove.push(...db.prepare("SELECT file_path FROM site_documents WHERE site_id = ?").all(siteId).map((d) => d.file_path));
    db.prepare("DELETE FROM site_documents WHERE site_id = ?").run(siteId);

    db.prepare("DELETE FROM sites WHERE id = ?").run(siteId);
  });

  deleteCascade(req.params.id);
  filesToRemove.forEach(removeUploadedFile);
  res.json({ ok: true });
});

// --- Recurring weekly schedule ---

sitesRouter.get("/:id/schedule", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { status, code, error } = getSiteScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ code, error });

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
    return res.status(400).json({ code: "weekday_required", error: "weekday (0-6) is required" });
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
  const { status, code, error } = getSiteScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ code, error });

  db.prepare("DELETE FROM site_schedules WHERE site_id = ? AND weekday = ?").run(req.params.id, req.params.weekday);
  res.json({ ok: true });
});

// --- Documents (floor plans, PDFs, etc.), visibility-scoped by role ---

// Staff (admin/manager/cleaner) see 'staff'/'both'; customer sees 'customer'/'both' and only
// for their own client's site — same scoping every other customer-facing route already uses.
sitesRouter.get("/:id/documents", requireAuth, (req, res) => {
  const { site, status, code, error } = getSiteScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ code, error });

  const visibleTo = req.user.role === "customer" ? ["customer", "both"] : ["staff", "both"];
  const docs = db
    .prepare(
      `SELECT * FROM site_documents WHERE site_id = ? AND visibility IN (${visibleTo.map(() => "?").join(",")}) ORDER BY created_at DESC`
    )
    .all(site.id, ...visibleTo);
  res.json(docs);
});

sitesRouter.post("/:id/documents", requireAuth, requireRole("admin", "manager"), docUpload.single("file"), async (req, res) => {
  const { site, status, code, error } = getSiteScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ code, error });
  if (!req.file) return res.status(400).json({ code: "no_file_selected", error: "Ingen fil valgt." });
  if (req.file.mimetype.startsWith("image/")) {
    await normalizeImageOrientation(path.join(process.env.UPLOADS_DIR || "uploads", req.file.filename));
  }

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
  if (!doc) return res.status(404).json({ code: "not_found", error: "Not found" });

  removeUploadedFile(doc.file_path);
  db.prepare("DELETE FROM site_documents WHERE id = ?").run(doc.id);
  res.json({ ok: true });
});

// Returns a scannable QR image (data URL) that encodes the check-in link for this site.
sitesRouter.get("/:id/qr", requireAuth, requireRole("admin", "manager"), async (req, res) => {
  const { site, status, code, error } = getSiteScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ code, error });

  const baseUrl = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:4000";
  const checkInUrl = `${baseUrl}/checkin/${site.qr_token}`;
  try {
    const dataUrl = await qrLabelSvgDataUrl(checkInUrl, site.name, site.qr_token);
    res.json({ checkInUrl, qrImage: dataUrl });
  } catch (err) {
    console.error("QR generation error:", err);
    res.status(500).json({ code: "qr_generation_failed", error: "Kunne ikke generere QR-kode." });
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
  if (!site || site.company_id !== req.user.company_id) return res.status(404).json({ code: "unknown_qr_code", error: "Unknown QR code" });

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

// Called when a customer scans the same physical QR sticker cleaners use (see App.jsx's
// ?checkin= handling) — unlike the cleaner's POST above, this has no side effects at all: it
// just resolves the token to a site (scoped to the customer's own client) so the frontend can
// jump straight to that site's "Fyll ut sjekkliste i dag" flow, same shortcut as the button on
// their dashboard. A customer has nothing analogous to a live GPS-verified check-in — they're
// not doing physical rounds — so there's no run to create here, just a lookup.
sitesRouter.get("/checkin/:qrToken", requireAuth, requireRole("customer"), (req, res) => {
  const site = db.prepare("SELECT * FROM sites WHERE qr_token = ?").get(req.params.qrToken);
  // Same "unknown QR code" message for a genuinely unknown token and one belonging to another
  // client's site — a customer scanning a foreign QR shouldn't learn that a matching site exists.
  if (!site || site.client_id !== req.user.client_id) return res.status(404).json({ code: "unknown_qr_code", error: "Unknown QR code" });
  res.json({ site: { ...site, has_customer_rooms: !!siteHasCustomerRoomsStmt.get(site.id) } });
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
