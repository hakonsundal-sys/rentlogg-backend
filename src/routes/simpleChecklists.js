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
import { measurementVerdict, measurementRangeLabel, parseMeasurement } from "../services/rooms.js";
import { digestRunLimiter } from "../middleware/rateLimits.js";
import { sendChecklistDigest, isValidEmail } from "../services/checklistDigest.js";
import QRCode from "qrcode";
import { weekdaysFromColumn, weekdayOf, dayState as scheduleDayState, isDueOn, isOnDemand, scheduleMode, monthStart, monthEnd } from "../services/checklistSchedule.js";
import { newQrToken } from "../utils/qrcode.js";

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

// "HH:MM" akkurat nå i Europe/Oslo — for å avgjøre om en frist i dag er passert.
function osloNowHHMM() {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit", hour12: false })
    .format(new Date());
}

function timesOf(list) {
  return scheduleMode(list) === "weekly" ? Math.max(1, Number(list.times_per_day) || 1) : 1;
}

// Dagens tilstand for én liste og én dag, delt av /today og /overview så de aldri er uenige.
//   done / deviation — nok utfyllinger (deviation hvis noen av dem hadde avvik)
//   missing — planlagt, dagen er over, for få utfyllinger
//   late    — planlagt i dag, fristen er passert, for få utfyllinger
//   partial — i gang i dag (1 av 2), fristen ikke passert
//   due     — planlagt, ingenting gjort ennå
//   none    — ikke planlagt (og ingenting gjort)
// Selve regelen bor i services/checklistSchedule.js (delt med morgen-e-posten); dette er bare
// Oslo-klokka koblet på.
function dayState(list, dateStr, today, count, deviations, monthCount = 0) {
  return scheduleDayState(list, dateStr, today, count, deviations, { monthCount, nowHHMM: osloNowHHMM() });
}

// Utfyllinger i en liste i én kalendermåned — for «én gang i måneden».
const monthCountStmt = db.prepare(
  `SELECT COUNT(*) AS n FROM simple_checklist_submissions
   WHERE checklist_id = ? AND submitted_at IS NOT NULL AND work_date BETWEEN ? AND ?`
);
function monthCount(listId, dateStr) {
  return monthCountStmt.get(listId, monthStart(dateStr), monthEnd(dateStr)).n;
}

// Norsk desimalkomma i alt som leses av mennesker (CSV, PDF, e-post).
function formatNumber(n) {
  return n === null || n === undefined ? "" : String(n).replace(".", ",");
}

// Måleoppsett på et punkt. Enhet satt = måling; tom enhet = vanlig avkrysning (og grensene
// nullstilles). Grensene er valgfrie hver for seg: bare maks (kjøl), bare min (varmholding), begge.
// `current` er punktet slik det står, så en PATCH som ikke nevner feltene lar dem være.
function readMeasure(body, current) {
  const has = (k) => k in body;
  const unit = has("measure_unit") ? cleanText(body.measure_unit, 20) : current.measure_unit ?? null;
  if (!unit) return { unit: null, min: null, max: null };
  const limit = (k) => {
    if (!has(k)) return { value: current[k] ?? null };
    if (body[k] === null || body[k] === "") return { value: null };
    const parsed = parseMeasurement(body[k]);
    return parsed.ok ? { value: parsed.value } : { error: true };
  };
  const min = limit("measure_min");
  const max = limit("measure_max");
  if (min.error || max.error) return { error: { code: "measure_limit_invalid", error: "Grenseverdiene må være tall." } };
  if (min.value !== null && max.value !== null && min.value > max.value) {
    return { error: { code: "measure_limits_reversed", error: "Nedre grense kan ikke være høyere enn øvre." } };
  }
  return { unit, min: min.value, max: max.value };
}

