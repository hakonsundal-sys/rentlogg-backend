import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import PDFDocument from "pdfkit";
import { db } from "../db.js";
import { requireRole } from "../middleware/auth.js";
import { todayInOslo } from "../services/schedule.js";
import { csvEscape } from "../utils/csv.js";
import { safeOriginalName, compressUploadedPhoto, imageFileFilter, removeUploadedFile } from "../utils/uploads.js";

// Sjekklister-modulen: enkle avkrysningslister for bedrifter som ikke driver renhold (se tabellene
// simple_checklist_* i schema.sql for hvorfor dette ikke er rom med nye navn).
//
// Montert bak requireAuth + requireModule("checklist") i server.js. Scoping følger samme form som
// resten av systemet: alt er firma-scopet på company_id, og ansatte (cleaner) er bevisst uscopet
// innenfor eget firma — de kan se hele loggen, slik de kan se alle besøk i renholdsdelen. Unntaket
// er et UTKAST: det tilhører den som startet det, og ingen andre kan skrive i det.
//
// `customer` har ingenting her å gjøre. Sjekklistene er bedriftens egne rutiner, ikke noe den
// viser fram til en oppdragsgiver.
export const simpleChecklistsRouter = Router();

const STAFF = ["admin", "manager", "cleaner"];
const MANAGERS = ["admin", "manager"];

simpleChecklistsRouter.use(requireRole(...STAFF));

const uploadsDir = process.env.UPLOADS_DIR || "uploads";

const upload = multer({
  storage: multer.diskStorage({
    destination: process.env.UPLOADS_DIR || "uploads/",
    filename: (req, file, cb) => cb(null, `${Date.now()}-${safeOriginalName(file.originalname)}`),
  }),
  fileFilter: imageFileFilter,
  limits: { fileSize: 20 * 1024 * 1024 },
});

const STATUSES = new Set(["ok", "deviation", "na"]);
const STATUS_LABEL = { ok: "OK", deviation: "Avvik", na: "Ikke relevant" };
const MAX_LABEL = 300;
const MAX_TEXT = 2000;

// --- hjelpere ---------------------------------------------------------------------------------

// '1,3,5' <-> [1, 3, 5]. Tom liste = ved behov. Validert og sortert, så samme utvalg alltid
// lagres likt og «er lista planlagt i dag» blir en enkel includes.
function parseWeekdays(value) {
  if (value === null || value === undefined || value === "") return { weekdays: [] };
  if (!Array.isArray(value)) return { error: { code: "weekdays_invalid", error: "Ukedager må være en liste." } };
  const days = [...new Set(value.map(Number))];
  if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    return { error: { code: "weekdays_invalid", error: "Ukedager må være tall fra 0 (søndag) til 6 (lørdag)." } };
  }
  return { weekdays: days.sort((a, b) => a - b) };
}

function weekdaysFromColumn(text) {
  if (!text) return [];
  return text.split(",").filter((s) => s !== "").map(Number);
}

// Samme konvensjon som services/schedule.js: datostrengen tolkes som lokal midnatt, så ukedagen
// blir den samme uansett hvilken tidssone serveren kjører i.
function weekdayOf(dateStr) {
  return new Date(`${dateStr}T00:00:00`).getDay();
}

function isDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function cleanText(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function serializeList(row) {
  return { ...row, weekdays: weekdaysFromColumn(row.weekdays), active: !!row.active };
}

// Delt eierskapssjekk per nivå, samme form som getSiteScoped/getRoomScoped andre steder.
function getListScoped(id, user) {
  const list = db.prepare("SELECT * FROM simple_checklists WHERE id = ?").get(id);
  if (!list) return { status: 404, code: "not_found", error: "Not found" };
  if (list.company_id !== user.company_id) return { status: 403, code: "not_allowed", error: "Not allowed" };
  return { list };
}

function getSubmissionScoped(id, user) {
  const submission = db.prepare("SELECT * FROM simple_checklist_submissions WHERE id = ?").get(id);
  if (!submission) return { status: 404, code: "not_found", error: "Not found" };
  if (submission.company_id !== user.company_id) return { status: 403, code: "not_allowed", error: "Not allowed" };
  // Et utkast er ikke dokumentasjon ennå, og hører til den som holder på med det. Andre ser det
  // ikke — heller ikke en admin, som ellers ville sett halvferdige skjemaer dukke opp i loggen.
  if (!submission.submitted_at && submission.user_id !== user.id) {
    return { status: 404, code: "not_found", error: "Not found" };
  }
  return { submission };
}

// Skriving i en utfylling: bare eierens eget utkast. Innsendt er låst for alle, også admin —
// en sjekkliste rettet i etterkant fra et kontor er ikke lenger det som ble krysset av på stedet.
function getOwnDraft(id, user) {
  const scoped = getSubmissionScoped(id, user);
  if (scoped.error) return scoped;
  if (scoped.submission.submitted_at) {
    return { status: 409, code: "submission_locked", error: "Sjekklisten er sendt inn og kan ikke endres." };
  }
  return scoped;
}

function fail(res, { status, code, error }) {
  return res.status(status).json({ code, error });
}

function submissionDetail(id) {
  const submission = db.prepare("SELECT * FROM simple_checklist_submissions WHERE id = ?").get(id);
  const answers = db
    .prepare("SELECT * FROM simple_checklist_answers WHERE submission_id = ? ORDER BY sort_order, id")
    .all(id);
  const photos = db
    .prepare("SELECT id, answer_id, file_path, created_at FROM simple_checklist_photos WHERE submission_id = ? ORDER BY id")
    .all(id)
    .map((p) => ({ ...p, file_path: path.basename(p.file_path) }));
  const list = submission.checklist_id
    ? db.prepare("SELECT description FROM simple_checklists WHERE id = ?").get(submission.checklist_id)
    : null;
  return { ...submission, description: list?.description ?? null, answers, photos };
}

// --- sjekklistene (oppsett) -------------------------------------------------------------------

simpleChecklistsRouter.get("/", (req, res) => {
  const includeArchived = req.query.include_archived === "1";
  const rows = db
    .prepare(
      `SELECT l.*,
              (SELECT COUNT(*) FROM simple_checklist_items i WHERE i.checklist_id = l.id) AS item_count,
              (SELECT MAX(s.submitted_at) FROM simple_checklist_submissions s
                 WHERE s.checklist_id = l.id AND s.submitted_at IS NOT NULL) AS last_submitted_at
       FROM simple_checklists l
       WHERE l.company_id = ? ${includeArchived ? "" : "AND l.active = 1"}
       ORDER BY l.active DESC, l.sort_order, l.name COLLATE NOCASE`
    )
    .all(req.user.company_id);
  res.json(rows.map(serializeList));
});

// Den ansattes startside: alle aktive lister, med hva som er gjort i dag og om personen har et
// utkast liggende. Lister som ikke er planlagt i dag er med — merket — fordi en rutine av og til
// tas en annen dag, og da skal den ikke måtte gjemmes bak en admin.
simpleChecklistsRouter.get("/today", (req, res) => {
  const today = todayInOslo();
  const weekday = weekdayOf(today);
  const lists = db
    .prepare(
      `SELECT l.*, (SELECT COUNT(*) FROM simple_checklist_items i WHERE i.checklist_id = l.id) AS item_count
       FROM simple_checklists l WHERE l.company_id = ? AND l.active = 1
       ORDER BY l.sort_order, l.name COLLATE NOCASE`
    )
    .all(req.user.company_id);

  const doneTodayStmt = db.prepare(
    `SELECT id, user_name, submitted_at, deviation_count FROM simple_checklist_submissions
     WHERE checklist_id = ? AND work_date = ? AND submitted_at IS NOT NULL ORDER BY submitted_at DESC`
  );
  const draftStmt = db.prepare(
    `SELECT s.id,
            (SELECT COUNT(*) FROM simple_checklist_answers a WHERE a.submission_id = s.id AND a.status IS NOT NULL) AS answered,
            (SELECT COUNT(*) FROM simple_checklist_answers a WHERE a.submission_id = s.id) AS total
     FROM simple_checklist_submissions s
     WHERE s.checklist_id = ? AND s.user_id = ? AND s.submitted_at IS NULL ORDER BY s.id DESC LIMIT 1`
  );

  res.json({
    date: today,
    weekday,
    lists: lists.map((l) => {
      const weekdays = weekdaysFromColumn(l.weekdays);
      const submissions = doneTodayStmt.all(l.id, today);
      return {
        ...serializeList(l),
        on_demand: weekdays.length === 0,
        due_today: weekdays.includes(weekday),
        submissions_today: submissions,
        my_draft: draftStmt.get(l.id, req.user.id) || null,
      };
    }),
  });
});

// Ukeoversikten: én rad per liste, én kolonne per dag, med hva som var planlagt og hva som ble
// gjort. Det er denne flaten en daglig leder faktisk bruker for å se om rutinene holdes — loggen
// svarer på «hva skjedde», denne på «hva mangler».
simpleChecklistsRouter.get("/overview", requireRole(...MANAGERS), (req, res) => {
  const today = todayInOslo();
  const to = isDate(req.query.to) ? req.query.to : today;
  const from = isDate(req.query.from) ? req.query.from : addDays(to, -6);
  if (from > to) return res.status(400).json({ code: "period_reversed", error: "Fra-dato må være før til-dato." });
  const days = [];
  for (let d = from; d <= to && days.length < 62; d = addDays(d, 1)) days.push(d);

  const lists = db
    .prepare(
      `SELECT * FROM simple_checklists WHERE company_id = ? AND active = 1
       ORDER BY sort_order, name COLLATE NOCASE`
    )
    .all(req.user.company_id);
  const rows = db
    .prepare(
      `SELECT checklist_id, work_date, COUNT(*) AS n, SUM(deviation_count) AS deviations
       FROM simple_checklist_submissions
       WHERE company_id = ? AND submitted_at IS NOT NULL AND work_date BETWEEN ? AND ?
       GROUP BY checklist_id, work_date`
    )
    .all(req.user.company_id, from, to);
  const byKey = new Map(rows.map((r) => [`${r.checklist_id}|${r.work_date}`, r]));

  res.json({
    from,
    to,
    today,
    days,
    lists: lists.map((l) => {
      const weekdays = weekdaysFromColumn(l.weekdays);
      const cells = {};
      days.forEach((d) => {
        const hit = byKey.get(`${l.id}|${d}`);
        const due = weekdays.includes(weekdayOf(d));
        // «missing» bare for dager som er over. I dag er ikke en mangel før dagen er slutt, og en
        // liste opprettet i går mangler ikke for forrige uke.
        let state = "none";
        if (hit) state = hit.deviations > 0 ? "deviation" : "done";
        else if (due && d < today && d >= l.created_at.slice(0, 10)) state = "missing";
        else if (due) state = "due";
        cells[d] = { state, count: hit?.n || 0, deviations: hit?.deviations || 0 };
      });
      return { id: l.id, name: l.name, weekdays, on_demand: weekdays.length === 0, cells };
    }),
  });
});

function readListBody(body, { partial }) {
  const out = {};
  if (!partial || "name" in body) {
    const name = cleanText(body.name, 120);
    if (!name) return { error: { code: "checklist_name_required", error: "Sjekklisten må ha et navn." } };
    out.name = name;
  }
  if ("description" in body) out.description = cleanText(body.description, MAX_TEXT);
  if (!partial || "weekdays" in body) {
    const parsed = parseWeekdays(body.weekdays);
    if (parsed.error) return parsed;
    out.weekdays = parsed.weekdays.join(",") || null;
  }
  if (partial && "active" in body) out.active = body.active ? 1 : 0;
  return { values: out };
}

simpleChecklistsRouter.post("/", requireRole(...MANAGERS), (req, res) => {
  const { values, error } = readListBody(req.body || {}, { partial: false });
  if (error) return res.status(400).json(error);
  const nextSort = db
    .prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM simple_checklists WHERE company_id = ?")
    .get(req.user.company_id).n;
  const info = db
    .prepare("INSERT INTO simple_checklists (company_id, name, description, weekdays, sort_order) VALUES (?, ?, ?, ?, ?)")
    .run(req.user.company_id, values.name, values.description ?? null, values.weekdays, nextSort);

  // Punkter kan sendes med ved opprettelse, så «ny liste» kan lages i ett steg fra en mal.
  const labels = Array.isArray(req.body.items) ? req.body.items : [];
  const insertItem = db.prepare(
    "INSERT INTO simple_checklist_items (checklist_id, label, help_text, sort_order) VALUES (?, ?, ?, ?)"
  );
  labels.forEach((item, i) => {
    const label = cleanText(typeof item === "string" ? item : item?.label, MAX_LABEL);
    if (label) insertItem.run(info.lastInsertRowid, label, cleanText(item?.help_text, MAX_TEXT), i + 1);
  });

  res.status(201).json(listWithItems(info.lastInsertRowid));
});

function listWithItems(id) {
  const list = db.prepare("SELECT * FROM simple_checklists WHERE id = ?").get(id);
  const items = db
    .prepare("SELECT * FROM simple_checklist_items WHERE checklist_id = ? ORDER BY sort_order, id")
    .all(id);
  return { ...serializeList(list), items };
}

simpleChecklistsRouter.get("/submissions", (req, res) => {
  res.json(querySubmissions(req));
});

simpleChecklistsRouter.get("/submissions.csv", requireRole(...MANAGERS), (req, res) => {
  const rows = querySubmissions(req, { limit: 10000 });
  const answersStmt = db.prepare(
    "SELECT label, status, comment FROM simple_checklist_answers WHERE submission_id = ? ORDER BY sort_order, id"
  );
  const header = ["Dato", "Sjekkliste", "Utført av", "Sendt inn", "Punkter", "OK", "Avvik", "Ikke relevant", "Avvikspunkter", "Kommentar"];
  const lines = [header.map(csvEscape).join(",")];
  rows.forEach((r) => {
    const answers = answersStmt.all(r.id);
    const count = (s) => answers.filter((a) => a.status === s).length;
    const deviations = answers
      .filter((a) => a.status === "deviation")
      .map((a) => (a.comment ? `${a.label}: ${a.comment}` : a.label))
      .join(" | ");
    lines.push(
      [r.work_date, r.checklist_name, r.user_name, r.submitted_at, answers.length, count("ok"), count("deviation"), count("na"), deviations, r.note || ""]
        .map(csvEscape)
        .join(",")
    );
  });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=sjekkliste-logg.csv`);
  // BOM, så Excel leser æøå riktig — samme som de andre CSV-eksportene.
  res.send(`﻿${lines.join("\r\n")}`);
});

// Loggen: bare innsendte utfyllinger. Filtrene er de en leder faktisk spør etter — periode, liste,
// person, og «bare de med avvik».
function querySubmissions(req, { limit = 500 } = {}) {
  const conditions = ["s.company_id = ?", "s.submitted_at IS NOT NULL"];
  const params = [req.user.company_id];
  if (isDate(req.query.from)) { conditions.push("s.work_date >= ?"); params.push(req.query.from); }
  if (isDate(req.query.to)) { conditions.push("s.work_date <= ?"); params.push(req.query.to); }
  if (req.query.checklist_id) { conditions.push("s.checklist_id = ?"); params.push(Number(req.query.checklist_id)); }
  if (req.query.user_id) { conditions.push("s.user_id = ?"); params.push(Number(req.query.user_id)); }
  if (req.query.deviations === "1") conditions.push("s.deviation_count > 0");
  return db
    .prepare(
      `SELECT s.id, s.checklist_id, s.checklist_name, s.user_id, s.user_name, s.work_date, s.started_at,
              s.submitted_at, s.note, s.deviation_count,
              (SELECT COUNT(*) FROM simple_checklist_answers a WHERE a.submission_id = s.id) AS item_count,
              (SELECT COUNT(*) FROM simple_checklist_photos p WHERE p.submission_id = s.id) AS photo_count
       FROM simple_checklist_submissions s
       WHERE ${conditions.join(" AND ")}
       ORDER BY s.submitted_at DESC
       LIMIT ?`
    )
    .all(...params, limit);
}

simpleChecklistsRouter.get("/submissions/:id", (req, res) => {
  const scoped = getSubmissionScoped(req.params.id, req.user);
  if (scoped.error) return fail(res, scoped);
  res.json(submissionDetail(scoped.submission.id));
});

simpleChecklistsRouter.patch("/submissions/:id", (req, res) => {
  const scoped = getOwnDraft(req.params.id, req.user);
  if (scoped.error) return fail(res, scoped);
  db.prepare("UPDATE simple_checklist_submissions SET note = ? WHERE id = ?")
    .run(cleanText(req.body?.note, MAX_TEXT), scoped.submission.id);
  res.json({ ok: true });
});

simpleChecklistsRouter.patch("/submissions/:id/answers/:answerId", (req, res) => {
  const scoped = getOwnDraft(req.params.id, req.user);
  if (scoped.error) return fail(res, scoped);
  const answer = db
    .prepare("SELECT * FROM simple_checklist_answers WHERE id = ? AND submission_id = ?")
    .get(req.params.answerId, scoped.submission.id);
  if (!answer) return res.status(404).json({ code: "not_found", error: "Not found" });

  const body = req.body || {};
  let status = answer.status;
  if ("status" in body) {
    if (body.status !== null && !STATUSES.has(body.status)) {
      return res.status(400).json({ code: "answer_status_invalid", error: "Ugyldig svar." });
    }
    status = body.status;
  }
  const comment = "comment" in body ? cleanText(body.comment, MAX_TEXT) : answer.comment;

  db.prepare(
    `UPDATE simple_checklist_answers SET status = ?, comment = ?,
       answered_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END
     WHERE id = ?`
  ).run(status, comment, status, answer.id);
  res.json(db.prepare("SELECT * FROM simple_checklist_answers WHERE id = ?").get(answer.id));
});

// «Alt i orden»: setter OK på alle punkter som ikke er besvart ennå. Rører aldri et punkt som
// allerede er markert som avvik eller ikke relevant — det er et bevisst valg noen har gjort.
simpleChecklistsRouter.post("/submissions/:id/answer-rest-ok", (req, res) => {
  const scoped = getOwnDraft(req.params.id, req.user);
  if (scoped.error) return fail(res, scoped);
  db.prepare(
    "UPDATE simple_checklist_answers SET status = 'ok', answered_at = datetime('now') WHERE submission_id = ? AND status IS NULL"
  ).run(scoped.submission.id);
  res.json(submissionDetail(scoped.submission.id));
});

simpleChecklistsRouter.post("/submissions/:id/submit", (req, res) => {
  const scoped = getOwnDraft(req.params.id, req.user);
  if (scoped.error) return fail(res, scoped);
  const answers = db
    .prepare("SELECT status, comment FROM simple_checklist_answers WHERE submission_id = ?")
    .all(scoped.submission.id);

  // Et ubesvart punkt er verken OK eller avvik, og en innsendt liste med hull i ser ut som
  // dokumentasjon uten å være det. Samme grunn til at et avvik må forklares.
  const unanswered = answers.filter((a) => !a.status).length;
  if (unanswered > 0) {
    return res.status(400).json({ code: "answers_missing", error: `${unanswered} punkt mangler svar.`, count: unanswered });
  }
  const unexplained = answers.filter((a) => a.status === "deviation" && !a.comment).length;
  if (unexplained > 0) {
    return res.status(400).json({ code: "deviation_comment_required", error: "Skriv hva som ikke var i orden for hvert avvik." });
  }

  const deviations = answers.filter((a) => a.status === "deviation").length;
  db.prepare(
    `UPDATE simple_checklist_submissions
     SET submitted_at = datetime('now'), work_date = ?, deviation_count = ?, user_name = ?
     WHERE id = ?`
  ).run(todayInOslo(), deviations, req.user.name, scoped.submission.id);
  res.json(submissionDetail(scoped.submission.id));
});

// Forkaste et utkast (eieren), eller slette en innsendt utfylling (bare admin — typisk en
// testutfylling eller en liste fylt ut ved en feil). En driftsleder kan ikke slette dokumentasjon.
simpleChecklistsRouter.delete("/submissions/:id", (req, res) => {
  const scoped = getSubmissionScoped(req.params.id, req.user);
  if (scoped.error) return fail(res, scoped);
  const { submission } = scoped;
  if (submission.submitted_at && req.user.role !== "admin") {
    return res.status(403).json({ code: "role_not_allowed", error: "Bare en administrator kan slette en innsendt sjekkliste." });
  }
  const photos = db.prepare("SELECT file_path FROM simple_checklist_photos WHERE submission_id = ?").all(submission.id);
  db.transaction(() => {
    db.prepare("DELETE FROM simple_checklist_photos WHERE submission_id = ?").run(submission.id);
    db.prepare("DELETE FROM simple_checklist_answers WHERE submission_id = ?").run(submission.id);
    db.prepare("DELETE FROM simple_checklist_submissions WHERE id = ?").run(submission.id);
  })();
  photos.forEach((p) => removeUploadedFile(p.file_path));
  res.json({ ok: true });
});

simpleChecklistsRouter.post("/submissions/:id/photos", upload.single("photo"), async (req, res) => {
  const scoped = getOwnDraft(req.params.id, req.user);
  if (scoped.error) {
    if (req.file) removeUploadedFile(req.file.filename);
    return fail(res, scoped);
  }
  if (!req.file) return res.status(400).json({ code: "no_file_uploaded", error: "No file uploaded (field name must be 'photo')" });

  let answerId = null;
  if (req.body.answer_id) {
    const answer = db
      .prepare("SELECT id FROM simple_checklist_answers WHERE id = ? AND submission_id = ?")
      .get(req.body.answer_id, scoped.submission.id);
    if (!answer) {
      removeUploadedFile(req.file.filename);
      return res.status(400).json({ code: "answer_not_in_submission", error: "Punktet hører ikke til denne sjekklisten." });
    }
    answerId = answer.id;
  }

  const storedName = await compressUploadedPhoto(uploadsDir, req.file.filename);
  const info = db
    .prepare("INSERT INTO simple_checklist_photos (submission_id, answer_id, file_path) VALUES (?, ?, ?)")
    .run(scoped.submission.id, answerId, path.join("uploads", storedName));
  res.status(201).json({ id: info.lastInsertRowid, answer_id: answerId, file_path: storedName });
});

simpleChecklistsRouter.delete("/submissions/:id/photos/:photoId", (req, res) => {
  const scoped = getOwnDraft(req.params.id, req.user);
  if (scoped.error) return fail(res, scoped);
  const photo = db
    .prepare("SELECT * FROM simple_checklist_photos WHERE id = ? AND submission_id = ?")
    .get(req.params.photoId, scoped.submission.id);
  if (!photo) return res.status(404).json({ code: "not_found", error: "Not found" });
  db.prepare("DELETE FROM simple_checklist_photos WHERE id = ?").run(photo.id);
  removeUploadedFile(photo.file_path);
  res.json({ ok: true });
});

simpleChecklistsRouter.get("/submissions/:id/pdf", (req, res) => {
  const scoped = getSubmissionScoped(req.params.id, req.user);
  if (scoped.error) return fail(res, scoped);
  const detail = submissionDetail(scoped.submission.id);
  const company = db.prepare("SELECT name FROM companies WHERE id = ?").get(detail.company_id);

  const safeName = detail.checklist_name.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").toLowerCase();
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="sjekkliste-${encodeURIComponent(safeName || "utfylling")}-${detail.work_date}.pdf"`
  );
  renderSubmissionPdf(res, detail, company?.name);
});

