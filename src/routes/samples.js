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
import { logQualityEvent } from "../services/qualityLog.js";

export const samplesRouter = Router();

// Grensene står trykt på OKVs eget skjema (BA002), lest etter Hygicults tabell. De ligger her i
// én konstant og ikke spredt i rutene, fordi de er en faglig terskel noen kommer til å justere:
// når de gjør det, skal det være ett sted.
export const TOTALKIM_BRA = 45;
export const TOTALKIM_MINDRE_BRA = 80;

// Sendes med hver liste, så en flate kan tegne en skala mot de samme tallene uten å skrive dem
// av. Skriver noen dem av likevel, er det den kopien som blir stående når terskelen justeres.
const GRENSER = { totalkim_bra: TOTALKIM_BRA, totalkim_mindre_bra: TOTALKIM_MINDRE_BRA };

// Hva et tall eller en hurtigtest betyr. `null` = ikke avlest ennå, som ikke er det samme som
// et godkjent resultat og aldri skal vises som grønt.
// Grensene punktet faktisk bedømmes mot: punktets egne hvis de er satt, ellers skjemaets
// standard for totalkim. ATP har ingen standard — Hygicult-tabellen er en totalkim-skala, og et
// RLU-tall fra et luminometer har ingen bransjefasit å falle tilbake på. Står atp_max tom, blir
// ATP derfor lagret og ikke vurdert, som før.
export function limitsFor(point) {
  return {
    totalkim_bra: point.totalkim_bra ?? TOTALKIM_BRA,
    totalkim_mindre_bra: point.totalkim_mindre_bra ?? TOTALKIM_MINDRE_BRA,
    atp_max: point.atp_max ?? null,
  };
}

function verdictFor(point) {
  const deler = [];
  const g = limitsFor(point);
  if (point.totalkim != null) {
    if (point.totalkim < g.totalkim_bra) deler.push({ felt: "totalkim", nivaa: "bra" });
    else if (point.totalkim <= g.totalkim_mindre_bra) deler.push({ felt: "totalkim", nivaa: "mindre_bra" });
    else deler.push({ felt: "totalkim", nivaa: "daarlig" });
  }
  // ATP bedømmes bare når punktet har en grense. Uten den ville et hvilket som helst tall blitt
  // grønt, og «innenfor» ville betydd «ingen sjekket det».
  if (point.atp != null && g.atp_max != null) {
    deler.push({ felt: "atp", nivaa: point.atp <= g.atp_max ? "bra" : "daarlig" });
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

// `limits` sendes med hvert punkt, ferdig utledet, så en flate aldri trenger å vite hvilken
// verdi som var punktets egen og hvilken som falt tilbake på skjemaets standard — den tegner
// bare mot tallene den får. Samme grunn som at grensene i det hele tatt ligger ett sted.
const pointsFor = (roundId) =>
  db
    .prepare("SELECT * FROM sample_points WHERE round_id = ? ORDER BY sort_order, id")
    .all(roundId)
    .map((p) => ({ ...p, ...verdictFor(p), limits: limitsFor(p) }));

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

// Samme scoping-form som resten av appen, jf. getRoomRunScoped i routes/rooms.js:
//
//   user.role === "customer" ? resource.client_id === user.client_id : resource.company_id === user.company_id
//
// Opprinnelig sto det her at «en kunde har ingenting her — dette er OKVs egen dokumentasjon av
// eget arbeid», og det var riktig for det modulen den gang gjorde. Det som kom til er en annen
// ting med samme form: kundens egen verifisering av arbeidet OKV har gjort. Derfor er ikke
// kunden sluppet inn i OKVs runder — hun ser bare sine egne, via performed_by.
//
// Lokasjonen bærer både company_id og client_id, så begge grenene leses derfra; sample_rounds
// har bare company_id, og en kunde skal uansett aldri scopes på firma.
function scopedRound(id, user) {
  const round = db
    .prepare(
      `SELECT r.*, s.client_id AS site_client_id, s.company_id AS site_company_id
       FROM sample_rounds r JOIN sites s ON s.id = r.site_id WHERE r.id = ?`
    )
    .get(id);
  if (!round) return { error: { status: 404, body: { code: "not_found", error: "Not found" } } };
  const forbidden = { error: { status: 403, body: { code: "not_allowed", error: "Not allowed" } } };
  if (user.role === "customer") {
    // To betingelser, ikke én: riktig kunde OG kundens egen runde. Uten den andre ville en kunde
    // kunne lese OKVs interne prøveplan for sin egen lokasjon ved å gjette en id.
    if (round.site_client_id !== user.client_id) return forbidden;
    if (round.performed_by !== "customer") return forbidden;
  } else if (round.site_company_id !== user.company_id) {
    return forbidden;
  }
  return { round };
}

function scopedSite(siteId, user) {
  const site = db.prepare("SELECT id, company_id, client_id, name FROM sites WHERE id = ?").get(siteId);
  if (!site) return null;
  if (user.role === "customer") return site.client_id === user.client_id ? site : null;
  return site.company_id === user.company_id ? site : null;
}

// Hvem runden tilhører, utledet av rollen og aldri lest fra request-kroppen: en kunde kan ikke
// registrere en runde i OKVs navn, og en ansatt kan ikke registrere en i kundens.
function performedByFor(user) {
  return user.role === "customer" ? "customer" : "company";
}

// Rollene som får se og føre prøverunder. Kunden er med fordi hennes egen verifisering er en
// prøverunde med samme form; hva hun faktisk når, avgjøres av scopedRound/scopedSite over.
const SAMPLE_ROLES = ["admin", "manager", "customer"];

const erDato = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));

