/**
 * Takes a database backup to Cloudflare R2 now, then keeps only the newest two.
 *
 *   pnpm backup:db             back up the database in DATABASE_URL
 *   pnpm backup:db --if-due    only if the newest backup is 12 hours old — what the server does
 *   pnpm backup:db --out <dir> save the archive to a folder on this computer instead; R2 is not
 *                              touched and nothing is deleted
 *
 * The server does this by itself every 12 hours in production (src/lib/backup.ts). This is for
 * the first backup after setting the R2 keys, and for one just before a risky change.
 *
 * It deletes older backups to keep two, so run it against the database you mean: the host is
 * printed first, because DATABASE_URL in .env has pointed at other projects' databases before.
 */
import "../src/env";

import { mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import {
  backupConfig,
  backupIfDue,
  backupKey,
  buildArchive,
  databaseTarget,
  runBackup,
} from "../src/lib/backup";

/** Same archive and file name as the R2 copies, so one restore procedure covers both. */
async function saveLocally(dir: string) {
  const { url, host, dbName } = databaseTarget();
  console.log(`Database: ${dbName} on ${host}`);
  mkdirSync(dir, { recursive: true });
  const archive = await buildArchive(url, dbName);
  const file = join(dir, backupKey("", dbName, new Date()));
  writeFileSync(file, archive.body);
  console.log(
    `Saved ${file}: ${(archive.body.length / 1024).toFixed(0)} KB, ` +
      `${archive.documents} documents in ${archive.collections} collections.`
  );
}

async function main() {
  const out = process.argv.indexOf("--out");
  if (out !== -1) {
    if (!process.argv[out + 1]) throw new Error("--out needs a folder.");
    return saveLocally(resolve(process.argv[out + 1]));
  }

  const config = backupConfig();
  if (!config) {
    console.error("Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET first.");
    process.exitCode = 1;
    return;
  }

  const { host, dbName } = databaseTarget();
  console.log(`Database: ${dbName} on ${host}`);
  console.log(`Saving to: r2://${config.bucket}/${config.prefix}`);

  const result = process.argv.includes("--if-due")
    ? await backupIfDue(config)
    : await runBackup(config);
  if (!result) {
    console.log("Not due: the newest backup is less than 12 hours old.");
    return;
  }
  console.log(
    `Saved ${result.key}: ${(result.bytes / 1024).toFixed(0)} KB, ` +
      `${result.documents} documents in ${result.collections} collections.`
  );
  console.log(result.deleted.length ? `Removed ${result.deleted.join(", ")}.` : "Nothing removed.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
