# Rentlogg — backend

The API behind Rentlogg, a cleaning documentation system in daily production use: QR
check-in per site, room-by-room checklists, before/after photos, deviation reporting with
customer sign-off, time clock, training records, and PDF/CSV reporting. Multi-tenant — one
deployment serves several cleaning companies, each with its own departments, customers,
sites and users, none of whom can see another company's data.

The frontend lives in a separate repo and is served at
[rentlogg.no](https://www.rentlogg.no). This repo is the backend only.

## Stack

- Node.js + Express
- SQLite via `better-sqlite3`, on a persistent disk — synchronous, single-file, no external
  database to run
- JWT auth (12h tokens), bcrypt password hashing, `helmet`, CORS allow-list, login rate limiting
- `qrcode` for QR generation, `multer` + `sharp` for photo upload and normalisation, `pdfkit`
  for PDF, `archiver` for photo ZIPs, `resend` for email
- `@anthropic-ai/sdk` + `pdf-parse` for the optional AI room-list import

## Getting started

```bash
npm install
cp .env.example .env      # every variable is documented there; JWT_SECRET must be set
npm run seed               # demo clients, sites, checklist templates, one user per role
npm run dev                 # starts on http://localhost:4000
```

`npm run seed` creates `admin@`, `manager@`, `cleaner@` and `kunde@rentlogg.no`. **Their
passwords are not in this repo**: set `SEED_ADMIN_PASSWORD` and friends in `.env` to choose
them, or leave them unset and the seed script generates random ones and prints them once.
`npm run seed:demo` builds a fuller demo company (rooms, a finished visit, an open deviation)
the same way, via `DEMO_PASSWORD`.

These are development accounts. Don't run either seed script against a database real people
log in to — that is exactly how publicly-known passwords once ended up on live accounts.

## How the pieces fit together

**Company → department → client → site → room.** Every row carries a `company_id`, and every
query is scoped by it; a `super_admin` (no company of its own) administers companies and
their modules, and is the only role that sees across them.

Roles are `super_admin`, `admin`, `manager`, `cleaner` and `customer`. Customer accounts are
additionally scoped to their own `client_id`, so a customer sees only their own sites,
deviations and reports.

**A site is cleaned in one of two shapes**, depending on how it was set up:

- *One shared checklist* — the site points at a **checklist template**, and a visit creates a
  `checklist_run` pre-filled from it. Suits a small site that is done in one pass.
- *Room by room* — the site has **rooms**, each with its own checklist items and a weekday
  schedule, and each visit to a room creates a `room_run`. Suits anything large enough that a
  single list would be unusable. A checklist item can also ask *which* alternative was used
  (which soap, which method) rather than just done or not done.

Either way:

- Each site has a unique `qr_token`. `GET /sites/:id/qr` returns a scannable image; scanning it
  with a phone's native camera opens `GET /checkin/:qrToken`, which redirects into the app's
  check-in flow. Check-in optionally validates GPS distance against the site's coordinates
  (`gps_radius_meters`, default 150).
- Cleaners tick off items, attach photos, and file **deviations** when something is wrong.
  Customers can file deviations too, reply to them, and approve the resolution.
- Rooms marked `requires_approval` are not finished when the cleaner is done — the customer
  signs off first. Until then the room counts as awaiting approval, not complete.
- Reports come out as per-visit HTML or PDF, per-site PDF, photo ZIPs, and a summary with CSV
  export. A **daily digest** email goes out per site at its own `report_send_hour` (default
  07:00 Europe/Oslo), sent through Resend.

### Add-on modules

`training` (courses, slides, per-employee records and certificates) and `timeclock` (stamp in
and out, hours per employee, payroll CSV) are sold separately. A `super_admin` enables them per
company; `requireModule()` returns 403 when a company doesn't have one, so hiding a menu item
is cosmetic and the backend is the real gate. Both default to off, including for companies that
already exist — a module should never appear in a live customer's menu on deploy day.

### Languages

The API ships Norwegian, English, Lithuanian, Latvian and Russian. Most cleaners aren't
Norwegian speakers and they are the app's main users, so every API error carries a stable
`code` the frontend translates, rather than a Norwegian string the frontend would have to
pattern-match.

## API overview

Around 140 endpoints across these routers — see `src/routes/` for the detail, and
`src/middleware/auth.js` for how `requireAuth`, `requireRole` and `requireModule` combine.

```
/auth          login, the super_admin bootstrap, own profile and password, staff admin
/companies     [super_admin] companies and their module flags
/departments   departments within a company
/clients       the cleaning company's own customers
/sites         sites, weekday schedules, documents, QR codes, check-in
/sites/:id/rooms + /rooms
               rooms, their checklist items and options, room schedules, room visits,
               customer approval, the monthly grid, and Excel/AI room-list import
/checklists    templates, and the single-checklist visit flow with photos and notes
/deviations    reporting, replies, resolution and customer approval
/reports       per-visit and per-site PDF, photo ZIPs, summary + CSV, daily digest trigger
/dashboard     the admin/manager summary
/invitations   invite-and-accept account creation
/modules       which add-on modules the caller's company has
/training      [module] courses, slides, assignments, progress, certificates
/time          [module] time entries, planned hours, month lock, payroll CSV
/uploads       authenticated file serving for photos, avatars and documents
```

Two things worth knowing before using the API:

- `POST /auth/register` is **not** open registration. It creates the very first `super_admin`
  and then permanently closes itself (`403 signup_closed`). Every other account is created by
  an admin (`POST /auth/users`) or through the invitation flow.
- `PATCH /auth/users/:id/password` deliberately refuses admin targets — an admin can't be reset
  by a co-admin. Admins change their own password with `PATCH /auth/me/password`, which
  requires the current one.

## Deployment

Live at **https://rentlogg-backend.onrender.com** (`GET /health` → `{"ok":true}`).

Deployed on [Render](https://render.com) from [render.yaml](render.yaml) as a Blueprint:
connect the repo in Render's "New Blueprint" flow and it builds with `npm install` and runs
`npm start`. `JWT_SECRET` is auto-generated by Render; every other variable is listed in
render.yaml with a comment saying whether it lives there or in the dashboard. **Adding an
environment variable to the code without adding it to render.yaml is how a rebuilt service
comes up silently missing it.**

A 1GB persistent disk is mounted at `/var/data`, with `DB_FILE=/var/data/rentlogg.db` and
`UPLOADS_DIR=/var/data/uploads` — the database and uploaded photos survive redeploys and
restarts. Run `npm run seed` once from the Render Shell after the first deploy, and never
again against that database.

`PUBLIC_BASE_URL` falls back to Render's own `RENDER_EXTERNAL_URL`, so printed QR codes
encode the right host without extra configuration.

## Known things to change

- **`ALLOWED_ORIGINS` is a single point of failure.** It's set in Render's dashboard, not in
  this repo, and it must list **`https://www.rentlogg.no`** — the apex 308-redirects to www, so
  www is what sits in the `Origin` header of every API call. Setting the apex alone, which is
  the obvious-looking value, blocks every browser request and takes the app down for all users
  with no code change to point at; the symptom is "Failed to fetch" rather than a status code.
  Left entirely unset, CORS falls back to reflecting any origin, which is safe-ish but wide.
- **Rate limiting covers login only** (`src/routes/auth.js`). Nothing else is bounded.
- **No input-validation library.** Request bodies are checked by hand, route by route —
  consistent, but easy to forget in a new endpoint. `zod` or similar would make it structural.
- **No token revocation.** Changing or resetting a password doesn't invalidate tokens already
  issued; the 12h expiry is the only bound on a stale or stolen session.
- **Photos live on the Render disk.** They survive redeploys, but there's no offsite copy — a
  lost disk is lost documentation. S3 or R2 before this gets big.
- **SQLite is single-server.** Fine for one Render instance; Postgres if this ever needs
  concurrent writes across instances, or managed backups.
- **`multer` is pinned to 1.x.** 2.x has a safer API and is worth migrating to.
- **`nodemailer` is still a dependency** but nothing imports it — a leftover from the Gmail SMTP
  setup that Resend replaced. Safe to remove.

## Import tooling

`tools/` turns a customer's existing "Renholdsplan ….xlsx" into the room list this API expects.
It is run by hand when a new site is set up, is not imported by the server, and has its own
[README](tools/README.md). Never import a room plan from a PDF when the Excel exists — that
file explains why.