samplesRouter.get("/", requireAuth, requireRole(...SAMPLE_ROLES), (req, res) => {
  const siteId = Number(req.query.site_id) || null;
  // Staben ser begge slag på egne lokasjoner — at kundens egen kontroll kom tilbake ren, og
  // særlig at den ikke gjorde det, er nettopp det OKV trenger å vite. `performed_by` følger med
  // i raden, så lista kan merke hvem som tok runden. Kunden ser bare sine egne.
  const erKunde = req.user.role === "customer";
  const where = erKunde
    ? "s.client_id = ? AND r.performed_by = 'customer'"
    : "s.company_id = ?";
  const args = [erKunde ? req.user.client_id : req.user.company_id];
  if (siteId) args.push(siteId);
  const rounds = db
    .prepare(
      `SELECT r.*, s.name AS site_name FROM sample_rounds r
       JOIN sites s ON s.id = r.site_id
       WHERE ${where} ${siteId ? "AND r.site_id = ?" : ""}
       ORDER BY r.taken_date DESC, r.id DESC`
    )
    .all(...args)
    .map(roundWithPoints);
  res.json({ rounds, limits: GRENSER });
});

samplesRouter.get("/:id", requireAuth, requireRole(...SAMPLE_ROLES), (req, res) => {
  const { round, error } = scopedRound(req.params.id, req.user);
  if (error) return res.status(error.status).json(error.body);
  const site = db.prepare("SELECT name FROM sites WHERE id = ?").get(round.site_id);
  res.json({ ...roundWithPoints(round), site_name: site?.name || "" });
});