function serializeList(row) {
  return {
    ...row,
    weekdays: weekdaysFromColumn(row.weekdays),
    active: !!row.active,
    schedule_mode: scheduleMode(row),
  };
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
  return {
    ...submission,
    description: list?.description ?? null,
    answers: answers.map((a) => ({ ...a, range_label: measurementRangeLabel(a) })),
    photos,
  };
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
  const withItems = req.query.with_items === "1";
  const itemsStmt = db.prepare(
    `SELECT id, label, help_text, sort_order, measure_unit, measure_min, measure_max, requires_photo
     FROM simple_checklist_items WHERE checklist_id = ? ORDER BY sort_order, id`
  );
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
      const submissions = doneTodayStmt.all(l.id, today);
      const deviations = submissions.reduce((n, s) => n + s.deviation_count, 0);
      const monthly = scheduleMode(l) === "monthly_any";
      const thisMonth = monthly ? monthCount(l.id, today) : 0;
      return {
        ...serializeList(l),
        on_demand: isOnDemand(l),
        due_today: isDueOn(l, today),
        // «Én gang i måneden» som ikke er gjort ennå denne måneden.
        due_this_month: monthly && thisMonth === 0,
        done_this_month: monthly && thisMonth > 0,
        times_per_day: timesOf(l),
        state: dayState(l, today, today, submissions.length, deviations, thisMonth),
        submissions_today: submissions,
        my_draft: draftStmt.get(l.id, req.user.id) || null,
        // Med ?with_items=1 får telefonen punktene også, og legger alt i en lokal kopi, så en liste
        // kan fylles ut i en kjeller uten dekning (se /:id/submit-complete).
        ...(withItems ? { items: itemsStmt.all(l.id) } : {}),
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
      const monthly = scheduleMode(l) === "monthly_any";
      const monthCache = new Map();
      days.forEach((d) => {
        const hit = byKey.get(`${l.id}|${d}`);
        // «missing» bare for perioder som er over, «late» i dag etter fristen. En liste opprettet i
        // går mangler ikke for forrige uke (se dayState).
        let mc = 0;
        if (monthly) {
          const key = d.slice(0, 7);
          if (!monthCache.has(key)) monthCache.set(key, monthCount(l.id, d));
          mc = monthCache.get(key);
        }
        const state = dayState(l, d, today, hit?.n || 0, hit?.deviations || 0, mc);
        cells[d] = { state, count: hit?.n || 0, deviations: hit?.deviations || 0 };
      });
      return {
        id: l.id, name: l.name, weekdays, on_demand: isOnDemand(l),
        schedule_mode: scheduleMode(l), month_day: l.month_day,
        times_per_day: timesOf(l), due_time: l.due_time, cells,
      };
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
  if ("due_time" in body) {
    const v = body.due_time;
    if (v === null || v === "") out.due_time = null;
    else if (typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)) out.due_time = v;
    else return { error: { code: "due_time_invalid", error: "Frist må være et klokkeslett (TT:MM)." } };
  }
  if ("schedule_mode" in body) {
    const mode = body.schedule_mode || "weekly";
    if (!["weekly", "monthly_day", "monthly_any"].includes(mode)) {
      return { error: { code: "schedule_mode_invalid", error: "Ukjent planform." } };
    }
    out.schedule_mode = mode === "weekly" ? null : mode;
    if (mode === "monthly_day") {
      const day = Number(body.month_day);
      if (!(Number.isInteger(day) && ((day >= 1 && day <= 31) || day === -1))) {
        return { error: { code: "month_day_invalid", error: "Velg en dag fra 1 til 31, eller siste dag i måneden." } };
      }
      out.month_day = day;
    } else {
      out.month_day = null;
    }
    // En månedlig liste har ingen ukedager og fylles ut én gang — ukedagene og antallet nullstilles,
    // så en senere overgang tilbake til ukedager ikke dukker opp med gamle valg ingen så.
    if (mode !== "weekly") {
      out.weekdays = null;
      out.times_per_day = null;
      if (mode === "monthly_any") out.due_time = null;
    }
  }
  if ("times_per_day" in body && out.schedule_mode == null) {
    const n = Number(body.times_per_day || 1);
    if (!Number.isInteger(n) || n < 1 || n > 12) {
      return { error: { code: "times_per_day_invalid", error: "Antall ganger per dag må være mellom 1 og 12." } };
    }
    out.times_per_day = n === 1 ? null : n;
  }
  if (!partial && out.schedule_mode === undefined) { out.schedule_mode = null; out.month_day = null; }
  return { values: out };
}

