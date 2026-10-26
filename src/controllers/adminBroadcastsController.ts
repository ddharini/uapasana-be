import { Request, Response } from "express";
import { z } from "zod";

import {
  MAX_RECIPIENTS,
  MAX_TEXT_LENGTH,
  VARIABLE_SOURCES,
  announcementTemplate,
  chooseRecipients,
  dailyLimit,
  pickSchema,
  renderBody,
  sendableTemplates,
  startBroadcast,
  variableSpecSchema,
} from "../lib/broadcasts";
import {
  WHATSAPP_PRICE_INR,
  WhatsAppSendError,
  WhatsAppUnavailableError,
  listMessageTemplates,
} from "../lib/whatsapp";
import { prisma } from "../utils/db";

/**
 * Send messages (/admin/messages): admin only (adminRoutes).
 *
 *   GET  /admin/broadcasts/templates      what can be sent, prices, the daily limit
 *   POST /admin/broadcasts                { dryRun } → the count; else starts sending
 *   GET  /admin/broadcasts                past sends, newest first
 *   GET  /admin/broadcasts/:id            one send, with delivery counts
 *   GET  /admin/broadcasts/:id/recipients who it went to, 100 a page
 *   POST /admin/broadcasts/:id/stop       no more messages from it
 *   POST /admin/broadcasts/:id/resume     carry on after a pause
 *
 * The rules are src/lib/broadcasts.ts.
 */

function fail(res: Response, status: number, code: string, message: string) {
  res.status(status).json({ success: false, code, message });
}

/** Meta's answer to "which templates", or a reply saying why there is none. */
async function templatesOrFail(res: Response) {
  try {
    return sendableTemplates(await listMessageTemplates());
  } catch (error) {
    if (error instanceof WhatsAppUnavailableError) {
      fail(
        res,
        503,
        "WHATSAPP_NOT_CONFIGURED",
        "WhatsApp is not set up on the server (WA_WABA_ID, WA_ACCESS_TOKEN)."
      );
    } else {
      console.error("[Broadcast] Could not list templates:", error);
      fail(
        res,
        502,
        "TEMPLATES_UNAVAILABLE",
        error instanceof WhatsAppSendError
          ? error.message
          : "Could not load the templates from Meta. Try again."
      );
    }
    return null;
  }
}

const templates = async (_req: Request, res: Response): Promise<void> => {
  const list = await templatesOrFail(res);
  if (!list) return;
  res.status(200).json({
    success: true,
    data: {
      templates: list,
      announcement: announcementTemplate(),
      sources: VARIABLE_SOURCES,
      priceInr: WHATSAPP_PRICE_INR,
      dailyLimit: dailyLimit(),
      maxRecipients: MAX_RECIPIENTS,
      maxTextLength: MAX_TEXT_LENGTH,
    },
  });
};

const createSchema = z.object({
  template: z.string().min(1).max(512),
  language: z.string().min(2).max(15),
  variables: z.array(variableSpecSchema).max(20),
  picks: z
    .array(pickSchema)
    .min(1, "Pick at least one person")
    .max(MAX_RECIPIENTS * 3),
  /** The filters, as words, to show beside the send later. */
  summary: z.string().trim().max(1000).default(""),
  /** Only count: nothing is saved or sent. */
  dryRun: z.boolean().optional(),
});

