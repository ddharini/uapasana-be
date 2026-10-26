/**
 * Names are kept in English letters, whatever language the form was shown in
 * (the public pages offer Gujarati), so the team's search, sorting and printed
 * reports work on every registration. The form says so first; these pin the
 * server's own check, which also covers the desk and any other client.
 */
import { describe, expect, it } from "vitest";

import { MOBILE_E164 } from "./event";
import {
  hasNonLatinLetters,
  isSevak,
  newRegistrationSchema,
  splitFullName,
  toCreateData,
} from "./registrations";

const stay = { date: "2027-01-29", slot: "morning", meal: true };
const leave = { date: "2027-01-30", slot: "evening", meal: true };
/** "Ramesh Patel" as the form sends it, with a middle name when the name has none. */
const person = (name: string, extra: object = {}) => ({
  ...splitFullName(name),
  ...(name.trim().split(/\s+/).length < 3 ? { middleName: "Kantilal" } : {}),
  gender: "male",
  age: 40,
  isPrimary: false,
  needsAssistance: false,
  arrival: stay,
  departure: leave,
  ...extra,
});
const registration = (overrides: object = {}) => ({
  type: "individual",
  mandal: "Surat",
  members: [person("Ramesh Patel", { isPrimary: true, mobile: "+919876543210" })],
  arrival: stay,
  departure: leave,
  travel: { mode: "train", needsPickup: false },
  accommodationRequired: false,
  source: "self",
  ...overrides,
});
const messagesAt = (input: object, path: string) => {
  const result = newRegistrationSchema.safeParse(input);
  return result.success
    ? []
    : result.error.issues.filter(i => i.path.join(".") === path).map(i => i.message);
};

describe("hasNonLatinLetters", () => {
  it.each(["Ramesh Patel", "José D'Souza", "R. K. Shah-Mehta", ""])("accepts %j", name => {
    expect(hasNonLatinLetters(name)).toBe(false);
  });
  it.each(["રમેશ પટેલ", "Ramesh પટેલ", "रमेश"])("rejects %j", name => {
    expect(hasNonLatinLetters(name)).toBe(true);
  });
});

describe("names on a registration", () => {
  it("accepts a name in English letters", () => {
    expect(newRegistrationSchema.safeParse(registration()).success).toBe(true);
  });

  it("refuses a person's name in Gujarati", () => {
    const input = registration({
      members: [person("રમેશ પટેલ", { isPrimary: true, mobile: "+919876543210" })],
    });
    expect(messagesAt(input, "members.0.firstName")).toContain("Write the name in English letters");
    expect(messagesAt(input, "members.0.surname")).toContain("Write the name in English letters");
  });

  it("asks for the first, middle and surname", () => {
    const contact = { isPrimary: true, mobile: "+919876543210" };
    const noSurname = registration({ members: [person("Ramesh", contact)] });
    expect(messagesAt(noSurname, "members.0.surname")).toEqual(["Enter the surname"]);
    const noFirst = registration({
      members: [{ ...person("Ramesh Patel", contact), firstName: " " }],
    });
    expect(messagesAt(noFirst, "members.0.firstName")).toEqual(["Enter the first name"]);
    for (const middleName of [" ", null, undefined]) {
      const noMiddle = registration({
        members: [{ ...person("Ramesh Patel", contact), middleName }],
      });
      expect(messagesAt(noMiddle, "members.0.middleName")).toEqual(["Enter the middle name"]);
    }
    expect(newRegistrationSchema.safeParse(registration()).success).toBe(true);
  });

  it("saves the parts joined as the full name", () => {
    const input = newRegistrationSchema.parse(
      registration({
        members: [
          person("Ramesh  Kantilal   Patel ", { isPrimary: true, mobile: "+919876543210" }),
        ],
      })
    );
    const [saved] = toCreateData(input).members;
    expect(saved).toMatchObject({
      firstName: "Ramesh",
      middleName: "Kantilal",
      surname: "Patel",
      fullName: "Ramesh Kantilal Patel",
    });
  });

  it("still takes one full name from a form opened before the change", () => {
    const legacy = {
      fullName: "Ramesh Kantilal Patel",
      gender: "male",
      age: 40,
      isPrimary: true,
      mobile: "+919876543210",
      needsAssistance: false,
      arrival: stay,
      departure: leave,
    };
    const input = newRegistrationSchema.parse(registration({ members: [legacy] }));
    expect(toCreateData(input).members[0]).toMatchObject({
      firstName: "Ramesh",
      middleName: "Kantilal",
      surname: "Patel",
      fullName: "Ramesh Kantilal Patel",
    });
  });

  it("flags the same person listed twice on the first name", () => {
    const input = registration({
      type: "family",
      groupName: "Patel family",
      members: [
        person("Ramesh Patel", { isPrimary: true, mobile: "+919876543210" }),
        person("ramesh  patel", { relation: "Brother" }),
      ],
    });
    expect(messagesAt(input, "members.1.firstName")).toEqual(["The same person is listed twice"]);
  });

  it("allows two people sharing a name when the age or gender differs", () => {
    const input = registration({
      type: "family",
      groupName: "Patel family",
      members: [
        person("Ramesh Patel", { isPrimary: true, mobile: "+919876543210" }),
        person("Ramesh Patel", { age: 12, relation: "Son" }),
        person("Ramesh Patel", { gender: "female", relation: "Daughter" }),
      ],
    });
    expect(messagesAt(input, "members.1.firstName")).toEqual([]);
    expect(messagesAt(input, "members.2.firstName")).toEqual([]);
  });

  it("refuses a family name in Gujarati", () => {
    const input = registration({
      type: "family",
      groupName: "પટેલ પરિવાર",
      members: [
        person("Ramesh Patel", { isPrimary: true, mobile: "+919876543210" }),
        person("Sita Patel", { gender: "female" }),
      ],
    });
    expect(messagesAt(input, "groupName")).toEqual(["Write the name in English letters"]);
  });
});

