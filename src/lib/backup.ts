import { createGzip } from "zlib";
import { BSON, MongoClient, type CollectionInfo } from "mongodb";
import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type _Object,
} from "@aws-sdk/client-s3";

/**
 * Database backups to Cloudflare R2: a full copy every 12 hours, the newest two kept.
 *
 * **The archive is a mongodump directory, tarred and gzipped** — `<db>/<collection>.bson` and
 * `<db>/<collection>.metadata.json` — so the restore is the stock tool and nothing of ours:
 *
 *   tar xzf upasanadb-2027-01-30T06-00-00Z.tar.gz
 *   mongorestore --uri "<cluster URI, no db path>" --drop <the folder holding upasanadb/>
 *
 * Why not run `mongodump` itself: Hostinger's Node.js apps have no way to install it, and the
 * server would fail the first backup with a missing binary nobody sees. The driver reads each
 * document as raw BSON (`raw: true`), which is byte for byte what mongodump writes, so ObjectIds,
 * dates and the rest come back exactly; the metadata carries every index, the partial unique one
 * on `contactMobile` and the Assistant's TTLs included — restored, they are rebuilt too.
 *
 * **R2 is the only record of when the last backup ran.** There is no Prisma model for it: the
 * scheduler lists the bucket and backs up when the newest object is 12 hours old. That makes it
 * survive restarts — Hostinger stops an idle app and starts it on the next request (§4.1), so a
 * timer that only counted from boot could go days without firing.
 *
 * **Old copies are deleted only after a new one has uploaded**, and only objects whose key this
 * file would have written. A failed backup leaves both previous ones in place; a stranger's file
 * under the same prefix is never touched.
 */

/** How often a backup is due, and how many to keep. The owner asked for 12 hours and 2. */
export const BACKUP_EVERY_MS = 12 * 60 * 60 * 1000;
export const BACKUPS_KEPT = 2;

/** How often the scheduler asks R2 whether one is due. Cheap: one LIST call. */
const CHECK_EVERY_MS = 60 * 60 * 1000;
/** The first check waits this long after boot, so a restart loop cannot hammer the bucket. */
const FIRST_CHECK_AFTER_MS = 60 * 1000;

interface BackupConfig {
  bucket: string;
  /** Folder inside the bucket, with its trailing slash. */
  prefix: string;
  client: S3Client;
}

/**
 * Null when R2 is not configured — then backups are simply off, which is right for a laptop.
 *
 * Read at call time, not at import, like every other env read in this tree (src/env.ts).
 */
