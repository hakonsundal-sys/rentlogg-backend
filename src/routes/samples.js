// Mikrobiologisk prøvetaking: teamlederens egen kontroll, ved siden av etterkontrollen av
// renholderens arbeid. Bygget etter OKVs skjemaer BA001/BA002 og prøveplanen for Modesta Mat.
//
// Formen er hentet fra hvordan prøven faktisk tas, ikke fra hvordan resten av appen ser ut:
// Hygicult-prøven inkuberes ett døgn ved 37 °C, så den som leser av er ofte en annen enn den som
// tok den, dagen etter. Derfor er en runde to signaturer på to datoer, med tomme resultatfelt i
// mellomtiden — en tilstand ingen avkryssingsoppgave i et romkjør kan ha.
import { Router } from "express";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { todayInOslo } from "../services/schedule.js";

export const samplesRouter = Router();

// Grensene står trykt på OKVs eget skjema (BA002), lest etter Hygicults tabell. De ligger her i
// én konstant og ikke spredt i rutene, fordi de er en faglig terskel noen kommer til å justere:
// når de gjør det, skal det være ett sted.
export const TOTALKIM_BRA = 45;
export const TOTALKIM_MINDRE_BRA = 80;

// Hva et tall eller en hurtigtest betyr. `null` = ikke avlest ennå, som ikke er det samme som
// et godkjent resultat og aldri skal vises som grønt.
function verdictFor(point) {
  const deler = [];
  if (point.totalkim != null) {
    if (point.totalkim < TOTALKIM_BRA) deler.push({ felt: "totalkim", nivaa: "bra" });
    else if (point.totalkim <= TOTALKIM_MINDRE_BRA) deler.push({ felt: "totalkim", nivaa: "mindre_bra" });
    else deler.push({ felt: "totalkim", nivaa: "daarlig" });
  }
  // Påvisning er i seg selv ikke godkjent — det er ingen «litt E-coli».
  for (const felt of ["ecoli", "listeria"]) {
    if (point[felt]) deler.push({ felt, nivaa: point[felt] === "paavist" ? "daarlig" : "bra" });
  }
  if (deler.length === 0) return { verdict: null, parts: [] };
  const verst = deler.some((d) => d.nivaa === "daarlig")
    ? "daarlig"
    : deler.some((d) => d.nivaa === "mindre_bra")
      ? "mindre_bra"
      : "bra";
  return { verdict: verst, parts: deler };
}

const pointsFor = (roundId) =>
  db
    .prepare("SELECT * FROM sample_points WHERE round_id = ? ORDER BY sort_order, id")
    .all(roundId)
    .map((p) => ({ ...p, ...verdictFor(p) }));

function roundWithPoints(round) {
  const points = pointsFor(round.id);
  return {
    ...round,
    points,
    // «Ferdig» betyr avlest, ikke tatt: en runde uten avlesning er et åpent spørsmål, og det er
    // den tilstanden lista skal få teamlederen til å gjøre noe med.
    status: round.read_date ? "avlest" : "til_avlesning",
    worst: points.reduce((v, p) => (p.verdict === "daarlig" || v === "daarlig" ? "daarlig" : p.verdict === "mindre_bra" || v === "mindre_bra" ? "mindre_bra" : p.verdict ? "bra" : v), null),
  };
}

// Samme scoping-form som resten av appen: en runde hører til et firma, og ingen ser en annens.
// En kunde har ingenting her — dette er OKVs egen dokumentasjon av eget arbeid.
function scopedRound(id, user) {
  const round = db.prepare("SELECT * FROM sample_rounds WHERE id = ?").get(id);
  if (!round) return { error: { status: 404, body: { code: "not_found", error: "Not found" } } };
  if (round.company_id !== user.company_id) {
    return { error: { status: 403, body: { code: "not_allowed", error: "Not allowed" } } };
  }
  return { round };
}

function scopedSite(siteId, user) {
  const site = db.prepare("SELECT id, company_id, name FROM sites WHERE id = ?").get(siteId);
  if (!site || site.company_id !== user.company_id) return null;
  return site;
}

const erDato = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));

samplesRouter.get("/", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const siteId = Number(req.query.site_id) || null;
  const rounds = db
    .prepare(
      `SELECT r.*, s.name AS site_name FROM sample_rounds r
       JOIN sites s ON s.id = r.site_id
       WHERE r.company_id = ? ${siteId ? "AND r.site_id = ?" : ""}
       ORDER BY r.taken_date DESC, r.id DESC`
    )
    .all(...(siteId ? [req.user.company_id, siteId] : [req.user.company_id]))
    .map(roundWithPoints);
  res.json({ rounds });
});

