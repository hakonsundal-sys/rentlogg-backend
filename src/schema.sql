-- Companies: the cleaning-company tenants Rentlogg is sold to. Every admin/manager/cleaner and
-- every client/site/checklist_template belongs to exactly one company; a null company_id is
-- reserved for the super_admin role, which manages companies but has no company of its own.
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Which add-on modules a company has turned on. See src/modules.js for the registry of what can
-- be turned on, and middleware/auth.js's requireModule() for where it's enforced. A company with
-- no row for a module falls back to that module's own defaultEnabled, so this table only ever
-- holds the deliberate exceptions — turning a module off never deletes the module's data, it
-- only stops the routes and hides the surfaces.
CREATE TABLE IF NOT EXISTS company_modules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  module_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  enabled_at TEXT DEFAULT (datetime('now')),
  enabled_by INTEGER REFERENCES users(id),
  UNIQUE(company_id, module_key)
);

-- Clients: the companies that hire the cleaning company (30-40+ expected)
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact_email TEXT,
  contact_name TEXT,
  phone TEXT,
  address TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Departments: an internal, company-wide regional grouping of sites (e.g. "Vest"/"Sør"/"Øst"/
-- "Midt"), independent of which client a site belongs to. Staff-only (admin/manager manage
-- these and tag sites with one) — customers have no visibility into or use for this.
CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  company_id INTEGER REFERENCES companies(id),
  created_at TEXT DEFAULT (datetime('now'))
);

-- Users: cleaners, managers, admins, and customer-portal logins
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('super_admin', 'admin', 'manager', 'cleaner', 'customer')),
  client_id INTEGER REFERENCES clients(id), -- set for 'customer' role users
  avatar_url TEXT,
  phone TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Sites: physical locations that get cleaned, one QR code each
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  department_id INTEGER REFERENCES departments(id), -- optional internal region tag (Vest/Sør/Øst/Midt)
  address TEXT,
  checklist_template_id INTEGER REFERENCES checklist_templates(id),
  qr_token TEXT UNIQUE NOT NULL,
  latitude REAL,
  longitude REAL,
  gps_radius_meters INTEGER DEFAULT 150,
  last_cleaned_at TEXT,
  status TEXT NOT NULL DEFAULT 'overdue' CHECK (status IN ('ok', 'overdue', 'deviation')),
  room_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Per-site document library (floor plans, PDFs, etc.), visibility-scoped so a document can be
-- shown to staff only, customer only, or both.
CREATE TABLE IF NOT EXISTS site_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'both' CHECK (visibility IN ('staff', 'customer', 'both')),
  created_at TEXT DEFAULT (datetime('now'))
);

-- Checklist templates: reusable per site type (kontor, produksjon, helse, ...)
CREATE TABLE IF NOT EXISTS checklist_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS checklist_template_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES checklist_templates(id),
  label TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0
);

-- Checklist runs: one per cleaning visit (created on QR scan / check-in)
CREATE TABLE IF NOT EXISTS checklist_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  cleaner_id INTEGER NOT NULL REFERENCES users(id),
  started_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  gps_verified INTEGER DEFAULT 0,
  latitude REAL,
  longitude REAL
);

CREATE TABLE IF NOT EXISTS checklist_run_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES checklist_runs(id),
  label TEXT NOT NULL,
  done INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0
);

-- Deviations: issues flagged during or outside a cleaning run
CREATE TABLE IF NOT EXISTS deviations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  run_id INTEGER REFERENCES checklist_runs(id),
  reported_by INTEGER NOT NULL REFERENCES users(id),
  title TEXT,
  description TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved')),
  created_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT
);

-- Photos: before/after documentation, attached to a run or a deviation
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER REFERENCES checklist_runs(id),
  deviation_id INTEGER REFERENCES deviations(id),
  file_path TEXT NOT NULL,
  kind TEXT DEFAULT 'general' CHECK (kind IN ('before', 'after', 'general')),
  created_at TEXT DEFAULT (datetime('now'))
);

