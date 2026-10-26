/**
 * The webhook is public, and Meta's payloads are nested several layers deep
 * with most fields optional. These pin the three things that must not
 * regress: a forged or altered body is refused, statuses and replies are read
 * out of Meta's real shapes (including another number's events being left
 * out), and the handshake echoes only for the right token.
 */
import crypto from "crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/db", () => ({ prisma: {} }));
vi.mock("./whatsapp-log", () => ({ registrationIdFor: vi.fn() }));

import { whatsappWebhookController } from "../controllers/whatsappWebhookController";
import { parseWebhook, statusRank, verifySignature } from "./whatsapp-webhook";

const sign = (body: string, secret: string) =>
  "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");

const OUR_NUMBER = "1329621763576319";

/** A webhook body the way Meta sends it, around one `value`. */
const envelope = (value: object, field = "messages") => ({
  object: "whatsapp_business_account",
  entry: [{ id: "2298684017631633", changes: [{ field, value }] }],
});
const metadata = (id = OUR_NUMBER) => ({
  display_phone_number: "919327103949",
  phone_number_id: id,
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("verifySignature", () => {
  const body = Buffer.from('{"object":"whatsapp_business_account"}');

  it("accepts Meta's signature of the exact bytes", () => {
    expect(verifySignature(body, sign(body.toString(), "s3cret"), "s3cret")).toBe(true);
  });

  it("refuses a body changed after signing, a wrong secret, and junk headers", () => {
    const header = sign(body.toString(), "s3cret");
    expect(verifySignature(Buffer.from(body.toString() + " "), header, "s3cret")).toBe(false);
    expect(verifySignature(body, header, "other")).toBe(false);
    expect(verifySignature(body, undefined, "s3cret")).toBe(false);
    expect(verifySignature(body, "sha256=abc", "s3cret")).toBe(false);
    expect(verifySignature(body, header.replace("sha256=", "sha1="), "s3cret")).toBe(false);
    expect(verifySignature(body, header, "")).toBe(false);
  });
});

describe("statusRank", () => {
  it("only lets a message move forward, with failure final", () => {
    const order = ["accepted", "sent", "delivered", "read", "failed"];
    order.forEach((status, i) => expect(statusRank[status]).toBe(i));
  });
});

describe("parseWebhook", () => {
  it("reads delivery statuses, with the reason for a failure", () => {
    const { statuses } = parseWebhook(
      envelope({
        messaging_product: "whatsapp",
        metadata: metadata(),
        statuses: [
          {
            id: "wamid.A",
            status: "delivered",
            timestamp: "1761200000",
            recipient_id: "919909002624",
          },
          {
            id: "wamid.B",
            status: "failed",
            timestamp: "1761200060",
            recipient_id: "919000000000",
            errors: [
              {
                code: 131026,
                title: "Message undeliverable",
                error_data: { details: "Not on WhatsApp" },
              },
            ],
          },
          { id: "wamid.C", status: "deleted", timestamp: "1761200000" },
        ],
      }),
      OUR_NUMBER
    );
    expect(statuses).toEqual([
      { waMessageId: "wamid.A", status: "delivered", at: new Date(1761200000 * 1000) },
      {
        waMessageId: "wamid.B",
        status: "failed",
        at: new Date(1761200060 * 1000),
        errorCode: 131026,
        errorMessage: "Not on WhatsApp",
      },
    ]);
  });

  it("reads a devotee's message, its profile name and its words", () => {
    const message = {
      from: "919909002624",
      id: "wamid.IN1",
      timestamp: "1761200100",
      type: "text",
      text: { body: "  Which gate do we use?  " },
    };
    const { inbound } = parseWebhook(
      envelope({
        metadata: metadata(),
        contacts: [{ profile: { name: "Harit" }, wa_id: "919909002624" }],
        messages: [message],
      }),
      OUR_NUMBER
    );
    expect(inbound).toEqual([
      {
        waMessageId: "wamid.IN1",
        from: "919909002624",
        profileName: "Harit",
        type: "text",
        text: "Which gate do we use?",
        raw: message,
        receivedAt: new Date(1761200100 * 1000),
      },
    ]);
  });

  it.each([
    [{ type: "button", button: { text: "Yes, coming" } }, "Yes, coming"],
    [
      { type: "interactive", interactive: { button_reply: { title: "Change dates" } } },
      "Change dates",
    ],
    [{ type: "image", image: { caption: "Our tickets" } }, "Our tickets"],
    [{ type: "location", location: { name: "Upasana Dham" } }, "Upasana Dham"],
    [{ type: "audio", audio: { id: "123" } }, undefined],
  ])("finds the words in a %j message", (parts, text) => {
    const { inbound } = parseWebhook(
      envelope({
        metadata: metadata(),
        messages: [{ from: "919909002624", id: "wamid.X", timestamp: "1", ...parts }],
      })
    );
    expect(inbound[0].text).toBe(text);
  });

  it("leaves out another number's events, and anything that is not Meta's shape", () => {
    const other = envelope({
      metadata: metadata("999"),
      statuses: [{ id: "wamid.A", status: "sent", timestamp: "1" }],
    });
    expect(parseWebhook(other, OUR_NUMBER).statuses).toEqual([]);
    expect(parseWebhook({ object: "page", entry: [] })).toEqual({
      statuses: [],
      inbound: [],
      notices: [],
    });
    expect(parseWebhook(null).statuses).toEqual([]);
    expect(parseWebhook({ object: "whatsapp_business_account", entry: "nope" }).inbound).toEqual(
      []
    );
  });

  it("passes other kinds of event on as notices for the log", () => {
    const { notices } = parseWebhook(
      envelope(
        { event: "APPROVED", message_template_name: "anoopam_otp" },
        "message_template_status_update"
      )
    );
    expect(notices[0]).toMatch(/^message_template_status_update: .*APPROVED/);
  });
});

/** Just enough of Express's res for the controller. */
function fakeResponse() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    type() {
      return res;
    },
    send(body: unknown) {
      res.body = body;
      return res;
    },
    sendStatus(code: number) {
      res.statusCode = code;
      return res;
    },
  };
  return res;
}

