import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import multer from "multer";
import fs from "node:fs";
import "./db.js";

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
import { startDailyReportScheduler } from "./services/scheduler.js";
import { UploadRejectedError } from "./utils/uploads.js";

const uploadsDir = process.env.UPLOADS_DIR || "uploads";
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(`${uploadsDir}/avatars`)) fs.mkdirSync(`${uploadsDir}/avatars`, { recursive: true });

const app = express();
// crossOriginResourcePolicy: false — otherwise helmet's default same-origin policy blocks the
// Vercel-hosted frontend from loading <img src="{API_URL}/uploads/..."> across origins.
// contentSecurityPolicy: false — GET /reports/runs/:id/html returns a real (inline-styled) HTML
// report opened directly in a browser tab; a default CSP is aimed at pages rendering untrusted
// user content, which doesn't apply to this JSON+file API, and would risk breaking that report.
app.use(helmet({ crossOriginResourcePolicy: false, contentSecurityPolicy: false }));
// ALLOWED_ORIGINS is a comma-separated list (e.g. "https://rentlogg.no,https://app.rentlogg.no").
// Left unset, this keeps today's "reflect any origin" behavior instead of breaking prod against
// a guessed domain — real impact is low anyway since every request carries its auth as a Bearer
// header, not a cookie, so a foreign origin can't ride an ambient credential either way. Still
// worth setting once the frontend's real domain(s) are known.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean);
app.use(cors(allowedOrigins.length ? { origin: allowedOrigins } : {}));
app.use(express.json());
app.use(morgan("dev"));
app.use("/uploads", uploadsRouter);

app.get("/health", (req, res) => res.json({ ok: true }));

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

// Without this, a rejected upload (most commonly a phone photo over the size limit — modern
// camera HDR/high-res shots routinely exceed what a "reasonable" limit looks like on paper)
// fell through to the generic 500 below with zero indication of what actually went wrong.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "Bildet er for stort. Prøv et bilde under 20 MB." });
    }
    return res.status(400).json({ error: "Kunne ikke laste opp filen." });
  }
  // A fileFilter rejection (wrong MIME/extension) reaches here as a plain error, not a
  // MulterError — without this it fell through to the generic 500 below.
  if (err instanceof UploadRejectedError) {
    return res.status(400).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Rentlogg backend running on http://localhost:${port}`));
startDailyReportScheduler();
