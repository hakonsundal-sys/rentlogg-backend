# PowerPoint til opplæringsleksjon

Gjør en `.pptx` om til en leksjon de ansatte kan se på mobilen — lysbilder med innlest tale på det
språket hver enkelt leser. Fire steg, kjørt for hånd på din egen maskin, akkurat som
[renholdsplan-importen](../README.md) ved siden av. Ingenting her er del av serveren.

## Hvorfor ikke en vanlig video

En leksjon i Rentlogg er **bilder + lyd**, ikke en mp4. Det er et bevisst valg:

- **Plass.** Render-disken er 1 GB, delt med databasen og hvert eneste bilde appen har lagret. Et
  20-lysbilders kurs blir ~3 MB bilder og ~3 MB lyd per språk. Den samme leksjonen som 720p-video
  er 100–150 MB.
- **Språk.** Et nytt språk er et sett lydfiler, ikke en ny film som må rendres på nytt.
- **Dokumentasjon.** Appen kan se hvilke lysbilder den ansatte faktisk har åpnet. Det er den
  påstanden signaturen hviler på, og en videospiller kan ikke gi den.

## Steg

```powershell
# 1. Eksporter lysbilder og rå tekst (bruker PowerPoint du allerede har installert)
powershell -ExecutionPolicy Bypass -File tools\pptx-til-leksjon\eksporter.ps1 `
  -Path "C:\...\Hygienekurs.pptx" -OutDir leksjon
```

```bash
# 2. Skriv manus og oversett det. Skriver manus.<språk>.json — LES DEM FØR DU GÅR VIDERE.
node tools/pptx-til-leksjon/manus.js leksjon --sprak no,lt,ru

# 3. Les inn manuset (koster penger per tegn — se under)
node tools/pptx-til-leksjon/tale.js leksjon --sprak no,lt,ru

# 4. Last opp i kurset, ett språk om gangen
node tools/pptx-til-leksjon/last-opp.js leksjon --kurs 4 --sprak no \
  --api https://rentlogg-backend.onrender.com --epost deg@okv-gruppen.no --passord ...
```

Kurset må finnes fra før: opprett det under **Ansatte → Opplæring → Kurs** med type
«Leksjon i appen», og bruk id-en derfra som `--kurs`.

## Steg 2 er ikke et mellomsteg du kan hoppe over

`manus.js` skriver om lysbildeteksten til noe et menneske faktisk kan si, og oversetter den.
Resultatet er det de ansatte **hører og signerer på**. Les gjennom `manus.<språk>.json` og rett det
der før du lager tale — samme regel som `transform.js` har for romlistene: utskriften er hele
poenget med steget.

Et lysbilde uten tekst i det hele tatt (bare et bilde eller et diagram) kommer ut med tomt manus og
varsel. Skriv det inn for hånd.

## Nøkler

Begge i `.env` i denne mappen, og **ingen av dem skal på Render** — serveren lager aldri tale eller
oversettelser selv, den tar bare imot ferdige filer.

| Nøkkel | Brukes av | Merknad |
|---|---|---|
| `ANTHROPIC_API_KEY` | steg 2 | Samme nøkkel som AI-importen av renholdsplaner bruker. |
| `ELEVENLABS_API_KEY` | steg 3 | Faktureres per tegn. Et 20-lysbilders kurs er ~4 000 tegn per språk. |

## Lag bare de språkene som faktisk brukes

Lyd er det som tar plass. Sjekk hvilke språk de som skal ha kurset står oppført med (`Ansatte`-siden
viser språk per person) og lag bare de. Norsk bør alltid være med — appen faller tilbake på norsk
når en ansatts eget språk mangler for et kurs.

## Å laste opp på nytt koster noe

`last-opp.js` erstatter hele språket i ett jafs. Hadde kurset lysbilder fra før, teller opplastingen
opp kursets versjon, og alle som har signert den gamle versjonen dukker opp i matrisen som «signert
på en eldre versjon» (↻). Det er meningen — materiellet er endret, og da vet du hvem som ikke har
sett endringen. Men det betyr at en opplasting for å rette en skrivefeil har en kostnad. Rett
teksten ferdig først.

## Stemme

`tale.js` bruker én stemme for alle språk (ElevenLabs `eleven_multilingual_v2`), så leksjonen leses
av den samme personen uansett hvilket språk den spilles på. Bytt med `--stemme <voice id>` hvis du
vil bruke en annen stemme fra kontoen.
