import { Router } from "express";
import fsSync from "node:fs";
import path from "node:path";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { todayInOslo, toOsloDateStr, getSitesScheduledOn } from "../services/schedule.js";
import { getRoomCompletionForSiteDate } from "../services/rooms.js";

export const dashboardRouter = Router();

const PRICE_PER_SITE = 349;
const TRIAL_LENGTH_DAYS = 14;

function computeTrial(companyId) {
  const earliest = db
    .prepare("SELECT MIN(created_at) AS created_at FROM users WHERE role IN ('admin', 'manager') AND company_id = ?")
    .get(companyId).created_at;
  const daysSince = earliest ? Math.floor((Date.now() - new Date(`${earliest.replace(" ", "T")}Z`)) / 86400000) : 0;
  const daysLeft = Math.max(0, TRIAL_LENGTH_DAYS - daysSince);
  const siteCount = db.prepare("SELECT COUNT(*) AS n FROM sites WHERE company_id = ?").get(companyId).n;

  return { daysLeft, siteCount, pricePerSite: PRICE_PER_SITE, monthlyTotal: siteCount * PRICE_PER_SITE };
}

dashboardRouter.get("/summary", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const today = todayInOslo();
  const companyId = req.user.company_id;

  // Runs are stored in UTC; fetch a window around today's UTC date, then filter to the exact
  // Oslo calendar day in JS (same approach as services/schedule.js).
  const candidateRuns = db
    .prepare(
      `SELECT r.*, s.name AS site_name, u.name AS cleaner_name FROM checklist_runs r
       JOIN sites s ON s.id = r.site_id
       JOIN users u ON u.id = r.cleaner_id
       WHERE s.company_id = ? AND date(r.started_at) BETWEEN date(?, '-1 day') AND date(?, '+1 day')`
    )
    .all(companyId, today, today);
  const runsToday = candidateRuns.filter((r) => toOsloDateStr(r.started_at) === today);

  const totalRunsToday = runsToday.length;
  const completedToday = runsToday.filter((r) => r.completed_at).length;
  const inProgressToday = totalRunsToday - completedToday;

  const openDeviationsCount = db
    .prepare(
      `SELECT COUNT(*) AS n FROM deviations d JOIN sites s ON s.id = d.site_id
       WHERE d.status != 'resolved' AND s.company_id = ?`
    )
    .get(companyId).n;
  const activeSites = db.prepare("SELECT COUNT(*) AS n FROM sites WHERE company_id = ?").get(companyId).n;

  const recentActivity = [...runsToday]
    .sort((a, b) => b.started_at.localeCompare(a.started_at))
    .slice(0, 5)
    .map((r) => {
      const roomCompletion = getRoomCompletionForSiteDate(r.site_id, today);
      return {
        id: r.id,
        siteName: r.site_name,
        cleanerName: r.cleaner_name,
        status: r.completed_at ? "completed" : "in_progress",
        startedAt: r.started_at,
        signedInitials: r.signed_initials || null,
        roomDueCount: roomCompletion?.dueCount ?? null,
        roomCompletedCount: roomCompletion?.completedCount ?? null,
      };
    });

  const plannedToday = getSitesScheduledOn(today, companyId)
    .filter((s) => s.scheduleStatus === "missing")
    .map((s) => ({
      siteId: s.id,
      siteName: s.name,
      label: s.assigned_cleaner_name ? "Tildelt" : "Planlagt",
      assignedCleanerName: s.assigned_cleaner_name,
    }));

  res.json({
    totalRunsToday,
    completedToday,
    inProgressToday,
    openDeviationsCount,
    activeSites,
    recentActivity,
    plannedToday,
    trial: computeTrial(companyId),
  });
});

// --- Lagring ---

// How much disk the documentation actually occupies, and how fast it is growing. Exists because
// the retention decision (three years, agreed with Nortura 2026-09-24) turns disk sizing from a
// judgement call into arithmetic — measured monthly growth × 36 — and render.yaml currently
// mounts a single 1GB disk for both the SQLite database and every photo ever uploaded. Without a
// real number the alternative is guessing, and the failure mode of guessing low is that uploads
// start failing and somebody frees space by deleting documentation by hand.
//
// Deliberately walks the uploads directory rather than trusting the database: files orphaned by
// the bulk-delete cascades that used to drop only the DB row (see utils/uploads.js's
// removeUploadedFile comment) still occupy the disk, so a DB-only sum would under-report exactly
// the thing being measured.
const RETENTION_MONTHS = 36;