export function backupConfig(): BackupConfig | null {
  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = process.env.R2_BUCKET?.trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;

  const rawPrefix = (process.env.BACKUP_PREFIX ?? "db-backups").trim().replace(/^\/+|\/+$/g, "");
  return {
    bucket,
    prefix: rawPrefix ? `${rawPrefix}/` : "",
    client: new S3Client({
      region: "auto",
      // A bucket created in the EU jurisdiction lives at <id>.eu.r2.cloudflarestorage.com.
      endpoint: process.env.R2_ENDPOINT?.trim() || `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
      // SDK releases since early 2025 attach CRC checksums to every request by default, and
      // Cloudflare's own R2 guide says to turn that down to "when the operation needs one".
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    }),
  };
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * `<prefix><db>-2027-01-30T06-00-00Z.tar.gz`. The timestamp is UTC with dashes for colons
 * (a colon in an object key is legal but breaks downloads on Windows), and it sorts as text in
 * time order — which is what retention relies on.
 */
export function backupKey(prefix: string, dbName: string, at: Date): string {
  const stamp = at
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/:/g, "-");
  return `${prefix}${dbName}-${stamp}.tar.gz`;
}

const keyPattern = (prefix: string, dbName: string) =>
  new RegExp(
    `^${escapeRegExp(prefix + dbName)}-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}Z\\.tar\\.gz$`
  );

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** This database's backups among whatever the listing returned, newest first. */
export function ourBackups<T extends { Key?: string }>(
  objects: T[],
  prefix: string,
  dbName: string
): (T & { Key: string })[] {
  const pattern = keyPattern(prefix, dbName);
  return objects
    .filter((object): object is T & { Key: string } => !!object.Key && pattern.test(object.Key))
    .sort((a, b) => (a.Key < b.Key ? 1 : a.Key > b.Key ? -1 : 0));
}

/** Every backup past the newest `keep`. */
export function backupsToDelete(sortedNewestFirst: { Key: string }[], keep = BACKUPS_KEPT) {
  return sortedNewestFirst.slice(keep).map(object => object.Key);
}

/** Due when there is no backup, or the newest one is at least 12 hours old. */
export function isBackupDue(newest: { LastModified?: Date } | undefined, now = new Date()) {
  if (!newest?.LastModified) return true;
  return now.getTime() - newest.LastModified.getTime() >= BACKUP_EVERY_MS;
}

// ---------------------------------------------------------------------------
// The archive
// ---------------------------------------------------------------------------

/**
 * One ustar header. Written by hand because a tar of in-memory buffers is ~30 lines, and a tar
 * dependency would be one more thing to install on a host where installs are the fragile step.
 */
export function tarHeader(name: string, size: number, mtime: Date): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error(`Name too long for a tar entry: ${name}`);
  const header = Buffer.alloc(512);
  const octal = (value: number, width: number) => value.toString(8).padStart(width - 1, "0") + "\0";

  header.write(name, 0, 100, "utf8");
  header.write(octal(0o644, 8), 100, 8, "ascii");
  header.write(octal(0, 8), 108, 8, "ascii");
  header.write(octal(0, 8), 116, 8, "ascii");
  header.write(octal(size, 12), 124, 12, "ascii");
  header.write(octal(Math.floor(mtime.getTime() / 1000), 12), 136, 12, "ascii");
  header.write("        ", 148, 8, "ascii"); // the checksum counts itself as eight spaces
  header.write("0", 156, 1, "ascii"); // regular file
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");

  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}

/** Zero bytes that take an entry of `size` to the next 512-byte boundary. */
const padding = (size: number) => Buffer.alloc((512 - (size % 512)) % 512);

/**
 * The tar entries of one database, streamed into `write` collection by collection.
 *
 * A tar header carries the entry's size, so each collection is gathered before it is written.
 * At this event's scale (a few thousand registrations) the largest is a few megabytes; only
 * one collection is in memory at a time.
 */
async function writeDump(
  client: MongoClient,
  dbName: string,
  write: (chunk: Buffer) => void
): Promise<{ collections: number; documents: number }> {
  const db = client.db(dbName);
  const now = new Date();
  // Views have no documents of their own, and `system.*` belongs to the server.
  const collections = (
    (await db.listCollections({ type: "collection" }).toArray()) as CollectionInfo[]
  )
    .filter(info => !info.name.startsWith("system."))
    .sort((a, b) => a.name.localeCompare(b.name));

  let documents = 0;
  for (const info of collections) {
    const collection = db.collection(info.name);

    const parts: Buffer[] = [];
    let size = 0;
    // `raw: true` hands back each document's BSON bytes untouched — exactly mongodump's .bson.
    for await (const doc of collection.find({}, { raw: true, batchSize: 500 })) {
      const bytes = doc as unknown as Buffer;
      parts.push(bytes);
      size += bytes.length;
      documents++;
    }
    write(tarHeader(`${dbName}/${info.name}.bson`, size, now));
    for (const part of parts) write(part);
    write(padding(size));

    const indexes = await collection.listIndexes().toArray();
    // Canonical extended JSON, as mongodump writes it: `{ "$numberInt": "1" }` rather than `1`,
    // so an index's key order and number types come back exactly.
    const metadata = Buffer.from(
      BSON.EJSON.stringify(
        {
          options: info.options ?? {},
          indexes,
          uuid: info.info?.uuid ? info.info.uuid.toString("hex") : "",
          collectionName: info.name,
          type: "collection",
        },
        { relaxed: false }
      )
    );
    write(tarHeader(`${dbName}/${info.name}.metadata.json`, metadata.length, now));
    write(metadata);
    write(padding(metadata.length));
  }
  write(Buffer.alloc(1024)); // two empty blocks end the archive
  return { collections: collections.length, documents };
}

/** The database named in DATABASE_URL — the one Prisma, and so the app, is using. */
export function databaseTarget(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is not set.");
  // Not `new URL()`: it refuses a replica set's `host1:27017,host2:27017` list.
  const match = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)(?:\/([^?]*))?/.exec(url);
  if (!match) throw new Error("DATABASE_URL is not a mongodb:// or mongodb+srv:// address.");
  const dbName = decodeURIComponent(match[2] ?? "");
  if (!dbName) throw new Error("DATABASE_URL names no database (expected …mongodb.net/<db>?…).");
  return { url, dbName, host: match[1] };
}

/** The whole database as a gzipped tar, in memory. */
export async function buildArchive(url: string, dbName: string) {
  const client = new MongoClient(url);
  const gzip = createGzip({ level: 9 });
  const chunks: Buffer[] = [];
  gzip.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve, reject) => {
    gzip.on("end", resolve);
    gzip.on("error", reject);
  });

  try {
    await client.connect();
    const counts = await writeDump(client, dbName, chunk => gzip.write(chunk));
    gzip.end();
    await finished;
    return { body: Buffer.concat(chunks), ...counts };
  } finally {
    await client.close();
  }
}

// ---------------------------------------------------------------------------
// R2
// ---------------------------------------------------------------------------

async function listAll(config: BackupConfig): Promise<_Object[]> {
  const objects: _Object[] = [];
  let token: string | undefined;
  do {
    const page = await config.client.send(
      new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: config.prefix,
        ContinuationToken: token,
      })
    );
    objects.push(...(page.Contents ?? []));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return objects;
}

export interface BackupResult {
  key: string;
  bytes: number;
  collections: number;
  documents: number;
  deleted: string[];
}

/** Takes a backup now, uploads it, then trims to the newest two. */
export async function runBackup(config: BackupConfig): Promise<BackupResult> {
  const { url, dbName } = databaseTarget();
  const startedAt = new Date();
  const archive = await buildArchive(url, dbName);
  const key = backupKey(config.prefix, dbName, startedAt);

  await config.client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: archive.body,
      ContentLength: archive.body.length,
      ContentType: "application/gzip",
    })
  );

  // Listed after the upload, so the new one is counted among the two kept. One at a time:
  // DeleteObjects needs a Content-MD5 the SDK no longer sends by default, and there are
  // rarely more than one or two to remove.
  const deleted = backupsToDelete(ourBackups(await listAll(config), config.prefix, dbName));
  for (const old of deleted) {
    await config.client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: old }));
  }

  return {
    key,
    bytes: archive.body.length,
    collections: archive.collections,
    documents: archive.documents,
    deleted,
  };
}

/** Runs a backup if the newest one in R2 is 12 hours old (or there is none). */
export async function backupIfDue(config: BackupConfig): Promise<BackupResult | null> {
  const { dbName } = databaseTarget();
  const [newest] = ourBackups(await listAll(config), config.prefix, dbName);
  if (!isBackupDue(newest)) return null;
  return runBackup(config);
}

// ---------------------------------------------------------------------------
// The schedule
// ---------------------------------------------------------------------------

let running: Promise<unknown> | null = null;

/**
 * Starts the hourly "is one due?" check inside the API process.
 *
 * In the API rather than the worker because the worker runs nowhere: Hostinger hosts one Node
 * app per repo, and `JobKind` is `never` (§2). On only in production, unless `BACKUP_SCHEDULE=on`
 * — a laptop with the R2 keys in its .env would otherwise back up its local database into the
 * same folder, and the retention step would then delete a real backup to make room for it.
 * `BACKUP_SCHEDULE=off` turns it off in production too.
 */
export function startBackupSchedule() {
  const setting = process.env.BACKUP_SCHEDULE?.trim().toLowerCase();
  const enabled = setting ? setting === "on" : process.env.NODE_ENV === "production";
  if (!enabled) return;

  const config = backupConfig();
  if (!config) {
    console.warn("[Backup] R2 is not configured (R2_* env), so no database backups will be taken.");
    return;
  }

  const check = () => {
    if (running) return; // a slow upload still going when the next check comes round
    running = backupIfDue(config)
      .then(result => {
        if (result)
          console.log(
            `[Backup] Saved ${result.key} (${(result.bytes / 1024).toFixed(0)} KB, ` +
              `${result.documents} documents in ${result.collections} collections)` +
              (result.deleted.length ? `; removed ${result.deleted.join(", ")}` : "")
          );
      })
      .catch(error => console.error("[Backup] Failed:", error))
      .finally(() => {
        running = null;
      });
  };

  // unref: a pending check must never be what keeps a shutting-down process alive.
  setTimeout(check, FIRST_CHECK_AFTER_MS).unref();
  setInterval(check, CHECK_EVERY_MS).unref();
  console.log(
    `[Backup] Every 12 hours to r2://${config.bucket}/${config.prefix}, newest ${BACKUPS_KEPT} kept.`
  );
}