samplesRouter.get("/:id", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { round, error } = scopedRound(req.params.id, req.user);
  if (error) return res.status(error.status).json(error.body);
  const site = db.prepare("SELECT name FROM sites WHERE id = ?").get(round.site_id);
  res.json({ ...roundWithPoints(round), site_name: site?.name || "" });
});

// Forrige runde på samme lokasjon, som utgangspunkt for neste. Prøveplanen sier at de faste
// punktene tas hver gang; å skrive dem inn på nytt for hånd hver tredje måned er den sikreste
// måten å få dem litt forskjellig hver gang.
samplesRouter.get("/suggest/:siteId", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const site = scopedSite(req.params.siteId, req.user);
  if (!site) return res.status(404).json({ code: "not_found", error: "Not found" });
  const forrige = db
    .prepare("SELECT * FROM sample_rounds WHERE site_id = ? ORDER BY taken_date DESC, id DESC LIMIT 1")
    .get(site.id);
  res.json({
    site_id: site.id,
    site_name: site.name,
    from_round: forrige?.id ?? null,
    from_date: forrige?.taken_date ?? null,
    points: forrige
      ? pointsFor(forrige.id).map((p) => ({ area: p.area, object: p.object }))
      : [],
  });
});

samplesRouter.post("/", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const site = scopedSite(req.body?.site_id, req.user);
  if (!site) return res.status(400).json({ code: "unknown_site", error: "Ukjent lokasjon" });

  const takenDate = req.body?.taken_date || todayInOslo();
  if (!erDato(takenDate)) return res.status(400).json({ code: "invalid_date", error: "Dato må være på formen 2026-10-31." });
  if (takenDate > todayInOslo()) return res.status(400).json({ code: "cannot_take_future", error: "Kan ikke registrere et uttak fram i tid." });

  const takenBy = String(req.body?.taken_by_name || "").trim();
  if (!takenBy) return res.status(400).json({ code: "taken_by_required", error: "Navn på den som tok prøvene er påkrevd." });

  const points = Array.isArray(req.body?.points) ? req.body.points : [];
  const rene = points
    .map((p) => ({ area: String(p?.area || "").trim() || null, object: String(p?.object || "").trim() }))
    .filter((p) => p.object);
  // En runde uten prøvepunkter dokumenterer ingenting, og ville stått i lista for alltid som noe
  // å lese av.
  if (rene.length === 0) return res.status(400).json({ code: "points_required", error: "Legg inn minst ett prøvepunkt." });

  const opprett = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO sample_rounds (company_id, site_id, taken_date, taken_by, taken_by_name, note)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(req.user.company_id, site.id, takenDate, req.user.id, takenBy, String(req.body?.note || "").trim() || null);
    const insertPoint = db.prepare(
      "INSERT INTO sample_points (round_id, sort_order, area, object) VALUES (?, ?, ?, ?)"
    );
    rene.forEach((p, i) => insertPoint.run(info.lastInsertRowid, i, p.area, p.object));
    return info.lastInsertRowid;
  });

  const id = opprett();
  res.status(201).json(roundWithPoints(db.prepare("SELECT * FROM sample_rounds WHERE id = ?").get(id)));
});

// Resultatet på ett punkt. Settes etter inkubering, ett felt eller flere om gangen.
samplesRouter.patch("/:id/points/:pointId", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { round, error } = scopedRound(req.params.id, req.user);
  if (error) return res.status(error.status).json(error.body);
  const point = db.prepare("SELECT * FROM sample_points WHERE id = ? AND round_id = ?").get(req.params.pointId, round.id);
  if (!point) return res.status(404).json({ code: "not_found", error: "Not found" });

  const tall = (raw) => {
    if (raw === null || raw === "") return { value: null };
    const n = typeof raw === "number" ? raw : Number(String(raw).replace(",", "."));
    if (!Number.isFinite(n) || n < 0) return { error: true };
    return { value: n };
  };

  const sett = [];
  const verdier = [];
  for (const felt of ["totalkim", "atp"]) {
    if (felt in req.body) {
      const { value, error: feil } = tall(req.body[felt]);
      if (feil) return res.status(400).json({ code: "invalid_number", error: "Måleverdien må være et tall som ikke er negativt." });
      sett.push(`${felt} = ?`);
      verdier.push(value);
    }
  }
  for (const felt of ["ecoli", "listeria"]) {
    if (felt in req.body) {
      const v = req.body[felt] === null || req.body[felt] === "" ? null : String(req.body[felt]);
      if (v !== null && v !== "paavist" && v !== "ikke_paavist") {
        return res.status(400).json({ code: "invalid_result", error: "Resultatet må være påvist eller ikke påvist." });
      }
      sett.push(`${felt} = ?`);
      verdier.push(v);
    }
  }
  if ("comment" in req.body) {
    sett.push("comment = ?");
    verdier.push(String(req.body.comment || "").trim() || null);
  }
  if ("area" in req.body) { sett.push("area = ?"); verdier.push(String(req.body.area || "").trim() || null); }
  if ("object" in req.body) {
    const o = String(req.body.object || "").trim();
    if (!o) return res.status(400).json({ code: "object_required", error: "Prøvepunktet må ha et navn." });
    sett.push("object = ?");
    verdier.push(o);
  }
  if (sett.length === 0) return res.status(400).json({ code: "no_valid_fields", error: "Ingen felter å oppdatere." });

  db.prepare(`UPDATE sample_points SET ${sett.join(", ")} WHERE id = ?`).run(...verdier, point.id);
  res.json(roundWithPoints(db.prepare("SELECT * FROM sample_rounds WHERE id = ?").get(round.id)));
});

