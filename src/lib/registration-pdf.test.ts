/**
 * The PDF is what a devotee shows at the desk, so what each row and travel
 * line says is pinned here; the layout itself was checked by eye (setup.md).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Registration } from "@prisma/client";

import {
  idFromPdfToken,
  pdfText,
  pdfToken,
  personRow,
  registrationPdf,
  registrationPdfUrl,
  travelLines,
  travelSection,
} from "./registration-pdf";

const member = (extra: object = {}) => ({
  id: "m1",
  code: "DM-0140",
  fullName: "Harit Patel",
  firstName: "Harit",
  gender: "male",
  age: 34,
  mobile: "+919876543210",
  relation: null,
  isPrimary: true,
  arrival: { date: "2027-01-30", slot: "morning" },
  departure: { date: "2027-02-01", slot: "evening" },
  needsAccommodation: true,
  travel: null,
  ...extra,
});

const noTravel = {
  vehicleCount: null,
  vehicleNumbers: [],
  reference: null,
  arrivalTime: null,
  station: null,
  needsPickup: false,
  needsDrop: null,
};

const registration = {
  code: "DM-F-0031",
  type: "family",
  groupName: "Patel family",
  mandal: "Surat",
  members: [
    member(),
    member({
      id: "m2",
      code: "DM-0141",
      fullName: "Riya Patel",
      gender: "female",
      relation: "Spouse",
      isPrimary: false,
      mobile: null,
      needsAccommodation: false,
    }),
  ],
  arrival: { date: "2027-01-30", slot: "morning" },
  departure: { date: "2027-02-01", slot: "evening" },
  travel: {
    ...noTravel,
    mode: "personal_vehicle",
    vehicleCount: 1,
    vehicleNumbers: ["GJ01AB1234"],
  },
  accommodationRequired: true,
  status: "pending",
  createdAt: new Date("2026-10-27T10:00:00Z"),
  editedAt: null,
} as unknown as Registration;

describe("personRow", () => {
  it("gives code, name, gender and age, relation, days and bed", () => {
    expect(personRow(registration, registration.members[0])).toEqual([
      "DM-0140",
      "Harit Patel",
      "Male, 34",
      "Contact",
      "30 Jan, morning",
      "1 Feb, evening",
      "Yes",
    ]);
    expect(personRow(registration, registration.members[1]).slice(3)).toEqual([
      "Spouse",
      "30 Jan, morning",
      "1 Feb, evening",
      "No",
    ]);
  });

  it("says no bed for anyone when the registration asked for none", () => {
    const none = { accommodationRequired: false } as Registration;
    expect(personRow(none, registration.members[0])[6]).toBe("No");
  });
});

describe("travelLines", () => {
  it("lists vehicles with their plates", () => {
    expect(travelLines(registration.travel)).toEqual([
      "Personal vehicle",
      "Vehicles: 1 (GJ01AB1234)",
    ]);
  });

  it("gives a train's arrival, pickup and drop", () => {
    const train = {
      ...noTravel,
      mode: "train",
      reference: "12009",
      station: "Kalupur",
      arrivalTime: "08:30",
      needsPickup: true,
      needsDrop: true,
      departureMode: "train",
      departureReference: "12010",
      departureStation: "Kalupur",
      departureTime: "18:00",
    } as unknown as Registration["travel"];
    expect(travelLines(train)).toEqual([
      "Train",
      "Arriving: 12009 to Kalupur at 08:30",
      "Pickup in Ahmedabad: Yes",
      "Drop when leaving: Yes - Train 12010 from Kalupur at 18:00",
    ]);
  });

  it("gives each person's own when the party travels separately", () => {
    const separate = {
      ...registration,
      travel: { ...noTravel, mode: "separate" },
      members: [
        member({ travel: { ...noTravel, mode: "mandal_bus" } }),
        member({ fullName: "Riya Patel", travel: null }),
      ],
    } as unknown as Registration;
    expect(travelSection(separate)).toEqual(["Harit Patel: Mandal bus", "Riya Patel: Not given"]);
  });
});

describe("pdfText", () => {
  it("keeps Latin-1 and dashes, and marks what Helvetica cannot draw", () => {
    expect(pdfText("José – Patel")).toBe("José – Patel");
    expect(pdfText("હરિત")).toBe("????");
  });
});

describe("registrationPdf", () => {
  it("renders a PDF", async () => {
    const pdf = await registrationPdf(registration);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("runs a big family onto more pages rather than off the bottom", async () => {
    const big = {
      ...registration,
      members: Array.from({ length: 40 }, (_, i) => member({ id: `m${i}`, isPrimary: i === 0 })),
    } as unknown as Registration;
    const pages = (await registrationPdf(big)).toString("latin1").match(/\/Type \/Page\b/g) ?? [];
    expect(pages.length).toBeGreaterThan(1);
  });
});

describe("the signed link", () => {
  const id = "65f1a2b3c4d5e6f7a8b9c0d1";
  afterEach(() => vi.unstubAllEnvs());
  const sign = () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "secret");
    vi.stubEnv("BETTER_AUTH_URL", "https://api.example.org");
  };

  it("opens the registration it was made for, with or without .pdf", () => {
    sign();
    const token = pdfToken(id)!;
    expect(idFromPdfToken(token)).toBe(id);
    expect(idFromPdfToken(`${token}.pdf`)).toBe(id);
    expect(registrationPdfUrl(id)).toBe(
      `https://api.example.org/api/registrations/pdf/${token}.pdf`
    );
  });

  it("refuses another id under the same signature, or another server's", () => {
    sign();
    const signature = pdfToken(id)!.split("-")[1];
    expect(idFromPdfToken(`65f1a2b3c4d5e6f7a8b9c0d2-${signature}`)).toBeNull();
    expect(idFromPdfToken("not-a-token")).toBeNull();
    const token = pdfToken(id)!;
    vi.stubEnv("BETTER_AUTH_SECRET", "another");
    expect(idFromPdfToken(token)).toBeNull();
  });

  it("makes no link without a real secret", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "replace-me");
    vi.stubEnv("BETTER_AUTH_URL", "https://api.example.org");
    expect(registrationPdfUrl(id)).toBeNull();
  });
});