-- Site schedules: recurring weekday cleaning plan per site (no cron — matched against
-- actual checklist_runs at request time to compute "planned" vs "missing")
CREATE TABLE IF NOT EXISTS site_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  assigned_cleaner_id INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(site_id, weekday)
);

-- Invitations: 14-day expiring links used to onboard new users without an admin-set password
CREATE TABLE IF NOT EXISTS invitations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'cleaner', 'customer')),
  client_id INTEGER REFERENCES clients(id),
  token TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'used', 'revoked')),
  invited_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- Rooms: per-room breakdown of a site's cleaning plan (opt-in; sites with no rooms keep
-- using the flat checklist_templates/checklist_runs model unchanged)
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  interval_days INTEGER, -- set = "every N days" mode
  monthly_weekday INTEGER, -- 0=søndag..6=lørdag; set = "Nth weekday of month" mode
  monthly_occurrence INTEGER, -- 1..4 = first..fourth, -1 = last; goes with monthly_weekday
  created_at TEXT DEFAULT (datetime('now'))
  -- exactly one of: room_schedules rows (weekday mode), interval_days, or the monthly_* pair — enforced in routes, not the DB
);

CREATE TABLE IF NOT EXISTS room_checklist_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  label TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS room_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  assigned_cleaner_id INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(room_id, weekday)
);

-- A checklist item's "weekly" schedule mode (see room_checklist_items.monthly_weekday) can name
-- more than one weekday (e.g. "man+tor") — one row per selected day, mirroring room_schedules.
CREATE TABLE IF NOT EXISTS room_checklist_item_weekdays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES room_checklist_items(id),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  UNIQUE(item_id, weekday)
);

-- A checklist item can carry a set of tick-off alternatives ("flervalg") instead of being a
-- plain done/not-done line: e.g. Sinkaberg's cleaners must record WHICH soap they used that day,
-- picking one or more from the site's chemical list. An item is a multi-choice item purely by
-- having rows here — there's no separate type column — and such an item can't be marked done
-- until at least one of its options is ticked (enforced in routes/rooms.js).
CREATE TABLE IF NOT EXISTS room_checklist_item_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES room_checklist_items(id),
  label TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS room_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  cleaner_id INTEGER REFERENCES users(id),
  started_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS room_run_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_run_id INTEGER NOT NULL REFERENCES room_runs(id),
  label TEXT NOT NULL,
  done INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0
);

-- One day's snapshot of a multi-choice item's options, mirroring how room_run_items already
-- snapshots its parent item's label: the option list a cleaner actually chose from is frozen into
-- the run, so renaming or removing a soap later never rewrites what last month's log says was
-- used. option_id is the same nullable "which template row did this come from" link
-- room_run_items.room_checklist_item_id is, and is cleared (not cascaded) when an option is
-- deleted, exactly like that one.
CREATE TABLE IF NOT EXISTS room_run_item_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_item_id INTEGER NOT NULL REFERENCES room_run_items(id),
  option_id INTEGER REFERENCES room_checklist_item_options(id),
  label TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  selected INTEGER DEFAULT 0
);

-- Training ("Opplæring"): documenting that a staff member has received training — a lesson watched
-- in the app, a routine read, a physical course held, an external certificate earned — and has
-- signed for it. An add-on module (see src/modules.js), off unless a super_admin turns it on.
--
-- Split the same way the rest of the app splits plan from event (room_schedules → room_runs):
-- training_assignments is who SHOULD take a course, training_records is what actually happened.
CREATE TABLE IF NOT EXISTS training_courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  title TEXT NOT NULL,
  description TEXT,
  -- 'lesson'    slides + narration played in the app
  -- 'video'     a YouTube video played in the app (see video_url) — costs no disk here, but is one
  --             language per video and needs real signal, unlike slides
  -- 'document'  a routine/PDF the person confirms having read
  -- 'classroom' physical/practical training, registered by an admin afterwards
  -- 'external'  an outside course (e.g. Hygiene Academy), documented by its certificate
  -- No CHECK constraint, matching every other enum-ish column in this app — validated in the route.
  kind TEXT NOT NULL DEFAULT 'lesson',
  validity_months INTEGER, -- null = never expires; else records get expires_at = completed + N months
  requires_signature INTEGER NOT NULL DEFAULT 1,
  -- On top of the typed name: the person draws their signature with a finger before the course can
  -- be completed. Adds nothing legally that the name and timestamp don't already carry — what it
  -- adds is that the documentation reads as a signature to a customer or an inspector looking at it.
  requires_drawn_signature INTEGER NOT NULL DEFAULT 0,
  video_url TEXT, -- kind = video: the YouTube link. Unlisted works; private cannot be embedded.
  -- Bumped whenever the lesson's slides are replaced. A record carries the version it was signed
  -- on, so "signed, but the course has changed since" is visible without discarding the old signature.
  version INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);

