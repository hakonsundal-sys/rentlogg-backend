import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  safeOriginalName, documentFileFilter, slideFileFilter, imageFileFilter,
  normalizeImageOrientation, removeUploadedFile,
} from "../utils/uploads.js";
import { todayInOslo } from "../services/schedule.js";
import { DEFAULT_LANGUAGE, normalizeLanguage } from "../utils/languages.js";

// "Opplæring" — documenting that a staff member has received training and signed for it. Mounted
// behind requireModule("training") in server.js, so every route here already knows the caller's
// company has the module; no route needs to re-check that.
//
// A customer never reaches any of this (no role list below includes 'customer'): training is about
// the cleaning company's own staff, and a customer has no business browsing who has been trained
// on what beyond the certificate an admin chooses to send them.
export const trainingRouter = Router();

const COURSE_KINDS = ["lesson", "video", "document", "classroom", "external"];
const COURSE_KIND_LABELS = {
  lesson: "Leksjon i appen",
  video: "Video",
  document: "Dokument som skal leses",
  classroom: "Fysisk opplæring",
  external: "Eksternt kurs",
};
// How long before expiry a course starts showing as "utløper snart". Two months is enough notice
// to book a re-certification (the hygiene courses OKV uses run a few times a year) without leaving
// the whole column yellow most of the time.
const EXPIRING_SOON_DAYS = 60;

const evidenceUpload = multer({
  storage: multer.diskStorage({
    destination: process.env.UPLOADS_DIR || "uploads/",
    filename: (req, file, cb) => cb(null, `${Date.now()}-${safeOriginalName(file.originalname)}`),
  }),
  fileFilter: documentFileFilter,
  limits: { fileSize: 20 * 1024 * 1024 },
});

// A signature drawn with a finger: a small PNG off a canvas, a few kilobytes. Its own upload rather
// than sharing the one above so the size limit can be tight — anything arriving here that is
// megabytes large is not a signature, whatever it claims to be.
const signatureUpload = multer({
  storage: multer.diskStorage({
    destination: process.env.UPLOADS_DIR || "uploads/",
    filename: (req, file, cb) => cb(null, `signatur-${Date.now()}-${safeOriginalName(file.originalname)}`),
  }),
  fileFilter: imageFileFilter,
  limits: { fileSize: 2 * 1024 * 1024 },
});

// --- Scoping ---------------------------------------------------------------------------------

// Same shape as getSiteScoped/getRoomScoped elsewhere: fetch once, then apply the one tenant rule.
// There's no customer branch because no route here admits a customer at all.
function getCourseScoped(courseId, requester) {
  const course = db.prepare("SELECT * FROM training_courses WHERE id = ?").get(courseId);
  if (!course) return { status: 404, code: "not_found", error: "Not found" };
  if (course.company_id !== requester.company_id) return { status: 403, code: "not_allowed", error: "Not allowed" };
  return { course };
}

// The staff member an admin/manager is acting on. Mirrors auth.js's own getStaffTarget: never a
// customer, never a super_admin, never another company's.
function getStaffTarget(userId, requester) {
  const target = db
    .prepare("SELECT id, name, role, company_id, department_id, language FROM users WHERE id = ?")
    .get(userId);
  if (!target) return { status: 404, code: "not_found", error: "Not found" };
  if (target.role === "customer" || target.role === "super_admin") {
    return { status: 403, code: "not_allowed", error: "Not allowed" };
  }
  if (target.company_id !== requester.company_id) return { status: 403, code: "not_allowed", error: "Not allowed" };
  return { target };
}

// A record belongs to one person. Deliberately stricter than the app's usual "staff are unscoped
// within their own company" rule (see the engineering conventions): an admin or manager may read
// anyone's training, but a cleaner only ever her own — this is personnel data, the same reasoning
// that keeps password reset off limits between colleagues.
function getRecordScoped(recordId, requester) {
  const record = db
    .prepare(
      `SELECT r.*, c.company_id, c.title AS course_title, c.kind, c.requires_signature,
              c.requires_drawn_signature, c.validity_months
       FROM training_records r JOIN training_courses c ON c.id = r.course_id WHERE r.id = ?`
    )
    .get(recordId);
  if (!record) return { status: 404, code: "not_found", error: "Not found" };
  if (record.company_id !== requester.company_id) return { status: 403, code: "not_allowed", error: "Not allowed" };
  const isOwn = record.user_id === requester.id;
  const managesStaff = requester.role === "admin" || requester.role === "manager";
  if (!isOwn && !managesStaff) return { status: 403, code: "not_allowed", error: "Not allowed" };
  return { record };
}

// --- Status ----------------------------------------------------------------------------------

function dayOf(value) {
  return value ? String(value).slice(0, 10) : null;
}

