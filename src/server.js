import "dotenv/config";
import "./utils/asyncErrors.js";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import multer from "multer";
import fs from "node:fs";
import { db } from "./db.js";

import { authRouter } from "./routes/auth.js";
import { clientsRouter } from "./routes/clients.js";
import { sitesRouter } from "./routes/sites.js";
import { checklistsRouter } from "./routes/checklists.js";
import { deviationsRouter } from "./routes/deviations.js";
import { reportsRouter } from "./routes/reports.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { invitationsRouter } from "./routes/invitations.js";
import { siteRoomsRouter, roomsRouter } from "./routes/rooms.js";
import { companiesRouter } from "./routes/companies.js";
import { departmentsRouter } from "./routes/departments.js";
import { uploadsRouter } from "./routes/uploads.js";
import { modulesRouter } from "./routes/modules.js";
import { chemicalsRouter } from "./routes/chemicals.js";
import { trainingRouter } from "./routes/training.js";
import { timeRouter } from "./routes/time.js";
import { simpleChecklistsRouter } from "./routes/simpleChecklists.js";
import { samplesRouter } from "./routes/samples.js";
import { requireAuth, requireRole, requireModule } from "./middleware/auth.js";
import { apiLimiter } from "./middleware/rateLimits.js";
import { startDailyReportScheduler, startBackupScheduler } from "./services/scheduler.js";
import { hoursSinceLastGoodBackup } from "./services/backup.js";
import { UploadRejectedError } from "./utils/uploads.js";

const uploadsDir = process.env.UPLOADS_DIR || "uploads";
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(`${uploadsDir}/avatars`)) fs.mkdirSync(`${uploadsDir}/avatars`, { recursive: true });