simpleChecklistsRouter.post("/", requireRole(...MANAGERS), (req, res) => {
  const { values, error } = readListBody(req.body || {}, { partial: false });
  if (error) return res.status(400).json(error);
  const nextSort = db
    .prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM simple_checklists WHERE company_id = ?")
    .get(req.user.company_id).n;
  const info = db
    .prepare(
      `INSERT INTO simple_checklists (company_id, name, description, weekdays, sort_order, due_time, times_per_day, schedule_mode, month_day)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.user.company_id, values.name, values.description ?? null, values.weekdays ?? null, nextSort,
      values.due_time ?? null, values.times_per_day ?? null, values.schedule_mode ?? null, values.month_day ?? null
    );

  // Punkter kan sendes med ved opprettelse, så «ny liste» kan lages i ett steg fra en mal.
  const labels = Array.isArray(req.body.items) ? req.body.items : [];
  const insertItem = db.prepare(
    `INSERT INTO simple_checklist_items (checklist_id, label, help_text, sort_order, measure_unit, measure_min, measure_max, requires_photo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  labels.forEach((item, i) => {
    const label = cleanText(typeof item === "string" ? item : item?.label, MAX_LABEL);
    if (!label) return;
    // Et ugyldig måleoppsett i en mal blir et vanlig punkt heller enn at hele lista avvises.
    const measure = typeof item === "object" && item ? readMeasure(item, {}) : { unit: null, min: null, max: null };
    const m = measure.error ? { unit: null, min: null, max: null } : measure;
    insertItem.run(info.lastInsertRowid, label, cleanText(item?.help_text, MAX_TEXT), i + 1, m.unit, m.min, m.max, item?.requires_photo ? 1 : 0);
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
    "SELECT * FROM simple_checklist_answers WHERE submission_id = ? ORDER BY sort_order, id"
  );
  const header = ["Dato", "Sjekkliste", "Utført av", "Sendt inn", "Punkter", "OK", "Avvik", "Ikke relevant", "Avvikspunkter", "Målinger", "Avvik fulgt opp", "Kommentar"];
  const lines = [header.map(csvEscape).join(",")];
  rows.forEach((r) => {
    const answers = answersStmt.all(r.id);
    const count = (s) => answers.filter((a) => a.status === s).length;
    const deviations = answers
      .filter((a) => a.status === "deviation")
      .map((a) => (a.comment ? `${a.label}: ${a.comment}` : a.label))
      .join(" | ");
    const measurements = answers
      .filter((a) => a.measure_unit && a.measured_value !== null)
      .map((a) => `${a.label}: ${formatNumber(a.measured_value)} ${a.measure_unit}`)
      .join(" | ");
    const devs = answers.filter((a) => a.status === "deviation");
    const followed = devs.length ? `${devs.filter((a) => a.followup_at).length} av ${devs.length}` : "";
    lines.push(
      [r.work_date, r.checklist_name, r.user_name, r.submitted_at, answers.length, count("ok"), count("deviation"), count("na"), deviations, measurements, followed, r.note || ""]
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
              (SELECT COUNT(*) FROM simple_checklist_photos p WHERE p.submission_id = s.id) AS photo_count,
              (SELECT COUNT(*) FROM simple_checklist_answers a
                 WHERE a.submission_id = s.id AND a.status = 'deviation' AND a.followup_at IS NULL) AS open_deviation_count
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
  let measured = answer.measured_value;
  if ("status" in body) {
    if (body.status !== null && !STATUSES.has(body.status)) {
      return res.status(400).json({ code: "answer_status_invalid", error: "Ugyldig svar." });
    }
    // En måling kvitteres med tallet, ikke med OK/Avvik: dommen er grensens, ikke personens.
    // «Ikke relevant» og å nullstille er lov, og nullstiller også tallet.
    if (answer.measure_unit && (body.status === "ok" || body.status === "deviation")) {
      return res.status(400).json({ code: "measurement_required", error: "Skriv inn måleverdien." });
    }
    status = body.status;
    if (answer.measure_unit) measured = null;
  }
  if ("measured_value" in body) {
    if (!answer.measure_unit) {
      return res.status(400).json({ code: "not_a_measurement", error: "Punktet er ikke en måling." });
    }
    if (body.measured_value === null || body.measured_value === "") {
      measured = null;
      status = null;
    } else {
      const parsed = parseMeasurement(body.measured_value);
      if (!parsed.ok) return res.status(400).json({ code: "measurement_invalid", error: "Måleverdien må være et tall." });
      measured = parsed.value;
      // Samme dom som rom-målingene (services/rooms.js) — ett sted i systemet avgjør innenfor/utenfor.
      status = measurementVerdict({ ...answer, measured_value: measured }) === "fail" ? "deviation" : "ok";
    }
  }
  const comment = "comment" in body ? cleanText(body.comment, MAX_TEXT) : answer.comment;

  db.prepare(
    `UPDATE simple_checklist_answers SET status = ?, comment = ?, measured_value = ?,
       answered_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END
     WHERE id = ?`
  ).run(status, comment, measured, status, answer.id);
  res.json(db.prepare("SELECT * FROM simple_checklist_answers WHERE id = ?").get(answer.id));
});

// «Alt i orden»: setter OK på alle punkter som ikke er besvart ennå. Rører aldri et punkt som
// allerede er markert som avvik eller ikke relevant — det er et bevisst valg noen har gjort.
simpleChecklistsRouter.post("/submissions/:id/answer-rest-ok", (req, res) => {
  const scoped = getOwnDraft(req.params.id, req.user);
  if (scoped.error) return fail(res, scoped);
  db.prepare(
    // Målinger hoppes over: en påstått måling uten tall ser ut som dokumentasjon uten å være det.
    "UPDATE simple_checklist_answers SET status = 'ok', answered_at = datetime('now') WHERE submission_id = ? AND status IS NULL AND measure_unit IS NULL"
  ).run(scoped.submission.id);
  res.json(submissionDetail(scoped.submission.id));
});

simpleChecklistsRouter.post("/submissions/:id/submit", (req, res) => {
  const scoped = getOwnDraft(req.params.id, req.user);
  if (scoped.error) return fail(res, scoped);
  const answers = db
    .prepare(
      `SELECT a.status, a.comment, a.requires_photo,
              (SELECT COUNT(*) FROM simple_checklist_photos p WHERE p.answer_id = a.id) AS photo_count
       FROM simple_checklist_answers a WHERE a.submission_id = ?`
    )
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

  // «Ikke relevant» trenger ikke bilde — det finnes ingenting å ta bilde av.
  const missingPhotos = answers.filter((a) => a.requires_photo && a.status !== "na" && a.photo_count === 0).length;
  if (missingPhotos > 0) {
    return res.status(400).json({ code: "photo_required", error: `${missingPhotos} punkt mangler påkrevd bilde.`, count: missingPhotos });
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

// --- avvik og oppfølging --------------------------------------------------------------------

// Alle avvik fra innsendte lister, åpne (ikke fulgt opp) eller lukkede. Lederens arbeidsliste:
// et avvik er ikke ferdig behandlet fordi det er meldt — internkontroll krever at noen har gjort
// noe med det, og skrevet ned hva.
simpleChecklistsRouter.get("/deviations", requireRole(...MANAGERS), (req, res) => {
  const closed = req.query.status === "closed";
  const rows = db
    .prepare(
      `SELECT a.id AS answer_id, a.label, a.comment, a.measured_value, a.measure_unit, a.measure_min, a.measure_max,
              a.followup_action, a.followup_by_name, a.followup_at,
              s.id AS submission_id, s.checklist_name, s.user_name, s.work_date, s.submitted_at
       FROM simple_checklist_answers a JOIN simple_checklist_submissions s ON s.id = a.submission_id
       WHERE s.company_id = ? AND s.submitted_at IS NOT NULL AND a.status = 'deviation'
         AND a.followup_at IS ${closed ? "NOT NULL" : "NULL"}
       ORDER BY ${closed ? "a.followup_at DESC" : "s.submitted_at ASC"}
       LIMIT 500`
    )
    .all(req.user.company_id);
  res.json(rows.map((r) => ({ ...r, range_label: measurementRangeLabel(r) })));
});

simpleChecklistsRouter.post("/submissions/:id/answers/:answerId/followup", requireRole(...MANAGERS), (req, res) => {
  const scoped = getSubmissionScoped(req.params.id, req.user);
  if (scoped.error) return fail(res, scoped);
  if (!scoped.submission.submitted_at) {
    return res.status(409).json({ code: "submission_not_submitted", error: "Sjekklisten er ikke sendt inn ennå." });
  }
  const answer = db
    .prepare("SELECT * FROM simple_checklist_answers WHERE id = ? AND submission_id = ?")
    .get(req.params.answerId, scoped.submission.id);
  if (!answer) return res.status(404).json({ code: "not_found", error: "Not found" });
  if (answer.status !== "deviation") {
    return res.status(400).json({ code: "not_a_deviation", error: "Punktet er ikke et avvik." });
  }
  if (answer.followup_at) {
    return res.status(409).json({ code: "followup_locked", error: "Avviket er allerede fulgt opp." });
  }
  const action = cleanText(req.body?.action, MAX_TEXT);
  if (!action) return res.status(400).json({ code: "followup_action_required", error: "Skriv hva som ble gjort." });

  db.prepare(
    `UPDATE simple_checklist_answers SET followup_action = ?, followup_by = ?, followup_by_name = ?, followup_at = datetime('now')
     WHERE id = ?`
  ).run(action, req.user.id, req.user.name, answer.id);
  res.json(submissionDetail(scoped.submission.id));
});

// --- daglig oppsummering på e-post ------------------------------------------------------------

function readSettings(companyId) {
  const row = db.prepare("SELECT * FROM simple_checklist_settings WHERE company_id = ?").get(companyId);
  return { report_recipients: row?.report_recipients || "", report_hour: row?.report_hour ?? 7 };
}

simpleChecklistsRouter.get("/settings", requireRole(...MANAGERS), (req, res) => {
  res.json(readSettings(req.user.company_id));
});

simpleChecklistsRouter.put("/settings", requireRole("admin"), (req, res) => {
  const raw = typeof req.body?.report_recipients === "string" ? req.body.report_recipients : "";
  const recipients = [...new Set(raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean))];
  const invalid = recipients.filter((r) => !isValidEmail(r));
  if (invalid.length) {
    return res.status(400).json({ code: "invalid_email", error: `Ugyldig e-postadresse: ${invalid.join(", ")}` });
  }
  if (recipients.length > 20) return res.status(400).json({ code: "too_many_recipients", error: "Maks 20 mottakere." });
  const hour = Number(req.body?.report_hour ?? 7);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    return res.status(400).json({ code: "report_hour_invalid", error: "Klokkeslett må være en hel time 0–23." });
  }
  db.prepare(
    `INSERT INTO simple_checklist_settings (company_id, report_recipients, report_hour, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(company_id) DO UPDATE SET report_recipients = excluded.report_recipients,
       report_hour = excluded.report_hour, updated_at = excluded.updated_at`
  ).run(req.user.company_id, recipients.join(", ") || null, hour);
  res.json(readSettings(req.user.company_id));
});

// «Send nå»: gårsdagens oppsummering til de lagrede mottakerne, så admin kan se hvordan den ser ut
// uten å vente til i morgen tidlig. Samme rate-limit som renholdsrapportens manuelle utsending.
simpleChecklistsRouter.post("/settings/send-now", requireRole("admin"), digestRunLimiter, async (req, res) => {
  const result = await sendChecklistDigest(req.user.company_id, { force: true });
  if (result.status === "no_recipients") {
    return res.status(400).json({ code: "no_recipients", error: "Legg inn minst én mottaker og lagre først." });
  }
  if (result.status === "failed") return res.status(502).json({ code: "send_failed", error: "Utsendingen feilet. Prøv igjen senere." });
  res.json(result);
});

// --- QR og målinger ---------------------------------------------------------------------------

// QR-koden på trucken eller kjøleskapet. Token er tilfeldig og sier ingenting; firmaet sjekkes her,
// så en kode fra et annet firma bare gir 404 — samme svar som en kode som ikke finnes.
simpleChecklistsRouter.get("/by-qr/:token", (req, res) => {
  const list = db.prepare("SELECT id, company_id, active FROM simple_checklists WHERE qr_token = ?").get(req.params.token);
  if (!list || list.company_id !== req.user.company_id) return res.status(404).json({ code: "not_found", error: "Ukjent QR-kode." });
  if (!list.active) return res.status(409).json({ code: "checklist_archived", error: "Sjekklisten er arkivert." });
  res.json({ id: list.id });
});

// Måleserier fra innsendte lister, til grafen og tabellen under «Målinger». Ett punkt per måling;
// klienten grupperer per punkt. Grensene er de som gjaldt da målingen ble tatt (kopiert ned).
simpleChecklistsRouter.get("/measurements", requireRole(...MANAGERS), (req, res) => {
  const today = todayInOslo();
  const to = isDate(req.query.to) ? req.query.to : today;
  const from = isDate(req.query.from) ? req.query.from : addDays(to, -29);
  const conditions = ["s.company_id = ?", "s.submitted_at IS NOT NULL", "a.measure_unit IS NOT NULL", "s.work_date BETWEEN ? AND ?"];
  const params = [req.user.company_id, from, to];
  if (req.query.checklist_id) { conditions.push("s.checklist_id = ?"); params.push(Number(req.query.checklist_id)); }
  const rows = db
    .prepare(
      `SELECT a.item_id, a.label, a.measure_unit, a.measure_min, a.measure_max, a.measured_value, a.status,
              s.id AS submission_id, s.checklist_id, s.checklist_name, s.work_date, s.submitted_at, s.user_name
       FROM simple_checklist_answers a JOIN simple_checklist_submissions s ON s.id = a.submission_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY s.submitted_at
       LIMIT 5000`
    )
    .all(...params);
  res.json({ from, to, rows });
});

simpleChecklistsRouter.get("/:id/qr", requireRole(...MANAGERS), async (req, res) => {
  const scoped = getListScoped(req.params.id, req.user);
  if (scoped.error) return fail(res, scoped);
  let token = scoped.list.qr_token;
  if (!token) {
    token = newQrToken();
    db.prepare("UPDATE simple_checklists SET qr_token = ? WHERE id = ?").run(token, scoped.list.id);
  }
  // Rett til appen, ikke via backendens /checkin: koden trykkes nå, med appen på /app/, og trenger
  // ikke rundturen de gamle lokasjonskodene har for å overleve flyttingen fra roten.
  const base = (process.env.PUBLIC_FRONTEND_URL || "https://www.rentlogg.no").replace(/\/$/, "");
  const url = `${base}/app/?sjekk=${token}`;
  try {
    const qrSvg = await QRCode.toString(url, { type: "svg", margin: 1, width: 320 });
    const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="430" viewBox="0 0 360 430">
<rect width="360" height="430" fill="#ffffff"/>
<text x="180" y="32" text-anchor="middle" font-family="Arial, sans-serif" font-size="20" font-weight="700" fill="#1a1a1a">${esc(scoped.list.name)}</text>
<g transform="translate(20, 50)">${qrSvg}</g>
<text x="180" y="396" text-anchor="middle" font-family="Arial, sans-serif" font-size="13" fill="#555555">Skann med kameraet for å fylle ut</text>
<text x="180" y="416" text-anchor="middle" font-family="Arial, sans-serif" font-size="11" fill="#888888">Sjekk det</text>
</svg>`;
    res.json({ url, qrImage: `data:image/svg+xml;base64,${Buffer.from(svg, "utf-8").toString("base64")}` });
  } catch (err) {
    console.error("QR generation error:", err);
    res.status(500).json({ code: "qr_generation_failed", error: "Kunne ikke generere QR-kode." });
  }
});

// Kopi av en liste med alle punktene — for «samme rutine, annen avdeling». Kopien får ikke QR-kode
// (den gamle koden skal fortsatt åpne originalen) og starter uten utfyllinger.
simpleChecklistsRouter.post("/:id/duplicate", requireRole(...MANAGERS), (req, res) => {
  const scoped = getListScoped(req.params.id, req.user);
  if (scoped.error) return fail(res, scoped);
  const src = scoped.list;
  const id = db.transaction(() => {
    const nextSort = db
      .prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM simple_checklists WHERE company_id = ?")
      .get(src.company_id).n;
    const info = db
      .prepare(
        `INSERT INTO simple_checklists (company_id, name, description, weekdays, sort_order, due_time, times_per_day, schedule_mode, month_day)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        src.company_id, `${src.name} (kopi)`.slice(0, 120), src.description, src.weekdays, nextSort,
        src.due_time, src.times_per_day, src.schedule_mode, src.month_day
      );
    db.prepare(
      `INSERT INTO simple_checklist_items (checklist_id, label, help_text, sort_order, measure_unit, measure_min, measure_max, requires_photo)
       SELECT ?, label, help_text, sort_order, measure_unit, measure_min, measure_max, requires_photo
       FROM simple_checklist_items WHERE checklist_id = ? ORDER BY sort_order, id`
    ).run(info.lastInsertRowid, src.id);
    return info.lastInsertRowid;
  })();
  res.status(201).json(listWithItems(id));
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
  const measure = readMeasure(req.body || {}, {});
  if (measure.error) return res.status(400).json(measure.error);
  const nextSort = db
    .prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM simple_checklist_items WHERE checklist_id = ?")
    .get(scoped.list.id).n;
  db.prepare(
    `INSERT INTO simple_checklist_items (checklist_id, label, help_text, sort_order, measure_unit, measure_min, measure_max, requires_photo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(scoped.list.id, label, cleanText(req.body?.help_text, MAX_TEXT), nextSort, measure.unit, measure.min, measure.max, req.body?.requires_photo ? 1 : 0);
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
  const measure = readMeasure(body, item);
  if (measure.error) return res.status(400).json(measure.error);
  db.prepare(
    "UPDATE simple_checklist_items SET label = ?, help_text = ?, measure_unit = ?, measure_min = ?, measure_max = ?, requires_photo = ? WHERE id = ?"
  ).run(label, helpText, measure.unit, measure.min, measure.max, "requires_photo" in body ? (body.requires_photo ? 1 : 0) : item.requires_photo, item.id);
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
// --- offline: hel utfylling i én forespørsel --------------------------------------------------

const offlineUpload = multer({
  storage: multer.diskStorage({
    destination: process.env.UPLOADS_DIR || "uploads/",
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeOriginalName(file.originalname)}`),
  }),
  fileFilter: imageFileFilter,
  limits: { fileSize: 20 * 1024 * 1024, files: 30 },
});

// Oslo-dato for et ISO-tidspunkt fra telefonen.
function osloDateOf(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo" }).format(date);
}

// En liste fylt ut uten nett. Telefonen hadde en lokal kopi av punktene (/today?with_items=1),
// fylte ut alt der, og sender nå hele utfyllingen med bildene i én forespørsel fra offline-køen.
//
// Samme regler som den vanlige innsendingen, sjekket på nytt her — telefonen sjekket dem også, men
// serveren stoler ikke på det: hvert punkt besvart, avvik forklart, påkrevde bilder med, og dommen
// over en måling regnes ut her (measurementVerdict), uansett hva telefonen viste.
//
// Punktene tas fra lista slik den står nå, matchet på id. Et punkt som er slettet siden står med
// teksten telefonen så; et punkt som er lagt til siden er ikke med — det sto ikke på lista hun fylte ut.
//
// Idempotent på client_key: kommer samme utfylling to ganger (køen fikk aldri svaret), får den
// andre tilbake den første.
simpleChecklistsRouter.post("/:id/submit-complete", offlineUpload.any(), async (req, res) => {
  const files = req.files || [];
  const discard = () => files.forEach((f) => removeUploadedFile(f.filename));

  const scoped = getListScoped(req.params.id, req.user);
  if (scoped.error) { discard(); return fail(res, scoped); }
  const { list } = scoped;

  let payload;
  try {
    payload = JSON.parse(req.body?.payload || "null");
  } catch {
    payload = null;
  }
  const clientKey = typeof payload?.client_key === "string" ? payload.client_key.slice(0, 80) : "";
  if (!payload || !clientKey || !Array.isArray(payload.answers)) {
    discard();
    return res.status(400).json({ code: "payload_invalid", error: "Ugyldig utfylling." });
  }

  const existing = db
    .prepare("SELECT id FROM simple_checklist_submissions WHERE company_id = ? AND client_key = ?")
    .get(req.user.company_id, clientKey);
  if (existing) { discard(); return res.json(submissionDetail(existing.id)); }

  const items = db.prepare("SELECT * FROM simple_checklist_items WHERE checklist_id = ? ORDER BY sort_order, id").all(list.id);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const photosFor = (key) => files.filter((f) => f.fieldname === key);

  // Bygg svarene og valider dem før noe skrives.
  const rows = [];
  for (const a of payload.answers) {
    const item = itemById.get(Number(a.item_id)) || null;
    const label = item ? item.label : cleanText(a.label, MAX_LABEL);
    if (!label) continue;
    const measureUnit = item ? item.measure_unit : null;
    let status = a.status === null || a.status === undefined ? null : String(a.status);
    let measured = null;
    if (measureUnit && status !== "na") {
      const parsed = parseMeasurement(a.measured_value);
      if (!parsed.ok) { discard(); return res.status(400).json({ code: "measurement_required", error: `«${label}» mangler måleverdi.` }); }
      measured = parsed.value;
      status = measurementVerdict({ measure_unit: measureUnit, measure_min: item.measure_min, measure_max: item.measure_max, measured_value: measured }) === "fail" ? "deviation" : "ok";
    }
    if (!STATUSES.has(status)) { discard(); return res.status(400).json({ code: "answers_missing", error: `«${label}» mangler svar.` }); }
    const comment = cleanText(a.comment, MAX_TEXT);
    if (status === "deviation" && !comment) {
      discard();
      return res.status(400).json({ code: "deviation_comment_required", error: "Skriv hva som ikke var i orden for hvert avvik." });
    }
    const photoKey = `photo_item_${a.item_id}`;
    if (item?.requires_photo && status !== "na" && photosFor(photoKey).length === 0) {
      discard();
      return res.status(400).json({ code: "photo_required", error: `«${label}» mangler påkrevd bilde.` });
    }
    rows.push({ item, label, status, comment, measured, photoKey });
  }
  if (rows.length === 0) { discard(); return res.status(400).json({ code: "answers_missing", error: "Utfyllingen har ingen svar." }); }

  // Når den ble fylt ut. Godtas bare innenfor de siste 14 dagene — en klokke som står feil skal
  // ikke kunne plassere en utfylling i fjor eller i morgen.
  const now = new Date();
  let completed = new Date(payload.completed_at);
  if (Number.isNaN(completed.getTime()) || completed > new Date(now.getTime() + 5 * 60000) || completed < new Date(now.getTime() - 14 * 86400000)) {
    completed = now;
  }
  const completedSql = completed.toISOString().slice(0, 19).replace("T", " ");
  const deviations = rows.filter((r) => r.status === "deviation").length;

  // Bildene komprimeres før transaksjonen (sharp er asynkron, transaksjonen er det ikke).
  const stored = new Map();
  for (const f of files) stored.set(f, await compressUploadedPhoto(uploadsDir, f.filename));

  let id;
  try {
    id = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO simple_checklist_submissions
             (company_id, checklist_id, checklist_name, user_id, user_name, work_date, started_at, submitted_at,
              note, deviation_count, client_key, completed_offline, client_completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, 1, ?)`
        )
        .run(
          list.company_id, list.id, list.name, req.user.id, req.user.name, osloDateOf(completed), completedSql,
          cleanText(payload.note, MAX_TEXT), deviations, clientKey, completedSql
        );
      const subId = info.lastInsertRowid;
      const insertAnswer = db.prepare(
        `INSERT INTO simple_checklist_answers
           (submission_id, item_id, label, help_text, sort_order, measure_unit, measure_min, measure_max, requires_photo,
            measured_value, status, comment, answered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const insertPhoto = db.prepare("INSERT INTO simple_checklist_photos (submission_id, answer_id, file_path) VALUES (?, ?, ?)");
      rows.forEach((r, i) => {
        const a = insertAnswer.run(
          subId, r.item?.id ?? null, r.label, r.item?.help_text ?? null, i + 1,
          r.item?.measure_unit ?? null, r.item?.measure_min ?? null, r.item?.measure_max ?? null, r.item?.requires_photo ?? 0,
          r.measured, r.status, r.comment, completedSql
        );
        photosFor(r.photoKey).forEach((f) => insertPhoto.run(subId, a.lastInsertRowid, path.join("uploads", stored.get(f))));
      });
      photosFor("photo_general").forEach((f) => insertPhoto.run(subId, null, path.join("uploads", stored.get(f))));
      return subId;
    })();
  } catch (err) {
    // To kopier av samme utfylling samtidig: den andre taper på den unike nøkkelen. Svar med den
    // som vant, som om den hadde kommet først.
    [...stored.values()].forEach((name) => removeUploadedFile(name));
    const winner = db
      .prepare("SELECT id FROM simple_checklist_submissions WHERE company_id = ? AND client_key = ?")
      .get(req.user.company_id, clientKey);
    if (winner) return res.json(submissionDetail(winner.id));
    throw err;
  }
  // Bilder sendt under et felt som ikke hører til noe punkt i utfyllingen, ble aldri lagret.
  const used = new Set(rows.map((r) => r.photoKey).concat("photo_general"));
  files.filter((f) => !used.has(f.fieldname)).forEach((f) => removeUploadedFile(stored.get(f)));

  res.status(201).json(submissionDetail(id));
});

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
      `INSERT INTO simple_checklist_answers (submission_id, item_id, label, help_text, sort_order, measure_unit, measure_min, measure_max, requires_photo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    items.forEach((item, i) =>
      insert.run(info.lastInsertRowid, item.id, item.label, item.help_text, i + 1, item.measure_unit, item.measure_min, item.measure_max, item.requires_photo)
    );
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
    answers: rawDetail.answers.map((a) => ({
      ...a, label: pdfText(a.label), help_text: pdfText(a.help_text), comment: pdfText(a.comment),
      followup_action: pdfText(a.followup_action), followup_by_name: pdfText(a.followup_by_name),
    })),
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
    // Fylt ut uten nett: begge tidspunktene, så ingen leser mottakstiden som utfyllingstiden.
    ...(detail.completed_offline
      ? [["Fylt ut", `${osloDateTime(detail.client_completed_at)} (uten nett)`], ["Mottatt", osloDateTime(detail.submitted_at)]]
      : [["Sendt inn", osloDateTime(detail.submitted_at)]]),
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
    if (a.measure_unit && a.measured_value !== null && a.measured_value !== undefined) {
      const range = a.range_label && a.range_label !== a.measure_unit ? ` (grense: ${pdfText(a.range_label)})` : "";
      doc.font("Helvetica-Bold").fontSize(10.5).fillColor(a.status === "deviation" ? "#b91c1c" : INK)
        .text(`Målt: ${formatNumber(a.measured_value)} ${pdfText(a.measure_unit)}${range}`, left + 14, doc.y + 2, { width: width - 114 });
    }
    if (a.comment) {
      doc.font("Helvetica-Oblique").fontSize(10).fillColor(a.status === "deviation" ? "#b91c1c" : INK)
        .text(a.comment, left + 14, doc.y + 2, { width: width - 114 });
    }
    if (a.followup_at) {
      doc.font("Helvetica").fontSize(9.5).fillColor("#16a34a")
        .text(`Fulgt opp av ${a.followup_by_name}, ${osloDateTime(a.followup_at)}: ${a.followup_action}`, left + 14, doc.y + 3, { width: width - 114 });
    } else if (a.status === "deviation" && detail.submitted_at) {
      doc.font("Helvetica").fontSize(9.5).fillColor("#d97706").text("Ikke fulgt opp", left + 14, doc.y + 3, { width: width - 114 });
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