// Forrige runde på samme lokasjon, som utgangspunkt for neste. Prøveplanen sier at de faste
// punktene tas hver gang; å skrive dem inn på nytt for hånd hver tredje måned er den sikreste
// måten å få dem litt forskjellig hver gang.
samplesRouter.get("/suggest/:siteId", requireAuth, requireRole(...SAMPLE_ROLES), (req, res) => {
  const site = scopedSite(req.params.siteId, req.user);
  if (!site) return res.status(404).json({ code: "not_found", error: "Not found" });
  // Forslaget hentes fra forrige runde av samme slag: en kunde skal få sine egne punkter igjen,
  // ikke OKVs prøveplan servert som utgangspunkt gjennom bakdøra.
  const forrige = db
    .prepare(
      "SELECT * FROM sample_rounds WHERE site_id = ? AND performed_by = ? ORDER BY taken_date DESC, id DESC LIMIT 1"
    )
    .get(site.id, performedByFor(req.user));
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

samplesRouter.post("/", requireAuth, requireRole(...SAMPLE_ROLES), (req, res) => {
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
        `INSERT INTO sample_rounds (company_id, site_id, taken_date, taken_by, taken_by_name, note, performed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      // company_id leses fra lokasjonen, ikke fra brukeren: en kundebruker hører til firmaet som
      // har henne som kunde, men runden skal uansett eie samme firma som lokasjonen gjør, og det
      // er lokasjonen som nettopp ble scopet.
      .run(
        site.company_id, site.id, takenDate, req.user.id, takenBy,
        String(req.body?.note || "").trim() || null, performedByFor(req.user)
      );
    // Grensene arves fra forrige gang samme objekt ble prøvetatt på samme lokasjon, og leses
    // ALDRI fra request-kroppen: det er kunden som oppretter sine egne runder, og grensen avgjør
    // når OKV får et avvik mot seg. Kom den inn med kallet, kunne hun satt sin egen strykgrense
    // for leverandøren. Admin endrer den etterpå med PATCH på punktet.
    //
    // Et objekt som aldri er prøvetatt før arver ingenting og står uten grense til admin setter
    // en. Det er en ærlig tilstand: ATP blir da lagret uten vurdering, i stedet for å bli grønn
    // fordi ingen hadde sagt hva som er grønt.
    const forrigeGrense = db.prepare(
      `SELECT p.totalkim_bra, p.totalkim_mindre_bra, p.atp_max
       FROM sample_points p JOIN sample_rounds r ON r.id = p.round_id
       WHERE r.site_id = ? AND p.object = ?
         AND (p.totalkim_bra IS NOT NULL OR p.totalkim_mindre_bra IS NOT NULL OR p.atp_max IS NOT NULL)
       ORDER BY r.taken_date DESC, p.id DESC LIMIT 1`
    );
    const insertPoint = db.prepare(
      `INSERT INTO sample_points (round_id, sort_order, area, object, totalkim_bra, totalkim_mindre_bra, atp_max)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    rene.forEach((p, i) => {
      const g = forrigeGrense.get(site.id, p.object) || {};
      insertPoint.run(
        info.lastInsertRowid, i, p.area, p.object,
        g.totalkim_bra ?? null, g.totalkim_mindre_bra ?? null, g.atp_max ?? null
      );
    });
    return info.lastInsertRowid;
  });

  const id = opprett();
  res.status(201).json(roundWithPoints(db.prepare("SELECT * FROM sample_rounds WHERE id = ?").get(id)));
});

