import { Request, Response } from "express";
import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { AiError, converse, isAiConfigured } from "../lib/ai/claude";
import { ASSISTANT_TOOLS, assistantSystem, includeDummy, retentionCutoff } from "../lib/assistant";
import { prisma } from "../utils/db";

/**
 * The Assistant screen. Admin only (adminRoutes).
 *
 * Chats are stored here (`AssistantChat`), private to the admin who asked.
 * One turn: the browser sends only what is new — a question, or the results
 * of the tools it ran — and the server adds it to the stored conversation,
 * sends the whole conversation to the model, stores the reply and returns it.
 * The model's turns are only ever written by the server, so a chat cannot be
 * edited from the browser (an edited turn would also void its thinking).
 *
 * Cards worth sharing (reports, meal counts, accommodation, guests) are also
 * kept as "Recently asked by the team" (`AssistantAsk`): their recipe, which
 * the other admins open with live data and no model call.
 */

/** A chat this long is refused; "New chat" starts over. */
const MAX_MESSAGES = 120;
const HISTORY_SIZE = 50;
const TEAM_SIZE = 20;

const objectId = z.string().regex(/^[a-f\d]{24}$/i);

/**
 * Content blocks are passed through as sent; the API checks their shape
 * itself. Only roles and sizes are checked here.
 */
const block = z.record(z.string(), z.unknown());

const cardEntry = z.object({
  card: z.record(z.string(), z.unknown()),
  title: z.string().trim().min(1).max(120),
  /** The recipe without its title, set on cards the team may reuse. */
  shareKey: z.string().max(8_000).optional(),
});

const turnSchema = z.object({
  chatId: objectId,
  messages: z
    .array(
      z.object({
        role: z.literal("user"),
        content: z.union([z.string().trim().min(1).max(4_000), z.array(block).min(1).max(40)]),
        cards: z.record(z.string(), cardEntry).optional(),
      })
    )
    .min(1)
    .max(4),
  tools: z
    .array(
      z.object({
        name: z.enum(ASSISTANT_TOOLS),
        description: z.string().max(4_000),
        input_schema: z.object({ type: z.literal("object") }).passthrough(),
      })
    )
    .max(ASSISTANT_TOOLS.length),
});

type Stored = { role: string; content: unknown };
type Block = { type?: unknown; id?: unknown; tool_use_id?: unknown; text?: unknown };

const blocksOf = (content: unknown): Block[] =>
  Array.isArray(content) ? (content as Block[]) : [];

/** The admin's question in a stored message, if it holds one. */
const questionIn = (message: Stored): string | null =>
  message.role !== "user"
    ? null
    : typeof message.content === "string"
      ? message.content
      : blocksOf(message.content)
          .filter(b => b.type === "text" && typeof b.text === "string")
          .map(b => b.text as string)
          .join(" ") || null;

