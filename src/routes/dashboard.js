import { Router } from "express";
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
