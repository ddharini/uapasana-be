/**
 * Adds the confirmed guest houses and hotels from the accommodation sheet
 * ("20261011_Dashabdi Mahapatv_Accommodation.xlsx"). The sheet's "Identified
 * as stand by" places are left out.
 *
 *   pnpm seed:accommodation    adds the places not already there (by name),
 *                              and brings the ones that are up to the sheet
 *
 * The sheet gives each place's number of rooms and the most people it takes,
 * not the rooms themselves. So the rooms here are made up to match those
 * totals — numbered 1 to N, beds spread as evenly as they go, about 40% family
 * rooms and the rest split between gents and ladies, all on the 1st floor until
 * someone says which are on the ground floor.
 * A place already in the database keeps every room it has (mandal stays and
 * allotments point at them); only the missing rooms are added after them, and
 * its map link is set from the sheet.
 * Admins correct them from the place's Edit screen once the places send
 * their real room lists.
 */
import "../src/env";

import { withRoomIds } from "../src/lib/accommodation";
import { prisma } from "../src/utils/db";

type Seed = {
  name: string;
  /** Names it was saved under before, from the older sheet. */
  formerNames?: string[];
  kind: "guest_house" | "hotel";
  address: string;
  area: string;
  mapUrl: string;
  rooms: number;
  beds: number;
  /** Kept in the place's notes. */
  remark?: string;
};

const PLACES: Seed[] = [
  { name: "Guj University Guest House", kind: "guest_house", address: "University Campus, Navrangpura", area: "Navrangpura", mapUrl: "https://maps.app.goo.gl/aezxTgHpgMzWwtor8", rooms: 40, beds: 120 },
  { name: "Sahkar Bhavan", kind: "guest_house", address: "Ankur Char Rasta, Naranpura", area: "Naranpura", mapUrl: "https://maps.app.goo.gl/Qcp1Ub8npT6TAmFs9", rooms: 12, beds: 60 },
  { name: "Swaminarayan Gurukul - Memnagar", formerNames: ["Gurukul – Memnagar"], kind: "guest_house", address: "Memnagar", area: "Memnagar", mapUrl: "https://maps.app.goo.gl/jx7Ke1Mgae3M6Jsu6", rooms: 40, beds: 100 },
  { name: "Hotel Page One (NRI)", kind: "hotel", address: "Sandesh Press Road, Lad Society", area: "Lad Society", mapUrl: "https://maps.app.goo.gl/XCHke1jhesDxLcKU9", rooms: 15, beds: 30 },
  { name: "Hotel Treat-O-Tel (NRI)", kind: "hotel", address: "Sterling Hospital Lane, Memnagar", area: "Memnagar", mapUrl: "https://maps.app.goo.gl/VreoQrubWdCA6y426", rooms: 40, beds: 80 },
  { name: "Hotel S N Blu", kind: "hotel", address: "Near SAL Hospital, Thaltej", area: "Thaltej", mapUrl: "https://maps.app.goo.gl/pA8yqiMdYuK6LUMJ7", rooms: 20, beds: 50 },
  { name: "Hotel Pragati Grand", kind: "hotel", address: "Near Zydus Hospital, Thaltej", area: "S G Highway", mapUrl: "https://maps.app.goo.gl/jhihZWwom7oLirLX7", rooms: 40, beds: 100, remark: "Booked for 30/01 – 31/01 only." },
  { name: "Hotel Maruti", kind: "hotel", address: "Madalpur, Paldi", area: "Paldi", mapUrl: "https://maps.app.goo.gl/5f7HABNqtYYEX9PSA", rooms: 25, beds: 75 },
  { name: "Hotel Shital Inn", kind: "hotel", address: "Vastrapur Fountain, Vastrapur", area: "Vastrapur", mapUrl: "https://maps.app.goo.gl/6FPPBoART3Emrpva7", rooms: 25, beds: 60 },
  { name: "Hotel Pragati PG", kind: "hotel", address: "Hindu Colony", area: "Navrangpura", mapUrl: "https://maps.app.goo.gl/e7s2gBjiTTqed4ZQ8", rooms: 15, beds: 45 },
];

/** `count` rooms holding `beds` between them, the bigger rooms first, numbered from `first`. */
function rooms(count: number, beds: number, first = 1) {
  const base = Math.floor(beds / count);
  const bigger = beds % count;
  const family = Math.round(count * 0.4);
  const gents = Math.round((count - family) / 2);
  const kind = (index: number): "family" | "gents" | "ladies" =>
    index < family ? "family" : index < family + gents ? "gents" : "ladies";
  return Array.from({ length: count }, (_, index) => ({
    label: String(first + index),
    beds: base + (index < bigger ? 1 : 0),
    extraBeds: 0,
    kind: kind(index),
    floor: 1,
  }));
}

const placeholderNote = (seed: Seed) =>
  [seed.remark, `Rooms are placeholders made from the sheet's totals (${seed.rooms} rooms, ${seed.beds} people). Replace them with the real room list.`]
    .filter(Boolean)
    .join(" ");

async function main() {
  const target = new URL((process.env.DATABASE_URL ?? "").replace(/^mongodb(\+srv)?:/, "http:"));
  console.log(`Writing to ${target.host}${target.pathname}`);

  const last = await prisma.accommodationPlace.findFirst({ orderBy: { sortOrder: "desc" } });
  let order = last?.sortOrder ?? 0;

  for (const seed of PLACES) {
    const existing = await prisma.accommodationPlace.findFirst({
      where: { name: { in: [seed.name, ...(seed.formerNames ?? [])] } },
    });

    if (!existing) {
      await prisma.accommodationPlace.create({
        data: {
          name: seed.name,
          kind: seed.kind,
          address: seed.address,
          area: seed.area,
          mapUrl: seed.mapUrl,
          notes: placeholderNote(seed),
          sortOrder: ++order,
          rooms: withRoomIds(rooms(seed.rooms, seed.beds)),
        },
      });
      console.log(`${seed.name}: added, ${seed.rooms} rooms, ${seed.beds} beds.`);
      continue;
    }

    const haveBeds = existing.rooms.reduce((sum, room) => sum + room.beds, 0);
    const missingRooms = Math.max(0, seed.rooms - existing.rooms.length);
    const missingBeds = Math.max(missingRooms, seed.beds - haveBeds);
    const labels = new Set(existing.rooms.map((room) => room.label.toLowerCase()));
    let first = existing.rooms.length + 1;
    while (Array.from({ length: missingRooms }, (_, i) => String(first + i)).some((label) => labels.has(label))) first++;
    const added = missingRooms ? withRoomIds(rooms(missingRooms, missingBeds, first), existing.rooms.map((room) => room.id)) : [];
    const placeholder = !existing.notes || existing.notes.startsWith("Rooms are placeholders");

    await prisma.accommodationPlace.update({
      where: { id: existing.id },
      data: {
        name: seed.name,
        address: seed.address,
        area: seed.area,
        mapUrl: seed.mapUrl,
        ...(placeholder && { notes: placeholderNote(seed) }),
        ...(added.length && { rooms: [...existing.rooms, ...added], version: { increment: 1 } }),
      },
    });
    const renamed = existing.name !== seed.name ? ` (was "${existing.name}")` : "";
    console.log(
      added.length
        ? `${seed.name}${renamed}: kept its ${existing.rooms.length} rooms (${haveBeds} beds), added ${added.length} rooms with ${missingBeds} beds.`
        : `${seed.name}${renamed}: rooms already match, map link and address updated.`
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
