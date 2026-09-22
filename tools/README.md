# Importverktøy for OKVs renholdsplaner

Skript for å lese en «Renholdsplan …».xlsx i OKVs standardmal og gjøre den om til romlisten
`POST /sites/:siteId/rooms/import-confirm` forventer.

Disse kjøres for hånd når en ny lokasjon skal settes opp. De er ikke del av serveren, importeres
ikke av `server.js`, og påvirker ikke appen som kjører. De ligger i repoet fordi kunnskapen om
hvordan malen skal leses er dyrt opptjent og var i ferd med å gå tapt i midlertidige mapper.

## Bruk

```powershell
# 1. Les Excel-filen (krever Excel installert - bruker COM)
.\tools\parse_renholdsplan.ps1 -Path "C:\...\Renholdsplan Kunde 2026-01-01.xlsx" > plan.json

# 2. Gjør om til importformat
node tools\transform.js plan.json rom.json
```

`transform.js` skriver ut hvilke oppgaver som ble holdt utenfor som kundens egne, og hvilke rom
som forsvant helt fordi alt i dem er kundens. **Les den utskriften før du importerer** — den er
hele poenget med steg 2.

Selve importen gjøres mot produksjons-API-et med en innlogget admin:
`POST /sites/:siteId/rooms/import-confirm` med `{ rooms: [...] }` fra `rom.json`.

## Slik er malen bygget

Hvert ark med romdata har en header-rad med `Lokale` (grov sone, verdien gjentas nedover via
tomme celler) og `Inv/Objekt` (én rad per oppgave i den sonen). **Lokale blir rommet,
Inv/Objekt blir sjekklisteoppgaven.** De 7 kolonnene rett etter `Merknader` er ukedagsrutenettet.

Malen finnes i tre utgaver med **identisk kolonnerekkefølge** — norsk, engelsk, og en
«Administrasjon»-utgave for kontorplaner som kaller oppgavekolonnen `Rom / Objekt`:

| Norsk | Engelsk |
|---|---|
| `Lokale` / `Område` | `Location` / `Area` |
| `Inv/Objekt` (adm.: `Rom / Objekt`) | `Inventory/Object` |
| `Frek.` | `Freq.` |
| `Merknader` | `Remarks` |
| `M T O T F L S` | `Mo Tu We Th Fr Sa Su` |

Parseren godtar begge, men headeren må matche ett av settene **fullstendig** — en delvis match
betyr et annet arkoppsett (se under) og skal fortsatt hoppes over.

Ukedagskolonnene er **posisjonsbaserte, ikke bokstavbaserte** (T står for både tirsdag og torsdag).

### Ansvarskolonnen — kundens oppgaver vs. våre

**Kolonnen rett etter de 7 ukedagskolonnene (`Merknader` + 8) sier hvem som gjør oppgaven.**

| Verdi | Betydning |
|---|---|
| `x` | Kundens egen oppgave (daglig/ukentlig frekvens) |
| `p` | Kundens egen oppgave (periodisk frekvens) |
| tom | **Vår** oppgave |

Dette er det som styrer den blå/grå radmarkeringen du ser i filen, og som stemmer med fargekoden
som er trykt i selve planen (blå = «Dag-/ukentlig: kunden», grå = «Periodisk: kunden», gul/oransje
= vårt).

**Ikke prøv å lese fargen.** Markeringen er betinget formatering, så `.Interior.Color` og
`.Font.Color` over COM returnerer ingenting — cellene har ingen statisk fyllfarge. Dette kostet en
hel arbeidsøkt på Goman Vest i september 2026 før flagg-kolonnen ble funnet. Hvis en «fargen må
bety noe»-teori ikke gir treff på celleegenskapene, er svaret betinget formatering: finn
kolonnen som utløser den.

`transform.js` holder flaggede oppgaver **utenfor** importen og lister dem opp i stedet. De skal
ikke havne på en renholders sjekkliste. Hvis kunden skal ha dem i appen likevel, er det et eget
rom med `responsible = 'customer'` (se `rooms.responsible` i `src/db.js`), ikke en oppgave i vårt
rom.

En oppgave uten flagg regnes alltid som vår — også i en fil parset før denne kolonnen ble lest i
det hele tatt. Det er den trygge retningen: oppgaven dukker opp på en sjekkliste og kan fjernes,
framfor å forsvinne i stillhet.

### Ark som skal hoppes over

- `kart *` (plantegninger), `kjemi *` (kjemikalieoversikt), `EK *` (egenkontroll/signaturlogg),
  `Historikk`, `Endring *`/`Endr *`, `Kommentarer *`, `tid *`, `Årsplan kopi`