function daysUntil(dateString, today) {
  return Math.round((new Date(`${dayOf(dateString)}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 86400000);
}

// 'none' | 'in_progress' | 'done' | 'expiring' | 'expired' — what one cell of the matrix says.
function statusOf(record, today) {
  if (!record) return "none";
  if (!record.completed_at) return "in_progress";
  if (!record.expires_at) return "done";
  const left = daysUntil(record.expires_at, today);
  if (left < 0) return "expired";
  return left <= EXPIRING_SOON_DAYS ? "expiring" : "done";
}

// Expiry is computed once, when the record is completed, rather than derived on every read: a
// course's validity_months can be edited later, and an already-signed record must not silently
// move its own expiry date because someone changed the course afterwards.
function computeExpiry(completedAt, validityMonths) {
  if (!validityMonths || !completedAt) return null;
  return db.prepare("SELECT datetime(?, ?) AS expires").get(completedAt, `+${Number(validityMonths)} months`).expires;
}

// Accepts the three shapes a YouTube link actually arrives in and hands back the 11-character id.
// Validated when the course is saved rather than when a cleaner opens it: a typo in a link should
// be an error for the person pasting it, not a blank screen for someone mid-shift.
export function youtubeIdFrom(url) {
  const match = String(url || "").match(
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
  );
  return match ? match[1] : null;
}

function nowStamp() {
  return db.prepare("SELECT datetime('now') AS now").get().now;
}

// Read from the database, never from req.user: language is deliberately kept out of the JWT (see
// the comment on POST /login), so req.user.language is always undefined. Reading it off the token
// silently played every lesson in Norwegian — caught 2026-09-23 watching a Lithuanian account get
// the Norwegian narration while the rest of her screen was in Lithuanian.
function accountLanguage(userId) {
  return db.prepare("SELECT language FROM users WHERE id = ?").get(userId)?.language || DEFAULT_LANGUAGE;
}

// --- Courses ---------------------------------------------------------------------------------

function courseWithExtras(course, today) {
  const assigned = db.prepare("SELECT COUNT(*) AS n FROM training_assignments WHERE course_id = ?").get(course.id).n;
  const records = db
    .prepare(
      `SELECT * FROM training_records WHERE course_id = ?
       ORDER BY user_id, COALESCE(completed_at, started_at) DESC, id DESC`
    )
    .all(course.id);
  // Ordered newest-first per user, so the first row seen for a person is the one that counts — an
  // old expired attempt never overrides the re-certification that replaced it.
  const latestPerUser = new Map();
  for (const r of records) if (!latestPerUser.has(r.user_id)) latestPerUser.set(r.user_id, r);

  let done = 0;
  let attention = 0;
  for (const r of latestPerUser.values()) {
    const status = statusOf(r, today);
    if (status === "done") done++;
    else if (status === "expiring" || status === "expired") attention++;
  }

  return {
    ...course,
    kind_label: COURSE_KIND_LABELS[course.kind] || course.kind,
    assigned_count: assigned,
    done_count: done,
    attention_count: attention,
    languages: db
      .prepare("SELECT language, COUNT(*) AS n FROM training_slides WHERE course_id = ? GROUP BY language ORDER BY language")
      .all(course.id)
      .map((row) => ({ language: row.language, slides: row.n })),
    files: db
      .prepare("SELECT id, name, file_path, language, created_at FROM training_course_files WHERE course_id = ? ORDER BY created_at")
      .all(course.id),
  };
}

trainingRouter.get("/courses", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const today = todayInOslo();
  const courses = db
    .prepare("SELECT * FROM training_courses WHERE company_id = ? ORDER BY active DESC, sort_order, title")
    .all(req.user.company_id);
  res.json(courses.map((c) => courseWithExtras(c, today)));
});

// Shared by POST and PATCH. PATCH merges the stored row under the request body first, so a partial
// edit keeps what it didn't send — which is why requires_signature is read as "anything but an
// explicit false/0", rather than trusting a bare truthiness check against a stored 0.
function readCourseFields(body) {
  const title = String(body.title || "").trim();
  if (!title) return { error: { code: "title_required", error: "Tittel er påkrevd." } };
  const kind = COURSE_KINDS.includes(body.kind) ? body.kind : "lesson";
  const validity = body.validity_months === "" || body.validity_months == null ? null : Number(body.validity_months);
  if (validity !== null && (!Number.isInteger(validity) || validity < 1 || validity > 120)) {
    return { error: { code: "invalid_validity", error: "Gyldighet må være mellom 1 og 120 måneder." } };
  }

  const videoUrl = String(body.video_url || "").trim() || null;
  if (kind === "video" && !youtubeIdFrom(videoUrl)) {
    return {
      error: {
        code: "invalid_video_url",
        error: "Lim inn en YouTube-lenke. Videoen må være ulistet eller offentlig — en privat video kan ikke spilles av i appen.",
      },
    };
  }

  return {
    fields: {
      title,
      description: String(body.description || "").trim() || null,
      kind,
      // Kept even when the kind is changed away from video, so switching a course to slides and
      // back doesn't lose the link someone already pasted.
      video_url: videoUrl,
      validity_months: validity,
      requires_signature: body.requires_signature === false || body.requires_signature === 0 ? 0 : 1,
      // Opposite default to the one above: asking for a drawn signature is the exception, so it is
      // off unless explicitly turned on. Same merged-body caveat applies, hence the === 1 rather
      // than a truthiness check that a stored 0 would also pass.
      requires_drawn_signature: body.requires_drawn_signature === true || body.requires_drawn_signature === 1 ? 1 : 0,
    },
  };
}

trainingRouter.post("/courses", requireAuth, requireRole("admin"), (req, res) => {
  const { fields, error } = readCourseFields(req.body);
  if (error) return res.status(400).json(error);

  const info = db
    .prepare(
      `INSERT INTO training_courses (company_id, title, description, kind, video_url, validity_months, requires_signature, requires_drawn_signature, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.user.company_id, fields.title, fields.description, fields.kind, fields.video_url,
      fields.validity_months, fields.requires_signature, fields.requires_drawn_signature, req.user.id
    );

  const course = db.prepare("SELECT * FROM training_courses WHERE id = ?").get(info.lastInsertRowid);
  res.status(201).json(courseWithExtras(course, todayInOslo()));
});

trainingRouter.patch("/courses/:id", requireAuth, requireRole("admin"), (req, res) => {
  const { course, status, code, error } = getCourseScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ code, error });

  // 'active' arrives on its own from the deactivate toggle, with none of the form's other fields.
  if (Object.keys(req.body).length === 1 && "active" in req.body) {
    db.prepare("UPDATE training_courses SET active = ? WHERE id = ?").run(req.body.active ? 1 : 0, course.id);
    return res.json(courseWithExtras(db.prepare("SELECT * FROM training_courses WHERE id = ?").get(course.id), todayInOslo()));
  }

  const { fields, error: fieldError } = readCourseFields({ ...course, ...req.body });
  if (fieldError) return res.status(400).json(fieldError);

  db.prepare(
    "UPDATE training_courses SET title = ?, description = ?, kind = ?, video_url = ?, validity_months = ?, requires_signature = ?, requires_drawn_signature = ? WHERE id = ?"
  ).run(fields.title, fields.description, fields.kind, fields.video_url, fields.validity_months, fields.requires_signature, fields.requires_drawn_signature, course.id);

  res.json(courseWithExtras(db.prepare("SELECT * FROM training_courses WHERE id = ?").get(course.id), todayInOslo()));
});

