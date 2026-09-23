# Hygienekurset

Kilden til «Hygiene i næringsmiddelproduksjon», kurset som ligger i produksjon. Seks lysbilder,
skrevet for hånd fordi det ikke fantes noen PowerPoint å kjøre gjennom — men utdataene er de samme
som `eksporter.ps1` lager, så resten av verktøykjeden virker uendret på dem.

```bash
node tools/pptx-til-leksjon/hygienekurs/bygg.mjs      # skriver bilder/ og manus.no.json hit
node tools/pptx-til-leksjon/manus.js  tools/pptx-til-leksjon/hygienekurs --sprak no,lt,lv,ru
node tools/pptx-til-leksjon/tale.js   tools/pptx-til-leksjon/hygienekurs --sprak no,lt,lv,ru
node tools/pptx-til-leksjon/last-opp.js tools/pptx-til-leksjon/hygienekurs --kurs 2 --sprak no \
  --api https://rentlogg-backend.onrender.com --epost <admin> --passord <...>
```

Teksten ligger i `bygg.mjs`, i `SLIDES`. Den er **standard næringsmiddelhygiene, ikke OKVs eget
fagstoff** — særlig lysbilde 4 (fargekoder på kluter) og 5 (hvilke midler renholdsplanene faktisk
nevner) er skrevet på generelt grunnlag og bør rettes mot det dere gjør, før noen signerer på det.

Husk at en ny opplasting av et språk som allerede finnes teller opp kursets versjon, og at alle som
har signert den forrige versjonen da vises med ↻ i matrisen. Rett teksten ferdig før du laster opp.

De genererte filene (`bilder/`, `manus.*.json`, `lyd/`) er med vilje ikke sjekket inn — de bygges
herfra på sekunder.