-- One slide of a lesson, in one language. The app plays image + audio and shows narration_text
-- underneath; a language nobody on the roster reads is simply never generated, so a course can
-- have Norwegian and Lithuanian slides and nothing else.
CREATE TABLE IF NOT EXISTS training_slides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES training_courses(id),
  language TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  image_path TEXT,
  audio_path TEXT,
  narration_text TEXT,
  duration_seconds INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Attachments belonging to the course itself (the routine PDF for a kind='document' course,
-- a handout for a classroom one) — not to be confused with a record's evidence file below.
CREATE TABLE IF NOT EXISTS training_course_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES training_courses(id),
  name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  language TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS training_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES training_courses(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  assigned_by INTEGER REFERENCES users(id),
  assigned_at TEXT DEFAULT (datetime('now')),
  due_at TEXT,
  UNIQUE(course_id, user_id)
);

-- One row per completion, not per person: a course that expires and is retaken gets a second row,
-- so the history of who was trained when survives the re-certification instead of being overwritten.
CREATE TABLE IF NOT EXISTS training_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES training_courses(id),
  course_version INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER NOT NULL REFERENCES users(id),
  started_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  signed_at TEXT,
  signed_initials TEXT,          -- the person's own name, same convention as room_runs.signed_initials
  registered_by INTEGER REFERENCES users(id), -- set when an admin registered it on someone's behalf
  instructor TEXT,               -- who held the training (a person or an external provider)
  evidence_path TEXT,            -- an external course certificate, uploaded as proof
  evidence_name TEXT,
  signature_path TEXT,           -- the drawn signature, when the course asks for one
  video_completed_at TEXT,       -- kind = video: when the player reported the video had ended

  expires_at TEXT,               -- computed from completed_at + course.validity_months at save time
  note TEXT,
  -- Lesson progress, kept on the record rather than in a table of its own: enough to resume where
  -- the person left off AND to document "saw 14 of 14 slides" once it's signed.
  slides_total INTEGER,
  slides_seen INTEGER DEFAULT 0,
  last_slide_index INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Timeregistrering: one row per person per stamping, born from the QR scan but deliberately
