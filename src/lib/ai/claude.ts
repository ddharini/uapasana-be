import Anthropic from "@anthropic-ai/sdk";

import { recordUsage } from "../usage";

/**
 * The only place this codebase talks to Anthropic.
 *
 * One file means "every model call is metered" and "every model call has a
 * timeout" are properties you can check by reading one file, rather than audit
 * across the whole codebase. Keep it that way: call `complete` / `completeJson`
 * from your features instead of constructing a client of your own.
 *
 * The client is built lazily so the app boots without an API key — a call fails
 * with a clear message at the point of use, which is far better than the server
 * refusing to start because a feature nobody is using yet is unconfigured.
 */

/**
 * Sonnet is the sensible default: it is the cheapest model that is good at most
 * production tasks. Pass `model` per call to override
 * — reach for Opus on genuinely hard reasoning, Haiku on classification.
 */
export const DEFAULT_MODEL = "claude-sonnet-5";

/**
 * Anthropic's published prices per million tokens, for the usage ledger.
 * Correct at time of writing, and the one place to change when it moves.
 */
const PRICE_PER_MTOK: Record<string, { input: number; output: number; cacheRead?: number }> = {
  "claude-fable-5-1": { input: 10, output: 50 },
  // Opus 5.5 reads its cache at a twentieth of the input price, not a tenth.
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/**
 * How long one attempt may run, scaled by how much it is allowed to write.
 *
 * The SDK's default is ten minutes per attempt with two retries — half an hour
 * before a hung call gives up. That outlives everything waiting on it: a queue
 * job is presumed dead at 15 minutes and re-delivered beside the call still in
 * flight, and an HTTP request behind it times out long before.
 *
 * A flat figure does not fit: a 500-token summary should not be allowed three
 * minutes, and an 8000-token document legitimately needs about two at Sonnet's
 * output rate. So: a fixed allowance for the network and the model to start,
 * plus a per-token budget that assumes 50 tokens a second — slower than the
 * model has been seen to write.
 */
const TIMEOUT_BASE_MS = 30_000;
const TIMEOUT_PER_OUTPUT_TOKEN_MS = 20;

export const timeoutFor = (maxTokens: number): number =>
  TIMEOUT_BASE_MS + maxTokens * TIMEOUT_PER_OUTPUT_TOKEN_MS;

/**
 * One retry, not the SDK's two. A 529 is worth a second attempt, but the worst
 * case is attempts × timeout, and at two retries a large call could run past ten
 * minutes before failing. Queued work has the queue's own retry on top of this.
 */
const MAX_RETRIES = 1;

let client: Anthropic | null = null;

export const isAiConfigured = (): boolean => Boolean(process.env.ANTHROPIC_API_KEY);

const anthropic = (): Anthropic => {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AiError("AI is not configured on this server. Set ANTHROPIC_API_KEY.", true);
  }
  client = new Anthropic({ apiKey });
  return client;
};

export class AiError extends Error {
  constructor(
    message: string,
    /** Retrying will never help — bad key, malformed request, unusable output. */
    readonly permanent: boolean
  ) {
    super(message);
    this.name = "AiError";
  }
}

export interface CompleteOptions {
  system: string;
  user: string;
  maxTokens?: number;
  model?: string;
  /** For the usage ledger, so spend is attributable to an account. */
  userId?: string;
  /** What to label this call in `usage_event.endpoint`, e.g. "summarize". */
  purpose: string;

  /**
   * Let the model think before answering. On by default on Opus 5, so this is
   * really only here to turn it *off* — pass `false` on a cheap extraction
   * where reasoning is pure cost. The reasoning itself is never returned; we
   * do not display it anywhere, so there is nothing to gain from asking for a
   * summary of it.
   */
  thinking?: boolean;