// Resultatet på ett punkt. Settes etter inkubering, ett felt eller flere om gangen.
samplesRouter.patch("/:id/points/:pointId", requireAuth, requireRole(...SAMPLE_ROLES), (req, res) => {
  const { round, error } = scopedRound(req.params.id, req.user);
  if (error) return res.status(error.status).json(error.body);
  const point = db.prepare("SELECT * FROM sample_points WHERE id = ? AND round_id = ?").get(req.params.pointId, round.id);
  if (!point) return res.status(404).json({ code: "not_found", error: "Not found" });
  // Signaturen på avlesningen sier «dette er resultatene jeg leste». Lot vi tallet endres
  // etterpå, ville den påstanden ikke vært verdt noe — og endringen ville ikke etterlatt seg
  // spor noe sted. Skjemaet i appen låser feltene allerede; dette er den som faktisk holder.
  // Samme regel som at en avlest runde ikke kan slettes.
  if (round.read_date) {
    return res.status(409).json({ code: "round_read", error: "Runden er avlest og signert. Resultatene kan ikke endres." });
  }

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
  // Grenseverdiene. Bare admin/driftsleder: grensen avgjør når OKV får et avvik mot seg, og den
  // som skal stryke bestemmer ikke strykgrensen. En kunde ser dem (de følger med hvert punkt som
  // `limits`), men et forsøk på å sette dem avvises — ikke stilltiende ignoreres, for da ville
  // flaten hennes kunne vise en grense som aldri ble lagret.
  const GRENSEFELT = ["totalkim_bra", "totalkim_mindre_bra", "atp_max"];
  if (GRENSEFELT.some((f) => f in req.body) && req.user.role === "customer") {
    return res.status(403).json({
      code: "limits_staff_only",
      error: "Grenseverdier settes av renholdsselskapet.",
    });
  }
  for (const felt of GRENSEFELT) {
    if (felt in req.body) {
      const { value, error: feil } = tall(req.body[felt]);
      if (feil) return res.status(400).json({ code: "invalid_number", error: "Grenseverdien må være et tall som ikke er negativt." });
      sett.push(`${felt} = ?`);
      verdier.push(value);
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
samplesRouter.post("/:id/read", requireAuth, requireRole(...SAMPLE_ROLES), (req, res) => {
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

  // Et dårlig funn i kundens egen kontroll blir en avvikssak, på samme måte som et kritisk punkt
  // i etterkontrollen gjør det (se POST /runs/:runId/control i routes/rooms.js). Begrunnelsen er
  // den samme: kontrollen SKAL skape avviket, ikke bare registrere det — et påvist listeria-funn
  // som blir liggende som et tall i et skjema er underrapportering.
  //
  // Bare for kundens runder. OKVs egne runder er teamlederens verktøy, og avviket der opprettes
  // av etterkontrollen; å lage et til herfra ville gitt to saker på samme funn.
  //
  // `room_id` står tomt med vilje: et prøvepunkt er «Håndtak kjølerom 1 og 2», et punkt på et
  // objekt og ikke et rom i vaskeplanen (se sample_points i schema.sql) — å gjette et rom ut av
  // det ville vært å finne på en kobling. `sample_point_id` er den ekte: den peker på punktet
  // funnet faktisk kom fra, så «dette punktet har sviktet tre ganger» er et spørsmål basen kan
  // svare på. Objektnavnet blir stående i room_task_label i tillegg, fordi det er det lesbare
  // feltet avvikslista allerede viser.
  const daarlige = pointsFor(round.id).filter((p) => p.verdict === "daarlig");
  const insertDeviation = db.prepare(
    `INSERT INTO deviations (site_id, sample_point_id, room_task_label, reported_by, reported_by_initials,
                             title, description, priority, category)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'high', 'kvalitet')`
  );

  db.transaction(() => {
    db.prepare("UPDATE sample_rounds SET read_date = ?, read_by = ?, read_by_name = ? WHERE id = ?")
      .run(readDate, req.user.id, readBy, round.id);

    if (round.performed_by === "customer") {
      for (const punkt of daarlige) {
        // Hvert felt forklares med tallet OG grensen det strøk mot — «ATP 47» alene sier ingenting
        // til den som leser avviket tre uker senere og ikke husker hva som var kravet.
        const hva = punkt.parts
          .filter((d) => d.nivaa === "daarlig")
          .map((d) => {
            if (d.felt === "totalkim") return `totalkim ${punkt.totalkim} (grense ${punkt.limits.totalkim_mindre_bra})`;
            if (d.felt === "atp") return `ATP ${punkt.atp} (grense ${punkt.limits.atp_max})`;
            return `${d.felt === "ecoli" ? "E-coli" : d.felt} påvist`;
          })
          .join(", ");
        insertDeviation.run(
          round.site_id,
          punkt.id,
          punkt.object,
          req.user.id,
          readBy,
          `Prøveresultat utenfor krav: ${punkt.object}`,
          `Kundens egen prøvetaking ${round.taken_date}, avlest ${readDate}: ${hva}.` +
            `${punkt.area ? ` Lokale: ${punkt.area}.` : ""}${punkt.comment ? ` Kommentar: ${punkt.comment}` : ""}`
        );
      }
    }
  })();

  res.json({
    ...roundWithPoints(db.prepare("SELECT * FROM sample_rounds WHERE id = ?").get(round.id)),
    // Så flaten kan si «2 avvik opprettet» i stedet for å la dem dukke opp uforklart i avvikslista.
    deviationsCreated: round.performed_by === "customer" ? daarlige.length : 0,
  });
});

// Trenden for ett prøvepunkt: samme objekt over tid, som er det samleskjemaets trend-ark er til.
samplesRouter.get("/trend/:siteId", requireAuth, requireRole(...SAMPLE_ROLES), (req, res) => {
  const site = scopedSite(req.params.siteId, req.user);
  if (!site) return res.status(404).json({ code: "not_found", error: "Not found" });
  const rader = db
    .prepare(
      `SELECT p.object, p.area, r.taken_date, p.totalkim, p.atp, p.ecoli, p.listeria,
              p.totalkim_bra, p.totalkim_mindre_bra, p.atp_max
       FROM sample_points p JOIN sample_rounds r ON r.id = p.round_id
       WHERE r.site_id = ? AND r.read_date IS NOT NULL AND (? = 0 OR r.performed_by = 'customer')
       ORDER BY p.object, r.taken_date`
    )
    // Staben får trenden på tvers av begge slag, som er den de faktisk trenger — to kurver for
    // samme punkt, tatt av hver sin part, er det nærmeste systemet kommer en fasit. Kunden får
    // bare sin egen, samme grense som alt annet hun ser her.
    .all(site.id, req.user.role === "customer" ? 1 : 0);
  const perPunkt = new Map();
  for (const rad of rader) {
    if (!perPunkt.has(rad.object)) {
      // Grensene objektet bedømmes mot i dag, sendt med serien. Uten dem er en trendkurve bare
      // en tallrekke: 47 betyr ingenting før man vet at kravet var 30. De leses fra den NYESTE
      // raden for objektet (radene er sortert stigende på dato, så siste vinner) — ikke fra hver
      // enkelt måling, fordi grenselinjen i grafen er én linje. Hver måling beholder samtidig
      // sin egen `verdict`, regnet mot grensen som gjaldt DA den ble avlest, så et punkt kan
      // ligge under dagens linje og likevel stå som dårlig. Det er riktig: dommen felles én
      // gang, ved avlesningen, og skrives ikke om når grensen justeres.
      perPunkt.set(rad.object, { object: rad.object, area: rad.area, limits: limitsFor(rad), samples: [] });
    }
    const p = perPunkt.get(rad.object);
    p.limits = limitsFor(rad);
    p.samples.push({ ...rad, ...verdictFor(rad) });
  }
  res.json({ site_id: site.id, site_name: site.name, points: [...perPunkt.values()] });
});

// Gjenåpning av en signert runde. Admin, ikke driftsleder: å avlese er en del av jobben, å
// oppheve en signatur er det ikke.
//
// Hele poenget er sporet. Resultatene slik de sto da det ble signert skrives inn i
// kvalitetsloggen FØR de kan endres, i samme transaksjon som gjenåpningen — klarer ikke loggen
// å skrive, skjer heller ikke gjenåpningen (se services/qualityLog.js om hvorfor den ikke
// svelger feil). Uten dette ville «gjenåpne, rett tallet, signer igjen» sett nøyaktig ut som en
// runde som ble riktig første gang.
samplesRouter.post("/:id/reopen", requireAuth, requireRole("admin"), (req, res) => {
  const { round, error } = scopedRound(req.params.id, req.user);
  if (error) return res.status(error.status).json(error.body);
  if (!round.read_date) {
    return res.status(409).json({ code: "round_not_read", error: "Runden er ikke avlest, så det er ingenting å gjenåpne." });
  }
  // En begrunnelse er ikke høflighet — den er grunnen til at sporet er verdt noe. Uten den
  // forteller loggen at noen opphevet en signatur, men ikke hvorfor, og det er det neste
  // spørsmålet uansett hvem som leser.
  const reason = String(req.body?.reason || "").trim();
  if (reason.length < 3) {
    return res.status(400).json({ code: "reason_required", error: "Skriv hvorfor runden gjenåpnes." });
  }

  const signert = pointsFor(round.id)
    .map((p) => {
      const deler = [];
      if (p.totalkim != null) deler.push(`totalkim ${p.totalkim}`);
      if (p.atp != null) deler.push(`ATP ${p.atp}`);
      if (p.ecoli) deler.push(`E-coli ${p.ecoli === "paavist" ? "påvist" : "ikke påvist"}`);
      if (p.listeria) deler.push(`listeria ${p.listeria === "paavist" ? "påvist" : "ikke påvist"}`);
      return `${p.object}: ${deler.join(", ") || "ingen resultater"}`;
    })
    .join(" | ");

  const gjenapne = db.transaction(() => {
    logQualityEvent({
      user: req.user,
      action: "sample_round_reopened",
      subjectType: "sample_round",
      subjectId: round.id,
      siteId: round.site_id,
      // Det signerte innholdet, ordrett, før noen kan røre det.
      beforeValue: `Avlest ${round.read_date} av ${round.read_by_name} — ${signert}`,
      afterValue: "Åpnet for endring",
      comment: reason,
    });
    db.prepare(
      "UPDATE sample_rounds SET read_date = NULL, read_by = NULL, read_by_name = NULL, reopen_count = reopen_count + 1 WHERE id = ?"
    ).run(round.id);
  });
  gjenapne();

  res.json(roundWithPoints(db.prepare("SELECT * FROM sample_rounds WHERE id = ?").get(round.id)));
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