describe("mobile numbers by country", () => {
  it.each([
    "+919876543210",
    "+12015550123",
    "+447700900123",
    "+61412345678",
    "+6421123456",
    "+64211234567",
    "+642112345678",
    "+971501234567",
  ])("accepts %s", mobile => expect(MOBILE_E164.test(mobile)).toBe(true));
  it.each([
    "+915876543210", // India: starts 6–9
    "+61312345678", // Australia: mobiles start with 4
    "+6491123456", // New Zealand: mobiles start with 2
    "+971412345678", // UAE: mobiles start with 5
    "+9715012345", // UAE: too short
  ])("refuses %s", mobile => expect(MOBILE_E164.test(mobile)).toBe(false));
});

/**
 * A family need not all travel the same way — three by train, two by flight.
 * The registration's travel then says "separate" and each person carries
 * their own; the party's vehicles stay on the registration.
 */
describe("travelling separately", () => {
  const family = (members: object[], travel: object = { mode: "separate", needsPickup: false }) =>
    registration({
      type: "family",
      groupName: "Patel family",
      members: [
        person("Brij Patel", { isPrimary: true, mobile: "+919876543210", ...members[0] }),
        person("Arpita Patel", { gender: "female", age: 38, ...members[1] }),
      ],
      travel,
    });
  const byTrain = {
    mode: "train",
    needsPickup: true,
    reference: "12009 Shatabdi Exp",
    station: "Sabarmati",
    arrivalTime: "06:30",
  };

  it("keeps each person's own travel and sums up the pickups", () => {
    const data = toCreateData(
      newRegistrationSchema.parse(
        family([{ travel: byTrain }, { travel: { mode: "flight", needsPickup: false } }])
      )
    );
    expect(data.travel.mode).toBe("separate");
    expect(data.travel.needsPickup).toBe(true);
    expect(data.travel.needsDrop).toBe(false);
    expect(data.members[0].travel).toMatchObject({ mode: "train", station: "Sabarmati", needsPickup: true });
    expect(data.members[1].travel).toMatchObject({ mode: "flight", needsPickup: false, station: null });
  });

  it("asks each person how they travel", () => {
    const input = family([{ travel: byTrain }, {}]);
    expect(messagesAt(input, "members.1.travel.mode")).toEqual(["Select how they are travelling"]);
  });

  it("asks for a person's journey when they want a pickup", () => {
    const input = family([
      { travel: byTrain },
      { travel: { mode: "flight", needsPickup: true } },
    ]);
    expect(messagesAt(input, "members.1.travel.reference")).toEqual(["Enter the flight number"]);
    expect(messagesAt(input, "members.1.travel.arrivalTime")).toEqual(["Pick the time"]);
  });

  it("allows no more vehicles than the people coming by vehicle", () => {
    const input = family(
      [{ travel: { mode: "personal_vehicle", needsPickup: false } }, { travel: byTrain }],
      { mode: "separate", needsPickup: false, vehicleCount: 2 }
    );
    expect(messagesAt(input, "travel.vehicleCount")).toEqual([
      "At most 1 vehicles for 1 people (and never more than 4)",
    ]);
  });

  it("drops a person's travel when the party travels together", () => {
    const data = toCreateData(
      newRegistrationSchema.parse(family([{ travel: byTrain }, {}], byTrain))
    );
    expect(data.travel.mode).toBe("train");
    expect(data.members.every(m => m.travel === null)).toBe(true);
  });

  it("refuses travelling separately for one person", () => {
    const input = registration({ travel: { mode: "separate", needsPickup: false } });
    expect(messagesAt(input, "travel.mode")).toEqual(["Select how you are travelling"]);
  });
});