// --- én liste: oppsett ------------------------------------------------------------------------

simpleChecklistsRouter.get("/:id", (req, res) => {
  const scoped = getListScoped(req.params.id, req.user);
  if (scoped.error) return fail(res, scoped);
  res.json(listWithItems(scoped.list.id));
});

simpleChecklistsRouter.patch("/:id", requireRole(...MANAGERS), (req, res) => {
  const scoped = getListScoped(req.params.id, req.user);
  if (scoped.error) return fail(res, scoped);
  const { values, error } = readListBody(req.body || {}, { partial: true });
  if (error) return res.status(400).json(error);
  const fields = Object.keys(values);
  if (fields.length > 0) {
    db.prepare(`UPDATE simple_checklists SET ${fields.map((f) => `${f} = ?`).join(", ")} WHERE id = ?`)
      .run(...fields.map((f) => values[f]), scoped.list.id);
  }
  res.json(listWithItems(scoped.list.id));
});

// En liste med utfyllinger arkiveres i stedet for å slettes: loggen skal kunne lenke tilbake, og
// et tilsyn som ber om fjorårets brannrunder skal få dem selv om rutinen er lagt ned. Uten
// utfyllinger finnes det ingenting å bevare, og da slettes den.
simpleChecklistsRouter.delete("/:id", requireRole(...MANAGERS), (req, res) => {
  const scoped = getListScoped(req.params.id, req.user);
  if (scoped.error) return fail(res, scoped);
  const id = scoped.list.id;
  const used = db.prepare("SELECT COUNT(*) AS n FROM simple_checklist_submissions WHERE checklist_id = ?").get(id).n;
  if (used > 0) {
    db.prepare("UPDATE simple_checklists SET active = 0 WHERE id = ?").run(id);
    return res.json({ ok: true, archived: true });
  }
  db.transaction(() => {
    db.prepare("DELETE FROM simple_checklist_items WHERE checklist_id = ?").run(id);
    db.prepare("DELETE FROM simple_checklists WHERE id = ?").run(id);
  })();
  res.json({ ok: true, archived: false });
});

