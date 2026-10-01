import { db } from "./db.js";

// Add-on modules: the parts of Rentlogg that are sold on top of the core product (QR check-in,
// rooms/checklists, deviations, history, locations, staff, reports) rather than being part of it.
// A module is turned on per company by a super_admin from "Firmaer" (see routes/companies.js) and
// enforced in the backend by requireModule() in middleware/auth.js — hiding a menu item is
// cosmetic, the 403 is the actual gate.
//
// Adding another module later is one entry here plus a checkbox in SelskaperPage.jsx: a company
// with no row in company_modules falls back to that entry's defaultEnabled, so nothing needs to be
// backfilled for the companies that already exist.
export const MODULES = [
  {
    key: "training",
    name: "Opplæring",
    description: "Kurs, opplæringsvideoer og signert dokumentasjon per ansatt.",
    // Off until someone turns it on, for every company including the ones already running — a new
    // module should never just appear in a live customer's menu on deploy day.
    defaultEnabled: false,
  },
  {
    key: "timeclock",
    name: "Timeregistrering",
    description: "Stempling inn og ut på QR-skanning, timer per ansatt og CSV-eksport til lønn.",
    // Same reason as above, and one more: this one produces payroll numbers. A company that has
    // not bought it must never end up with half a month of stamped shifts nobody asked for.
    defaultEnabled: false,
  },
  {
    key: "hygiene",
    name: "Hygiene og måling",
    description:
      "Hygienetrinn i fast sekvens med kontakttid, måleverdier mot grenseverdi (ATP, temperatur, " +
      "pH), kjemikalieregister, og sperret frigivelse ved prøve utenfor grensen.",
    // Et kontorbygg trenger ingenting av dette. Å la en renholdsbedrift som vasker kontorer få
    // «+ Måling» og «+ Trinn» i oppgaveeditoren er ikke bare støy — det er to valg til i en
    // skjerm som allerede har mange, for en bransje der svaret alltid er nei.
    //
    // Het «Næringsmiddel» til 2026-10-01. Navnet var feil: kontakttid er en DESINFEKSJONS-
    // funksjon, ikke en matfunksjon, og ATP måles i helsebygg også. Et legesenter, en barnehage
    // under et utbrudd eller et treningssenter har alle «spray, la det stå ti minutter, tørk
    // av» — og ingen av dem ville fått tilbud om en modul som het Næringsmiddel. Navnet skal
    // beskrive hva modulen gjør, ikke hvilken bransje som først spurte etter den.
    //
    // Merk hva denne modulen IKKE skrur av: en måling som allerede ligger på et besøk fortsetter
    // å virke, og kontakttiden fortsetter å sperre. Modulen styrer hva som kan settes OPP, ikke
    // hva som allerede er dokumentert — skrur man den av midt i et skift, skal ikke renholderen
    // plutselig kunne kvittere ut en desinfeksjon uten kontakttid.
    defaultEnabled: false,
  },
];

const MODULE_BY_KEY = new Map(MODULES.map((m) => [m.key, m]));

export function isKnownModule(key) {
  return MODULE_BY_KEY.has(key);
}

// A company_modules row wins; with none, the module's own default applies. Read straight from
// SQLite on every call rather than cached — better-sqlite3 is synchronous and local, this is a
// single indexed lookup, and a cache would have to be invalidated from the toggle route to avoid
// a super_admin turning a module on and the company not seeing it until the next restart.
export function isModuleEnabled(companyId, key) {
  const module = MODULE_BY_KEY.get(key);
  if (!module) return false;
  // super_admin (and anything else without a company) owns no company's data, so no company's
  // modules apply to it either. Deliberate: every module so far is company-scoped, so "enabled for
  // whom?" has no answer here. A future module that Rentlogg's own operator surface needs would
  // have to say so explicitly rather than inherit an exception from this line.
  if (!companyId) return false;
  const row = db
    .prepare("SELECT enabled FROM company_modules WHERE company_id = ? AND module_key = ?")
    .get(companyId, key);
  return row ? !!row.enabled : module.defaultEnabled;
}

// The keys a given company currently has — what the frontend uses to decide which surfaces exist.
export function enabledModulesForCompany(companyId) {
  return MODULES.filter((m) => isModuleEnabled(companyId, m.key)).map((m) => m.key);
}

// Every module with its on/off state for one company — the shape super_admin's "Firmaer" list
// renders a checkbox per row from.
export function modulesWithStatus(companyId) {
  return MODULES.map(({ key, name, description }) => ({
    key,
    name,
    description,
    enabled: isModuleEnabled(companyId, key),
  }));
}

// Upsert rather than insert-or-update by hand: the UNIQUE(company_id, module_key) constraint makes
// this the one statement that's correct whether or not the company has ever had a row for it.
export function setModuleEnabled(companyId, key, enabled, byUserId) {
  db.prepare(
    `INSERT INTO company_modules (company_id, module_key, enabled, enabled_at, enabled_by)
     VALUES (?, ?, ?, datetime('now'), ?)
     ON CONFLICT(company_id, module_key)
     DO UPDATE SET enabled = excluded.enabled, enabled_at = excluded.enabled_at, enabled_by = excluded.enabled_by`
  ).run(companyId, key, enabled ? 1 : 0, byUserId ?? null);
}