  /**
   * How hard to think, and therefore how much to spend. `high` is the API
   * default. Drop to `low` for classification-shaped work, raise to `xhigh`
   * when a wrong answer costs more than the tokens do.
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

/**
 * One completion, metered.
 *
 * Returns raw text. Callers that want JSON go through `completeJson` rather than
 * parsing here, because the repair path — a model that wrapped its JSON in prose
 * or a code fence — belongs in one place too.
 */
export const complete = async (opts: CompleteOptions): Promise<string> => {
  const model = opts.model ?? DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? 4096;

  let response;
  try {
    response = await anthropic().messages.create(
      {
        model,
        max_tokens: maxTokens,
        system: opts.system,
        messages: [{ role: "user", content: opts.user }],
        ...(opts.thinking === false ? { thinking: { type: "disabled" as const } } : {}),
        ...(opts.effort ? { output_config: { effort: opts.effort } } : {}),
      },
      { timeout: timeoutFor(maxTokens), maxRetries: MAX_RETRIES }
    );
  } catch (error) {
    const status = (error as { status?: number }).status;
    // 401/403 is a bad key and 400 is a malformed request; neither improves on
    // a retry. 429, 5xx and a timeout (which has no status) are worth backing
    // off for.
    const permanent = status === 400 || status === 401 || status === 403;
    throw new AiError(
      `Anthropic call failed${status ? ` (${status})` : ""}: ${(error as Error).message}`,
      permanent
    );
  }

  const price = PRICE_PER_MTOK[model] ?? PRICE_PER_MTOK[DEFAULT_MODEL];
  await recordUsage({
    endpoint: `ai:${opts.purpose}`,
    userId: opts.userId,
    units: response.usage.input_tokens + response.usage.output_tokens,
    costUsd:
      (response.usage.input_tokens / 1_000_000) * price.input +
      (response.usage.output_tokens / 1_000_000) * price.output,
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  // Truncation is silent otherwise: the reply is valid text, it simply stops
  // mid-sentence, and every downstream parse failure then points at the prompt
  // instead of at the token budget.
  // A refusal is an HTTP 200 with no usable text. Without this it reads as "the
  // model returned an empty string", and the caller goes looking for a bug in
  // the prompt rather than at the safety classifier that declined it.
  if (response.stop_reason === "refusal") {
    throw new AiError(
      `The model declined the request on "${opts.purpose}"` +
        `${response.stop_details?.category ? ` (${response.stop_details.category})` : ""}.`,
      true
    );
  }

  if (response.stop_reason === "max_tokens") {
    throw new AiError(
      `The model ran out of output tokens after ${response.usage.output_tokens} (limit ${maxTokens}) ` +
        `on "${opts.purpose}". Raise maxTokens for this call.`,
      true
    );
  }

  return text;
};

/**
 * A completion parsed as JSON.
 *
 * Seeding the assistant turn with `{` would be the tidier way to guarantee an
 * object — but the current models reject a prefilled assistant message outright
 * ("the conversation must end with a user message"), so the guarantee has to
 * come from parsing instead. Both failures models actually produce are handled
 * here rather than thrown at the caller: a ```json fence around the object, and
 * prose either side of it.
 *
 * Anything past that is a real failure and marked permanent — a model that
 * cannot produce parseable JSON on this prompt will not produce it on the retry
 * either, and burning five attempts to discover that wastes real money.
 */
export const completeJson = async <T>(opts: CompleteOptions): Promise<T> => {
  const raw = await complete(opts);

  const cleaned = raw
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Last resort: take the outermost braces and ignore whatever surrounds them.
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first !== -1 && last > first) {
      try {
        return JSON.parse(cleaned.slice(first, last + 1)) as T;
      } catch {
        /* fall through to the error below */
      }
    }
    throw new AiError(
      `The model did not return usable JSON. First 200 chars: ${cleaned.slice(0, 200)}`,
      true
    );
  }
};

/**
 * The model behind the admins' Assistant, when ASSISTANT_MODEL does not say
 * otherwise. Haiku: the work is picking a tool and its filters from a fixed
 * menu, then summing up what came back — and at $0.10 / $0.50 per million
 * tokens a question costs a fraction of a rupee. The tools check every input
 * and send mistakes back for the model to fix.
 */
export const DEFAULT_ASSISTANT_MODEL = "claude-haiku-5-5";

/**
 * ASSISTANT_MODEL from the environment, read on every call so a restart is
 * all a change needs. Any current Claude model id works (claude-sonnet-5-5,
 * claude-opus-5-5…); it must take `output_config.effort`, which rules out
 * Haiku 4.5 and Sonnet 4.5.
 */
export const assistantModel = (): string =>
  process.env.ASSISTANT_MODEL?.trim() || DEFAULT_ASSISTANT_MODEL;

/**
 * Haiku 5.5 has two rate cards: a prompt over 100K tokens (a very long chat)
 * is billed at five times the rate, all of it.
 */
const HAIKU_LONG_PROMPT = 100_000;
const HAIKU_LONG_PRICE = { input: 0.5, output: 2.5 };

/** A model missing from PRICE_PER_MTOK is metered at Haiku's price; say so once. */
const unpriced = new Set<string>();
const warnUnpriced = (model: string) => {
  if (unpriced.has(model)) return;
  unpriced.add(model);
  console.warn(
    `[ai] No price for ${model} in PRICE_PER_MTOK (src/lib/ai/claude.ts); usage_event costs are wrong until it is added.`
  );
};

/** Cache prices relative to the input price, unless the table says otherwise. */
const CACHE_WRITE_FACTOR = 1.25;
const CACHE_READ_FACTOR = 0.1;

export interface ConverseOptions {
  /** Stable text first, so it caches; anything that changes daily last. */
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  maxTokens?: number;
  userId?: string;
  purpose: string;
}

/**
 * One turn of a conversation with tools, metered: the model either answers
 * or asks for tools to be run. The caller runs them and calls again with the
 * results appended — the loop lives with whoever holds the data.
 *
 * Unlike `complete`, the reply is returned whole (thinking blocks included):
 * the next turn has to send it back unchanged.
 *
 * A refusal comes back as a reply with `stop_reason: "refusal"` and no text,
 * for the caller to show; Haiku has no server-side fallback to another model.
 */
export const converse = async (opts: ConverseOptions): Promise<Anthropic.Message> => {
  const maxTokens = opts.maxTokens ?? 16_000;
  const model = assistantModel();

  let response;
  try {
    response = await anthropic().messages.create(
      {
        model,
        max_tokens: maxTokens,
        // Caches the conversation so far; each turn re-reads it at a tenth
        // of the price instead of paying for the whole history again.
        cache_control: { type: "ephemeral" },
        // Medium rather than low: reading "travelling on the 29th" into the
        // right filters is where it earns its keep, and the thinking is cheap.
        output_config: { effort: "medium" },
        system: opts.system,
        tools: opts.tools,
        messages: opts.messages,
      },
      { timeout: timeoutFor(maxTokens), maxRetries: MAX_RETRIES }
    );
  } catch (error) {
    const status = (error as { status?: number }).status;
    const permanent = status === 400 || status === 401 || status === 403;
    throw new AiError(
      `Anthropic call failed${status ? ` (${status})` : ""}: ${(error as Error).message}`,
      permanent
    );
  }

  const usage = response.usage;
  const written = usage.cache_creation_input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  const prompt = usage.input_tokens + written + read;
  const listed = PRICE_PER_MTOK[response.model] ?? PRICE_PER_MTOK[model];
  if (!listed) warnUnpriced(model);
  const base = listed ?? PRICE_PER_MTOK[DEFAULT_ASSISTANT_MODEL];
  const price: { input: number; output: number; cacheRead?: number } =
    response.model === "claude-haiku-5-5" && prompt > HAIKU_LONG_PROMPT ? HAIKU_LONG_PRICE : base;
  const cacheRead = price.cacheRead ?? price.input * CACHE_READ_FACTOR;
  await recordUsage({
    endpoint: `ai:${opts.purpose}`,
    userId: opts.userId,
    units: prompt + usage.output_tokens,
    costUsd:
      ((usage.input_tokens + written * CACHE_WRITE_FACTOR) * price.input +
        read * cacheRead +
        usage.output_tokens * price.output) /
      1_000_000,
  });

  if (response.stop_reason === "max_tokens") {
    throw new AiError(
      `The model ran out of output tokens (limit ${maxTokens}) on "${opts.purpose}".`,
      true
    );
  }

  return response;
};
