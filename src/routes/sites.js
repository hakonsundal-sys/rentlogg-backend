import { Router } from "express";
import multer from "multer";
import path from "node:path";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { newQrToken, qrLabelSvgDataUrl } from "../utils/qrcode.js";
import { findRunForSiteDate, getRunStatusForSiteDate, todayInOslo, toOsloDateStr } from "../services/schedule.js";
import { safeOriginalName, normalizeImageOrientation, documentFileFilter, removeUploadedFile } from "../utils/uploads.js";
import { logQualityEvent } from "../services/qualityLog.js";
import { haversineMeters } from "../utils/geo.js";
import { startEntryForCheckin } from "../services/timeEntries.js";

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

// A site row carries OKV's own operational config next to the facts the customer portal needs.
// report_recipients is the daily digest's distribution list — often OKV-internal addresses — and
// a customer opening their own dashboard could read it straight out of the API response. Stripped
// from every site object a customer can reach; the two call sites below are the only routes that
// hand that role a whole row (every other customer-facing route returns a site's name, not the
// row). Kept as a list so the neighbouring internal fields (report_send_hour, and the
// time_billing_mode/time_fixed_minutes rammetimetall) can be added the same way if they should be
// hidden too.
const CUSTOMER_HIDDEN_SITE_FIELDS = ["report_recipients"];

function siteForCustomer(site) {
  const visible = { ...site };
  for (const field of CUSTOMER_HIDDEN_SITE_FIELDS) delete visible[field];
  return visible;
}