const create = async (req: Request, res: Response): Promise<void> => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      code: "VALIDATION_ERROR",
      message: parsed.error.issues[0]?.message ?? "Invalid send",
      errors: parsed.error.issues.map(i => ({ path: i.path.join("."), message: i.message })),
    });
    return;
  }
  const input = parsed.data;

  // Checked against Meta now, not against what the browser loaded earlier: a
  // template can be paused or deleted in between.
  const list = await templatesOrFail(res);
  if (!list) return;
  const template = list.find(t => t.name === input.template);
  const language = template?.languages.find(l => l.code === input.language);
  if (!template || !language) {
    return fail(
      res,
      400,
      "TEMPLATE_UNAVAILABLE",
      "That template is not approved in that language (any more)."
    );
  }
  if (input.variables.length !== language.variables) {
    return fail(
      res,
      400,
      "VALIDATION_ERROR",
      `This template has ${language.variables} blank(s) to fill.`
    );
  }

  const registrations = await prisma.registration.findMany({
    where: { id: { in: [...new Set(input.picks.map(p => p.registrationId))] } },
  });
  const { recipients, skipped, tooLong } = chooseRecipients(
    registrations,
    input.picks,
    input.variables,
    language.body
  );
  if (tooLong) {
    return fail(
      res,
      400,
      "MESSAGE_TOO_LONG",
      `The message for ${tooLong} is over WhatsApp's 1024 characters. Shorten the text.`
    );
  }
  if (recipients.length === 0) {
    return fail(
      res,
      400,
      "NO_RECIPIENTS",
      "None of the people picked has a WhatsApp number to send to."
    );
  }
  if (recipients.length > MAX_RECIPIENTS) {
    return fail(
      res,
      400,
      "TOO_MANY_RECIPIENTS",
      `At most ${MAX_RECIPIENTS} numbers in one send. Narrow the filters.`
    );
  }

  const priceInr = WHATSAPP_PRICE_INR[template.category] ?? WHATSAPP_PRICE_INR.UTILITY;
  const estimate = {
    total: recipients.length,
    skipped,
    category: template.category,
    costInr: Math.round(recipients.length * priceInr * 100) / 100,
    dailyLimit: dailyLimit(),
    preview: renderBody(language.body, recipients[0].values),
    previewFor: recipients[0].name,
  };
  if (input.dryRun) {
    res.status(200).json({ success: true, data: estimate });
    return;
  }

  const broadcast = await prisma.whatsAppBroadcast.create({
    data: {
      template: template.name,
      language: language.code,
      category: template.category,
      bodyText: language.body,
      variables: input.variables,
      summary: input.summary,
      total: recipients.length,
      skipped,
      createdById: req.user.id,
      createdByName: req.user.name,
    },
  });
  await prisma.whatsAppBroadcastRecipient.createMany({
    data: recipients.map(r => ({ ...r, broadcastId: broadcast.id })),
  });
  startBroadcast(broadcast.id);

  res.status(201).json({ success: true, data: { id: broadcast.id, ...estimate } });
};

const toBroadcastDto = (
  b: Awaited<ReturnType<typeof prisma.whatsAppBroadcast.findFirstOrThrow>>
) => ({
  id: b.id,
  template: b.template,
  language: b.language,
  category: b.category,
  bodyText: b.bodyText,
  variables: b.variables,
  summary: b.summary,
  status: b.status,
  pauseReason: b.pauseReason ?? undefined,
  total: b.total,
  accepted: b.accepted,
  failed: b.failed,
  skipped: b.skipped,
  createdByName: b.createdByName,
  createdAt: b.createdAt.toISOString(),
  finishedAt: b.finishedAt?.toISOString(),
});

const PAGE_SIZE = 50;
const RECIPIENT_PAGE_SIZE = 100;
const pageSchema = z.coerce.number().int().min(1).max(10_000).catch(1);
const idSchema = z.string().regex(/^[a-f\d]{24}$/i);

