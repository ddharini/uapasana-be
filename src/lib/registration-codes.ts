import { prisma } from "../utils/db";
import { formatFamilyCode, formatPersonCode, isFamilyCode } from "./event";

/**
 * Registration numbers.
 *
 * Every person has their own number ("DM-0142"), kept for as long as they
 * stay on the registration. A registration's own `code` is its family number
 * ("DM-F-0031") for a family, and the one person's number for an individual —
 * so an individual has a single number to quote at the desk.
 *
 * Each kind comes from its own counter document in the `counter` collection:
 * "person", "family", and "registration" (the internal `sequence`, which only
 * orders registrations).
 */

export type Counter = "registration" | "person" | "family";

/**
 * `count` new numbers from a counter, in one atomic step on the server
 * (`findAndModify` with `$inc` and `upsert`), so two devotees submitting in the
 * same instant never get the same one. Counting the collection instead would
 * hand both the same number. Raw, because Prisma's own upsert is a read
 * followed by a write.
 */
export async function takeNumbers(counter: Counter, count: number): Promise<number[]> {
  if (count <= 0) return [];
  const result = (await prisma.$runCommandRaw({
    findAndModify: "counter",
    query: { _id: counter },
    update: { $inc: { value: count } },
    upsert: true,
    new: true,
  })) as { value?: { value?: unknown } };

  // Raw results come back as extended JSON: a plain number for an int32, but
  // `{ $numberLong: "65" }` if the counter was ever written as a 64-bit int.
  const raw = result.value?.value;
  const last =
    typeof raw === "number"
      ? raw
      : Number(
          (raw as { $numberLong?: string; $numberInt?: string })?.$numberLong ??
            (raw as { $numberInt?: string })?.$numberInt
        );
  if (!Number.isInteger(last)) throw new Error(`The ${counter} counter returned no value`);
  return Array.from({ length: count }, (_, i) => last - count + 1 + i);
}

type Saved = { code: string; members: { id: string; code?: string | null }[] };

/**
 * The numbers for a registration about to be saved: `data` as from
 * `toCreateData`, `previous` the registration before an edit.
 *
 * People already on it keep their number (matched by member id); anyone new
 * gets the next ones. A family keeps its family number; a registration that
 * becomes a family gets a new one, and one that becomes an individual goes by
 * that person's number.
 */
export async function withCodes<T extends { type: string; members: { id: string }[] }>(
  data: T,
  previous?: Saved,
  take: typeof takeNumbers = takeNumbers
): Promise<T & { code: string; members: (T["members"][number] & { code: string })[] }> {
  const kept = new Map(previous?.members.filter(m => m.code).map(m => [m.id, m.code as string]));
  const fresh = await take("person", data.members.filter(m => !kept.has(m.id)).length);
  const members = data.members.map(m => ({ ...m, code: kept.get(m.id) ?? formatPersonCode(fresh.shift()!) }));

  let code: string;
  if (data.type !== "family") code = members[0].code;
  else if (previous && isFamilyCode(previous.code)) code = previous.code;
  else code = formatFamilyCode((await take("family", 1))[0]);

  return { ...data, members, code };
}
