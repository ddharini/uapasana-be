/**
 * Backups delete things, so these pin what decides what goes: only this database's own
 * backups, only past the newest two, and only once the new one has uploaded. Plus the parts a
 * restore depends on — a tar header `tar` accepts, and the database read from DATABASE_URL.
 */
import { gunzipSync } from "zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const s3 = vi.hoisted(() => ({
  objects: [] as { Key: string; LastModified: Date }[],
  calls: [] as string[],
  failPut: false,
}));

vi.mock("@aws-sdk/client-s3", () => {
  class Command {
    constructor(public input: Record<string, unknown>) {}
  }
  class PutObjectCommand extends Command {}
  class ListObjectsV2Command extends Command {}
  class DeleteObjectCommand extends Command {}
  class S3Client {
    async send(command: Command) {
      const key = command.input.Key as string;
      if (command instanceof PutObjectCommand) {
        s3.calls.push(`put ${key}`);
        if (s3.failPut) throw new Error("upload refused");
        s3.objects.push({ Key: key, LastModified: new Date() });
        return {};
      }
      if (command instanceof DeleteObjectCommand) {
        s3.calls.push(`delete ${key}`);
        s3.objects = s3.objects.filter(object => object.Key !== key);
        return {};
      }
      s3.calls.push("list");
      return { Contents: [...s3.objects], IsTruncated: false };
    }
  }
  return { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand };
});

vi.mock("mongodb", async importOriginal => {
  const real = await importOriginal<typeof import("mongodb")>();
  const docs = [{ _id: 1, name: "Asha" }].map(doc => Buffer.from(real.BSON.serialize(doc)));
  class MongoClient {
    async connect() {}
    async close() {}
    db() {
      return {
        listCollections: () => ({
          toArray: async () => [{ name: "registration", options: {} }, { name: "system.views" }],
        }),
        collection: () => ({
          find: () => docs,
          listIndexes: () => ({ toArray: async () => [{ v: 2, key: { _id: 1 }, name: "_id_" }] }),
        }),
      };
    }
  }
  return { ...real, MongoClient };
});

import {
  backupConfig,
  backupIfDue,
  backupKey,
  backupsToDelete,
  buildArchive,
  databaseTarget,
  isBackupDue,
  ourBackups,
  runBackup,
  tarHeader,
} from "./backup";

const ENV = {
  R2_ACCOUNT_ID: "acct",
  R2_ACCESS_KEY_ID: "id",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_BUCKET: "upasana",
  DATABASE_URL: "mongodb+srv://u:p@upasana.ab12cd.mongodb.net/upasanadb?retryWrites=true",
};

beforeEach(() => {
  s3.objects = [];
  s3.calls = [];
  s3.failPut = false;
  for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
});
afterEach(() => vi.unstubAllEnvs());

const at = (iso: string) => new Date(iso);

describe("backupKey", () => {
  it("is UTC, without colons or milliseconds, and sorts as text in time order", () => {
    const key = backupKey("db-backups/", "upasanadb", at("2027-01-30T06:05:09.123Z"));
    expect(key).toBe("db-backups/upasanadb-2027-01-30T06-05-09Z.tar.gz");
    expect(
      backupKey("", "x", at("2027-01-30T18:00:00Z")) >
        backupKey("", "x", at("2027-01-30T06:00:00Z"))
    ).toBe(true);
  });
});

describe("ourBackups / backupsToDelete", () => {
  const key = (iso: string, db = "upasanadb") => ({ Key: backupKey("db-backups/", db, at(iso)) });

  it("keeps the newest two and deletes the rest", () => {
    const listed = [
      key("2027-01-29T06:00:00Z"),
      key("2027-01-30T06:00:00Z"),
      key("2027-01-28T18:00:00Z"),
      key("2027-01-29T18:00:00Z"),
    ];
    expect(backupsToDelete(ourBackups(listed, "db-backups/", "upasanadb"))).toEqual([
      "db-backups/upasanadb-2027-01-29T06-00-00Z.tar.gz",
      "db-backups/upasanadb-2027-01-28T18-00-00Z.tar.gz",
    ]);
  });

  it("never counts or deletes a file it did not write, or another database's backup", () => {
    const listed = [
      key("2027-01-28T06:00:00Z", "otherdb"),
      key("2027-01-28T06:00:00Z", "upasanadb-old"),
      { Key: "db-backups/upasanadb-manual-copy.tar.gz" },
      { Key: "db-backups/notes.txt" },
      key("2027-01-30T06:00:00Z"),
    ];
    const ours = ourBackups(listed, "db-backups/", "upasanadb");
    expect(ours.map(object => object.Key)).toEqual([
      "db-backups/upasanadb-2027-01-30T06-00-00Z.tar.gz",
    ]);
    expect(backupsToDelete(ours)).toEqual([]);
  });
});