describe("webhook controller", () => {
  const verifyWith = (query: Record<string, string>) => {
    const res = fakeResponse();
    whatsappWebhookController.verify({ query } as never, res as never);
    return res;
  };

  it("echoes the challenge only for the right verify token", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("WA_WEBHOOK_VERIFY_TOKEN", "tok-123");
    const ok = verifyWith({
      "hub.mode": "subscribe",
      "hub.verify_token": "tok-123",
      "hub.challenge": "42",
    });
    expect([ok.statusCode, ok.body]).toEqual([200, "42"]);
    expect(
      verifyWith({ "hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "42" })
        .statusCode
    ).toBe(403);

    vi.stubEnv("WA_WEBHOOK_VERIFY_TOKEN", "");
    expect(
      verifyWith({ "hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "42" })
        .statusCode
    ).toBe(403);
  });

  const receiveWith = (body: string, signature?: string) => {
    const res = fakeResponse();
    const req = { body: Buffer.from(body), header: () => signature };
    whatsappWebhookController.receive(req as never, res as never);
    return res;
  };

  it("refuses unsigned or wrongly signed events, and everything without a secret", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const body = JSON.stringify({ object: "page" });

    vi.stubEnv("WA_APP_SECRET", "");
    expect(receiveWith(body, sign(body, "")).statusCode).toBe(503);

    vi.stubEnv("WA_APP_SECRET", "s3cret");
    expect(receiveWith(body).statusCode).toBe(401);
    expect(receiveWith(body, sign(body, "other")).statusCode).toBe(401);
    expect(receiveWith("not json", sign("not json", "s3cret")).statusCode).toBe(400);
    expect(receiveWith(body, sign(body, "s3cret")).statusCode).toBe(200);
  });
});
