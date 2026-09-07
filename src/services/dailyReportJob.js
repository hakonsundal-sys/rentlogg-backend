import { db } from "../db.js";
import { findRunForSiteDate } from "./schedule.js";
import { getRunDetail } from "./runDetail.js";
import { buildReportBody } from "./runReport.js";
import { sendEmail } from "./mailer.js";

// Sends one digest email per site with a completed/in-progress visit on dateStr, to that site's
// report_recipients list. Sites with no recipients configured, or no visit at all that day, are
// silently skipped — this is a daily "here's what happened" digest, not a missed-visit alert.
// siteId narrows this to a single site (for a manual resend), skipping the recipients-configured
// filter so a targeted send still runs (and reports skipped) even if that site has none set.
// companyId scopes to one company's sites (the manual admin-triggered endpoint always passes the
// caller's own company, so a Company A admin can never target Company B's sites even by guessing
// a site_id); the 07:00 scheduler omits it entirely since that run is system-wide, not tied to
// any one company's session.
export async function sendDailyReports(dateStr, siteId, companyId) {
  let sites;
  if (siteId) {
    const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(siteId);
    sites = site && (companyId === undefined || site.company_id === companyId) ? [site] : [];
  } else if (companyId !== undefined) {
    sites = db
      .prepare("SELECT * FROM sites WHERE company_id = ? AND report_recipients IS NOT NULL AND TRIM(report_recipients) != ''")
      .all(companyId);
  } else {
    sites = db.prepare("SELECT * FROM sites WHERE report_recipients IS NOT NULL AND TRIM(report_recipients) != ''").all();
  }

  const results = { sent: 0, skipped: 0, failed: 0 };
  for (const site of sites) {
    const recipients = (site.report_recipients || "").split(",").map((s) => s.trim()).filter(Boolean);
    const run = findRunForSiteDate(site.id, dateStr);
    if (!recipients.length || !run) {
      results.skipped++;
      continue;
    }

    try {
      const body = buildReportBody(getRunDetail(run.id));
      const html = `<!doctype html><html lang="no"><head><meta charset="utf-8"></head><body style="margin:0;padding:24px;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;">${body}</body></html>`;
      await sendEmail({ to: recipients, subject: `Renholdsrapport ${site.name} — ${dateStr}`, html });
      results.sent++;
    } catch (err) {
      console.error(`Daglig rapport feilet for lokasjon ${site.id}:`, err.message);
      results.failed++;
    }
  }
  return results;
}