-- independent of checklist_runs.
--
-- Why its own table rather than reading hours off the check-in: a checklist_run is shared per site
-- per day. findRunForSiteDate (services/schedule.js) hands today's run to whoever scans, so its
-- cleaner_id is only ever "whoever scanned first" and a second cleaner on the same site that day
-- leaves no trace on it at all; findOrCreateRoomRunForDate shares room runs the same way. And
-- completed_at only means somebody tapped "Avslutt besøk" (see the caveat in routes/checklists.js),
-- which a cleaner can do with most rooms still undone. None of that is wrong for a checklist — it
-- is exactly wrong for a timesheet, where the question is always "this person, this shift".
--
-- This is payroll data, so the lock and the edit trail are here from the first row rather than
-- retrofitted: locked_at freezes an exported period, and edited_at/edited_by_initials follow the
-- same shape room_runs already uses for a corrected checklist.
CREATE TABLE IF NOT EXISTS time_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  -- Null for a shift booked on an order with no building — intern tid, kjøring, fravær. Every
  -- QR stamping has one; only a hand-registered entry on such an order does not.
  site_id INTEGER REFERENCES sites(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  -- The Europe/Oslo calendar day the shift belongs to, stored rather than derived: started_at is
  -- UTC (Render runs in UTC), and every grouping, filter and export in this module is by working
  -- day. Fixed at stamp-in, so a shift running past midnight stays on the day it started.
  work_date TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  -- 'qr' stamped in by scanning the site's QR code, 'manual' registered afterwards by an
  -- admin/driftsleder. No CHECK constraint, matching every other enum-ish column in this app.
  source TEXT NOT NULL DEFAULT 'qr',
  -- The visit this stamping was born from, kept for context only — never read to compute hours,
  -- and null for a manually registered entry.
  run_id INTEGER REFERENCES checklist_runs(id),
  start_gps_verified INTEGER DEFAULT 0,
  start_latitude REAL,
  start_longitude REAL,
  end_gps_verified INTEGER DEFAULT 0,
  end_latitude REAL,
  end_longitude REAL,
  -- The raw clock difference, always kept even when the site pays a fixed frame — "she was there
  -- 2t 40m but the site is paid as 2t" is the whole point of having both numbers.
  actual_minutes INTEGER,
  -- The unpaid break she reported when stamping out. Asked rather than clocked: a pause button
  -- only works if she remembers to press it twice, and a forgotten one costs her real money.
  -- Deducted from the clock on an 'actual' site; on a 'fixed' site the frame is the frame and this
  -- is recorded without changing what she is paid (Håkon, 2026-09-24).
  pause_minutes INTEGER NOT NULL DEFAULT 0,
  -- What actually counts for this shift, and which rule produced it: 'actual' = the clock,
  -- 'fixed' = the site's rammetimetall, 'manual' = a number an admin typed. billing_mode and
  -- fixed_minutes are snapshots taken when the entry was closed, not looked up on read: changing
  -- a site's rammetimetall next month must never silently rewrite what last month's payroll said
  -- (same reasoning as training_records.expires_at being computed at save time).
  minutes INTEGER,
  billing_mode TEXT,
  fixed_minutes INTEGER,
  -- Set when nobody stamped out by hand: 'new_checkin' (closed at the moment the same person
  -- stamped in somewhere else the same day) or 'stale' (still open when a later day started — left
  -- with no ended_at on purpose, because inventing an evening departure time is inventing payroll).
  auto_closed_reason TEXT,
  note TEXT,
  -- Payroll lock: set over a whole period once it has been exported, after which the entry can be
  -- neither edited nor deleted until an admin unlocks it again.
  locked_at TEXT,
  locked_by INTEGER REFERENCES users(id),
  edited_at TEXT,
  edited_by_initials TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Lønnsarter: what a line of hours, or a supplement, is called by the time it reaches payroll.
-- Unimicro reads `code`, so that string is the actual interface to the payroll system and is
-- snapshotted onto every line rather than joined at read time — renaming an art next year must not
-- rewrite what was exported last year. Defaults are seeded per company from OKV's own Mobile Worker
-- list (see seedDefaultTimeTypes in services/timeEntries.js) and are editable from "Timearter".
--
-- kind: 'hours' (has fra/til, sums to a duration) or 'supplement' ("tillegg/annet" — a count, e.g.
-- one night supplement for a shift). Expenses ("utlegg") are deliberately absent: OKV registers
-- those by hand in the payroll system, and they are kroner, not time.
CREATE TABLE IF NOT EXISTS time_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  kind TEXT NOT NULL DEFAULT 'hours',
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  -- The art a QR stamping turns into. Exactly one per company is the default; setting a new one
  -- clears the old (enforced in the route, like every other invariant in this app).
  is_default INTEGER NOT NULL DEFAULT 0,
  -- Lunch is hours, and belongs on the timesheet, but is not worked time — without this the daily
  -- total silently pays for it.
  counts_as_work INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- What a stamping actually consists of. A QR stamping produces exactly one line (the default art,
-- the whole shift); a shift registered by hand can be split — 16:00–16:30 ordinary plus 16:30–18:00
-- overtime — which is the reason this is a table and not three more columns on time_entries.
--
-- time_entries.minutes stays the authoritative payable total and is recomputed as the sum of the
-- work-counting lines whenever they change, so every existing reader (totals, CSV, the cleaner's
-- own card) keeps working without knowing lines exist.
CREATE TABLE IF NOT EXISTS time_entry_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL REFERENCES time_entries(id),
  kind TEXT NOT NULL DEFAULT 'hours',
  time_type_id INTEGER REFERENCES time_types(id),
  -- Snapshots, for the same reason billing_mode/fixed_minutes are snapshotted on the entry.
  type_code TEXT,
  type_name TEXT,
  counts_as_work INTEGER NOT NULL DEFAULT 1,
  -- Oslo wall clock "HH:MM", null on a supplement line and on an hours line entered as a bare
  -- quantity. The day itself lives on the parent entry's work_date.
  start_time TEXT,
  end_time TEXT,
  minutes INTEGER,        -- hours lines
  quantity REAL,          -- supplement lines ("2 nattillegg")
  description TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Prosjekt og ordre: the dimension time is actually booked on, modelled after the Mobile Worker
-- OKV runs today (Håkon 2026-09-23). A site is a building with a QR code; an order is the thing
-- that gets invoiced, reported on and paid against — and not every order is a building. "Intern
-- tid" is an order with no site and no customer, which is precisely why hours could not be booked
-- to it before this existed: there was nothing to scan.
--
-- Hierarchy: projects → orders → sites. A site belongs to at most one order, and a stamping
-- inherits its order from the site it was stamped at; an entry registered by hand (internal time,
-- holiday, sick leave) has an order and no site at all.
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  number TEXT,
  name TEXT NOT NULL,
  client_id INTEGER REFERENCES clients(id),
  manager_id INTEGER REFERENCES users(id),
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  project_id INTEGER REFERENCES projects(id),
  -- The number staff actually say out loud ("1014 Vågen"). Free text, not the row id: it comes
  -- from the customer's own order system as often as from ours.
  number TEXT,
  name TEXT NOT NULL,
  -- 'customer' the ordinary case, 'internal' (intern tid, kjøring) and 'absence' (ferie,
  -- sykefravær) — the two that have no customer to invoice and no building to stand in. No CHECK
  -- constraint, matching every other enum-ish column in this app.
  kind TEXT NOT NULL DEFAULT 'customer',
  client_id INTEGER REFERENCES clients(id),
  manager_id INTEGER REFERENCES users(id),   -- ordreansvarlig
  cost_center TEXT,                          -- kostnadssted
  labels TEXT,                               -- etiketter, comma-separated
  invoice_comment TEXT,                      -- fakturakommentar
  -- Lets an order be stamped without a QR code at all, which is what makes "Før timer" possible
  -- for internal time and absence. A customer order normally leaves this off: hours there come
  -- from actually being at the building.
  allows_manual INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Godkjenningsnivåer: the ladder a shift climbs before it counts as approved — OKV's own is
-- Teamleder → Formann → Driftssjef → Administrasjon. Each staff member sits at one level, and a
-- shift needs one approval from each level marked `required`, in step order.
--
-- Deliberately a table rather than a role enum: the levels are the company's own org chart, they
-- differ between companies, and an admin has to be able to add "Kvalitet" next year without a
-- deploy.
CREATE TABLE IF NOT EXISTS approval_levels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  step INTEGER NOT NULL DEFAULT 1,
  -- An optional level may approve but is never waited for. Lets a company keep "Teamleder" as a
  -- courtesy signature without stalling payroll when the team leader is on holiday.
  required INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

-- One level per person, the same shape Mobile Worker's "Tildel brukere til godkjenningsnivå"
-- shows. Somebody with no row here simply cannot approve.
CREATE TABLE IF NOT EXISTS user_approval_levels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  level_id INTEGER NOT NULL REFERENCES approval_levels(id),
  UNIQUE(user_id)
);