// Guarded the same way clients.js and departments.js guard theirs: a course somebody has actually
// signed for is documentation, and deleting it would take their signature with it. Deactivating
// keeps the history and just stops handing the course out.
trainingRouter.delete("/courses/:id", requireAuth, requireRole("admin"), (req, res) => {
  const { course, status, code, error } = getCourseScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ code, error });

  const records = db.prepare("SELECT COUNT(*) AS n FROM training_records WHERE course_id = ?").get(course.id).n;
  if (records > 0) {
    return res.status(409).json({
      code: "course_in_use",
      error: `Kurset har ${records} registrerte gjennomføringer og kan ikke slettes. Deaktiver det i stedet.`,
    });
  }

  const files = [
    ...db.prepare("SELECT file_path FROM training_course_files WHERE course_id = ?").all(course.id),
    ...db.prepare("SELECT image_path AS file_path FROM training_slides WHERE course_id = ? AND image_path IS NOT NULL").all(course.id),
    ...db.prepare("SELECT audio_path AS file_path FROM training_slides WHERE course_id = ? AND audio_path IS NOT NULL").all(course.id),
  ].map((row) => row.file_path);

  db.transaction(() => {
    db.prepare("DELETE FROM training_assignments WHERE course_id = ?").run(course.id);
    db.prepare("DELETE FROM training_course_files WHERE course_id = ?").run(course.id);
    db.prepare("DELETE FROM training_slides WHERE course_id = ?").run(course.id);
    db.prepare("DELETE FROM training_courses WHERE id = ?").run(course.id);
  })();
  // Files last and outside the transaction: unlinking can't be rolled back, so a failure here
  // should leave an orphaned file rather than an orphaned row. Skipping this step entirely is the
  // mistake several older delete cascades made — see utils/uploads.js's removeUploadedFile.
  files.forEach(removeUploadedFile);

  res.json({ ok: true });
});

trainingRouter.post(
  "/courses/:id/files",
  requireAuth,
  requireRole("admin", "manager"),
  evidenceUpload.single("file"),
  async (req, res) => {
    const { course, status, code, error } = getCourseScoped(req.params.id, req.user);
    if (error) return res.status(status).json({ code, error });
    if (!req.file) return res.status(400).json({ code: "no_file_selected", error: "Ingen fil valgt." });
    if (req.file.mimetype.startsWith("image/")) {
      await normalizeImageOrientation(path.join(process.env.UPLOADS_DIR || "uploads", req.file.filename));
    }

    const name = String(req.body.name || req.file.originalname || "Dokument").trim();
    const language = normalizeLanguage(req.body.language) ?? null;
    const info = db
      .prepare("INSERT INTO training_course_files (course_id, name, file_path, language) VALUES (?, ?, ?, ?)")
      .run(course.id, name, path.join("uploads", req.file.filename), language);

    res.status(201).json({ id: info.lastInsertRowid, name, file_path: req.file.filename, language });
  }
);

trainingRouter.delete("/courses/:id/files/:fileId", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { course, status, code, error } = getCourseScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ code, error });

  const file = db.prepare("SELECT * FROM training_course_files WHERE id = ? AND course_id = ?").get(req.params.fileId, course.id);
  if (!file) return res.status(404).json({ code: "not_found", error: "Not found" });

  removeUploadedFile(file.file_path);
  db.prepare("DELETE FROM training_course_files WHERE id = ?").run(file.id);
  res.json({ ok: true });
});

// --- Slides (the lesson itself) ------------------------------------------------------------------