const list = async (req: Request, res: Response): Promise<void> => {
  const page = pageSchema.parse(req.query.page);
  const [rows, total] = await Promise.all([
    prisma.whatsAppBroadcast.findMany({
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.whatsAppBroadcast.count(),
  ]);
  res.status(200).json({
    success: true,
    data: { broadcasts: rows.map(toBroadcastDto), total, page, pageSize: PAGE_SIZE },
  });
};

async function findBroadcast(req: Request, res: Response) {
  const id = idSchema.safeParse(req.params.id);
  const broadcast = id.success
    ? await prisma.whatsAppBroadcast.findUnique({ where: { id: id.data } })
    : null;
  if (!broadcast) fail(res, 404, "NOT_FOUND", "No such send");
  return broadcast;
}

const getOne = async (req: Request, res: Response): Promise<void> => {
  const broadcast = await findBroadcast(req, res);
  if (!broadcast) return;
  // What Meta reported after accepting each message, from the webhook.
  const sent = await prisma.whatsAppBroadcastRecipient.findMany({
    where: { broadcastId: broadcast.id, waMessageId: { not: null } },
    select: { waMessageId: true },
  });
  const statuses = await prisma.whatsAppMessage.groupBy({
    by: ["status"],
    where: { waMessageId: { in: sent.map(s => s.waMessageId as string) } },
    _count: { _all: true },
  });
  const delivery = Object.fromEntries(statuses.map(s => [s.status, s._count._all]));
  res.status(200).json({ success: true, data: { ...toBroadcastDto(broadcast), delivery } });
};

const recipientsQuery = z.object({
  /** "pending", "accepted", "failed", or a delivery status: "delivered", "read", "undelivered". */
  status: z
    .enum(["pending", "accepted", "failed", "delivered", "read", "undelivered"])
    .optional()
    .catch(undefined),
  page: pageSchema,
});

const recipients = async (req: Request, res: Response): Promise<void> => {
  const broadcast = await findBroadcast(req, res);
  if (!broadcast) return;
  const { status, page } = recipientsQuery.parse(req.query);

  // Delivery statuses live on WhatsAppMessage; turn them into message ids first.
  let byDelivery: string[] | undefined;
  if (status === "delivered" || status === "read" || status === "undelivered") {
    const sent = await prisma.whatsAppBroadcastRecipient.findMany({
      where: { broadcastId: broadcast.id, waMessageId: { not: null } },
      select: { waMessageId: true },
    });
    const wanted =
      status === "undelivered" ? ["failed"] : status === "read" ? ["read"] : ["delivered", "read"];
    const matching = await prisma.whatsAppMessage.findMany({
      where: {
        waMessageId: { in: sent.map(s => s.waMessageId as string) },
        status: { in: wanted },
      },
      select: { waMessageId: true },
    });
    byDelivery = matching.map(m => m.waMessageId);
  }
  const where = {
    broadcastId: broadcast.id,
    ...(byDelivery
      ? { waMessageId: { in: byDelivery } }
      : status === "pending"
        ? { status: { in: ["pending", "sending"] } }
        : status
          ? { status }
          : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.whatsAppBroadcastRecipient.findMany({
      where,
      orderBy: { order: "asc" },
      skip: (page - 1) * RECIPIENT_PAGE_SIZE,
      take: RECIPIENT_PAGE_SIZE,
    }),
    prisma.whatsAppBroadcastRecipient.count({ where }),
  ]);
  const messages = await prisma.whatsAppMessage.findMany({
    where: { waMessageId: { in: rows.flatMap(r => (r.waMessageId ? [r.waMessageId] : [])) } },
    select: { waMessageId: true, status: true, errorCode: true, errorMessage: true },
  });
  const delivery = new Map(messages.map(m => [m.waMessageId, m]));

  res.status(200).json({
    success: true,
    data: {
      recipients: rows.map(r => {
        const message = r.waMessageId ? delivery.get(r.waMessageId) : undefined;
        return {
          id: r.id,
          to: r.to,
          name: r.name,
          registrationId: r.registrationId,
          values: r.values,
          // Where it got to: not yet sent, refused by Meta, or Meta's latest word.
          status:
            r.status === "accepted"
              ? (message?.status ?? "accepted")
              : r.status === "sending"
                ? "pending"
                : r.status,
          errorCode: message?.errorCode ?? r.errorCode ?? undefined,
          errorMessage: message?.errorMessage ?? r.errorMessage ?? undefined,
          sentAt: r.sentAt?.toISOString(),
        };
      }),
      total,
      page,
      pageSize: RECIPIENT_PAGE_SIZE,
    },
  });
};

const stop = async (req: Request, res: Response): Promise<void> => {
  const broadcast = await findBroadcast(req, res);
  if (!broadcast) return;
  await prisma.whatsAppBroadcast.updateMany({
    where: { id: broadcast.id, status: { in: ["sending", "paused"] } },
    data: { status: "cancelled", finishedAt: new Date() },
  });
  res.status(200).json({ success: true, data: { id: broadcast.id } });
};

const resume = async (req: Request, res: Response): Promise<void> => {
  const broadcast = await findBroadcast(req, res);
  if (!broadcast) return;
  const { count } = await prisma.whatsAppBroadcast.updateMany({
    where: { id: broadcast.id, status: "paused" },
    data: { status: "sending", pauseReason: null },
  });
  if (count === 0) return fail(res, 409, "NOT_PAUSED", "Only a paused send can be resumed.");
  startBroadcast(broadcast.id);
  res.status(200).json({ success: true, data: { id: broadcast.id } });
};

export const adminBroadcastsController = {
  templates,
  create,
  list,
  getOne,
  recipients,
  stop,
  resume,
};