function scopeSitesForUser(user) {
  if (user.role === "customer") {
    const sites = db.prepare("SELECT * FROM sites WHERE client_id = ? ORDER BY name").all(user.client_id);
    // Lets the customer portal show a direct "fill out today's checklist" shortcut only on sites
    // where that's actually possible — most customer sites have no rooms marked responsible, and
    // showing the shortcut there would just open an empty, nothing-to-do checklist.
    return sites.map((site) => ({ ...siteForCustomer(site), has_customer_rooms: !!siteHasCustomerRoomsStmt.get(site.id) }));
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
  const { name, client_id, department_id, address, checklist_template_id, latitude, longitude, gps_radius_meters, room_count, report_recipients, report_send_hour, time_billing_mode, time_fixed_minutes } = req.body;
  if (!name || !client_id) return res.status(400).json({ code: "name_and_client_required", error: "name and client_id are required" });
  if (!isValidSendHour(report_send_hour)) return res.status(400).json({ code: "invalid_report_hour", error: "report_send_hour må være et heltall 0–23" });
  const timeSettingsError = validateTimeSettings(req.body);
  if (timeSettingsError) return res.status(400).json(timeSettingsError);

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
      `INSERT INTO sites (name, client_id, department_id, company_id, address, checklist_template_id, qr_token, latitude, longitude, gps_radius_meters, room_count, report_recipients, report_send_hour, time_billing_mode, time_fixed_minutes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(name, client_id, department_id || null, req.user.company_id, address || null, checklist_template_id || null, qr_token, latitude || null, longitude || null, gps_radius_meters || 150, room_count || 0, report_recipients || null, report_send_hour ?? null, time_billing_mode || "actual", time_fixed_minutes ?? null);

  res.status(201).json({ id: info.lastInsertRowid, qr_token });
});

const SITE_PATCH_FIELDS = ["name", "client_id", "department_id", "address", "checklist_template_id", "latitude", "longitude", "gps_radius_meters", "room_count", "report_recipients", "report_send_hour", "time_billing_mode", "time_fixed_minutes"];

// Timeregistrering: 'actual' pays the clock between stamp-in and stamp-out, 'fixed' pays this
// site's own rammetimetall however long the visit actually took. 'fixed' without a frame would
// mean paying nothing, so the number is required alongside it rather than defaulted — see
// services/timeEntries.js, which degrades to the clock if it ever finds one missing anyway.
function validateTimeSettings(body, current = {}) {
  const mode = "time_billing_mode" in body ? body.time_billing_mode : current.time_billing_mode;
  if (mode != null && mode !== "actual" && mode !== "fixed") {
    return { code: "invalid_billing_mode", error: "time_billing_mode må være 'actual' eller 'fixed'" };
  }
  const minutes = "time_fixed_minutes" in body ? body.time_fixed_minutes : current.time_fixed_minutes;
  if (minutes != null && (!Number.isInteger(minutes) || minutes <= 0 || minutes > 24 * 60)) {
    return { code: "invalid_fixed_minutes", error: "Rammetimetall må være et antall minutter mellom 1 og 1440" };
  }
  if (mode === "fixed" && !minutes) {
    return { code: "fixed_minutes_required", error: "Et rammetimetall må settes når lokasjonen bruker faste timer" };
  }
  return null;
}

sitesRouter.patch("/:id", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { site, status, code, error } = getSiteScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ code, error });

  if ("report_send_hour" in req.body && !isValidSendHour(req.body.report_send_hour)) {
    return res.status(400).json({ code: "invalid_report_hour", error: "report_send_hour må være et heltall 0–23" });
  }
  // Validated against the site's current values as well as the body, so switching a site to fixed
  // hours without also sending a rammetimetall is caught rather than saved half-applied.
  const timeSettingsError = validateTimeSettings(req.body, site);
  if (timeSettingsError) return res.status(400).json(timeSettingsError);

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

    // The single most destructive action in the app: every visit, room, avvik, photo and document
    // for a whole location, in one transaction. Counted before anything is deleted, and written
    // inside this same transaction so that a location's documentation cannot vanish without a
    // row saying who removed it and how much went with it. See services/qualityLog.js.
    const roomCount = db.prepare("SELECT COUNT(*) AS n FROM rooms WHERE site_id = ?").get(siteId).n;
    const roomRunCount = db
      .prepare("SELECT COUNT(*) AS n FROM room_runs WHERE room_id IN (SELECT id FROM rooms WHERE site_id = ?)")
      .get(siteId).n;
    logQualityEvent({
      user: req.user,
      action: "site_deleted",
      subjectType: "site",
      subjectId: Number(siteId),
      siteId: Number(siteId),
      occurredAt: req.body?.occurred_at,
      beforeValue: site.name,
      comment:
        `${runIds.length} besøk, ${roomCount} rom, ${roomRunCount} rombesøk og ` +
        `${deviationIds.length} avvik slettet sammen med lokasjonen`,
    });

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

// What the last person who was here wrote down. Cleaners cover for each other constantly, so the
// person arriving is often not the person who was here last — and everything she needs to know
// about the building's quirks ("fryseren må gjøres sist", "bakdøra klemmer") is already in the
// notes, it has just never been shown to the next one through the door.
//
// Nothing new is stored: checklist_runs.note and room_runs.note have been written for months.
const previousRunsStmt = db.prepare(
  `SELECT r.id, r.started_at, r.note, r.signed_initials, u.name AS cleaner_name
   FROM checklist_runs r LEFT JOIN users u ON u.id = r.cleaner_id
   WHERE r.site_id = ? AND date(r.started_at) <= date(?, '+1 day')
   ORDER BY r.started_at DESC
   LIMIT 20`
);
const roomNotesForDateStmt = db.prepare(
  `SELECT rr.note, rr.signed_initials, rr.started_at, ro.name AS room_name
   FROM room_runs rr JOIN rooms ro ON ro.id = rr.room_id
   WHERE ro.site_id = ? AND rr.note IS NOT NULL AND TRIM(rr.note) != ''
     AND date(rr.started_at) BETWEEN date(?, '-1 day') AND date(?, '+1 day')
   ORDER BY ro.sort_order, ro.id`
);

sitesRouter.get("/:id/previous-visit", requireAuth, (req, res) => {
  const { site, status, code, error } = getSiteScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ code, error });

  const today = todayInOslo();
  // Runs are stored in UTC, so the Oslo calendar day is resolved in JS the same way
  // findRunForSiteDate does — a visit just before midnight belongs to the day it started.
  const previous = previousRunsStmt.all(site.id, today).find((r) => toOsloDateStr(r.started_at) < today);
  if (!previous) return res.json(null);

  const date = toOsloDateStr(previous.started_at);
  const roomNotes = roomNotesForDateStmt
    .all(site.id, date, date)
    .filter((n) => toOsloDateStr(n.started_at) === date)
    .map(({ started_at, ...note }) => note);

  // A visit with nothing written down has nothing to pass on. Returning it anyway would put an
  // empty card on the screen she checks in from every morning.
  if (!previous.note?.trim() && roomNotes.length === 0) return res.json(null);

  res.json({
    date,
    // How stale it is, so a note from three weeks ago is visibly not from yesterday.
    days_ago: Math.round((new Date(`${today}T00:00:00Z`) - new Date(`${date}T00:00:00Z`)) / 86400000),
    by: previous.signed_initials || previous.cleaner_name || null,
    note: previous.note?.trim() || null,
    rooms: roomNotes,
  });
});

// "Hvor skal jeg i morgen?" — the question a cleaner asks most often, and the one Rentlogg could
// already answer but never did: site_schedules.assigned_cleaner_id has held the weekly plan all
// along, it was only ever readable from the admin side.
//
// This is a VIEW, not a restriction. Cleaners cover for each other and rotate between sites (see
// the engineering conventions), so a site missing from her week is not a site she may not enter —
// which is why anything she actually worked shows up here too, marked as unplanned rather than
// hidden.
const myPlanStmt = db.prepare(
  `SELECT sch.weekday, s.id AS site_id, s.name, s.address, s.status,
          s.time_billing_mode, s.time_fixed_minutes
   FROM site_schedules sch JOIN sites s ON s.id = sch.site_id
   WHERE sch.assigned_cleaner_id = ? AND s.company_id = ?
   ORDER BY s.name`
);
const myVisitsStmt = db.prepare(
  `SELECT r.id, r.started_at, r.site_id, s.name
   FROM checklist_runs r JOIN sites s ON s.id = r.site_id
   WHERE r.cleaner_id = ? AND s.company_id = ?
     AND date(r.started_at) BETWEEN date(?, '-1 day') AND date(?, '+1 day')`
);

sitesRouter.get("/my-week", requireAuth, (req, res) => {
  // Monday of the week the given day falls in; without a date, the week she is standing in.
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || "") ? req.query.from : todayInOslo();
  const anchorDate = new Date(`${anchor}T00:00:00Z`);
  const monday = new Date(anchorDate);
  monday.setUTCDate(monday.getUTCDate() - ((anchorDate.getUTCDay() + 6) % 7));

  const plan = myPlanStmt.all(req.user.id, req.user.company_id);
  const dates = [...Array(7)].map((_, i) => {
    const d = new Date(monday);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
  const visits = myVisitsStmt.all(req.user.id, req.user.company_id, dates[0], dates[6]);
  const today = todayInOslo();

  const days = dates.map((date) => {
    // Date#getDay(), 0=søndag — the same convention site_schedules stores.
    const weekday = new Date(`${date}T00:00:00`).getDay();
    const planned = plan.filter((p) => p.weekday === weekday);
    const visitedIds = new Set(visits.filter((v) => toOsloDateStr(v.started_at) === date).map((v) => v.site_id));

    const sites = planned.map((p) => ({
      site_id: p.site_id,
      name: p.name,
      address: p.address,
      planned: true,
      // Only a fixed-frame site has a number to promise her; on an hourly site the answer is
      // honestly "as long as it takes".
      planned_minutes: p.time_billing_mode === "fixed" ? p.time_fixed_minutes : null,
      status: getRunStatusForSiteDate(p.site_id, date),
    }));

    // Somewhere she actually worked that her plan says nothing about — covering for somebody, or a
    // one-off. Hiding it would make her own week disagree with her own memory.
    for (const visit of visits.filter((v) => toOsloDateStr(v.started_at) === date)) {
      if (planned.some((p) => p.site_id === visit.site_id)) continue;
      sites.push({
        site_id: visit.site_id, name: visit.name, address: null, planned: false,
        planned_minutes: null, status: getRunStatusForSiteDate(visit.site_id, date),
      });
    }

    return { date, weekday, is_today: date === today, is_past: date < today, sites };
  });

  res.json({ from: dates[0], to: dates[6], days });
});

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
    // The run is shared per site per day — this same row is handed to everyone who scans, and its
    // cleaner_id stays whoever scanned first. The time entry below is the opposite: one row per
    // person per stamping, which is exactly why a timesheet can't be read off the run. Returns
    // null (at the cost of one indexed module lookup) for any company without Timeregistrering.
    const timeEntry = startEntryForCheckin({ site, user: req.user, latitude, longitude, runId: existing.id });
    return res.json({ runId: existing.id, site, gps_verified: !!existing.gps_verified, timeEntry });
  }

  const runInfo = db
    .prepare("INSERT INTO checklist_runs (site_id, cleaner_id, gps_verified, latitude, longitude) VALUES (?, ?, ?, ?, ?)")
    .run(site.id, req.user.id, gps_verified, latitude || null, longitude || null);

  const templateItems = site.checklist_template_id
    ? db.prepare("SELECT * FROM checklist_template_items WHERE template_id = ? ORDER BY sort_order").all(site.checklist_template_id)
    : [];

  const insertItem = db.prepare("INSERT INTO checklist_run_items (run_id, label, sort_order) VALUES (?, ?, ?)");
  templateItems.forEach((item, i) => insertItem.run(runInfo.lastInsertRowid, item.label, i));

  const timeEntry = startEntryForCheckin({ site, user: req.user, latitude, longitude, runId: runInfo.lastInsertRowid });

  res.status(201).json({ runId: runInfo.lastInsertRowid, site, gps_verified: !!gps_verified, timeEntry });
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
  res.json({ site: { ...siteForCustomer(site), has_customer_rooms: !!siteHasCustomerRoomsStmt.get(site.id) } });
});
