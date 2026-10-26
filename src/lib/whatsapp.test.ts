/**
 * The Cloud API request is built by hand from Meta's docs, and nothing else
 * checks its shape until a real message fails to arrive. These tests pin the
 * payload (bare-digit numbers, body parameters, the button that also carries
 * an Authentication template's code), which refusals are retried, the
 * fall-back to the default language when a translation is missing, and that
 * only a send Meta accepted reaches the usage ledger.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./usage", () => ({ recordUsage: vi.fn() }));
vi.mock("./whatsapp-log", () => ({ logSentMessage: vi.fn() }));

import { recordUsage } from "./usage";
import { logSentMessage } from "./whatsapp-log";
import {
  WhatsAppSendError,
  WhatsAppUnavailableError,
  isWhatsAppConfigured,
  sendWhatsAppTemplate,
  templateLanguageCode,
  toWhatsAppNumber,
} from "./whatsapp";

const fetchMock = vi.fn();

const reply = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
const accepted = (id = "wamid.ABC") => reply(200, { messages: [{ id }] });
const refused = (status: number, code: number, message = "nope") =>
  reply(status, { error: { message, code } });

const send = (extra: Partial<Parameters<typeof sendWhatsAppTemplate>[0]> = {}) =>
  sendWhatsAppTemplate({
    to: "+919876543210",
    template: "team_invite",
    body: ["Harit Patel", "Dashabdi Mahotsav"],
    buttonUrl: "tok_123",
    usage: { endpoint: "whatsapp:admin_invite", userId: "u1" },
    ...extra,
  });

/** Lets the backoff sleeps elapse instantly while `promise` runs. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  const result = promise.then(
    value => ({ value }),
    error => ({ error })
  );
  await vi.runAllTimersAsync();
  const outcome = await result;
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

const bodyOf = (call: number) => JSON.parse(fetchMock.mock.calls[call][1].body);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("WA_ACCESS_TOKEN", "EAAG_token");
  vi.stubEnv("WA_PHONE_NUMBER_ID", "1391824954010292");
  vi.stubEnv("WA_GRAPH_VERSION", "v25.0");
  vi.stubEnv("WA_DEFAULT_LANG", "");
  vi.stubEnv("WA_LANG_CODE_EN", "");
  vi.stubEnv("WA_LANG_CODE_GU", "");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  fetchMock.mockReset();
});

describe("toWhatsAppNumber", () => {
  it.each([
    ["+919876543210", "919876543210"],
    ["+91 98765 43210", "919876543210"],
    ["9876543210", "919876543210"],
    ["09876543210", "919876543210"],
    ["00447700900123", "447700900123"],
    ["+1 (555) 667-0274", "15556670274"],
  ])("%s → %s", (input, expected) => {
    expect(toWhatsAppNumber(input)).toBe(expected);
  });

  it.each(["", "12345", "+1234567890123456"])("refuses %j", input => {
    expect(() => toWhatsAppNumber(input)).toThrow(WhatsAppSendError);
  });
});

describe("isWhatsAppConfigured", () => {
  it("is false while the token is the .env.example placeholder", () => {
    vi.stubEnv("WA_ACCESS_TOKEN", "replace-me");
    expect(isWhatsAppConfigured()).toBe(false);
  });

  it("is false without a phone number id", () => {
    vi.stubEnv("WA_PHONE_NUMBER_ID", "");
    expect(isWhatsAppConfigured()).toBe(false);
  });

  it("is true with both", () => {
    expect(isWhatsAppConfigured()).toBe(true);
  });
});

describe("templateLanguageCode", () => {
  it("is the app's own code unless .env names Meta's", () => {
    expect(templateLanguageCode("gu")).toBe("gu");
    vi.stubEnv("WA_LANG_CODE_EN", "en_US");
    expect(templateLanguageCode("en")).toBe("en_US");
  });
});

describe("sendWhatsAppTemplate", () => {
  it("refuses before any request when not configured", async () => {
    vi.stubEnv("WA_ACCESS_TOKEN", "replace-me");
    await expect(send()).rejects.toBeInstanceOf(WhatsAppUnavailableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the template in the Cloud API's shape and returns the message id", async () => {
    fetchMock.mockResolvedValue(accepted("wamid.XYZ"));
    await expect(send()).resolves.toEqual({ waMessageId: "wamid.XYZ" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v25.0/1391824954010292/messages");
    expect(init.headers.Authorization).toBe("Bearer EAAG_token");
    expect(bodyOf(0)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "919876543210",
      type: "template",
      template: {
        name: "team_invite",
        language: { code: "en" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "Harit Patel" },
              { type: "text", text: "Dashabdi Mahotsav" },
            ],
          },
          {
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [{ type: "text", text: "tok_123" }],
          },
        ],
      },
    });
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "whatsapp:admin_invite", userId: "u1" })
    );
    expect(logSentMessage).toHaveBeenCalledWith({
      waMessageId: "wamid.XYZ",
      to: "919876543210",
      template: "team_invite",
      language: "en",
      purpose: "whatsapp:admin_invite",
    });
  });

  it("sends an OTP with the code in the body and on the copy-code button", async () => {
    fetchMock.mockResolvedValue(accepted());
    await send({ template: "anoopam_otp", body: ["042917"], buttonUrl: "042917", lang: "gu" });
    const { template } = bodyOf(0);
    expect(template.language).toEqual({ code: "gu" });
    expect(template.components[0].parameters[0].text).toBe("042917");
    expect(template.components[1].parameters[0].text).toBe("042917");
  });

  it("leaves out components the template has no placeholders for", async () => {
    fetchMock.mockResolvedValue(accepted());
    await send({ template: "hello_world", languageCode: "en_US", body: [], buttonUrl: undefined });
    expect(bodyOf(0).template).toEqual({
      name: "hello_world",
      language: { code: "en_US" },
      components: [],
    });
  });

  it("retries a rate limit, then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(refused(400, 130429, "Rate limit hit"))
      .mockResolvedValueOnce(accepted());
    await expect(settle(send())).resolves.toEqual({ waMessageId: "wamid.ABC" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recordUsage).toHaveBeenCalledTimes(1);
  });

  it("retries a 5xx and a dropped connection, then gives up", async () => {
    fetchMock
      .mockResolvedValueOnce(refused(503, 2, "Service unavailable"))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(refused(500, 1, "Unknown error"));
    const error = await settle(send()).catch(e => e);
    expect(error).toBeInstanceOf(WhatsAppSendError);
    expect(error.code).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(recordUsage).not.toHaveBeenCalled();
    expect(logSentMessage).not.toHaveBeenCalled();
  });

  it("does not retry a refusal that will not change", async () => {
    fetchMock.mockResolvedValue(refused(400, 132000, "Number of parameters does not match"));
    await expect(send()).rejects.toThrow("(132000): Number of parameters does not match");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("names an expired access token plainly", async () => {
    fetchMock.mockResolvedValue(refused(401, 190, "Session has expired"));
    await expect(send()).rejects.toThrow("WA_ACCESS_TOKEN is expired or invalid");
  });

  it("falls back to the default language when the template has no copy in the reader's", async () => {
    fetchMock
      .mockResolvedValueOnce(refused(404, 132001, "Template name does not exist in the translation"))
      .mockResolvedValueOnce(accepted());
    await send({ lang: "gu" });
    expect(bodyOf(0).template.language.code).toBe("gu");
    expect(bodyOf(1).template.language.code).toBe("en");
    // The log says which language actually went out.
    expect(logSentMessage).toHaveBeenCalledWith(expect.objectContaining({ language: "en" }));
  });

  it("does not fall back when the default language itself is missing", async () => {
    fetchMock.mockResolvedValue(refused(404, 132001, "Template name does not exist"));
    await expect(send({ lang: "en" })).rejects.toThrow("132001");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats a 200 without a message id, or an HTML error page, as a failure", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, {}));
    await expect(send()).rejects.toBeInstanceOf(WhatsAppSendError);
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => {
        throw new SyntaxError("not json");
      },
    } as unknown as Response);
    await expect(send()).rejects.toThrow("HTTP 400");
  });
});