describe("arriving early for seva", () => {
  const early = { date: "2027-01-10", slot: "morning", meal: true };
  const late = { date: "2027-02-20", slot: "evening", meal: true };
  const contact = (extra: object = {}) =>
    person("Ramesh Patel", { isPrimary: true, mobile: "+919876543210", ...extra });
  const alone = (extra: object = {}) =>
    registration({
      members: [contact({ arrival: early, departure: late, ...extra })],
      arrival: early,
      departure: late,
    });
  /** A family whose contact comes early for seva, and a wife who comes for the event. */
  const family = (wifeExtra: object = {}) =>
    registration({
      type: "family",
      groupName: "Patel family",
      members: [
        contact({ arrival: early, departure: late, earlySeva: true }),
        person("Sita Ramesh Patel", { gender: "female", relation: "Spouse", ...wifeExtra }),
      ],
      arrival: early,
      departure: late,
    });

  it("refuses days outside the event for someone who is not one", () => {
    expect(messagesAt(alone(), "arrival.date")).toEqual([
      "Pick an arrival day between 28 January and 1 February",
    ]);
    expect(messagesAt(alone(), "members.0.departure.date")).toEqual([
      "Pick a departure day between 28 January and 1 February",
    ]);
  });

  it("accepts any day of January or February 2027 for a Swayam Sevak, and stores it", () => {
    const input = alone({ earlySeva: true });
    expect(newRegistrationSchema.safeParse(input).success).toBe(true);
    const data = toCreateData(newRegistrationSchema.parse(input));
    expect(data.members[0].earlySeva).toBe(true);
    expect(data.earlySeva).toBe(true);
  });

  it("lets one person in a family come early while another comes for the event", () => {
    const input = family();
    expect(newRegistrationSchema.safeParse(input).success).toBe(true);
    const data = toCreateData(newRegistrationSchema.parse(input));
    expect(data.members.map(m => m.earlySeva)).toEqual([true, false]);
    expect(data.earlySeva).toBe(true);
  });

  it("holds the others in a family to the event's days", () => {
    const input = family({ arrival: early });
    expect(messagesAt(input, "members.1.arrival.date")).toEqual([
      "Pick an arrival day between 28 January and 1 February",
    ]);
    expect(messagesAt(input, "members.0.arrival.date")).toEqual([]);
  });

  it("still refuses a day outside those two months", () => {
    const input = alone({ earlySeva: true, arrival: { ...early, date: "2026-12-31" } });
    expect(messagesAt(input, "members.0.arrival.date")).toEqual([
      "Pick a day in January or February 2027",
    ]);
  });

  it("is stored as no when not sent", () => {
    const data = toCreateData(newRegistrationSchema.parse(registration()));
    expect(data.earlySeva).toBe(false);
    expect(data.members[0].earlySeva).toBe(false);
  });

  it("reads a party-wide answer from before it was asked per person as everyone's", () => {
    expect(isSevak({ earlySeva: true }, { earlySeva: null })).toBe(true);
    expect(isSevak({ earlySeva: true }, { earlySeva: false })).toBe(false);
    expect(isSevak({ earlySeva: null }, {})).toBe(false);
  });
});

describe("airport flights per person", () => {
  const land = (date: string) => ({ needsPickup: true, arrival: { date, flight: "ai 144" }, needsDrop: false });
  const usa = (members: object[], extra: object = {}) =>
    registration({
      type: "family",
      groupName: "Patel family",
      mandal: "USA",
      members: [
        person("Ramesh Patel", { isPrimary: true, mobile: "+919876543210", ...members[0] }),
        person("Sita Ramesh Patel", { gender: "female", relation: "Spouse", ...members[1] }),
      ],
      ...extra,
    });

  it("keeps the party's flights when they share them", () => {
    const data = toCreateData(newRegistrationSchema.parse(usa([{}, {}], { indiaTravel: land("2027-01-27") })));
    expect(data.indiaTravel?.arrival?.date).toBe("2027-01-27");
    expect(data.members.every(m => m.indiaTravel === null)).toBe(true);
  });

  it("stores each person's own flights, and only whether anyone needs a pickup on the party", () => {
    const data = toCreateData(
      newRegistrationSchema.parse(usa([{ indiaTravel: land("2027-01-25") }, {}]))
    );
    expect(data.members[0].indiaTravel?.arrival).toEqual({ date: "2027-01-25", time: null, flight: "AI 144" });
    expect(data.members[1].indiaTravel).toBeNull();
    expect(data.indiaTravel).toEqual({ needsPickup: true, arrival: null, needsDrop: false, departure: null });
  });

  it("checks each person's landing against their own arrival", () => {
    // Arrives 29 Jan (the fixture's day); landing on the 30th is too late.
    const input = usa([{}, { indiaTravel: land("2027-01-30") }]);
    expect(messagesAt(input, "members.1.indiaTravel.arrival.date")).toEqual([
      "Has to be on or before you reach the event",
    ]);
  });

  it("drops flights for a mandal in India", () => {
    const input = usa([{ indiaTravel: land("2027-01-25") }, {}], { mandal: "Surat", travel: { mode: "train", needsPickup: false } });
    const data = toCreateData(newRegistrationSchema.parse(input));
    expect(data.indiaTravel).toBeNull();
    expect(data.members[0].indiaTravel).toBeNull();
  });
});
