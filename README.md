# Rentlogg — backend scaffold

A working backend for a general-purpose cleaning documentation system: QR check-in per
site, digital checklists, before/after photos, deviation reporting, GPS validation, and
PDF report export. Built to support many clients (e.g. 30–40+), each with their own
sites and users.

This has been tested end-to-end (login, QR check-in, checklist completion, deviation
reporting, PDF export) and works out of the box with the seed data below.

## Stack

- Node.js + Express
- SQLite via `better-sqlite3` (zero external DB to set up — swap for Postgres later if you outgrow it)
- JWT auth with roles: `admin`, `manager`, `cleaner`, `customer`
- `qrcode` for QR generation, `multer` for photo uploads, `pdfkit` for report export

## Getting started

```bash
npm install
cp .env.example .env      # edit JWT_SECRET before any real use
npm run seed               # creates demo clients, sites, checklist templates, users
npm run dev                 # starts on http://localhost:4000
```

Demo logins created by the seed script:

| Role     | Email                  | Password      |
|----------|------------------------|---------------|
| admin    | admin@rentlogg.no      | admin1234     |
| manager  | manager@rentlogg.no    | manager1234   |
| cleaner  | cleaner@rentlogg.no    | cleaner1234   |
| customer | kunde@rentlogg.no      | kunde1234     |

## How the pieces fit together

- **Clients** are your 30–40 customers. Each has one or more **sites**.
- Each **site** gets a unique `qr_token`. `GET /sites/:id/qr` returns a scannable QR
  image that encodes a check-in link (`/checkin/:qrToken`).
- A **checklist template** (e.g. "Kontor", "Produksjon", "Helse") holds a reusable list
  of tasks. A site points at one template.
- When a cleaner scans the QR code, `POST /sites/checkin/:qrToken` creates a
  **checklist run** pre-filled from the site's template, and optionally checks GPS
  distance against the site's stored coordinates.
- The cleaner ticks off `checklist_run_items`, can attach photos
  (`POST /checklists/runs/:id/photos`), and files a **deviation** if something's wrong
  (`POST /deviations`) — this immediately flags the site as `deviation` status.
- `POST /checklists/runs/:id/complete` closes the run and updates the site's
  `last_cleaned_at` and status (`ok` unless there's a still-open deviation).
- `GET /reports/sites/:id/pdf` generates a PDF with recent runs and deviations — usable
  for client hand-off or internal audits.
- Customer-role users are scoped to their own `client_id` everywhere (sites, deviations,
  reports) so one client's users never see another's data.

## API overview

```
POST   /auth/register              (name, email, password, role, client_id?)
POST   /auth/login                 -> { token, user }

GET    /clients                    [admin, manager]
POST   /clients                    [admin]

GET    /sites                      (scoped to caller's client if role=customer)
POST   /sites                      [admin, manager]
GET    /sites/:id/qr                [admin, manager]  -> { checkInUrl, qrImage }
POST   /sites/checkin/:qrToken     [cleaner]           -> creates a checklist run

GET    /checklists/templates       [admin, manager]
POST   /checklists/templates       [admin, manager]
GET    /checklists/runs/:id
PATCH  /checklists/runs/:id/items/:itemId   [cleaner]  { done }
POST   /checklists/runs/:id/complete        [cleaner]
POST   /checklists/runs/:id/photos          [cleaner]  (multipart, field "photo")

GET    /deviations                 (scoped to caller's client if role=customer)
POST   /deviations                 [cleaner, manager]
PATCH  /deviations/:id             [admin, manager]    { status }

GET    /reports/sites/:id/pdf      [admin, manager, customer]
```

## Deployment

Live at **https://rentlogg-backend.onrender.com** (`GET /health` → `{"ok":true}`).

Deployed on [Render](https://render.com) from this repo's [render.yaml](render.yaml) as a
Blueprint (Starter plan): connect the GitHub repo in Render's "New Blueprint" flow and it
builds with `npm install` / runs `npm start` automatically. `JWT_SECRET` is auto-generated
by Render.

**Persistent disk**: a 1GB disk is mounted at `/var/data` (see `disk:` in render.yaml),
with `DB_FILE=/var/data/rentlogg.db` and `UPLOADS_DIR=/var/data/uploads` pointing at it —
the SQLite database and uploaded photos/avatars now survive redeploys and restarts. Run
`npm run seed` once via the Render Shell tab after the first deploy; it won't need
repeating on every deploy anymore.

The QR check-in URL (`GET /sites/:id/qr`) falls back to Render's auto-provided
`RENDER_EXTERNAL_URL` if `PUBLIC_BASE_URL` isn't set, so it works correctly out of the
box on Render without extra config.

## Connecting the frontend prototype

The earlier React click-through prototype (`rentlogg-prototype.jsx`) used in-memory
mock data. To wire it to this backend:

1. Replace the mock `INITIAL_SITES` state with a `fetch('/sites', { headers: { Authorization: 'Bearer ' + token } })` call on load.
2. Replace the "Simuler QR-skann" button with a real QR scanner (e.g. the `html5-qrcode`
   npm package reading the device camera), then call `POST /sites/checkin/:qrToken`
   with the scanned token.
3. Replace the checklist toggle and deviation form handlers with calls to the
   corresponding `PATCH`/`POST` endpoints above.
4. Add a login screen calling `POST /auth/login` and storing the JWT in memory (or a
   short-lived cookie) — not localStorage, since tokens shouldn't sit in persistent
   browser storage indefinitely.

## Known things to change before real use

- **Photo storage**: currently saves to a local `uploads/` folder via `multer`. Fine for
  a prototype or small deployment; move to S3 or R2 storage before relying on it in
  production, since local disk won't survive redeploys on most hosting platforms.
- **Multer version**: pinned to the 1.x line for stability; 2.x has a different (safer)
  API and is worth migrating to before production.
- **SQLite**: great for getting started and for a single-server deployment; move to
  Postgres if you need concurrent writes at scale or managed backups.
- **JWT_SECRET**: the `.env.example` value is a placeholder — generate a real random
  secret before deploying anywhere reachable from the internet.
- **Rate limiting / input validation**: not included here — add before exposing this
  publicly (e.g. `express-rate-limit`, `zod` for request validation).