// Avlesningen: den andre signaturen, og den som gjør runden ferdig.
samplesRouter.post("/:id/read", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { round, error } = scopedRound(req.params.id, req.user);
  if (error) return res.status(error.status).json(error.body);

  const readBy = String(req.body?.read_by_name || "").trim();
  if (!readBy) return res.status(400).json({ code: "read_by_required", error: "Navn på den som leste av er påkrevd." });
  const readDate = req.body?.read_date || todayInOslo();
  if (!erDato(readDate)) return res.status(400).json({ code: "invalid_date", error: "Dato må være på formen 2026-10-31." });
  // En prøve kan ikke være avlest før den ble tatt, og inkuberingen tar et døgn — men datoen
  // sjekkes bare mot uttaket, ikke mot døgnet: en runde avlest samme kveld er feilregistrert,
  // ikke umulig, og det er ikke appens jobb å nekte en rettelse.
  if (readDate < round.taken_date) {
    return res.status(400).json({ code: "read_before_taken", error: "Avlesningen kan ikke være før uttaket." });
  }

  // Hvert punkt må ha minst ett resultat. Uten dette kunne runden signeres som avlest med tomme
  // felter — nøyaktig den påstanden signaturen er ment å dekke.
  const uavleste = pointsFor(round.id).filter((p) => p.verdict === null);
  if (uavleste.length > 0) {
    return res.status(409).json({
      code: "results_missing",
      error: `Mangler resultat på ${uavleste.length} prøvepunkt: ${uavleste.map((p) => p.object).join(", ")}`,
    });
  }

  db.prepare("UPDATE sample_rounds SET read_date = ?, read_by = ?, read_by_name = ? WHERE id = ?")
    .run(readDate, req.user.id, readBy, round.id);
  res.json(roundWithPoints(db.prepare("SELECT * FROM sample_rounds WHERE id = ?").get(round.id)));
});

// Trenden for ett prøvepunkt: samme objekt over tid, som er det samleskjemaets trend-ark er til.
samplesRouter.get("/trend/:siteId", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const site = scopedSite(req.params.siteId, req.user);
  if (!site) return res.status(404).json({ code: "not_found", error: "Not found" });
  const rader = db
    .prepare(
      `SELECT p.object, p.area, r.taken_date, p.totalkim, p.atp, p.ecoli, p.listeria
       FROM sample_points p JOIN sample_rounds r ON r.id = p.round_id
       WHERE r.site_id = ? AND r.read_date IS NOT NULL
       ORDER BY p.object, r.taken_date`
    )
    .all(site.id);
  const perPunkt = new Map();
  for (const rad of rader) {
    if (!perPunkt.has(rad.object)) perPunkt.set(rad.object, { object: rad.object, area: rad.area, samples: [] });
    perPunkt.get(rad.object).samples.push({ ...rad, ...verdictFor(rad) });
  }
  res.json({ site_id: site.id, site_name: site.name, points: [...perPunkt.values()] });
});

samplesRouter.delete("/:id", requireAuth, requireRole("admin"), (req, res) => {
  const { round, error } = scopedRound(req.params.id, req.user);
  if (error) return res.status(error.status).json(error.body);
  if (round.read_date) {
    return res.status(409).json({ code: "round_read", error: "En avlest runde er dokumentasjon og kan ikke slettes." });
  }
  db.prepare("DELETE FROM sample_points WHERE round_id = ?").run(round.id);
  db.prepare("DELETE FROM sample_rounds WHERE id = ?").run(round.id);
  res.json({ ok: true });
});