describe("isBackupDue", () => {
  const now = at("2027-01-30T18:00:00Z");
  it("is due with no backup at all", () => expect(isBackupDue(undefined, now)).toBe(true));
  it("is due at 12 hours, not before", () => {
    expect(isBackupDue({ LastModified: at("2027-01-30T06:00:00Z") }, now)).toBe(true);
    expect(isBackupDue({ LastModified: at("2027-01-30T06:00:01Z") }, now)).toBe(false);
  });
});

describe("databaseTarget", () => {
  it("reads the database from an Atlas srv address", () => {
    expect(databaseTarget(ENV.DATABASE_URL)).toMatchObject({
      dbName: "upasanadb",
      host: "upasana.ab12cd.mongodb.net",
    });
  });
  it("accepts a replica set's list of hosts", () => {
    const url = "mongodb://u:p@h1:27017,h2:27017,h3:27017/upasanadb?replicaSet=rs0";
    expect(databaseTarget(url)).toMatchObject({
      dbName: "upasanadb",
      host: "h1:27017,h2:27017,h3:27017",
    });
  });
  it("refuses an address with no database, rather than backing up `test`", () => {
    expect(() => databaseTarget("mongodb://localhost:27017/?replicaSet=rs0")).toThrow(
      /no database/
    );
  });
});

describe("the archive", () => {
  it("writes a ustar header whose checksum tar will accept", () => {
    const header = tarHeader("upasanadb/registration.bson", 1234, at("2027-01-30T06:00:00Z"));
    expect(header.length).toBe(512);
    expect(header.toString("ascii", 257, 262)).toBe("ustar");
    expect(parseInt(header.toString("ascii", 124, 135), 8)).toBe(1234);
    const stored = parseInt(header.toString("ascii", 148, 154), 8);
    const blanked = Buffer.from(header);
    blanked.fill(" ", 148, 156);
    expect(stored).toBe(blanked.reduce((sum, byte) => sum + byte, 0));
  });

  it("is a mongodump folder: .bson and .metadata.json per collection, system.* left out", async () => {
    const { body, collections, documents } = await buildArchive(ENV.DATABASE_URL, "upasanadb");
    const tar = gunzipSync(body);
    const names: string[] = [];
    for (let offset = 0; offset < tar.length && tar[offset] !== 0;) {
      const name = tar.toString("utf8", offset, offset + 100).replace(/\0.*$/s, "");
      const size = parseInt(tar.toString("ascii", offset + 124, offset + 135), 8);
      names.push(name);
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    expect(names).toEqual(["upasanadb/registration.bson", "upasanadb/registration.metadata.json"]);
    expect({ collections, documents }).toEqual({ collections: 1, documents: 1 });
    expect(tar.length % 512).toBe(0);
  });
});

describe("runBackup", () => {
  const old = (iso: string) => ({
    Key: backupKey("db-backups/", "upasanadb", at(iso)),
    LastModified: at(iso),
  });

  it("uploads first, then trims to the newest two", async () => {
    s3.objects = [old("2026-01-29T06:00:00Z"), old("2026-01-29T18:00:00Z")];
    const result = await runBackup(backupConfig()!);
    expect(s3.calls[0]).toMatch(/^put /);
    expect(result.deleted).toEqual(["db-backups/upasanadb-2026-01-29T06-00-00Z.tar.gz"]);
    expect(s3.objects.map(object => object.Key)).toEqual([
      "db-backups/upasanadb-2026-01-29T18-00-00Z.tar.gz",
      result.key,
    ]);
  });

  it("deletes nothing when the upload fails", async () => {
    s3.objects = [old("2026-01-29T06:00:00Z"), old("2026-01-29T18:00:00Z")];
    s3.failPut = true;
    await expect(runBackup(backupConfig()!)).rejects.toThrow("upload refused");
    expect(s3.calls.some(call => call.startsWith("delete"))).toBe(false);
    expect(s3.objects).toHaveLength(2);
  });

  it("does nothing when the newest backup is under 12 hours old", async () => {
    s3.objects = [{ ...old("2026-01-29T06:00:00Z"), LastModified: new Date() }];
    expect(await backupIfDue(backupConfig()!)).toBeNull();
    expect(s3.calls).toEqual(["list"]);
  });
});

describe("backupConfig", () => {
  it("is off until all four R2 values are set", () => {
    vi.stubEnv("R2_BUCKET", "");
    expect(backupConfig()).toBeNull();
  });
  it("normalises the folder to one trailing slash", () => {
    vi.stubEnv("BACKUP_PREFIX", "/backups/prod/");
    expect(backupConfig()!.prefix).toBe("backups/prod/");
  });
});
