import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { enabledModulesForCompany } from "../modules.js";

// Which add-on modules the caller's own company has. Every authenticated role can ask (a cleaner
// needs it to know whether her "Opplæring" tab exists at all) — it says nothing about any company
// but the caller's own, and the real access control is requireModule() on each module's routes.
export const modulesRouter = Router();

modulesRouter.get("/", requireAuth, (req, res) => {
  res.json(enabledModulesForCompany(req.user.company_id));
});
