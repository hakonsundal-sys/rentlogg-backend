import { Router } from "express";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

// Kjemikalieregisteret: ett sett midler per bedrift, som flervalg-alternativer kan peke på.
// Se chemicals-tabellen i schema.sql for hvorfor det er per bedrift og ikke per lokasjon.
//
// Scoping følger samme form som resten av systemet (se feedback_engineering_conventions): en
// `customer` har ingenting her å gjøre — registeret er renholdsbedriftens eget oppsett — så
// rutene er låst til admin/manager, og hver spørring filtrerer i tillegg på company_id.
export const chemicalsRouter = Router();

function companyScope(user) {
  // super_admin eier ingen bedrift og dermed ingen kjemikalier. Å la den lese på tvers ville
  // vært det ene stedet i systemet der en global rolle plutselig ser andres driftsdata.
  return user.company_id ?? null;
}

chemicalsRouter.get("/", requireAuth, requireRole("admin", "manager", "cleaner"), (req, res) => {
  const companyId = companyScope(req.user);
  if (!companyId) return res.json([]);
  res.json(
    db.prepare("SELECT * FROM chemicals WHERE company_id = ? ORDER BY name COLLATE NOCASE").all(companyId)
  );
});

function readBody(body) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { error: { code: "chemical_name_required", error: "Navn er påkrevd." } };

  let seconds = null;
  if (body.contact_seconds !== null && body.contact_seconds !== undefined && body.contact_seconds !== "") {
    const n = Number(body.contact_seconds);
    if (!Number.isFinite(n) || n < 0 || n > 14400) {
      return { error: { code: "contact_seconds_invalid", error: "Kontakttiden må være mellom 0 og 4 timer." } };
    }
    seconds = Math.round(n) || null;
  }

  // Bare http(s). Et sikkerhetsdatablad er en lenke renholderen trykker på med hansker; en
  // javascript:- eller data:-URL her ville vært et åpent hull rett inn i appen deres.
  const rawUrl = typeof body.sds_url === "string" ? body.sds_url.trim() : "";
  let sdsUrl = null;
  if (rawUrl) {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return { error: { code: "sds_url_invalid", error: "Lenken til sikkerhetsdatablad må være en gyldig nettadresse." } };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { error: { code: "sds_url_invalid", error: "Lenken må begynne med http:// eller https://." } };
    }
    sdsUrl = parsed.href;
  }

  return {
    name,
    strength: typeof body.strength === "string" ? body.strength.trim() || null : null,
    contact_seconds: seconds,
    safety_note: typeof body.safety_note === "string" ? body.safety_note.trim() || null : null,
    sds_url: sdsUrl,
  };
}

chemicalsRouter.post("/", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const companyId = companyScope(req.user);
  if (!companyId) return res.status(403).json({ code: "no_company", error: "Ingen bedrift." });

  const c = readBody(req.body);
  if (c.error) return res.status(400).json(c.error);

  const info = db
    .prepare(
      `INSERT INTO chemicals (company_id, name, strength, contact_seconds, safety_note, sds_url)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(companyId, c.name, c.strength, c.contact_seconds, c.safety_note, c.sds_url);
  res.status(201).json(db.prepare("SELECT * FROM chemicals WHERE id = ?").get(info.lastInsertRowid));
});

chemicalsRouter.patch("/:id", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const companyId = companyScope(req.user);
  const existing = db.prepare("SELECT * FROM chemicals WHERE id = ?").get(req.params.id);
  if (!existing || existing.company_id !== companyId) {
    return res.status(404).json({ code: "not_found", error: "Fant ikke kjemikaliet." });
  }

  const c = readBody(req.body);
  if (c.error) return res.status(400).json(c.error);

  db.prepare(
    `UPDATE chemicals SET name = ?, strength = ?, contact_seconds = ?, safety_note = ?, sds_url = ?
     WHERE id = ?`
  ).run(c.name, c.strength, c.contact_seconds, c.safety_note, c.sds_url, req.params.id);
  res.json(db.prepare("SELECT * FROM chemicals WHERE id = ?").get(req.params.id));
});

chemicalsRouter.delete("/:id", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const companyId = companyScope(req.user);
  const existing = db.prepare("SELECT * FROM chemicals WHERE id = ?").get(req.params.id);
  if (!existing || existing.company_id !== companyId) {
    return res.status(404).json({ code: "not_found", error: "Fant ikke kjemikaliet." });
  }

  // Alternativer som peker hit mister lenken, men beholder sin egen tekst — nøyaktig samme
  // behandling som en slettet oppgave får i rooms.js, og av samme grunn: historikken skal ikke
  // rives ned fordi noen rydder i registeret. Allerede utførte besøk har uansett sin egen kopi
  // av navn, styrke og sikkerhetsnotat.
  db.transaction(() => {
    db.prepare("UPDATE room_checklist_item_options SET chemical_id = NULL WHERE chemical_id = ?").run(req.params.id);
    db.prepare("DELETE FROM chemicals WHERE id = ?").run(req.params.id);
  })();
  res.json({ ok: true });
});