simpleChecklistsRouter.post("/:id/items", requireRole(...MANAGERS), (req, res) => {
  const scoped = getListScoped(req.params.id, req.user);
  if (scoped.error) return fail(res, scoped);
  const label = cleanText(req.body?.label, MAX_LABEL);
  if (!label) return res.status(400).json({ code: "item_label_required", error: "Punktet må ha en tekst." });
  const nextSort = db
    .prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM simple_checklist_items WHERE checklist_id = ?")
    .get(scoped.list.id).n;
  db.prepare("INSERT INTO simple_checklist_items (checklist_id, label, help_text, sort_order) VALUES (?, ?, ?, ?)")
    .run(scoped.list.id, label, cleanText(req.body?.help_text, MAX_TEXT), nextSort);
  res.status(201).json(listWithItems(scoped.list.id));
});

// Rekkefølge settes samlet: klienten sender hele lista med id-er i ny rekkefølge.
simpleChecklistsRouter.post("/:id/items/reorder", requireRole(...MANAGERS), (req, res) => {
  const scoped = getListScoped(req.params.id, req.user);
  if (scoped.error) return fail(res, scoped);
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : null;
  if (!ids) return res.status(400).json({ code: "ids_required", error: "ids må være en liste." });
  const update = db.prepare("UPDATE simple_checklist_items SET sort_order = ? WHERE id = ? AND checklist_id = ?");
  db.transaction(() => ids.forEach((itemId, i) => update.run(i + 1, itemId, scoped.list.id)))();
  res.json(listWithItems(scoped.list.id));
});

