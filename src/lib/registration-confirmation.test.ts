/**
 * The confirmation's four values are what a devotee reads on WhatsApp, in the
 * language they registered in, and Meta refuses a send whose values do not
 * match the template's count. These pin the order, the Gujarati dates, and
 * that a refused or impossible send never reaches the registration's request.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./usage", () => ({ recordUsage: vi.fn() }));
vi.mock("./whatsapp-log", () => ({ logSentMessage: vi.fn() }));

import type { Registration } from "@prisma/client";

import {
  confirmationLang,
  confirmationValues,
  sendRegistrationConfirmation,
} from "./registration-confirmation";

const member = (extra: object) => ({
  id: "m1",
  fullName: "Harit Patel",
  firstName: "Harit",
  isPrimary: true,
  ...extra,
});

const registration = {
  id: "65f1a2b3c4d5e6f7a8b9c0d1",
  code: "DM-F-0031",
  contactMobile: "+919876543210",
  isSample: false,
  members: [
    member({}),
    member({ id: "m2", fullName: "Riya Patel", firstName: "Riya", isPrimary: false }),
  ],
  arrival: { date: "2027-01-30", slot: "morning" },
  departure: { date: "2027-02-01", slot: "evening" },
} as unknown as Registration;

describe("confirmationValues", () => {
  it("gives first name, code, people and stay, in that order", () => {
    expect(confirmationValues(registration, "en")).toEqual([
      "Harit",
      "DM-F-0031",
      "2",
      "30 Jan, morning – 1 Feb, evening",
    ]);
  });

  it("adds the link to everyone's details after the stay, in the form's language", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "secret");
    vi.stubEnv("BETTER_AUTH_URL", "https://api.example.org/");
    const link =
      /https:\/\/api\.example\.org\/api\/registrations\/pdf\/65f1a2b3c4d5e6f7a8b9c0d1-[0-9a-f]{32}\.pdf$/;
    const [en, gu] = [
      confirmationValues(registration, "en")[3],
      confirmationValues(registration, "gu")[3],
    ];
    expect(en).toMatch(/^30 Jan, morning – 1 Feb, evening\. Everyone's details: /);
    expect(en).toMatch(link);
    expect(gu).toMatch(/^30 જાન્યુ, સવાર – 1 ફેબ્રુ, સાંજ\. બધાની વિગતો: /);
    vi.unstubAllEnvs();
  });

  it("writes the stay in Gujarati for a Gujarati form", () => {
    expect(confirmationValues(registration, "gu")[3]).toBe("30 જાન્યુ, સવાર – 1 ફેબ્રુ, સાંજ");
  });

  it("falls back to the full name's first word on older rows without firstName", () => {
    const old = {
      ...registration,
      members: [member({ firstName: null })],
    } as unknown as Registration;
    expect(confirmationValues(old, "en")[0]).toBe("Harit");
  });
});

describe("confirmationLang", () => {
  it("takes en or gu and defaults anything else", () => {
    expect(confirmationLang("gu")).toBe("gu");
    expect(confirmationLang("hi")).toBe("en");
    expect(confirmationLang(undefined)).toBe("en");
  });
});

describe("sendRegistrationConfirmation", () => {
  const fetchMock = vi.fn();
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fetchMock.mockReset();
  });
  const configure = () => {
    vi.stubEnv("WA_ACCESS_TOKEN", "token");
    vi.stubEnv("WA_PHONE_NUMBER_ID", "123");
    vi.stubGlobal("fetch", fetchMock);
  };

  it("sends the template to the contact with the four values", async () => {
    configure();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: "wamid.X" }] }),
    });
    await sendRegistrationConfirmation(registration, "gu");
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.to).toBe("919876543210");
    expect(payload.template.name).toBe("registration_confirmation");
    expect(payload.template.language.code).toBe("gu");
    expect(payload.template.components[0].parameters).toHaveLength(4);
  });

  it("never throws when Meta refuses", async () => {
    configure();
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { code: 132000, message: "x" } }),
    });
    await expect(sendRegistrationConfirmation(registration, "en")).resolves.toBeUndefined();
  });

  it("sends nothing for dummy data, or without WhatsApp configured", async () => {
    configure();
    await sendRegistrationConfirmation({ ...registration, isSample: true }, "en");
    vi.stubEnv("WA_ACCESS_TOKEN", "");
    await sendRegistrationConfirmation(registration, "en");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
