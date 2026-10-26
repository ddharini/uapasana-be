/**
 * The parts of OTP verification that are pure: the code, its keyed hash, the
 * constant-time compare, and what `/otp/send` accepts. The limits and the
 * single-use rules live in queries on `PhoneVerification` (otpController).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/db", () => ({ prisma: {} }));

import { hashOtpCode, newOtpCode, sameHash, sendOtpSchema } from "./otp";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("newOtpCode", () => {
  it("is always six digits, leading zeros kept", () => {
    for (let i = 0; i < 200; i++) expect(newOtpCode()).toMatch(/^\d{6}$/);
  });
});

describe("hashOtpCode", () => {
  it("is bound to the number, so a code for one cannot match another's row", () => {
    expect(hashOtpCode("+919876543210", "123456")).not.toBe(hashOtpCode("+919876543211", "123456"));
  });

  it("is keyed with the server secret", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "one");
    const first = hashOtpCode("+919876543210", "123456");
    vi.stubEnv("BETTER_AUTH_SECRET", "two");
    expect(hashOtpCode("+919876543210", "123456")).not.toBe(first);
  });
});

describe("sameHash", () => {
  const hash = hashOtpCode("+919876543210", "123456");

  it("matches the same code and refuses another", () => {
    expect(sameHash(hash, hashOtpCode("+919876543210", "123456"))).toBe(true);
    expect(sameHash(hash, hashOtpCode("+919876543210", "123457"))).toBe(false);
  });

  it("refuses digests of different lengths instead of throwing", () => {
    expect(sameHash(hash, "abcd")).toBe(false);
  });
});

describe("sendOtpSchema", () => {
  it("takes an optional language, English or Gujarati only", () => {
    expect(sendOtpSchema.parse({ mobile: "+919876543210" }).lang).toBeUndefined();
    expect(sendOtpSchema.parse({ mobile: "+919876543210", lang: "gu" }).lang).toBe("gu");
    expect(sendOtpSchema.safeParse({ mobile: "+919876543210", lang: "hi" }).success).toBe(false);
  });
});