-- One row per level that has signed off on one shift. Kept rather than collapsed into a flag on
-- time_entries, because "who signed, at which level, when" is the whole point of having levels —
-- and because a correction has to be able to throw away the signatures without throwing away the
-- record that they once existed (see time_entry_log).
CREATE TABLE IF NOT EXISTS time_entry_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL REFERENCES time_entries(id),
  level_id INTEGER NOT NULL REFERENCES approval_levels(id),
  level_name TEXT,                 -- snapshot, so a renamed level doesn't rewrite old sign-offs
  level_step INTEGER,
  approved_at TEXT,
  approved_by INTEGER REFERENCES users(id),
  approved_by_name TEXT,
  comment TEXT,
  UNIQUE(entry_id, level_id)
);

-- Endringsloggen. Mobile Worker shows Status | Ansattnavn | Tid | Kommentar under every timesheet,
-- and it is the thing that answers "why does this say 6 hours when she was there 8" three months
-- later. Append-only: nothing in this app ever edits or deletes a row here.
CREATE TABLE IF NOT EXISTS time_entry_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL REFERENCES time_entries(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  at TEXT DEFAULT (datetime('now')),
  user_id INTEGER REFERENCES users(id),
  user_name TEXT,
  -- 'stamped_in' | 'stamped_out' | 'auto_closed' | 'created' | 'edited' | 'approved' |
  -- 'rejected' | 'approval_cleared' | 'locked' | 'unlocked'
  action TEXT NOT NULL,
  status TEXT,      -- what the shift looked like after this happened
  comment TEXT
);