simpleChecklistsRouter.patch("/:id/items/:itemId", requireRole(...MANAGERS), (req, res) => {
  const scoped = getListScoped(req.params.id, req.user);
  if (scoped.error) return fail(res, scoped);
  const item = db
    .prepare("SELECT * FROM simple_checklist_items WHERE id = ? AND checklist_id = ?")
    .get(req.params.itemId, scoped.list.id);
  if (!item) return res.status(404).json({ code: "not_found", error: "Not found" });
  const body = req.body || {};
  let label = item.label;
  if ("label" in body) {
    label = cleanText(body.label, MAX_LABEL);
    if (!label) return res.status(400).json({ code: "item_label_required", error: "Punktet må ha en tekst." });
  }
  const helpText = "help_text" in body ? cleanText(body.help_text, MAX_TEXT) : item.help_text;
  db.prepare("UPDATE simple_checklist_items SET label = ?, help_text = ? WHERE id = ?").run(label, helpText, item.id);
  res.json(listWithItems(scoped.list.id));
});

simpleChecklistsRouter.delete("/:id/items/:itemId", requireRole(...MANAGERS), (req, res) => {
  const scoped = getListScoped(req.params.id, req.user);
  if (scoped.error) return fail(res, scoped);
  const item = db
    .prepare("SELECT id FROM simple_checklist_items WHERE id = ? AND checklist_id = ?")
    .get(req.params.itemId, scoped.list.id);
  if (!item) return res.status(404).json({ code: "not_found", error: "Not found" });
  // Svarene står med sin egen kopi av teksten; bare lenken tilbake til punktet nullstilles, ellers
  // stopper fremmednøkkelen slettingen (samme felle som rom-oppgavene gikk i 2026-09-21).
  db.transaction(() => {
    db.prepare("UPDATE simple_checklist_answers SET item_id = NULL WHERE item_id = ?").run(item.id);
    db.prepare("DELETE FROM simple_checklist_items WHERE id = ?").run(item.id);
  })();
  res.json(listWithItems(scoped.list.id));
});

