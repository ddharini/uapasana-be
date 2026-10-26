import { GoogleGenAI } from "@google/genai";

import { recordUsage } from "../usage";
import { AiError } from "./claude";

/**
 * The only place this codebase talks to Google.
 *
 * Deliberately the same shape as src/lib/ai/claude.ts — lazy client, metered
 * call, `AiError` on the way out — so the two providers are interchangeable at
 * the call site and neither one's quirks leak into a feature. It reuses
 * `AiError` rather than defining a second error type: a handler catching "the
 * model call failed" should not have to care which vendor failed.
 *
 * The split is by job, not by preference. Claude reasons — the handful of calls
 * where quality decides the outcome. Gemini Flash classifies in bulk — the
 * hundreds of calls where cost per call decides whether the pricing works.
 */

/**
 * Flash is the whole point of this file. If a task here is hard enough to want
 * something bigger, it belongs in claude.ts instead.
 */
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

/**
 * Google's published prices per million tokens, for the usage ledger.
 *
 * Note the promotional rates: 3.8 Flash is $0.75/$3.75 through 2026-12-31 and
 * doubles on 2027-01-01. This table will silently under-report from that date
 * — it is a calendar entry, not a TODO that can be inferred from the code.
 */
const PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {
  "gemini-3.8-flash": { input: 0.75, output: 3.75 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
};

/** Same reasoning as claude.ts: a fixed allowance plus a per-token budget. */
const TIMEOUT_BASE_MS = 30_000;
const TIMEOUT_PER_OUTPUT_TOKEN_MS = 20;

const timeoutFor = (maxTokens: number): number =>
  TIMEOUT_BASE_MS + maxTokens * TIMEOUT_PER_OUTPUT_TOKEN_MS;

let client: GoogleGenAI | null = null;

export const isGeminiConfigured = (): boolean => Boolean(process.env.GOOGLE_API_KEY);

const gemini = (): GoogleGenAI => {
  if (client) return client;
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new AiError("Gemini is not configured on this server. Set GOOGLE_API_KEY.", true);
  }
  client = new GoogleGenAI({ apiKey });
  return client;
};

export interface GeminiOptions {
  system: string;
  user: string;
  maxTokens?: number;
  model?: string;
  userId?: string;
  /** What to label this call in `usage_event.endpoint`, e.g. "classify". */
  purpose: string;
  /**
   * A JSON schema the response must conform to. Google enforces this
   * server-side, which is the reason bulk work belongs here: it removes the
   * repair-the-model's-JSON path entirely, and at hundreds of calls that path
   * would otherwise be hit regularly.
   */
  responseSchema?: Record<string, unknown>;
}

/** One completion, metered. Returns raw text. */
export const complete = async (opts: GeminiOptions): Promise<string> => {
  const model = opts.model ?? DEFAULT_GEMINI_MODEL;
  const maxTokens = opts.maxTokens ?? 4096;

  let response;
  try {
    response = await gemini().models.generateContent({
      model,
      contents: opts.user,
      config: {
        systemInstruction: opts.system,
        maxOutputTokens: maxTokens,
        ...(opts.responseSchema
          ? { responseMimeType: "application/json", responseSchema: opts.responseSchema }
          : {}),
        abortSignal: AbortSignal.timeout(timeoutFor(maxTokens)),
      },
    });
  } catch (error) {
    const status = (error as { status?: number }).status;
    const permanent = status === 400 || status === 401 || status === 403;
    throw new AiError(
      `Gemini call failed${status ? ` (${status})` : ""}: ${(error as Error).message}`,
      permanent
    );
  }

  const usage = response.usageMetadata;
  const price = PRICE_PER_MTOK[model] ?? PRICE_PER_MTOK[DEFAULT_GEMINI_MODEL];
  const inputTokens = usage?.promptTokenCount ?? 0;
  const outputTokens = usage?.candidatesTokenCount ?? 0;

  await recordUsage({
    endpoint: `ai:${opts.purpose}`,
    userId: opts.userId,
    units: inputTokens + outputTokens,
    costUsd: (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output,
  });

  const text = response.text;
  const finishReason = response.candidates?.[0]?.finishReason;

  if (!text) {
    // Same failure shape as an Anthropic refusal: a successful response with
    // nothing in it, usually a safety block or a hit on the output cap.
    throw new AiError(
      `Gemini returned no text on "${opts.purpose}" (finishReason: ${finishReason ?? "unknown"}).`,
      true
    );
  }

  // Truncation is the failure worth naming, because it does not look like one.
  // The reply is well-formed right up to where it stops, so the caller's
  // `JSON.parse` fails and reports "the model did not return usable JSON" —
  // sending whoever reads it to the prompt, when the actual problem is the
  // token budget. Gemini's thinking counts against `maxOutputTokens`, so a
  // budget sized for the JSON alone runs out before the JSON is even started.
  if (finishReason === "MAX_TOKENS") {
    throw new AiError(
      `Gemini ran out of output tokens on "${opts.purpose}" (limit ${maxTokens}, of which ` +
        `thinking is deducted first). Raise maxTokens for this call.`,
      true
    );
  }

  return text;
};

/**
 * A completion parsed as JSON.
 *
 * With `responseSchema` set the parse is guaranteed by the API, so unlike
 * claude.ts's `completeJson` there is no fence-stripping or brace-hunting
 * repair path here. The try/catch stays because a caller may omit the schema.
 */
export const completeJson = async <T>(opts: GeminiOptions): Promise<T> => {
  const raw = await complete(opts);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new AiError(
      `Gemini did not return usable JSON on "${opts.purpose}". First 200 chars: ${raw.slice(0, 200)}`,
      true
    );
  }
};