- **Skjulte ark er aldri aktiv plan** — en skjult versjon av et ark er en gammel eller
  ikke-gjeldende utgave, uansett hvor gyldig innholdet ser ut.
- `Lørd *`/`Lørdag` (roterende lørdagsvask: kolonnene er uke-i-måned 1–5) og `Peri *`/`År *`
  (periodisk: kolonnene er månedsnummer 1–12). Disse har et annet rutenett og importeres ikke av
  dette verktøyet.

**Importer fra .xlsx-en, ikke fra en PDF.** En PDF av planen er som regel ett ark, og du ser
aldri at resten finnes. Det er nøyaktig slik Domstein Sjømat Bergen mistet hele kontorplanen sin:
lokasjonen ble bygget fra to ensides PDF-er, og arket `kontor (1)` med 18 rom lå urørt i arbeidsboka
i ti måneder uten at noe sa fra.

`transform.js` skriver derfor ut **hvor mange rom og oppgaver hvert ark ga**. Hold den lista opp mot
arkfanene i arbeidsboka før du importerer — et ark som mangler i lista, mangler i importen.

**Kontroller alltid at (ark som ga rom) + (ark i `skipped`) = totalt antall ark.** Et ark som
matcher headeren, men har tomme Lokale/Inv-Objekt-kolonner, forsvant tidligere sporløst uten at
noe feilet. Nå rapporteres det, men sjekk summen uansett.

## Én plan, én frekvens per rom

Appen støtter bare **én** plan per rom (ukedagssett, månedlig eller intervall), mens kildeplanen
ofte har ulik frekvens per oppgave. Policyen, avklart med Håkon:

- **Rommets plan er unionen av ukedagene til oppgavene i det** — rommet skal dukke opp hver dag
  det finnes noe å gjøre der. Har ett objekt 6 ganger i uka og resten bare lørdag, står rommet
  man–lør.
- Hver oppgave som avviker fra rommets sett, får det i navnet: `«Reoler (1x/mnd)»`, `«Bord (kun
  tirsdag)»`. Appen har dessuten ukedager **per oppgave** (`weekly_days` på
  `PATCH /rooms/:id/items/:itemId`) — settes de, vises oppgaven bare på sine egne dager, og
  merknaden i navnet er overflødig.
- Regelen var tidligere «det settet som dekker flest oppgaver». Det satte Goman Trondheims bakeri
  på kun lørdag, fordi ni av seksten oppgaver var lørdagsoppgaver, og rommet forsvant fra planen
  man–fre. 45 rom måtte repareres i produksjon i september 2026.
- Et rom uten ukentlige oppgaver i det hele tatt får ingen plan (`schedule: null`).
- Sier frekvensen «ved behov» samtidig som ukedagene er krysset av, vinner kryssene for planen,
  men ordene blir med i navnet: `«… (ved behov)»`.
- `0 / u` betyr at oppgaven ikke gjøres i dag — den beholdes med sitt eget navn, uten tillegg.

## Ukedagskonvensjonen — les denne før du rører et ukedagstall

Appen lagrer ukedag som JS `Date#getDay()`: **0 = søndag**, 1 = mandag … 6 = lørdag. Fasiten er
`WEEKDAYS`-arrayet i frontendens `src/components/admin/LokasjonerPage.jsx`.

Parseren jobber internt i kildens egen kolonneposisjon (0 = mandag … 6 = søndag) fordi det er
riktig for å regne ut flertallsplan og navnetillegg. Konverteringen skjer **ett sted**:
`toAppWeekday()` i `transform.js`, rett før `schedule.weekdays` skrives ut.

Dette var en ekte feil i september 2026: alt som ble importert før fiksen fikk «mandag–fredag»
lagret som søndag–torsdag. Ikke anta 0 = mandag fordi rutenettet leses M-T-O-T-F-L-S.

## Kjente fallgruver med Excel-COM

- **Kjør ett skript av gangen, i forgrunnen.** Flere samtidige COM-instanser gir ekte
  «RPC server unavailable»-feil.
- **`Out-File` tømmer målfilen i det pipelinen starter**, før kilden har produsert noe. En
  bakgrunnsjobb som feiler etter det, har allerede ødelagt forrige gode resultat. Skriv til et
  nytt filnavn, eller fang output i en variabel først.
- Parseren er pakket i `try/finally` slik at en feilet `Workbooks.Open` fortsatt slipper
  COM-objektet — ellers blir det liggende igjen en `EXCEL.EXE` per feil.
- `.ps1`-filen har ingen BOM, og Windows PowerShell 5.1 leser da æøå i kildekoden feil. Derfor
  bygges «Område» fra `[char]`-koder i stedet for å skrives som literal.
