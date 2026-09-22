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

companiesRouter.post("/", requireAuth, requireRole("super_admin"), (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ code: "name_required", error: "name er påkrevd" });
  const info = db.prepare("INSERT INTO companies (name) VALUES (?)").run(name.trim());
  res.status(201).json({ id: info.lastInsertRowid, name: name.trim() });
});