function walkUploads(dir) {
  const sizes = new Map();
  let totalBytes = 0;
  let fileCount = 0;

  const visit = (current) => {
    let entries;
    try {
      entries = fsSync.readdirSync(current, { withFileTypes: true });
    } catch {
      return; // directory missing entirely (fresh install, or UPLOADS_DIR not created yet)
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(full); // avatars live in their own subdirectory (see routes/auth.js)
        continue;
      }
      let stat;
      try {
        stat = fsSync.statSync(full);
      } catch {
        continue; // deleted between readdir and stat
      }
      totalBytes += stat.size;
      fileCount++;
      // Keyed by basename, which is how every file_path column stores it once path.basename is
      // applied — the stored value itself is "uploads/x" or "uploads\x" depending on the OS that
      // wrote it, so the basename is the only portable key.
      sizes.set(entry.name, stat.size);
    }
  };

  visit(dir);
  return { sizes, totalBytes, fileCount };
}

dashboardRouter.get("/storage", requireAuth, requireRole("admin", "super_admin"), (req, res) => {
  const uploadsDir = process.env.UPLOADS_DIR || "uploads";
  const { sizes, totalBytes, fileCount } = walkUploads(uploadsDir);

  let databaseBytes = 0;
  try {
    databaseBytes = fsSync.statSync(process.env.DB_FILE || "./data/rentlogg.db").size;
  } catch {
    databaseBytes = 0;
  }

  // A photo hangs off exactly one of three owners, and each of those reaches a site by its own
  // path — this resolves all three at once so the per-department split below doesn't need three
  // separate queries plus a merge.
  const photos = db
    .prepare(
      `SELECT p.file_path, p.created_at,
              COALESCE(rm.site_id, cr.site_id, dv.site_id) AS site_id
         FROM photos p
         LEFT JOIN room_runs rr ON rr.id = p.room_run_id
         LEFT JOIN rooms rm ON rm.id = rr.room_id
         LEFT JOIN checklist_runs cr ON cr.id = p.run_id
         LEFT JOIN deviations dv ON dv.id = p.deviation_id`
    )
    .all();

  // Company scoping, same rule as every other resource: a photo counts only if the site it hangs
  // off belongs to the caller's company. The disk totals above are deliberately NOT scoped — they
  // are a property of the server, not of a tenant, and reveal only an aggregate byte count.
  const siteDepartment = new Map(
    db
      .prepare(
        `SELECT s.id, COALESCE(d.name, 'Uten avdeling') AS department
           FROM sites s LEFT JOIN departments d ON d.id = s.department_id
          WHERE s.company_id = ?`
      )
      .all(req.user.company_id)
      .map((row) => [row.id, row.department])
  );

  const byMonth = new Map();
  const byDepartment = new Map();
  let photoBytes = 0;
  let photoCount = 0;

  for (const photo of photos) {
    const department = siteDepartment.get(photo.site_id);
    if (!department) continue; // another company's site, or a photo whose owner row is gone
    const bytes = sizes.get(path.basename(photo.file_path)) ?? 0;
    photoBytes += bytes;
    photoCount++;

    const month = (photo.created_at || "").slice(0, 7);
    const monthEntry = byMonth.get(month) || { month, count: 0, bytes: 0 };
    monthEntry.count++;
    monthEntry.bytes += bytes;
    byMonth.set(month, monthEntry);

    const departmentEntry = byDepartment.get(department) || { department, count: 0, bytes: 0 };
    departmentEntry.count++;
    departmentEntry.bytes += bytes;
    byDepartment.set(department, departmentEntry);
  }

  const months = [...byMonth.values()].sort((a, b) => b.month.localeCompare(a.month));
  // The current month is still accruing, so averaging it in would understate growth. Dropped
  // here rather than in the caller, and the API says so via completeMonthsUsed.
  const currentMonth = new Date().toISOString().slice(0, 7);
  const completeMonths = months.filter((m) => m.month && m.month !== currentMonth).slice(0, 3);
  const monthlyBytes = completeMonths.length
    ? Math.round(completeMonths.reduce((sum, m) => sum + m.bytes, 0) / completeMonths.length)
    : 0;

  res.json({
    disk: { uploadsBytes: totalBytes, uploadsFiles: fileCount, databaseBytes },
    photos: {
      count: photoCount,
      bytes: photoBytes,
      averageBytes: photoCount ? Math.round(photoBytes / photoCount) : 0,
    },
    byMonth: months.slice(0, 12),
    byDepartment: [...byDepartment.values()].sort((a, b) => b.bytes - a.bytes),
    projection: {
      retentionMonths: RETENTION_MONTHS,
      completeMonthsUsed: completeMonths.length,
      monthlyBytes,
      projectedBytes: monthlyBytes * RETENTION_MONTHS,
    },
  });
});