const app = express();
// Render puts one proxy in front of the process, so without this req.ip is the proxy's address and
// every rate limit below would count the whole company as one caller.
app.set("trust proxy", 1);
// crossOriginResourcePolicy: false — otherwise helmet's default same-origin policy blocks the
// Vercel-hosted frontend from loading <img src="{API_URL}/uploads/..."> across origins.
// contentSecurityPolicy: false here, set by hand just below — helmet's default policy assumes a
// page that loads its own scripts and styles, which this JSON+file API never serves.
app.use(helmet({ crossOriginResourcePolicy: false, contentSecurityPolicy: false }));
// What the API sends is JSON, or a file (photo, PDF, the HTML report) that a person opens. JSON
// should never be rendered, so everything is denied outright. /uploads and /reports are the
// exceptions: a locked-down default-src would strip the inline styling off the HTML report and
// block an image or PDF from showing, so there the only rule is that nothing may frame them.
app.use((req, res, next) => {
  const serves = req.path.startsWith("/uploads") || req.path.startsWith("/reports");
  res.setHeader(
    "Content-Security-Policy",
    serves ? "frame-ancestors 'none'" : "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  );
  next();
});
// ALLOWED_ORIGINS is a comma-separated list (e.g. "https://rentlogg.no,https://app.rentlogg.no").
// Left unset on Render (RENDER is set there), no cross-origin caller is allowed at all: a redeploy
// that loses the variable should fail closed, and render.yaml sets it. Left unset anywhere else —
// a developer's machine — every origin is answered, so the local frontend on another port works
// without configuration.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean);
const corsOptions = allowedOrigins.length ? { origin: allowedOrigins } : process.env.RENDER ? { origin: false } : {};
app.use(cors(corsOptions));
app.use(express.json());
// The query string is left out of the log on purpose: /uploads takes the login token as ?token=
// (an <img> cannot send a header), so logging the whole URL put a valid token in the log for every
// photo. Control characters are replaced so a crafted URL cannot forge a log line.
morgan.token("path", (req) =>
  Array.from((req.originalUrl || req.url || "").split("?")[0], (c) => {
    const n = c.charCodeAt(0);
    return n < 32 || n === 127 || n === 0x2028 || n === 0x2029 ? "?" : c;
  }).join("")
);
app.use(morgan(":method :path :status :response-time ms - :res[content-length]"));
app.use("/uploads", uploadsRouter);

// Fortsatt offentlig og fortsatt billig, men den svarer nå på det spørsmålet som faktisk kan gå
// galt uten at noen merker det: NÅR gikk sikkerhetskopieringen sist bra.
//
// En backup-jobb som slutter å kjøre sender ingen feilmelding — den gjør ingenting, stille. Det
// er den vanligste måten å oppdage at man ikke hadde noen kopi likevel, og den oppdages typisk
// den dagen man trenger kopien. Ved å legge alderen her blir fraværet noe en overvåkingstjeneste
// kan se utenfra, uten tilgang til noe annet.
//
// Ingen data lekker: bare et tall i timer og et ja/nei. Ikke hvor kopien ligger, ikke hva den
// inneholder, ikke om den finnes i det hele tatt utover alderen.
//
// Svaret har også to ting som faktisk kan være ødelagt mens prosessen fortsatt svarer: databasen
// (en enkel spørring — 503 hvis den feiler, så Render ser en syk tjeneste i stedet for en frisk
// en) og ledig plass på disken. Full disk melder bare `diskLow` og feiler ikke helsesjekken:
// Render ville startet instansen på nytt i en løkke, og en omstart gir ikke mer plass.
app.get("/health", (req, res) => {
  let dbOk = true;
  try {
    db.prepare("SELECT 1").get();
  } catch {
    dbOk = false;
  }

  let diskLow = null;
  try {
    const stats = fs.statfsSync(uploadsDir);
    const freeMB = (stats.bavail * stats.bsize) / (1024 * 1024);
    diskLow = freeMB < Number(process.env.DISK_LOW_MB ?? 100);
  } catch {
    // Unknown on a platform without statfs — absent rather than a guess.
  }

  const hours = hoursSinceLastGoodBackup();
  const maxAge = Number(process.env.BACKUP_MAX_AGE_HOURS ?? 36);
  res.status(dbOk ? 200 : 503).json({
    ok: dbOk,
    db: dbOk,
    diskLow,
    backup: {
      hoursSinceLastGood: hours === null ? null : Number(hours.toFixed(1)),
      stale: hours === null || hours > maxAge,
    },
  });
});

// Captured at module load. Render's starter plan runs one instance and replaces it on every
// deploy, so process start is the closest thing this runtime actually knows to "when did the API
// last change" — a manual restart moves it too, which is why the field is named for what it
// measures rather than for what it is usually used as.
const startedAt = new Date().toISOString();

// Set by Render on every build. Absent locally, and that is fine — nothing here may throw at
// module load, since this file is the whole server's entry point.
const commit = (process.env.RENDER_GIT_COMMIT || "").slice(0, 7) || null;

let version = null;
try {
  version = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
} catch {
  // A missing or unreadable package.json is not worth refusing to boot over — the field is
  // informational and the two below carry the part anyone actually reads.
}

// Deliberately public, like /health: it carries no data that isn't already in a public repo, and
// the callers that need it most are the ones with no token — the login screen, and a curl after a
// deploy. It is also the marker a deploy can be verified against, which /health cannot be: the old
// instance answers {"ok":true} right up until it is swapped out, so a 200 there proves only that
// something is running, never that the new code is.
app.get("/version", (req, res) => res.json({ version, commit, startedAt }));

// Every site's printed QR sticker encodes {PUBLIC_BASE_URL}/checkin/:qrToken — this backend's
// own domain — because that's the only URL the app can compute at print time. Scanned through
// the in-app scanner that's just parsed as text and never actually requested, but a phone's
// native camera app treats it as a real link and opens it directly: previously that 404'd here,
// since nothing served this path. This makes that same, already-printed link redirect straight
// into the app's own check-in flow instead, with no need to reprint or regenerate any QR code —
// old and new codes both point at this exact path already. No auth/DB lookup here on purpose:
// the token is opaque and the real ownership/company check happens at the actual check-in call
// this lands on, so this route is a pure, stateless redirect.
app.get("/checkin/:qrToken", (req, res) => {
  const frontendUrl = process.env.PUBLIC_FRONTEND_URL || "https://rentlogg.no";
  res.redirect(302, `${frontendUrl}/?checkin=${encodeURIComponent(req.params.qrToken)}`);
});

// After /health, /version, /checkin and /uploads on purpose: monitoring and Render's own health
// check poll the first two constantly, the third is a stateless redirect, and /uploads streams
// files behind its own token check — none of them should count against a person's allowance.
app.use(apiLimiter);

app.use("/auth", authRouter);
app.use("/clients", clientsRouter);
app.use("/sites", sitesRouter);
app.use("/checklists", checklistsRouter);
app.use("/deviations", deviationsRouter);
app.use("/reports", reportsRouter);
app.use("/dashboard", dashboardRouter);
app.use("/invitations", invitationsRouter);
app.use("/sites/:siteId/rooms", siteRoomsRouter);
app.use("/rooms", roomsRouter);
app.use("/companies", companiesRouter);
app.use("/departments", departmentsRouter);
app.use("/modules", modulesRouter);
// Kjemikalieregisteret er KJERNE, ikke modul. Et kontorvask-firma trenger ingen ATP-grenser,
// men det bruker Zalo og et desinfeksjonsmiddel, og har like mye bruk for å slå opp styrken.
// Sikkerhetsnotatet og lenken til sikkerhetsdatabladet er dessuten arbeidsmiljø — det samme
// uansett hva som vaskes — og flervalg («hvilken såpe») er allerede kjerne, så med registeret
// bak en betalt modul registrerte en kjernefunksjon «Zalo» som naken tekst for alle andre.
//
// Kontakttiden i registeret er INFORMASJON (det leverandøren oppgir). Nedtellingen som faktisk
// sperrer avkryssingen leser room_checklist_items.contact_seconds, og DEN står i hygiene-modulen.
app.use("/chemicals", requireAuth, chemicalsRouter);
// Gated at the mount rather than per route, so no route inside training.js can ever forget the
// check — a company without the "Opplæring" module gets 403 module_not_enabled on all of it.
app.use("/training", requireAuth, requireModule("training"), trainingRouter);
// Same gating as training above. Note that stamping IN is NOT here — it happens inside the QR
// check-in (POST /sites/checkin/:qrToken), which stays ungated for everyone and checks the module
// itself via startEntryForCheckin.
//
// Customers are kept out here too: they carry the cleaning company's company_id, so without a role
// gate the module check lets them through, and nine routes in time.js have no role check of their
// own. A customer could create a payroll row that then showed up in the company's timesheet.
app.use("/time", requireAuth, requireRole("admin", "manager", "cleaner"), requireModule("timeclock"), timeRouter);
// Sjekklister: same gating at the mount. Not to be confused with /checklists above, which is the
// old site-level checklist of the cleaning product.
app.use("/simple-checklists", requireAuth, requireModule("checklist"), simpleChecklistsRouter);
app.use("/samples", requireAuth, requireModule("sampling"), samplesRouter);

// Without this, a rejected upload (most commonly a phone photo over the size limit — modern
// camera HDR/high-res shots routinely exceed what a "reasonable" limit looks like on paper)
// fell through to the generic 500 below with zero indication of what actually went wrong.
app.use((err, req, res, next) => {
  // Part of the response is already on its way (a PDF being streamed, say): nothing sensible can
  // still be said, and Express's own handler closes the connection instead of leaving it hanging.
  if (res.headersSent) return next(err);
  // body-parser's own failures carry a 4xx status: malformed JSON, or a body over the size limit.
  // They are the caller's mistake, not a server fault, so they must not look like a 500 (and must
  // not print a stack trace into the log for every bad request).
  if (err.type === "entity.too.large") {
    return res.status(413).json({ code: "payload_too_large", error: "Forespørselen er for stor." });
  }
  if (err.type === "entity.parse.failed" || (Number.isInteger(err.status) && err.status >= 400 && err.status < 500)) {
    return res.status(err.status || 400).json({ code: "bad_request", error: "Ugyldig forespørsel." });
  }
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ code: "photo_too_large", error: "Bildet er for stort. Prøv et bilde under 20 MB." });
    }
    return res.status(400).json({ code: "upload_failed", error: "Kunne ikke laste opp filen." });
  }
  // A fileFilter rejection (wrong MIME/extension) reaches here as a plain error, not a
  // MulterError — without this it fell through to the generic 500 below.
  if (err instanceof UploadRejectedError) {
    return res.status(400).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ code: "internal_error", error: "Internal server error" });
});

// Backstop for a rejection that still escapes every handler (a scheduler job, a fire-and-forget
// promise): log it and keep serving. The default on Node 22 is to end the process, which for a
// single-instance API means every logged-in user is dropped over one failed side job. A genuine
// uncaughtException is left alone on purpose — the process may be in a bad state, and a restart is
// the right answer there.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Rentlogg backend running on http://localhost:${port}`));
startDailyReportScheduler();
startBackupScheduler();
