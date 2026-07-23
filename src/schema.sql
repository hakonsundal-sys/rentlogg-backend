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

-- Users: cleaners, managers, admins, and customer-portal logins
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'cleaner', 'customer')),
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

CREATE INDEX IF NOT EXISTS idx_sites_client ON sites(client_id);
CREATE INDEX IF NOT EXISTS idx_runs_site ON checklist_runs(site_id);
CREATE INDEX IF NOT EXISTS idx_deviations_site ON deviations(site_id);
CREATE INDEX IF NOT EXISTS idx_schedules_site ON site_schedules(site_id);
CREATE INDEX IF NOT EXISTS idx_invitations_token ON invitations(token);
CREATE INDEX IF NOT EXISTS idx_rooms_site ON rooms(site_id);
CREATE INDEX IF NOT EXISTS idx_room_schedules_room ON room_schedules(room_id);
CREATE INDEX IF NOT EXISTS idx_room_runs_room ON room_runs(room_id);