const slideUpload = multer({
  storage: multer.diskStorage({
    destination: process.env.UPLOADS_DIR || "uploads/",
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeOriginalName(file.originalname)}`),
  }),
  fileFilter: slideFileFilter,
  limits: { fileSize: 25 * 1024 * 1024, files: 200 },
});

// PowerPoint exports slides as full-resolution PNGs — a megabyte each, several hundred for a
// handful of courses, on a Render volume of one gigabyte shared with the database and every
// deviation photo. Re-encoding to a capped JPEG here brings a slide down to roughly 150 kB, which
// is what makes lessons affordable to store at all. Same write-to-temp dance normalizeImageOrientation
// uses, because sharp can't read and write the same path in one pipeline.
async function storeSlideImage(file) {
  const dir = process.env.UPLOADS_DIR || "uploads";
  const source = path.join(dir, file.filename);
  const targetName = `${file.filename.replace(/\.[^.]+$/, "")}.jpg`;
  const target = path.join(dir, targetName);
  const temp = `${target}.tmp`;
  try {
    await sharp(source).rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toFile(temp);
    await fs.rename(temp, target);
    if (source !== target) await fs.rm(source, { force: true });
    return path.join("uploads", targetName);
  } catch (err) {
    // An unreadable or unsupported image should cost us the compression, not the slide.
    await fs.rm(temp, { force: true });
    console.error("Kunne ikke konvertere lysbilde:", err.message);
    return path.join("uploads", file.filename);
  }
}

// Replaces one language's slides for a course, in one call: the PowerPoint tool exports a lesson,
// generates narration, and posts the whole thing here (see tools/pptx-til-leksjon). Partial edits
// aren't supported on purpose — a lesson is regenerated as a unit, and a half-replaced one would
// mean slide 4 narrating something slide 4 no longer shows.
//
// `slides` is a JSON array; file fields are named image_<i>/audio_<i> by position in it.
trainingRouter.post(
  "/courses/:id/slides",
  requireAuth,
  requireRole("admin", "manager"),
  slideUpload.any(),
  async (req, res) => {
    const { course, status, code, error } = getCourseScoped(req.params.id, req.user);
    if (error) return res.status(status).json({ code, error });

    const language = normalizeLanguage(req.body.language);
    if (!language) return res.status(400).json({ code: "unsupported_language", error: "Ukjent språk." });

    let incoming;
    try {
      incoming = JSON.parse(req.body.slides || "[]");
    } catch {
      return res.status(400).json({ code: "invalid_slides", error: "slides må være gyldig JSON." });
    }
    if (!Array.isArray(incoming) || incoming.length === 0) {
      return res.status(400).json({ code: "invalid_slides", error: "Leksjonen må ha minst ett lysbilde." });
    }

    const byField = new Map((req.files || []).map((f) => [f.fieldname, f]));
    const prepared = [];
    for (let i = 0; i < incoming.length; i++) {
      const imageFile = byField.get(`image_${i}`);
      const audioFile = byField.get(`audio_${i}`);
      prepared.push({
        sort_order: i,
        image_path: imageFile ? await storeSlideImage(imageFile) : null,
        audio_path: audioFile ? path.join("uploads", audioFile.filename) : null,
        narration_text: String(incoming[i]?.narration_text || "").trim() || null,
        duration_seconds: Number.isInteger(incoming[i]?.duration_seconds) ? incoming[i].duration_seconds : null,
      });
    }

    const existing = db
      .prepare("SELECT id, image_path, audio_path FROM training_slides WHERE course_id = ? AND language = ?")
      .all(course.id, language);

    const insert = db.prepare(
      `INSERT INTO training_slides (course_id, language, sort_order, image_path, audio_path, narration_text, duration_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    db.transaction(() => {
      db.prepare("DELETE FROM training_slides WHERE course_id = ? AND language = ?").run(course.id, language);
      for (const slide of prepared) {
        insert.run(course.id, language, slide.sort_order, slide.image_path, slide.audio_path, slide.narration_text, slide.duration_seconds);
      }
      // Replacing material someone may already have signed for is a new version of the course —
      // the matrix then shows those signatures as "signert på en eldre versjon" rather than
      // silently treating them as covering content they never saw. A first upload isn't a change.
      if (existing.length > 0) db.prepare("UPDATE training_courses SET version = version + 1 WHERE id = ?").run(course.id);
    })();

    existing.forEach((slide) => {
      removeUploadedFile(slide.image_path);
      removeUploadedFile(slide.audio_path);
    });

    res.status(201).json(courseWithExtras(db.prepare("SELECT * FROM training_courses WHERE id = ?").get(course.id), todayInOslo()));
  }
);

// --- Overview --------------------------------------------------------------------------------

// Everyone the matrix has a row for: the company's own staff, never customers or super_admins.
// Deactivated accounts are included but flagged — their training history is still documentation of
// what the company did, and hiding it would make an audit trail disappear on the day someone quits.
function staffOf(companyId) {
  return db
    .prepare(
      `SELECT id, name, role, department_id, active FROM users
       WHERE company_id = ? AND role NOT IN ('customer', 'super_admin') ORDER BY name`
    )
    .all(companyId);
}

function buildOverview(companyId, today) {
  const courses = db
    .prepare("SELECT * FROM training_courses WHERE company_id = ? AND active = 1 ORDER BY sort_order, title")
    .all(companyId);
  const users = staffOf(companyId);

  const assignments = db
    .prepare("SELECT a.* FROM training_assignments a JOIN training_courses c ON c.id = a.course_id WHERE c.company_id = ?")
    .all(companyId);
  const records = db
    .prepare(
      `SELECT r.* FROM training_records r JOIN training_courses c ON c.id = r.course_id WHERE c.company_id = ?
       ORDER BY r.user_id, r.course_id, COALESCE(r.completed_at, r.started_at) DESC, r.id DESC`
    )
    .all(companyId);

  const assignedBy = new Map(assignments.map((a) => [`${a.user_id}:${a.course_id}`, a]));
  const latestBy = new Map();
  for (const r of records) {
    const key = `${r.user_id}:${r.course_id}`;
    if (!latestBy.has(key)) latestBy.set(key, r);
  }

  return {
    courses: courses.map((c) => ({
      id: c.id,
      title: c.title,
      kind: c.kind,
      kind_label: COURSE_KIND_LABELS[c.kind] || c.kind,
      version: c.version,
      validity_months: c.validity_months,
    })),
    users: users.map((u) => {
      const cells = {};
      for (const course of courses) {
        const key = `${u.id}:${course.id}`;
        const record = latestBy.get(key) || null;
        const assignment = assignedBy.get(key) || null;
        cells[course.id] = {
          status: statusOf(record, today),
          assigned: !!assignment,
          assignment_id: assignment?.id ?? null,
          due_at: assignment?.due_at ?? null,
          record_id: record?.id ?? null,
          completed_at: record?.completed_at ?? null,
          expires_at: record?.expires_at ?? null,
          signed_initials: record?.signed_initials ?? null,
          // Signed, but the course has been revised since — worth re-running, without pretending
          // the old signature never happened.
          outdated: !!record?.completed_at && record.course_version < course.version,
        };
      }
      return { id: u.id, name: u.name, role: u.role, department_id: u.department_id, active: !!u.active, cells };
    }),
  };
}

trainingRouter.get("/overview", requireAuth, requireRole("admin", "manager"), (req, res) => {
  res.json(buildOverview(req.user.company_id, todayInOslo()));
});

// --- Assignments -----------------------------------------------------------------------------

trainingRouter.post("/assignments", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { course, status, code, error } = getCourseScoped(req.body.course_id, req.user);
  if (error) return res.status(status).json({ code, error });

  const { user_ids, department_id, role, due_at } = req.body;
  let targets = [];
  if (Array.isArray(user_ids) && user_ids.length > 0) {
    // Never trusted as given: each id is re-read and re-scoped, the same way deviations.js
    // re-validates a room_id/run_id out of a request body before using it.
    for (const id of user_ids) {
      const { target, error: targetError } = getStaffTarget(id, req.user);
      if (targetError) return res.status(403).json({ code: "not_allowed", error: "Not allowed" });
      targets.push(target);
    }
  } else if (department_id) {
    targets = db
      .prepare(
        `SELECT id FROM users WHERE company_id = ? AND department_id = ?
         AND role NOT IN ('customer', 'super_admin') AND active = 1`
      )
      .all(req.user.company_id, department_id);
  } else if (role) {
    targets = db
      .prepare("SELECT id FROM users WHERE company_id = ? AND role = ? AND active = 1")
      .all(req.user.company_id, role);
  } else {
    return res.status(400).json({ code: "no_targets", error: "Velg minst én ansatt, en avdeling eller en rolle." });
  }

  if (targets.length === 0) {
    return res.status(400).json({ code: "no_targets", error: "Ingen ansatte å tildele kurset til." });
  }

  // INSERT OR IGNORE against UNIQUE(course_id, user_id): re-running "tildel hele Vest" after two
  // new hires should add those two and quietly leave the other nineteen alone, not fail.
  const insert = db.prepare(
    "INSERT OR IGNORE INTO training_assignments (course_id, user_id, assigned_by, due_at) VALUES (?, ?, ?, ?)"
  );
  let added = 0;
  db.transaction(() => {
    for (const t of targets) added += insert.run(course.id, t.id, req.user.id, due_at || null).changes;
  })();

  res.status(201).json({ added, targeted: targets.length });
});

trainingRouter.delete("/assignments/:id", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const assignment = db
    .prepare("SELECT a.id, c.company_id FROM training_assignments a JOIN training_courses c ON c.id = a.course_id WHERE a.id = ?")
    .get(req.params.id);
  if (!assignment) return res.status(404).json({ code: "not_found", error: "Not found" });
  if (assignment.company_id !== req.user.company_id) return res.status(403).json({ code: "not_allowed", error: "Not allowed" });

  // Only the assignment goes — any record of training actually received stays. Taking someone off a
  // course they have already been through must never erase that they went through it.
  db.prepare("DELETE FROM training_assignments WHERE id = ?").run(assignment.id);
  res.json({ ok: true });
});