/** "Who is arriving by train on 29 Jan? I need…" — for the History list. */
const titleOf = (question: string) => {
  const flat = question.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 79).trimEnd()}…` : flat;
};

/** A chat of the caller's that has not expired. */
const findChat = (req: Request, id: string) =>
  prisma.assistantChat.findFirst({
    where: { id, userId: req.user.id, updatedAt: { gte: retentionCutoff() } },
  });

const notFound = (res: Response) =>
  res.status(404).json({
    success: false,
    code: "CHAT_NOT_FOUND",
    message: "That chat has expired or was deleted. Start a new one.",
  });

const status = async (_req: Request, res: Response): Promise<void> => {
  res.status(200).json({
    success: true,
    data: { configured: isAiConfigured(), includeDummy: includeDummy() },
  });
};

/** Starts an empty chat. Its title is the first question, set on the first turn. */
const createChat = async (req: Request, res: Response): Promise<void> => {
  const chat = await prisma.assistantChat.create({
    data: { userId: req.user.id, title: "New chat", messages: [] },
    select: { id: true },
  });
  res.status(201).json({ success: true, data: chat });
};

/** The caller's chats, last used first. */
const listChats = async (req: Request, res: Response): Promise<void> => {
  const chats = await prisma.assistantChat.findMany({
    where: { userId: req.user.id, updatedAt: { gte: retentionCutoff() }, questions: { gt: 0 } },
    select: { id: true, title: true, questions: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
    take: HISTORY_SIZE,
  });
  res.status(200).json({ success: true, data: chats });
};

/**
 * One chat, for the screen: what it needs to redraw the conversation —
 * questions, answers, which tools ran and whether they worked, and the cards.
 * Thinking and the tool results' rows stay on the server.
 */
const getChat = async (req: Request, res: Response): Promise<void> => {
  const id = objectId.safeParse(req.params.id);
  const chat = id.success ? await findChat(req, id.data) : null;
  if (!chat) {
    notFound(res);
    return;
  }
  const messages = chat.messages.map(m => ({
    role: m.role,
    content:
      typeof m.content === "string"
        ? m.content
        : blocksOf(m.content).flatMap((b): unknown[] => {
            const full = b as Record<string, unknown>;
            if (b.type === "text") return [{ type: "text", text: full.text }];
            if (b.type === "tool_use")
              return [{ type: "tool_use", id: full.id, name: full.name, input: full.input }];
            if (b.type === "tool_result")
              return [
                { type: "tool_result", tool_use_id: full.tool_use_id, is_error: !!full.is_error },
              ];
            return [];
          }),
    cards: m.cards ?? undefined,
  }));
  res.status(200).json({
    success: true,
    data: { id: chat.id, title: chat.title, updatedAt: chat.updatedAt, messages },
  });
};

const deleteChat = async (req: Request, res: Response): Promise<void> => {
  const id = objectId.safeParse(req.params.id);
  if (id.success)
    await prisma.assistantChat.deleteMany({ where: { id: id.data, userId: req.user.id } });
  res.status(200).json({ success: true, data: { id: req.params.id } });
};

/** "Recently asked by the team", newest first. */
const team = async (req: Request, res: Response): Promise<void> => {
  const asks = await prisma.assistantAsk.findMany({
    where: { askedAt: { gte: retentionCutoff() } },
    orderBy: { askedAt: "desc" },
    take: TEAM_SIZE,
  });
  res.status(200).json({
    success: true,
    data: asks.map(a => ({
      id: a.id,
      question: a.question,
      title: a.title,
      card: a.card,
      askedByName: a.askedById === req.user.id ? "You" : a.askedByName,
      askedAt: a.askedAt,
      timesAsked: a.timesAsked,
    })),
  });
};

const turn = async (req: Request, res: Response): Promise<void> => {
  if (!isAiConfigured()) {
    res.status(503).json({
      success: false,
      code: "AI_NOT_CONFIGURED",
      message: "The Assistant is not set up on this server yet (ANTHROPIC_API_KEY is missing).",
    });
    return;
  }

  const parsed = turnSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      code: "VALIDATION_ERROR",
      message: "That message could not be read. Start a new chat.",
    });
    return;
  }
  const { chatId, messages: incoming, tools } = parsed.data;

  const chat = await findChat(req, chatId);
  if (!chat) {
    notFound(res);
    return;
  }
  const stored: Stored[] = chat.messages;

  if (stored.length + incoming.length + 2 > MAX_MESSAGES) {
    res.status(409).json({
      success: false,
      code: "CHAT_TOO_LONG",
      message: "This chat is long enough. Start a new chat to keep going.",
    });
    return;
  }

  const now = new Date();
  const toStore: Prisma.AssistantMessageCreateInput[] = [];

  // A turn that asked for tools whose results never arrived (the browser
  // closed, the network dropped) would make every later turn fail: answer
  // the missing ones as failed.
  const last = stored.at(-1);
  if (last?.role === "assistant") {
    const answered = new Set(
      blocksOf(incoming[0].content)
        .filter(b => b.type === "tool_result")
        .map(b => b.tool_use_id)
    );
    const missing = blocksOf(last.content).filter(
      b => b.type === "tool_use" && !answered.has(b.id)
    );
    if (missing.length)
      toStore.push({
        role: "user",
        content: missing.map(b => ({
          type: "tool_result",
          tool_use_id: b.id as string,
          is_error: true,
          content: "No result: the admin's screen did not send one back.",
        })),
        at: now,
      });
  }

  for (const message of incoming)
    toStore.push({
      role: "user",
      content: message.content as Prisma.InputJsonValue,
      cards: message.cards
        ? (Object.fromEntries(
            Object.entries(message.cards).map(([toolUseId, entry]) => [
              toolUseId,
              { card: entry.card, title: entry.title },
            ])
          ) as Prisma.InputJsonValue)
        : undefined,
      at: now,
    });

  const newQuestions = toStore.map(questionIn).filter((q): q is string => !!q);
  const latestQuestion =
    newQuestions.at(-1) ?? [...stored].reverse().map(questionIn).find(Boolean) ?? "";

  await prisma.assistantChat.update({
    where: { id: chat.id },
    data: {
      messages: { push: toStore },
      ...(newQuestions.length
        ? {
            questions: { increment: newQuestions.length },
            ...(chat.questions === 0 ? { title: titleOf(newQuestions[0]) } : {}),
          }
        : {}),
    },
  });

  // Cards the team may reuse: one entry per recipe, moved to the top when
  // asked again.
  for (const message of incoming)
    for (const entry of Object.values(message.cards ?? {})) {
      if (!entry.shareKey || !latestQuestion) continue;
      const key = createHash("sha256").update(entry.shareKey).digest("hex");
      const fields = {
        question: titleOf(latestQuestion),
        title: entry.title,
        card: entry.card as Prisma.InputJsonValue,
        askedById: req.user.id,
        askedByName: req.user.name,
        askedAt: now,
      };
      await prisma.assistantAsk.upsert({
        where: { key },
        create: { key, ...fields },
        update: { ...fields, timesAsked: { increment: 1 } },
      });
    }

  try {
    const reply = await converse({
      system: assistantSystem(),
      messages: [...stored, ...toStore].map(m => ({
        role: m.role as "user" | "assistant",
        content: m.content as Anthropic.MessageParam["content"],
      })),
      tools: tools as Anthropic.Tool[],
      userId: req.user?.id,
      purpose: "assistant",
    });
    await prisma.assistantChat.update({
      where: { id: chat.id },
      data: {
        messages: {
          push: {
            role: "assistant",
            content: reply.content as unknown as Prisma.InputJsonValue,
            at: new Date(),
          },
        },
      },
    });
    res.status(200).json({
      success: true,
      data: { content: reply.content, stopReason: reply.stop_reason },
    });
  } catch (error) {
    if (!(error instanceof AiError)) throw error;
    console.error("[assistant]", error.message);
    res.status(502).json({
      success: false,
      code: "AI_FAILED",
      message: error.permanent
        ? "The Assistant could not answer that. Try rephrasing, or start a new chat."
        : "The Assistant is busy right now. Try again in a moment.",
    });
  }
};

export const assistantController = {
  status,
  turn,
  createChat,
  listChats,
  getChat,
  deleteChat,
  team,
};