// Starter (eller fortsetter) en utfylling. Har personen allerede et utkast på denne lista,
// fortsetter hun på det — også fra i går — i stedet for å få et nytt: en telefon som mistet fanen
// midt i en runde skal ikke etterlate et halvt skjema som aldri blir sendt.
simpleChecklistsRouter.post("/:id/start", (req, res) => {
  const scoped = getListScoped(req.params.id, req.user);
  if (scoped.error) return fail(res, scoped);
  const { list } = scoped;
  if (!list.active) return res.status(409).json({ code: "checklist_archived", error: "Sjekklisten er arkivert." });

  const existing = db
    .prepare(
      "SELECT id FROM simple_checklist_submissions WHERE checklist_id = ? AND user_id = ? AND submitted_at IS NULL ORDER BY id DESC LIMIT 1"
    )
    .get(list.id, req.user.id);
  if (existing) return res.json(submissionDetail(existing.id));

  const items = db
    .prepare("SELECT * FROM simple_checklist_items WHERE checklist_id = ? ORDER BY sort_order, id")
    .all(list.id);
  if (items.length === 0) {
    return res.status(409).json({ code: "checklist_empty", error: "Sjekklisten har ingen punkter ennå." });
  }

  const id = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO simple_checklist_submissions (company_id, checklist_id, checklist_name, user_id, user_name, work_date)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(list.company_id, list.id, list.name, req.user.id, req.user.name, todayInOslo());
    const insert = db.prepare(
      "INSERT INTO simple_checklist_answers (submission_id, item_id, label, help_text, sort_order) VALUES (?, ?, ?, ?, ?)"
    );
    items.forEach((item, i) => insert.run(info.lastInsertRowid, item.id, item.label, item.help_text, i + 1));
    return info.lastInsertRowid;
  })();
  res.status(201).json(submissionDetail(id));
});