// --- Records registered by an admin ------------------------------------------------------------

// Physical training, an external course, a routine gone through in person — the forms of training
// that happen away from the app and are documented here afterwards. registered_by records who
// entered it, so an admin-registered signature is never confused with a self-signed one.
trainingRouter.post(
  "/records",
  requireAuth,
  requireRole("admin", "manager"),
  // .fields rather than .single: the person is standing there when a leader registers a course
  // held in a room, so the signature can be drawn on the spot alongside any certificate.
  evidenceUpload.fields([{ name: "evidence", maxCount: 1 }, { name: "signature", maxCount: 1 }]),
  async (req, res) => {
    const evidenceFile = req.files?.evidence?.[0] || null;
    const signatureFile = req.files?.signature?.[0] || null;
    const { course, status, code, error } = getCourseScoped(req.body.course_id, req.user);
    if (error) return res.status(status).json({ code, error });
    const { target, status: targetStatus, code: targetCode, error: targetError } = getStaffTarget(req.body.user_id, req.user);
    if (targetError) return res.status(targetStatus).json({ code: targetCode, error: targetError });

    const completedAt = dayOf(req.body.completed_at) || todayInOslo();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(completedAt)) {
      return res.status(400).json({ code: "invalid_date", error: "Ugyldig dato." });
    }
    const signedInitials = String(req.body.signed_initials || "").trim();
    if (course.requires_signature && !signedInitials) {
      return res.status(400).json({ code: "signature_required", error: "Skriv inn navnet til den som har fått opplæringen." });
    }

    let evidencePath = null;
    if (evidenceFile) {
      if (evidenceFile.mimetype.startsWith("image/")) {
        await normalizeImageOrientation(path.join(process.env.UPLOADS_DIR || "uploads", evidenceFile.filename));
      }
      evidencePath = path.join("uploads", evidenceFile.filename);
    }
    // Not run through normalizeImageOrientation: a canvas PNG has no EXIF to rotate by, and
    // sharp would only rewrite the file for nothing.
    const signaturePath = signatureFile ? path.join("uploads", signatureFile.filename) : null;

    const info = db
      .prepare(
        `INSERT INTO training_records
          (course_id, course_version, user_id, started_at, completed_at, signed_at, signed_initials,
           registered_by, instructor, evidence_path, evidence_name, signature_path, expires_at, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        course.id, course.version, target.id, completedAt, completedAt,
        signedInitials ? completedAt : null, signedInitials || null,
        req.user.id, String(req.body.instructor || "").trim() || null,
        evidencePath, evidenceFile ? String(req.body.evidence_name || evidenceFile.originalname).trim() : null,
        signaturePath, computeExpiry(completedAt, course.validity_months), String(req.body.note || "").trim() || null
      );

    res.status(201).json(db.prepare("SELECT * FROM training_records WHERE id = ?").get(info.lastInsertRowid));
  }
);

// Admin-only, for correcting a mis-registered one. Deliberately not open to a manager, and never
// to the person themselves: a signature you can delete yourself documents nothing.
trainingRouter.delete("/records/:id", requireAuth, requireRole("admin"), (req, res) => {
  const { record, status, code, error } = getRecordScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ code, error });

  if (record.evidence_path) removeUploadedFile(record.evidence_path);
  if (record.signature_path) removeUploadedFile(record.signature_path);
  db.prepare("DELETE FROM training_records WHERE id = ?").run(record.id);
  res.json({ ok: true });
});

// --- One person --------------------------------------------------------------------------------

function trainingForUser(userId, companyId, today) {
  const courses = db
    .prepare("SELECT * FROM training_courses WHERE company_id = ? ORDER BY sort_order, title")
    .all(companyId);
  const assignments = db.prepare("SELECT * FROM training_assignments WHERE user_id = ?").all(userId);
  const records = db
    .prepare(
      `SELECT r.* FROM training_records r JOIN training_courses c ON c.id = r.course_id
       WHERE r.user_id = ? AND c.company_id = ?
       ORDER BY COALESCE(r.completed_at, r.started_at) DESC, r.id DESC`
    )
    .all(userId, companyId);

  const assignedBy = new Map(assignments.map((a) => [a.course_id, a]));
  return courses
    .map((course) => {
      const courseRecords = records.filter((r) => r.course_id === course.id);
      const latest = courseRecords[0] || null;
      const assignment = assignedBy.get(course.id) || null;
      return {
        course_id: course.id,
        title: course.title,
        description: course.description,
        kind: course.kind,
        kind_label: COURSE_KIND_LABELS[course.kind] || course.kind,
        version: course.version,
        active: !!course.active,
        validity_months: course.validity_months,
        requires_signature: !!course.requires_signature,
        requires_drawn_signature: !!course.requires_drawn_signature,
        video_url: course.video_url,
        assigned: !!assignment,
        assignment_id: assignment?.id ?? null,
        due_at: assignment?.due_at ?? null,
        status: statusOf(latest, today),
        outdated: !!latest?.completed_at && latest.course_version < course.version,
        slide_count: db
          .prepare("SELECT COUNT(*) AS n FROM training_slides WHERE course_id = ?")
          .get(course.id).n,
        files: db
          .prepare("SELECT id, name, file_path, language FROM training_course_files WHERE course_id = ? ORDER BY created_at")
          .all(course.id),
        record: latest,
        history: courseRecords,
      };
    })
    // A course nobody assigned and nobody took is noise on a person's card — keep the row only when
    // there is something to say about it.
    .filter((row) => row.assigned || row.record);
}

trainingRouter.get("/users/:id", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { target, status, code, error } = getStaffTarget(req.params.id, req.user);
  if (error) return res.status(status).json({ code, error });
  res.json({ user: target, courses: trainingForUser(target.id, req.user.company_id, todayInOslo()) });
});

// --- The staff member's own view ---------------------------------------------------------------

trainingRouter.get("/me", requireAuth, requireRole("admin", "manager", "cleaner"), (req, res) => {
  const rows = trainingForUser(req.user.id, req.user.company_id, todayInOslo());
  // A deactivated course she never started disappears; one she already has a record on stays, so a
  // receipt never vanishes from under her.
  res.json(rows.filter((row) => row.active || row.record));
});

// The slides for one lesson, in the caller's own language — falling back to Norwegian, which is the
// language every course is expected to have (see utils/languages.js).
trainingRouter.get("/me/courses/:id/slides", requireAuth, requireRole("admin", "manager", "cleaner"), (req, res) => {
  const { course, status, code, error } = getCourseScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ code, error });

  // The language she is reading the app in right now wins over the one stored on her account — she
  // may have picked a different one from the header, and that is the language she can actually read.
  const wanted = normalizeLanguage(req.query.language) || accountLanguage(req.user.id);
  const available = db
    .prepare("SELECT DISTINCT language FROM training_slides WHERE course_id = ? ORDER BY language")
    .all(course.id)
    .map((r) => r.language);
  const language = available.includes(wanted)
    ? wanted
    : available.includes(DEFAULT_LANGUAGE)
      ? DEFAULT_LANGUAGE
      : available[0];
  if (!language) return res.json({ language: null, available, slides: [] });

  const slides = db
    .prepare(
      `SELECT id, sort_order, image_path, audio_path, narration_text, duration_seconds
       FROM training_slides WHERE course_id = ? AND language = ? ORDER BY sort_order`
    )
    .all(course.id, language);
  res.json({ language, available, slides });
});

// Opens — or resumes — the caller's own attempt at a course she has been assigned.
trainingRouter.post("/me/courses/:id/start", requireAuth, requireRole("admin", "manager", "cleaner"), (req, res) => {
  const { course, status, code, error } = getCourseScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ code, error });

  const assigned = db
    .prepare("SELECT 1 FROM training_assignments WHERE course_id = ? AND user_id = ?")
    .get(course.id, req.user.id);
  if (!assigned) return res.status(403).json({ code: "course_not_assigned", error: "Dette kurset er ikke tildelt deg." });

  const open = db
    .prepare("SELECT * FROM training_records WHERE course_id = ? AND user_id = ? AND completed_at IS NULL ORDER BY id DESC")
    .get(course.id, req.user.id);
  if (open) return res.json(open);

  // Snapshotted at start, in the language she will actually be shown: what "saw all of it" means
  // has to be fixed when the attempt begins, not re-read later from a course that may have grown a
  // slide in the meantime.
  const countSlides = db.prepare("SELECT COUNT(*) AS n FROM training_slides WHERE course_id = ? AND language = ?");
  const slidesTotal =
    countSlides.get(course.id, normalizeLanguage(req.body?.language) || accountLanguage(req.user.id)).n ||
    countSlides.get(course.id, DEFAULT_LANGUAGE).n;

  const info = db
    .prepare("INSERT INTO training_records (course_id, course_version, user_id, slides_total) VALUES (?, ?, ?, ?)")
    .run(course.id, course.version, req.user.id, slidesTotal);
  res.status(201).json(db.prepare("SELECT * FROM training_records WHERE id = ?").get(info.lastInsertRowid));
});

trainingRouter.patch("/me/records/:id/progress", requireAuth, requireRole("admin", "manager", "cleaner"), (req, res) => {
  const { record, status, code, error } = getRecordScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ code, error });
  if (record.user_id !== req.user.id) return res.status(403).json({ code: "not_allowed", error: "Not allowed" });
  if (record.completed_at) return res.status(409).json({ code: "already_completed", error: "Kurset er allerede fullført." });

  // A video course reports one thing and one thing only: that the player said it reached the end.
  // Stamped once and never cleared — watching it again should not un-watch it.
  if (req.body.video_completed === true) {
    db.prepare("UPDATE training_records SET video_completed_at = COALESCE(video_completed_at, ?) WHERE id = ?")
      .run(nowStamp(), record.id);
    return res.json(db.prepare("SELECT * FROM training_records WHERE id = ?").get(record.id));
  }

  const lastIndex = Number(req.body.last_slide_index);
  const seen = Number(req.body.slides_seen);
  if (!Number.isInteger(lastIndex) || lastIndex < 0) {
    return res.status(400).json({ code: "invalid_progress", error: "Ugyldig fremdrift." });
  }

  // slides_seen only ever climbs: paging back to slide 3 to re-read something must not undo that
  // slides 4-12 were already watched.
  db.prepare("UPDATE training_records SET last_slide_index = ?, slides_seen = MAX(slides_seen, ?) WHERE id = ?")
    .run(lastIndex, Number.isInteger(seen) && seen > 0 ? seen : 0, record.id);

  res.json(db.prepare("SELECT * FROM training_records WHERE id = ?").get(record.id));
});

// Multipart rather than JSON because of the drawn signature — a canvas PNG as base64 inside a JSON
// body would sail past express.json()'s 100 kB limit on a long signature, and would sidestep the
// fileFilter and size limit every other upload in this app goes through.
trainingRouter.post(
  "/me/records/:id/sign",
  requireAuth,
  requireRole("admin", "manager", "cleaner"),
  signatureUpload.single("signature"),
  (req, res) => {
  // multer has already written the signature to disk by the time this runs, so every path that
  // refuses the signing has to take it away again — otherwise a person tapping "signer" twice on a
  // bad signal leaves a file on the disk that no row will ever point at.
  const signaturePath = req.file ? path.join("uploads", req.file.filename) : null;
  const refuse = (httpStatus, body) => {
    if (signaturePath) removeUploadedFile(signaturePath);
    return res.status(httpStatus).json(body);
  };

  const { record, status, code, error } = getRecordScoped(req.params.id, req.user);
  if (error) return refuse(status, { code, error });
  if (record.user_id !== req.user.id) return refuse(403, { code: "not_allowed", error: "Not allowed" });
  if (record.completed_at) return refuse(409, { code: "already_completed", error: "Kurset er allerede fullført." });

  // The whole claim this module makes is "she saw the training". A lesson signed halfway through
  // would make that claim falsely, so the gate lives here on the server, not only in the player.
  if (record.kind === "lesson" && record.slides_total > 0 && (record.slides_seen || 0) < record.slides_total) {
    return refuse(409, { code: "lesson_not_finished", error: "Du må se hele leksjonen før du kan signere." });
  }
  // Weaker evidence than the slide count — the scrubber can be dragged — but it is what a player
  // can honestly report, and it still means the video ran to its end on her device.
  if (record.kind === "video" && !record.video_completed_at) {
    return refuse(409, { code: "video_not_finished", error: "Du må se hele videoen før du kan signere." });
  }

  const signedInitials = String(req.body.signed_initials || "").trim();
  if (record.requires_signature && !signedInitials) {
    return refuse(400, { code: "signature_required", error: "Skriv inn navnet ditt for å signere." });
  }
  if (record.requires_drawn_signature && !signaturePath) {
    return refuse(400, { code: "drawn_signature_required", error: "Skriv signaturen din i feltet." });
  }

  const completedAt = nowStamp();
  db.prepare(
    `UPDATE training_records SET completed_at = ?, signed_at = ?, signed_initials = ?, signature_path = ?, expires_at = ?
     WHERE id = ?`
  ).run(
    completedAt,
    signedInitials ? completedAt : null,
    signedInitials || null,
    signaturePath,
    computeExpiry(completedAt, record.validity_months),
    record.id
  );

  res.json(db.prepare("SELECT * FROM training_records WHERE id = ?").get(record.id));
  }
);

// --- Documentation on paper --------------------------------------------------------------------

function drawPdfHeader(doc, title, subtitle) {
  doc.fontSize(20).fillColor("black").text(title);
  if (subtitle) doc.fontSize(11).fillColor("gray").text(subtitle);
  doc.moveDown();
}

// One page per course, laid out as a certificate rather than a list. The old version stacked every
// course into a flowing list and dropped the signature image into the middle of it, which put a
// handwritten scrawl in between two lines of grey label text and read as a mess. Håkon pointed at
// OKV's own Solenis/Lilleborg certificates as the shape to hit: one page per person per course,
// the name large, the course named, the date and the instructor stated, and room to breathe.
//
// The signature block is anchored to a fixed height above the footer instead of flowing with the
// text above it, so it lands in the same place on every page whatever the course is called.
const ACCENT = "#f97316";
const INK = "#18181b";
const MUTED = "#71717a";

function formatNorwegianDate(value) {
  const day = dayOf(value);
  if (!day) return "";
  const months = [
    "januar", "februar", "mars", "april", "mai", "juni",
    "juli", "august", "september", "oktober", "november", "desember",
  ];
  const [y, m, d] = day.split("-").map(Number);
  return `${d}. ${months[m - 1]} ${y}`;
}

function drawCertificatePage(doc, { company, person, department, row, today }) {
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bottom = doc.page.height - doc.page.margins.bottom;

  doc.rect(0, 0, doc.page.width, 12).fill(ACCENT);

  doc.font("Helvetica-Bold").fontSize(11).fillColor(MUTED)
    .text((company?.name || "").toUpperCase(), left, 56, { width, characterSpacing: 1.5 });

  doc.font("Helvetica-Bold").fontSize(34).fillColor(INK).text("Kursbevis", left, 96, { width });
  doc.rect(left, 146, 70, 4).fill(ACCENT);

  doc.font("Helvetica").fontSize(12).fillColor(MUTED).text("Dette bekrefter at", left, 200, { width });
  doc.font("Helvetica-Bold").fontSize(26).fillColor(INK).text(person.name, left, 222, { width });
  doc.font("Helvetica").fontSize(12).fillColor(MUTED)
    .text(department ? `${department.name} · har gjennomført` : "har gjennomført", left, 262, { width });
  doc.font("Helvetica-Bold").fontSize(19).fillColor(INK).text(row.title, left, 286, { width });

  let y = doc.y + 18;
  if (row.description) {
    doc.font("Helvetica").fontSize(11).fillColor(MUTED).text(row.description, left, y, { width });
    y = doc.y + 10;
  }

  // Label/value pairs in two columns, so the page has structure instead of a paragraph of facts.
  const facts = [
    ["Gjennomført", formatNorwegianDate(row.record.completed_at)],
    ["Type", row.kind_label],
    row.record.instructor ? ["Holdt av", row.record.instructor] : null,
    row.record.expires_at
      ? [row.status === "expired" ? "Utløpt" : "Gyldig til", formatNorwegianDate(row.record.expires_at)]
      : ["Gyldighet", "Uten utløpsdato"],
    // Slide count deliberately left off: it is the evidence behind the claim, not part of the
    // claim. On a certificate handed to a customer or an inspector, "saw 6 of 6 slides" reads as a
    // receipt from an e-learning system rather than a qualification. It stays visible on the
    // person's card in the admin view, which is where someone would go to check it.
    row.record.evidence_name ? ["Vedlagt bevis", row.record.evidence_name] : null,
  ].filter(Boolean);

  y = Math.max(y, 380);
  doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.5).strokeColor("#e4e4e7").stroke();
  y += 18;

  const columnWidth = width / 2;
  facts.forEach(([label, value], i) => {
    const x = left + (i % 2) * columnWidth;
    const rowY = y + Math.floor(i / 2) * 46;
    doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(label.toUpperCase(), x, rowY, { width: columnWidth - 20, characterSpacing: 0.8 });
    doc.font("Helvetica-Bold").fontSize(12)
      .fillColor(label === "Utløpt" ? "#dc2626" : INK)
      .text(value, x, rowY + 14, { width: columnWidth - 20 });
  });

  // Anchored to the bottom, not to however long the course title happened to be.
  const signatureTop = bottom - 150;
  const lineY = bottom - 78;
  if (row.record.signature_path) {
    try {
      doc.image(path.join(process.env.UPLOADS_DIR || "uploads", path.basename(row.record.signature_path)), left, signatureTop, {
        fit: [220, 62],
        align: "left",
      });
    } catch {
      doc.font("Helvetica-Oblique").fontSize(9).fillColor(MUTED).text("(signaturbildet mangler på disk)", left, lineY - 16);
    }
  }
  doc.moveTo(left, lineY).lineTo(left + 240, lineY).lineWidth(0.8).strokeColor("#a1a1aa").stroke();
  doc.font("Helvetica").fontSize(9).fillColor(MUTED).text("SIGNATUR", left, lineY + 8, { characterSpacing: 0.8 });
  doc.font("Helvetica-Bold").fontSize(12).fillColor(INK)
    .text(row.record.signed_initials || person.name, left, lineY + 22, { width: 240 });

  if (row.record.registered_by) {
    doc.font("Helvetica").fontSize(9).fillColor(MUTED)
      .text("Registrert av arbeidsgiver", left + 300, lineY + 8, { width: width - 300 });
  }

  doc.font("Helvetica").fontSize(8).fillColor(MUTED)
    .text(`Utskrift ${today} · Rentlogg${row.version > 1 ? ` · kursversjon ${row.record.course_version}` : ""}`, left, bottom - 12, { width });
}

// Shared by the admin route below and by the staff member fetching her own copy. Expired courses
// are deliberately included, marked as expired: a certificate that quietly leaves out that the
// hygiene course ran out last year is a worse document, not a kinder one.
function sendCertificate(res, target, companyId) {
  const today = todayInOslo();
  const rows = trainingForUser(target.id, companyId, today).filter((row) => row.record?.completed_at);
  const company = db.prepare("SELECT name FROM companies WHERE id = ?").get(companyId);
  const department = target.department_id
    ? db.prepare("SELECT name FROM departments WHERE id = ?").get(target.department_id)
    : null;

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=kursbevis-${target.id}.pdf`);

  // A4 rather than pdfkit's default letter: this gets printed and filed in Norway.
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  doc.pipe(res);

  if (rows.length === 0) {
    doc.rect(0, 0, doc.page.width, 12).fill(ACCENT);
    doc.font("Helvetica-Bold").fontSize(26).fillColor(INK).text("Kursbevis", 50, 96);
    doc.font("Helvetica").fontSize(12).fillColor(MUTED)
      .text(`Ingen gjennomført opplæring er registrert på ${target.name}.`, 50, 150);
  }

  rows.forEach((row, index) => {
    if (index > 0) doc.addPage();
    drawCertificatePage(doc, { company, person: target, department, row, today });
  });

  doc.end();
}

