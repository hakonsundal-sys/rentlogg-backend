import { Router } from "express";
import path from "node:path";
import { db } from "../db.js";
import { requireAuthQueryOrHeader } from "../middleware/auth.js";
import { isModuleEnabled } from "../modules.js";

// Replaces the old `app.use("/uploads", express.static(uploadsDir))`, which served every
// uploaded file — deviation/checklist/room photos, site documents, avatars — to anyone who knew
// or guessed a filename, with zero auth and zero tenant check. That bypassed every company_id/
// client_id scoping rule enforced everywhere else in the app, since none of those rules ever got
// a chance to run once a file's URL existed. This route looks up which resource a filename
// belongs to and applies the exact same scoping check its own API route already uses, before
// streaming the file.
export const uploadsRouter = Router();

const uploadsDir = process.env.UPLOADS_DIR || "uploads";

function sendStoredFile(res, subdir, filePath) {
  const absolutePath = path.resolve(uploadsDir, ...(subdir ? [subdir] : []), path.basename(filePath));
  res.sendFile(absolutePath, (err) => {
    if (err && !res.headersSent) res.status(404).json({ code: "not_found", error: "Not found" });
  });
}

// Avatars carry low sensitivity (a staff member's own profile photo, already shown wherever
// their name appears) — allowed for the user themselves or any colleague in the same company,
// matching the existing staff-directory (GET /auth/users) scoping rather than the stricter
// client_id/company_id rule used for actual customer/site data below.
uploadsRouter.get("/avatars/:filename", requireAuthQueryOrHeader, (req, res) => {
  const owner = db
    .prepare("SELECT id, company_id, avatar_url FROM users WHERE instr(avatar_url, ?) > 0")
    .get(req.params.filename);
  if (!owner || path.basename(owner.avatar_url) !== req.params.filename) {
    return res.status(404).json({ code: "not_found", error: "Not found" });
  }
  const sameCompany = req.user.role !== "customer" && owner.company_id === req.user.company_id;
  if (owner.id !== req.user.id && !sameCompany) return res.status(403).json({ code: "not_allowed", error: "Not allowed" });

  sendStoredFile(res, "avatars", owner.avatar_url);
});

uploadsRouter.get("/:filename", requireAuthQueryOrHeader, (req, res) => {
  const { filename } = req.params;

  // A photo hangs off exactly one of three parents (run/deviation/room_run) — join all three
  // and coalesce, same shape as getRunDetail/getDeviationScoped/getRoomRunScoped use elsewhere.
  const photo = db
    .prepare(
      `SELECT p.file_path,
              COALESCE(rs.client_id, ds.client_id, rrs.client_id) AS site_client_id,
              COALESCE(rs.company_id, ds.company_id, rrs.company_id) AS site_company_id
       FROM photos p
       LEFT JOIN checklist_runs r ON r.id = p.run_id
       LEFT JOIN sites rs ON rs.id = r.site_id
       LEFT JOIN deviations d ON d.id = p.deviation_id
       LEFT JOIN sites ds ON ds.id = d.site_id
       LEFT JOIN room_runs rr ON rr.id = p.room_run_id
       LEFT JOIN rooms room ON room.id = rr.room_id
       LEFT JOIN sites rrs ON rrs.id = room.site_id
       WHERE instr(p.file_path, ?) > 0`
    )
    .get(filename);

  if (photo && path.basename(photo.file_path) === filename) {
    const allowed =
      req.user.role === "customer"
        ? photo.site_client_id === req.user.client_id
        : photo.site_company_id === req.user.company_id;
    if (!allowed) return res.status(403).json({ code: "not_allowed", error: "Not allowed" });
    return sendStoredFile(res, null, photo.file_path);
  }

  const doc = db
    .prepare(
      `SELECT sd.file_path, sd.visibility, s.client_id, s.company_id
       FROM site_documents sd JOIN sites s ON s.id = sd.site_id
       WHERE instr(sd.file_path, ?) > 0`
    )
    .get(filename);

  if (doc && path.basename(doc.file_path) === filename) {
    const allowed =
      req.user.role === "customer" ? doc.client_id === req.user.client_id : doc.company_id === req.user.company_id;
    // Mirrors GET /sites/:id/documents' own visibility filter — a staff-only document shouldn't
    // become fetchable by a customer just because they learned its filename some other way.
    const visibleTo = req.user.role === "customer" ? ["customer", "both"] : ["staff", "both"];
    if (!allowed || !visibleTo.includes(doc.visibility)) return res.status(403).json({ code: "not_allowed", error: "Not allowed" });
    return sendStoredFile(res, null, doc.file_path);
  }

  // Training ("Opplæring") files, in the module's own two sensitivities. Both branches also require
  // the caller's company to still have the module — turning it off has to close the files too, not
  // just the routes and the menu.
  const trainingEnabled = req.user.role !== "customer" && isModuleEnabled(req.user.company_id, "training");

  // Course material: slide images, narration audio, the routine PDF attached to a course. Readable
  // by any staff member in the owning company — it's the training itself, not anyone's record of it.
  const material = db
    .prepare(
      `SELECT file_path, company_id FROM (
         SELECT f.file_path AS file_path, c.company_id AS company_id
           FROM training_course_files f JOIN training_courses c ON c.id = f.course_id
         UNION ALL
         SELECT s.image_path, c.company_id FROM training_slides s JOIN training_courses c ON c.id = s.course_id
           WHERE s.image_path IS NOT NULL
         UNION ALL
         SELECT s.audio_path, c.company_id FROM training_slides s JOIN training_courses c ON c.id = s.course_id
           WHERE s.audio_path IS NOT NULL
       ) WHERE instr(file_path, ?) > 0`
    )
    .get(filename);

  if (material && path.basename(material.file_path) === filename) {
    if (!trainingEnabled || material.company_id !== req.user.company_id) {
      return res.status(403).json({ code: "not_allowed", error: "Not allowed" });
    }
    return sendStoredFile(res, null, material.file_path);
  }

  // A record's evidence (an external course certificate) is personnel data, so it follows the
  // stricter rule the training routes themselves use: the person it belongs to, or an admin/manager
  // in the same company — never a colleague.
  const evidence = db
    .prepare(
      `SELECT r.file_path, r.user_id, c.company_id FROM
         (SELECT evidence_path AS file_path, user_id, course_id FROM training_records WHERE evidence_path IS NOT NULL) r
       JOIN training_courses c ON c.id = r.course_id
       WHERE instr(r.file_path, ?) > 0`
    )
    .get(filename);

  if (evidence && path.basename(evidence.file_path) === filename) {
    const managesStaff = req.user.role === "admin" || req.user.role === "manager";
    const allowed =
      trainingEnabled && evidence.company_id === req.user.company_id && (evidence.user_id === req.user.id || managesStaff);
    if (!allowed) return res.status(403).json({ code: "not_allowed", error: "Not allowed" });
    return sendStoredFile(res, null, evidence.file_path);
  }

  res.status(404).json({ code: "not_found", error: "Not found" });
});
