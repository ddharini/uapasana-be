import { AiError, completeJson, isAiConfigured } from "./ai/claude";
import type { ScheduleSnapshot } from "./schedule";

/**
 * Gujarati for the programme's own words, made when an admin publishes.
 *
 * Admins type the schedule in English; most devotees read the public page in
 * Gujarati. Translating once, at publish, means a devotee's page load never
 * waits on — or pays for — a model call, and every phone sees the same words.
 *
 * Kept as `{ english: gujarati }` beside the published days. A text already
 * translated in the previous publication is reused rather than sent again, so
 * a publish only pays for what is new or edited, and a wording a devotee has
 * already seen does not shift between publishes.
 *
 * Custom session types are left as typed: their colour on the timeline is
 * derived from the name, and a translated name would recolour them.
 */

export type Translations = Record<string, string>;

/** Change the prompt below, bump this — so a log line says which wording made a translation. */
export const SCHEDULE_TRANSLATION_PROMPT = "schedule-gu.v1";

/**
 * Sonnet, not Haiku: Gujarati script for names like "Anoopam Mantradiksha" is
 * where a smaller model slips, and a whole programme is a few cents at most.
 */
const MODEL = "claude-sonnet-5-5";

/** Texts per call. Gujarati costs several tokens a word; this keeps a reply well inside its budget. */
const CHUNK = 60;

const SYSTEM = `You translate an event programme from English into Gujarati for devotees of a Hindu spiritual organisation (Anoopam Mission). The event is the Dashabdi Mahotsav at Upasana Dham Mandir, Ahmedabad.

You get a JSON array of short texts: session titles, place names, day themes and notes. Reply with only a JSON object {"gu": [...]} holding one Gujarati string per input, in the same order — no commentary, no code fence.

- Names of people, places, events and sabhas are written in Gujarati script as they are said, not translated word by word: "Anoopam Mantradiksha Hirak Mahotsav Sabha" → "અનુપમ મંત્રદીક્ષા હીરક મહોત્સવ સભા", "Upasana Dham Mandir" → "ઉપાસના ધામ મંદિર", "Sabha Hall" → "સભા હૉલ".
- Words devotees already say in Gujarati stay in their usual form: Sabha → સભા, Aarti → આરતી, Prasad → પ્રસાદ, Mandir → મંદિર, Satsang → સત્સંગ.
- Everything else is translated plainly and respectfully, as a Gujarati notice board would say it. "Tentative" means not yet final — "સંભવિત", never "તાત્કાલિક" (urgent): "Tentative — timing to be confirmed" → "સંભવિત — સમય હજી નક્કી થવાનો છે".
- Keep digits, times ("9:30 am"), dates and punctuation as they are. Do not add or drop information.`;

/** Every theme, title, place and note in the programme, once each. */
export function textsOf(days: ScheduleSnapshot): string[] {
  const texts = new Set<string>();
  const add = (text: string | null) => {
    if (text?.trim()) texts.add(text);
  };
  for (const day of days) {
    add(day.theme);
    for (const session of day.sessions) {
      add(session.title);
      add(session.place);
      add(session.note);
    }
  }
  return [...texts];
}

/** A stored `gu` map, or an empty one for a publication from before it existed. */
export function translationsOf(publication: { gu?: unknown } | null | undefined): Translations {
  const gu = publication?.gu;
  if (!gu || typeof gu !== "object" || Array.isArray(gu)) return {};
  return Object.fromEntries(
    Object.entries(gu).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

/** Texts in the programme the map has no Gujarati for. */
export const untranslated = (days: ScheduleSnapshot, gu: Translations) =>
  textsOf(days).filter(text => !gu[text]);

/**
 * Gujarati for every text in `days`: reused from `previous` where it has one,
 * asked of Claude for the rest.
 *
 * Never throws. A publish must go out even when translation cannot — the
 * programme in English beats no programme — so a failure is logged and the
 * texts it missed simply show in English until the next publish fills them.
 */
export async function translateSchedule(
  days: ScheduleSnapshot,
  previous: Translations,
  userId?: string
): Promise<Translations> {
  const gu: Translations = {};
  const todo: string[] = [];
  for (const text of textsOf(days)) {
    if (previous[text]) gu[text] = previous[text];
    else todo.push(text);
  }
  if (todo.length === 0 || !isAiConfigured()) return gu;

  for (let i = 0; i < todo.length; i += CHUNK) {
    const chunk = todo.slice(i, i + CHUNK);
    try {
      const reply = await completeJson<{ gu?: unknown }>({
        model: MODEL,
        system: SYSTEM,
        user: JSON.stringify(chunk),
        maxTokens: 8000,
        // Not `thinking: false`: Sonnet 5.5 refuses that with a 400. Low
        // effort keeps a straight translation from reasoning at length.
        effort: "low",
        userId,
        purpose: "schedule-translate",
      });
      const out = reply.gu;
      // Matched by position, so a reply of the wrong length cannot be trusted
      // to line up at all — better English than a title under the wrong session.
      if (!Array.isArray(out) || out.length !== chunk.length) {
        throw new AiError(
          `Expected ${chunk.length} translations, got ${Array.isArray(out) ? out.length : typeof out}`,
          true
        );
      }
      chunk.forEach((text, j) => {
        const translated = out[j];
        if (typeof translated === "string" && translated.trim()) gu[text] = translated.trim();
      });
    } catch (error) {
      console.error(
        `[schedule] Gujarati translation failed (${SCHEDULE_TRANSLATION_PROMPT}); ${chunk.length} texts stay in English:`,
        (error as Error).message
      );
    }
  }
  return gu;
}