-- Team og ansattgrupper: the two ways OKV slices its staff in Mobile Worker, alongside the
-- Avdeling (Vest/Midt/Sør/Øst) Rentlogg already has. They are not the same thing and neither
-- replaces the other:
--   Avdeling  the org unit a person is paid under
--   Team      where they physically work — Bergen, Haugesund, Rørvik, Nortura Malvik …
--   Gruppe    what kind of staff they are — Renhold, Teamleder/Ledelse
-- All three are filters on the timesheet, and a person belongs to at most one of each.
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS employee_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sites_client ON sites(client_id);
CREATE INDEX IF NOT EXISTS idx_runs_site ON checklist_runs(site_id);
CREATE INDEX IF NOT EXISTS idx_deviations_site ON deviations(site_id);
CREATE INDEX IF NOT EXISTS idx_schedules_site ON site_schedules(site_id);
CREATE INDEX IF NOT EXISTS idx_invitations_token ON invitations(token);
CREATE INDEX IF NOT EXISTS idx_rooms_site ON rooms(site_id);
CREATE INDEX IF NOT EXISTS idx_room_schedules_room ON room_schedules(room_id);
CREATE INDEX IF NOT EXISTS idx_room_runs_room ON room_runs(room_id);
CREATE INDEX IF NOT EXISTS idx_item_options_item ON room_checklist_item_options(item_id);
CREATE INDEX IF NOT EXISTS idx_run_item_options_run_item ON room_run_item_options(run_item_id);
CREATE INDEX IF NOT EXISTS idx_training_courses_company ON training_courses(company_id);
CREATE INDEX IF NOT EXISTS idx_training_slides_course ON training_slides(course_id, language, sort_order);
CREATE INDEX IF NOT EXISTS idx_training_course_files_course ON training_course_files(course_id);
CREATE INDEX IF NOT EXISTS idx_training_assignments_user ON training_assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_training_records_user ON training_records(user_id, course_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_company_date ON time_entries(company_id, work_date);
CREATE INDEX IF NOT EXISTS idx_time_entries_user_date ON time_entries(user_id, work_date);
CREATE INDEX IF NOT EXISTS idx_time_entries_site_date ON time_entries(site_id, work_date);
CREATE INDEX IF NOT EXISTS idx_time_types_company ON time_types(company_id, kind, sort_order);
CREATE INDEX IF NOT EXISTS idx_time_entry_lines_entry ON time_entry_lines(entry_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_orders_company ON orders(company_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_orders_project ON orders(project_id);
CREATE INDEX IF NOT EXISTS idx_projects_company ON projects(company_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_approval_levels_company ON approval_levels(company_id, step);
CREATE INDEX IF NOT EXISTS idx_user_approval_levels_company ON user_approval_levels(company_id);
CREATE INDEX IF NOT EXISTS idx_entry_approvals_entry ON time_entry_approvals(entry_id);
CREATE INDEX IF NOT EXISTS idx_entry_log_entry ON time_entry_log(entry_id, at);
CREATE INDEX IF NOT EXISTS idx_teams_company ON teams(company_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_employee_groups_company ON employee_groups(company_id, sort_order);

-- Kvalitetslogg: an append-only record of everything that happens to the cleaning documentation
-- after it has been written. Rentlogg's history view (services/runHistory.js) is assembled from
-- the timestamps the app happens to keep, which means it can only ever show the LAST edit, cannot
-- show a task being un-ticked, and shows nothing at all when a photo, room or site is deleted —
-- the cascades simply removed the rows and the files. For an ordinary checklist that was fine.
-- For documentation a food-safety auditor relies on, evidence that can be changed or removed
-- without trace is not evidence, so this table exists to make every such event survive the thing
-- it happened to.
--
-- Same shape as time_entry_log, which already does this for payroll: one row per event, never
-- updated, never deleted, carrying a snapshot of who did it rather than only a foreign key (the
-- export has to still name them after they leave the company).
--
-- Deliberately NOT cascaded from anything. A row here outlives the room, site, photo or avvik it
-- describes — that is the entire point — so subject_id is a plain integer, not a foreign key.
--
-- occurred_at vs recorded_at: a cleaner's phone queues actions in IndexedDB while it has no
-- signal and replays them FIFO when it reconnects (frontend's offlineQueue.js), so a plain
-- datetime('now') would date a morning's work to whenever the bus came back into coverage.
-- occurred_at is when it actually happened, recorded_at when the server heard about it, and
-- offline flags the rows where those two legitimately differ. A report that shows a tick as
-- having happened hours after the room was finished, with no explanation, invites exactly the
-- question this system exists to answer.
CREATE TABLE IF NOT EXISTS quality_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  -- 'room_run' | 'room_run_item' | 'photo' | 'room' | 'site' | 'deviation'
  subject_type TEXT NOT NULL,
  subject_id INTEGER NOT NULL,
  -- Where it happened, denormalised so a room/site report can be built after the room or site
  -- itself is gone. Nullable because not every subject can resolve both.
  site_id INTEGER,
  room_id INTEGER,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT DEFAULT (datetime('now')),
  offline INTEGER DEFAULT 0,
  user_id INTEGER REFERENCES users(id),
  user_name TEXT,
  -- 'photo_deleted' | 'room_deleted' | 'site_deleted' | 'deviation_deleted' | …
  action TEXT NOT NULL,
  -- What the record said before and after, as free text: enough for a reader to see what changed
  -- without this table having to mirror every column of every table it describes.
  before_value TEXT,
  after_value TEXT,
  comment TEXT
);

CREATE INDEX IF NOT EXISTS idx_quality_log_subject ON quality_log(subject_type, subject_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_quality_log_room ON quality_log(room_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_quality_log_site ON quality_log(site_id, occurred_at);

-- Hvem var med i rommet. A room_run is shared per room per day: findOrCreateRoomRunForDate hands
-- the same row to whoever opens the room first, so its cleaner_id only ever names that person —
-- see time_entries' own comment above, which is why the timesheet got its own table rather than
-- reading hours off the checklist. The same flaw is worse for the quality record: at a site like
-- Nortura Malvik, with 60 rooms and a crew working them in parallel, "who cleaned this room"
-- currently has one name on it and no way to tell whether that name did the work.
--
-- One row per person who actually touched the run — ticking a task, choosing a soap, adding a
-- photo, writing a note, completing it. user_name is snapshotted beside the id for the same
-- reason approved_by_name is on time_entries: the documentation has to still name them after
-- they leave the company.
CREATE TABLE IF NOT EXISTS room_run_participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_run_id INTEGER NOT NULL REFERENCES room_runs(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  user_name TEXT NOT NULL,
  first_action_at TEXT DEFAULT (datetime('now')),
  UNIQUE(room_run_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_room_run_participants_run ON room_run_participants(room_run_id);