// --- PDF ----------------------------------------------------------------------------------------

const INK = "#18181b";
const MUTED = "#71717a";
const STATUS_COLOR = { ok: "#16a34a", deviation: "#dc2626", na: MUTED };

function osloDateTime(sqliteDatetime) {
  if (!sqliteDatetime) return "";
  const d = new Date(`${sqliteDatetime.replace(" ", "T")}Z`);
  return new Intl.DateTimeFormat("nb-NO", {
    timeZone: "Europe/Oslo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(d);
}

// Bare formater pdfkit kan tegne. Bilder lagres som JPEG etter komprimering, men faller tilbake på
// originalen (f.eks. HEIC) hvis sharp feilet — de hoppes over i stedet for å velte hele rapporten.
function drawablePhoto(filePath) {
  const abs = path.join(uploadsDir, path.basename(filePath));
  if (!/\.(jpe?g|png)$/i.test(abs) || !fs.existsSync(abs)) return null;
  return abs;
}

// pdfkit's built-in Helvetica only has the WinAnsi character set. A phone keyboard happily types
// characters outside it — the minus sign in "−12 °C", curly apostrophes on iOS are fine, but the
// minus and a few others come out as garbage. Map the ones people actually type; everything else
// outside the set becomes "?" rather than a wrong-looking glyph.
const PDF_REPLACEMENTS = new Map([[0x2212, "-"], [0x2010, "-"], [0x2011, "-"], [0x00a0, " "], [0x202f, " "], [0x2009, " "]]);
const WIN_ANSI_EXTRA = new Set([0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d,
  0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178]);
function pdfText(value) {
  if (value === null || value === undefined) return value;
  let out = "";
  for (const ch of String(value)) {
    const code = ch.codePointAt(0);
    if (PDF_REPLACEMENTS.has(code)) out += PDF_REPLACEMENTS.get(code);
    else if (code === 10 || (code >= 32 && code <= 255) || WIN_ANSI_EXTRA.has(code)) out += ch;
    else out += "?";
  }
  return out;
}

function renderSubmissionPdf(res, rawDetail, rawCompanyName) {
  const companyName = pdfText(rawCompanyName);
  const detail = {
    ...rawDetail,
    checklist_name: pdfText(rawDetail.checklist_name),
    description: pdfText(rawDetail.description),
    user_name: pdfText(rawDetail.user_name),
    note: pdfText(rawDetail.note),
    answers: rawDetail.answers.map((a) => ({ ...a, label: pdfText(a.label), help_text: pdfText(a.help_text), comment: pdfText(a.comment) })),
  };
  // A4, ikke pdfkits standard letter: dette skrives ut og arkiveres i Norge.
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  doc.pipe(res);
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const ensureSpace = (h) => { if (doc.y + h > bottom()) doc.addPage(); };

  if (companyName) doc.font("Helvetica").fontSize(10).fillColor(MUTED).text(companyName.toUpperCase(), { characterSpacing: 0.8 });
  doc.moveDown(0.4);
  doc.font("Helvetica-Bold").fontSize(20).fillColor(INK).text(detail.checklist_name, { width });
  if (detail.description) doc.font("Helvetica").fontSize(10).fillColor(MUTED).text(detail.description, { width });
  doc.moveDown(0.6);

  const counts = { ok: 0, deviation: 0, na: 0 };
  detail.answers.forEach((a) => { if (counts[a.status] !== undefined) counts[a.status] += 1; });

  const facts = [
    ["Dato", detail.work_date.split("-").reverse().join(".")],
    ["Utført av", detail.user_name],
    ["Sendt inn", osloDateTime(detail.submitted_at)],
    ["Resultat", `${counts.ok} OK · ${counts.deviation} avvik · ${counts.na} ikke relevant`],
  ];
  facts.forEach(([label, value]) => {
    const y = doc.y;
    doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(label.toUpperCase(), left, y, { width: 90, characterSpacing: 0.6 });
    doc.font("Helvetica-Bold").fontSize(10.5).fillColor(INK).text(value || "—", left + 95, y, { width: width - 95 });
    doc.moveDown(0.25);
  });
  if (!detail.submitted_at) {
    doc.moveDown(0.3);
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#d97706").text("UTKAST — ikke sendt inn");
  }
  doc.moveDown(0.6);
  doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor("#e4e4e7").lineWidth(1).stroke();
  doc.moveDown(0.6);

  const photosByAnswer = new Map();
  const generalPhotos = [];
  detail.photos.forEach((p) => {
    if (p.answer_id) photosByAnswer.set(p.answer_id, [...(photosByAnswer.get(p.answer_id) || []), p]);
    else generalPhotos.push(p);
  });

  const drawPhotos = (photos) => {
    const size = 120;
    let x = left + 20;
    // Høyden på raden er det høyeste bildet i den, ikke boksen — et liggende bilde er lavere enn
    // det er bredt, og en fast 120 la igjen et hull under hver rad.
    let rowHeight = 0;
    photos.forEach((p) => {
      const abs = drawablePhoto(p.file_path);
      if (!abs) return;
      let img;
      try {
        img = doc.openImage(abs);
      } catch {
        return; // ødelagt fil: hopp over bildet, ikke rapporten
      }
      const scale = Math.min(size / img.width, size / img.height);
      const h = img.height * scale;
      if (x + size > left + width) { x = left + 20; doc.y += rowHeight + 8; rowHeight = 0; }
      ensureSpace(size + 8);
      doc.image(img, x, doc.y, { width: img.width * scale, height: h });
      rowHeight = Math.max(rowHeight, h);
      x += img.width * scale + 8;
    });
    if (rowHeight > 0) doc.y += rowHeight + 8;
    doc.x = left;
  };

  detail.answers.forEach((a, i) => {
    ensureSpace(40);
    const y = doc.y;
    const tag = STATUS_LABEL[a.status] || "Ikke besvart";
    doc.font("Helvetica-Bold").fontSize(9).fillColor(STATUS_COLOR[a.status] || "#d97706")
      .text(tag.toUpperCase(), left + width - 90, y, { width: 90, align: "right", characterSpacing: 0.4 });
    doc.font("Helvetica").fontSize(11).fillColor(INK).text(`${i + 1}. ${a.label}`, left, y, { width: width - 100 });
    if (a.help_text) doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(a.help_text, left + 14, doc.y, { width: width - 114 });
    if (a.comment) {
      doc.font("Helvetica-Oblique").fontSize(10).fillColor(a.status === "deviation" ? "#b91c1c" : INK)
        .text(a.comment, left + 14, doc.y + 2, { width: width - 114 });
    }
    const photos = photosByAnswer.get(a.id);
    if (photos) { doc.moveDown(0.3); drawPhotos(photos); }
    doc.x = left;
    doc.moveDown(0.6);
  });

  if (detail.note) {
    ensureSpace(60);
    doc.moveDown(0.3);
    doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text("Kommentar", left);
    doc.font("Helvetica").fontSize(10.5).fillColor(INK).text(detail.note, { width });
    doc.moveDown(0.6);
  }

  if (generalPhotos.length > 0) {
    ensureSpace(150);
    doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text("Bilder", left);
    doc.moveDown(0.3);
    drawPhotos(generalPhotos);
  }

  ensureSpace(40);
  doc.moveDown(1);
  doc.font("Helvetica").fontSize(8).fillColor(MUTED)
    .text(`Generert av Rentlogg ${osloDateTime(new Date().toISOString().slice(0, 19).replace("T", " "))}`, left, doc.y, { width });

  doc.end();
}