trainingRouter.get("/users/:id/certificate.pdf", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { target, status, code, error } = getStaffTarget(req.params.id, req.user);
  if (error) return res.status(status).json({ code, error });
  sendCertificate(res, target, req.user.company_id);
});

// Her own copy. The route above deliberately refuses a cleaner asking after a colleague's
// certificate, and caught her own in the same net — but her own training record is the one piece of
// personnel data she is plainly entitled to, and can request under GDPR whatever the app does. This
// is just the cheap way to answer that request. It is also hers in a practical sense: documented
// hygiene training is a qualification she carries to her next job, not only paperwork about her.
trainingRouter.get("/me/certificate.pdf", requireAuth, requireRole("admin", "manager", "cleaner"), (req, res) => {
  const me = db.prepare("SELECT id, name, department_id FROM users WHERE id = ?").get(req.user.id);
  if (!me) return res.status(404).json({ code: "not_found", error: "Not found" });
  sendCertificate(res, me, req.user.company_id);
});

const PARTICIPANT_STATUS_TEXT = {
  done: "Gjennomført",
  expiring: "Gjennomført (utløper snart)",
  expired: "Utløpt",
  in_progress: "Påbegynt",
  none: "Ikke gjennomført",
};

trainingRouter.get("/courses/:id/participants.pdf", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { course, status, code, error } = getCourseScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ code, error });

  const today = todayInOslo();
  const overview = buildOverview(req.user.company_id, today);
  const company = db.prepare("SELECT name FROM companies WHERE id = ?").get(req.user.company_id);
  const rows = overview.users
    .map((u) => ({ name: u.name, cell: u.cells[course.id] }))
    .filter((r) => r.cell && (r.cell.assigned || r.cell.record_id));

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=deltakerliste-${course.id}.pdf`);

  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);

  drawPdfHeader(doc, course.title, `${company?.name || ""} · ${COURSE_KIND_LABELS[course.kind] || course.kind}`);
  doc.fontSize(10).fillColor("gray").text(`Utskrift ${today}`);
  doc.moveDown();

  rows.forEach((row) => {
    if (doc.y > doc.page.height - 90) doc.addPage();
    doc.fontSize(11).fillColor("black").text(row.name, { continued: true });
    const done = row.cell.status === "done" || row.cell.status === "expiring";
    doc
      .fillColor(done ? "green" : row.cell.status === "expired" ? "red" : "gray")
      .text(`   ${PARTICIPANT_STATUS_TEXT[row.cell.status] || row.cell.status}`);
    const details = [
      row.cell.completed_at ? `Dato ${dayOf(row.cell.completed_at)}` : null,
      row.cell.signed_initials ? `Signert ${row.cell.signed_initials}` : null,
      row.cell.expires_at ? `Gyldig til ${dayOf(row.cell.expires_at)}` : null,
    ].filter(Boolean);
    if (details.length) doc.fontSize(9).fillColor("gray").text(`    ${details.join(" · ")}`);
  });

  if (rows.length === 0) doc.fontSize(11).fillColor("gray").text("Ingen er tildelt dette kurset ennå.");

  doc.end();
});
