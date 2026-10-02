// Hvor sikkerhetskopien havner.
//
// Målet er Cloudflare R2 med EU-jurisdiksjon (valgt 2026-10-02): personopplysninger skal ligge i
// EU, og R2 tar ikke betalt for uthenting — og uthenting er nøyaktig det man gjør den dagen det
// brenner. R2 snakker S3-API-et, så det samme gjelder B2, S3 og Scaleway om vi bytter senere.
// Leverandøren er fire miljøvariabler, ikke en kodeendring.
//
// Det finnes to drivere, og den lokale er ikke teststillas: den gjør at HELE sløyfen — kopiere,
// laste opp, hente ned igjen, gjenopprette — kan kjøres og bevises uten nøkler til noe som helst.
// En gjenopprettingsrutine ingen har prøvd er ikke en rutine. Den lokale driveren er også et
// gyldig mål i seg selv for den som vil speile til et montert volum.

import fs from "node:fs";
import path from "node:path";

// Nøkkelen backenden får SKAL IKKE ha slettetilgang (avtalt 2026-10-02). Da kan verken en
// kompromittert server eller en feil herfra slette kopihistorikken. Oppbevaringstiden settes
// som livssyklusregel på bøtta i stedet. Derfor finnes det med vilje ingen delete() her.
export function configuredDriver() {
  const target = process.env.BACKUP_TARGET || "";
  if (target === "s3") return s3Driver();
  if (target === "file") return fileDriver();
  return null; // ikke satt opp — den som kaller avgjør om det er en feil eller greit
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} mangler — sikkerhetskopien kan ikke lastes opp`);
  return value;
}

// S3-kompatibelt mål. Importeres dynamisk slik at en installasjon uten BACKUP_TARGET=s3 ikke
// trenger pakken i det hele tatt, og slik at en manglende avhengighet aldri kan hindre
// serveren i å starte — resten av systemet skal ikke falle fordi backupen er feilkonfigurert.
function s3Driver() {
  const bucket = requireEnv("BACKUP_S3_BUCKET");
  const endpoint = requireEnv("BACKUP_S3_ENDPOINT");
  const accessKeyId = requireEnv("BACKUP_S3_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("BACKUP_S3_SECRET_ACCESS_KEY");
  // R2 bryr seg ikke om region, men SDK-en krever at feltet er satt.
  const region = process.env.BACKUP_S3_REGION || "auto";

  async function client() {
    const { S3Client } = await import("@aws-sdk/client-s3");
    return new S3Client({
      region,
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  return {
    name: `s3:${bucket}`,
    async put(key, filePath, contentType = "application/octet-stream") {
      const { PutObjectCommand } = await import("@aws-sdk/client-s3");
      const c = await client();
      await c.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          // Strøm fra disk i stedet for å lese hele fila inn i minnet: instansen har 512 MB, og
          // en database som vokser skal ikke kunne ta ned serveren mens den sikkerhetskopieres.
          Body: fs.createReadStream(filePath),
          ContentLength: fs.statSync(filePath).size,
          ContentType: contentType,
        })
      );
      return key;
    },
    // Paginert, og det er ikke en detalj: ListObjectsV2 svarer med maks 1000 objekter om gangen.
    // Uten løkka her ville bildespeilingen fra og med fil nummer 1001 trodd at alt den ikke så
    // manglet, forsøkt å laste opp på nytt — og blitt avvist av Bucket Lock, som nekter
    // overskriving. Altså: speilingen ville stoppet med feil, hver natt, så snart biblioteket
    // passerte tusen filer.
    async list(prefix = "") {
      const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
      const c = await client();
      const objects = [];
      let token;
      do {
        const out = await c.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token })
        );
        for (const o of out.Contents || []) {
          objects.push({ key: o.Key, size: o.Size, modified: o.LastModified });
        }
        token = out.IsTruncated ? out.NextContinuationToken : undefined;
      } while (token);
      return objects;
    },
    async get(key, destPath) {
      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      const { pipeline } = await import("node:stream/promises");
      const c = await client();
      const out = await c.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      await pipeline(out.Body, fs.createWriteStream(destPath));
      return destPath;
    },
  };
}

function fileDriver() {
  const root = requireEnv("BACKUP_DIR");
  return {
    name: `file:${root}`,
    async put(key, filePath, _contentType) {
      const dest = path.join(root, key);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(filePath, dest);
      return key;
    },
    async list(prefix = "") {
      if (!fs.existsSync(root)) return [];
      const walk = (dir, base = "") =>
        fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
          const rel = base ? `${base}/${e.name}` : e.name;
          if (e.isDirectory()) return walk(path.join(dir, e.name), rel);
          const stat = fs.statSync(path.join(dir, e.name));
          return [{ key: rel, size: stat.size, modified: stat.mtime }];
        });
      return walk(root).filter((o) => o.key.startsWith(prefix));
    },
    async get(key, destPath) {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(path.join(root, key), destPath);
      return destPath;
    },
  };
}
