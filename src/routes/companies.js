import { Router } from "express";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { isKnownModule, modulesWithStatus, setModuleEnabled } from "../modules.js";

export const companiesRouter = Router();

// super_admin-only: managing companies (tenants) is Rentlogg's own operator surface, not
// anything a company's own admin/manager touches.
companiesRouter.get("/", requireAuth, requireRole("super_admin"), (req, res) => {
  const companies = db.prepare("SELECT * FROM companies ORDER BY name").all();
  // Every company carries its full module list (each with its own on/off), not just the enabled
  // keys — "Firmaer" renders one checkbox per known module per row, so it needs the off ones too.
  res.json(companies.map((c) => ({ ...c, modules: modulesWithStatus(c.id) })));
});

// Turns one add-on module on or off for one company. The only way a module's state ever changes:
// a company's own admin can't buy or enable one from inside the product (deliberate for now —
// everything is sold directly), so there's no company-facing counterpart to this route.
companiesRouter.patch("/:id/modules", requireAuth, requireRole("super_admin"), (req, res) => {
  const { module_key, enabled } = req.body;
  const company = db.prepare("SELECT id FROM companies WHERE id = ?").get(req.params.id);
  if (!company) return res.status(404).json({ code: "not_found", error: "Not found" });
  if (!isKnownModule(module_key)) {
    return res.status(400).json({ code: "unknown_module", error: "Ukjent modul." });
  }
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ code: "enabled_required", error: "enabled må være true eller false" });
  }

  setModuleEnabled(company.id, module_key, enabled, req.user.id);
  res.json({ id: company.id, modules: modulesWithStatus(company.id) });
});

// Renaming a tenant. The name is display-only — every relation in the app hangs off company_id,
// and nothing in reports, exports, e-mail or QR codes reads it — so this is a one-column update
// rather than the migration it sounds like. It exists because OKV Gruppen turned out to be the
// wrong legal entity on paperwork the customer sees, and there was no way to correct it at all.
companiesRouter.patch("/:id", requireAuth, requireRole("super_admin"), (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name) return res.status(400).json({ code: "name_required", error: "name er påkrevd" });
  const company = db.prepare("SELECT id FROM companies WHERE id = ?").get(req.params.id);
  if (!company) return res.status(404).json({ code: "not_found", error: "Not found" });
  // Two tenants sharing a name is not a data error the schema stops, but it makes every
  // super_admin list ambiguous — and seed.js still finds a company by name.
  const clash = db
    .prepare("SELECT id FROM companies WHERE name = ? COLLATE NOCASE AND id != ?")
    .get(name, company.id);
  if (clash) return res.status(409).json({ code: "company_name_taken", error: "Et annet firma heter allerede dette." });

  db.prepare("UPDATE companies SET name = ? WHERE id = ?").run(name, company.id);
  res.json({ id: company.id, name, modules: modulesWithStatus(company.id) });
});

companiesRouter.post("/", requireAuth, requireRole("super_admin"), (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ code: "name_required", error: "name er påkrevd" });
  const info = db.prepare("INSERT INTO companies (name) VALUES (?)").run(name.trim());
  res.status(201).json({ id: info.lastInsertRowid, name: name.trim() });
});

// Profilen et firma kan sette sitt eget preg på. Se kommentaren på companies i db.js for
// hvorfor det bare er én kulør, og hvorfor logoen er en data-URI og ikke en fil.
//
// super_admin-only, som resten av denne ruteren: white-label er noe Rentlogg slår på for en
// kunde, ikke noe kunden endrer selv — en admin som skrur om på sin egen logo midt i en
// arbeidsdag er en supportsak, ikke en funksjon.

// 150 kB. En logo som er større enn dette er et fotografi, ikke en logo, og den skal ikke
// sendes med hver /branding-forespørsel. Grensen gjelder den ferdige data-URI-en, altså etter
// base64 — det er den strengen som faktisk går over nettet.
const MAX_LOGO_CHARS = 150 * 1024;

const ALLOWED_LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];

function readBranding(body) {
  const out = {};

  if ("brand_color" in body) {
    const raw = typeof body.brand_color === "string" ? body.brand_color.trim() : "";
    if (!raw) {
      out.brand_color = null;
    } else if (!/^#[0-9a-fA-F]{6}$/.test(raw)) {
      // Kun 6-sifret hex. Appen setter denne rett inn i en CSS-variabel, og en vilkårlig streng
      // der er et injeksjonspunkt — `red; } body { display:none } .x {` er en gyldig «farge»
      // for en naiv validator.
      return { error: { code: "brand_color_invalid", error: "Fargen må være på formen #1e2a38." } };
    } else {
      out.brand_color = raw.toLowerCase();
    }
  }

  if ("logo_data_url" in body) {
    const raw = typeof body.logo_data_url === "string" ? body.logo_data_url.trim() : "";
    if (!raw) {
      out.logo_data_url = null;
    } else {
      const m = /^data:([a-z+/-]+);base64,([A-Za-z0-9+/=]+)$/.exec(raw);
      if (!m) {
        return { error: { code: "logo_invalid", error: "Logoen må være en base64 data-URI." } };
      }
      if (!ALLOWED_LOGO_TYPES.includes(m[1])) {
        return { error: { code: "logo_type_invalid", error: "Logoen må være PNG, JPG, WEBP eller SVG." } };
      }
      if (raw.length > MAX_LOGO_CHARS) {
        return { error: { code: "logo_too_large", error: "Logoen er for stor. Maks 150 kB." } };
      }
      out.logo_data_url = raw;
    }
  }

  if ("custom_domain" in body) {
    const raw = typeof body.custom_domain === "string" ? body.custom_domain.trim().toLowerCase() : "";
    if (!raw) {
      out.custom_domain = null;
    } else if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(raw)) {
      return { error: { code: "domain_invalid", error: "Oppgi bare verten, f.eks. rent.okv-gruppen.no." } };
    } else {
      out.custom_domain = raw;
    }
  }

  return out;
}

companiesRouter.patch("/:id/branding", requireAuth, requireRole("super_admin"), (req, res) => {
  const company = db.prepare("SELECT * FROM companies WHERE id = ?").get(req.params.id);
  if (!company) return res.status(404).json({ code: "not_found", error: "Not found" });

  const fields = readBranding(req.body || {});
  if (fields.error) return res.status(400).json(fields.error);

  // To firmaer på samme vert ville gjort /branding tvetydig, og den ruta velger hvilket
  // firmas logo en innloggingsside viser.
  if (fields.custom_domain) {
    const clash = db
      .prepare("SELECT id FROM companies WHERE custom_domain = ? AND id != ?")
      .get(fields.custom_domain, company.id);
    if (clash) return res.status(409).json({ code: "domain_taken", error: "Domenet er allerede i bruk av et annet firma." });
  }

  const keys = Object.keys(fields);
  if (keys.length === 0) return res.status(400).json({ code: "nothing_to_update", error: "Ingenting å endre." });

  db.prepare(`UPDATE companies SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), company.id);

  res.json(db.prepare("SELECT id, name, brand_color, logo_data_url, custom_domain FROM companies WHERE id = ?").get(company.id));
});
