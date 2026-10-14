// Fargene systemet sender ut av seg selv.
//
// Frontenden har hatt dette i orden lenge: hele React-appen har én hardkodet fargeverdi, resten
// går via tokenene i `src/index.css`. Utdataene våre hadde ingen. 2026-10-08 lå det 30 unike
// hardkodede farger i backend, alle i noe en kunde ser — dagsrapporten, revisjons-PDF-en,
// QR-plakatene, Sjekk det-digesten. Tre palettgenerasjoner om hverandre, og ingen av dem helt lik
// appens.
//
// ### Hver statusfarge har to roller
//
// Det er den ene regelen fila finnes for. `ok` og `warn` er FLATEfarger. Som liten tekst måler de
// 3,30:1 og 3,19:1 mot hvitt, altså under WCAG AA — og de ble brukt nettopp slik, som fet
// tabelltekst i e-posten kunden får hver morgen. Fargen var ikke feil, bruken var det.
// `okText` og `warnText` er de samme statusene gjort lesbare. Bruk *Text når status blir tekst.
//
// Tallene i kommentarene er målt kontrast mot hvitt, ikke anslag.
export const BRAND = {
  ink: "#17151f", //      17,2:1 — brødtekst
  ink2: "#413c52", //      9,4:1 — sekundær tekst
  muted: "#6e6a7a", //     5,2:1 — meta. Den lyseste gråtonen som er tillatt; forgjengeren
  //                               #a1a1aa lå på 2,56:1 og sto i digesten til 2026-10-09.
  line: "#e7e3f2",
  lineSoft: "#f1edfb",
  ground: "#faf9fe",
  surface: "#ffffff",

  brand: "#6d28d9", //     7,1:1 — merkevare, lenker og knapper
  brandBg: "#f5f3ff",

  ok: "#16a34a", //        FLATE  (3,30:1 — ikke bruk som tekst)
  okText: "#146c35", //    6,5:1  TEKST
  okBg: "#dcf5e4",
  okLine: "#bfe6cd",

  warn: "#ea580c", //      FLATE  (3,56:1 — ikke bruk som tekst)
  warnText: "#c2410c", //  5,2:1  TEKST
  warnBg: "#fff1e6",
  warnLine: "#ffd9bd",

  danger: "#dc2626", //    FLATE
  dangerText: "#b91c1c", // 6,5:1 TEKST
  dangerBg: "#fef2f2",
  dangerLine: "#f6c9c9",

  kunde: "#2563eb", //     «kundens eget» — reservert, se frontendens index.css
};

// E-post, ikke nettside. Schibsted Grotesk finnes ikke på mottakerens maskin, og @font-face
// lastes ikke i Outlook — så fallback-stacken ER fonten her, ikke en sikkerhetsmargin.
export const MAIL_FONT = "Arial, Helvetica, sans-serif";

// Avsenderlåsen: en violett strek over dokumenttittelen.
//
// Streken er en RAMME på samme celle som teksten, ikke en egen rad med bakgrunnsfarge. Første
// forsøk var `<td style="width:34px;height:4px;background:...">&nbsp;</td>` i raden over, og det
// var feil på to måter som begge gikk rett i produksjon 2026-10-13:
//
//   1. Bredden var aldri 34px. Cella sto i SAMME kolonne som etiketten under, og en tabellkolonne
//      er så bred som sin videste celle. «RENHOLDSRAPPORT» bestemte bredden; `width:34px` kunne
//      ikke gjøre kolonnen smalere enn innholdet. Det så slik ut i forhåndsvisningen også — jeg
//      kalte det en 34px-strek uten å måle at det var det.
//   2. Høyden var aldri 4px. `font-size:0;line-height:0` + `&nbsp;` er et triks som forutsetter at
//      klienten respekterer begge deler. Outlook gjør ikke det; der falt cella tilbake på arvet
//      skriftstørrelse, og hårstreken ble en 50px violett kloss.
//
// En ramme har ingen av problemene: den tegnes av alle klienter, inkludert Word-motoren, og den
// er nøyaktig så bred som teksten under — uten at noe må oppgis i piksler.
export function mailLockup(label) {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin-bottom:22px;">` +
    `<tr><td style="border-top:4px solid ${BRAND.brand};padding-top:9px;` +
    `font:700 12px/1.3 ${MAIL_FONT};letter-spacing:0.14em;color:${BRAND.brand};">${label}</td></tr>` +
    `</table>`
  );
}

// Skallet rundt enhver e-postkropp vi sender. Ett sted, så de tre utsenderne ikke driver fra
// hverandre igjen.
export function mailShell(body, { lang = "no" } = {}) {
  return (
    `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
    `<body style="margin:0;padding:24px;background:${BRAND.surface};` +
    `font-family:${MAIL_FONT};color:${BRAND.ink};">${body}</body></html>`
  );
}
