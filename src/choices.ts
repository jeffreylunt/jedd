import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Numbered options, PERSISTED and RE-RESOLVED — never re-derived.
 *
 * ── 🔴 THE V1 DEFECT THIS EXISTS TO NOT HAVE ─────────────────────────────────
 *
 * In V1 every inbound message opened a NEW conversation id, so a bare
 * `"Number 1 is great"` arrived in a session that had never seen the list and
 * Jedd answered *"I lost track of those options."* **The pick-a-number flow was
 * structurally incapable of working.**
 *
 * V1's own analysis goes further, and it is a BUILD-ORDER constraint rather than
 * a nicety: the separately-observed "picked and sent before presenting the list"
 * bug is a SYMPTOM of this one — the model, knowing the list will not survive,
 * acts immediately while it still holds it. **So fixing premature-send without
 * fixing continuity makes things strictly worse**, because every pick would then
 * die instead of occasionally landing right by acting early. Continuity lands
 * first, or with it, never after.
 *
 * ── IT IS ALSO NOT AN EDGE CASE ──────────────────────────────────────────────
 *
 * Measured over 806 real user turns: bare continuations like `'2'`, `'Yes'` and
 * *"None of those, the Toy Story 5 that just got released"* are common. The
 * pick-a-number flow is load-bearing traffic, not a nicety.
 *
 * ── WHY THERE IS NO PROSE PARSING IN THIS FILE ───────────────────────────────
 *
 * The user writes *"Number 1 is great"*, *"the second one"*, *"let's do 3"*. None
 * of that is parsed here. **The MODEL reads the message and calls a tool with an
 * integer** — a choice from an enum, which is what it is good at — and this store
 * only maps that integer back to the object that was offered. Code guessing an
 * ordinal out of prose would be the same mistake as guessing a media type.
 */

export interface ChoiceOption {
  /** 1-based, as presented to the user. */
  n: number;
  /** A short label, for re-presenting the list if asked. */
  label: string;
  /**
   * The structured payload the tool needs to act — an arr id, a magnet hash, a
   * release. **This is why options are stored as objects: resolution must never
   * re-parse the rendered prose it showed the user.**
   */
  value: Record<string, unknown>;
}

export interface PendingChoice {
  senderHandle: string;
  /** What the list was FOR, so a re-ask can say what it was about. */
  subject: string;
  kind: string;
  options: ChoiceOption[];
  presentedAt: string;
  expiresAt: string;
}

export type ChoiceResolution =
  | { ok: true; choice: PendingChoice; option: ChoiceOption }
  | { ok: false; reason: 'none' | 'expired' | 'out-of-range'; detail: string };

/**
 * How long a presented list stays resolvable.
 *
 * Long enough for a real reply (people answer minutes later, and the corpus's
 * p90 reply latency is 85 s), short enough that a stale list cannot be picked
 * from days later when the underlying search results have moved on.
 */
export const CHOICE_TTL_MS = 60 * 60 * 1000;

type LogRecord =
  | { type: 'present'; choice: PendingChoice }
  | { type: 'clear'; senderHandle: string; at: string };

export class ChoiceStore {
  private readonly byHandle = new Map<string, PendingChoice>();

  constructor(private readonly path: string) {
    this.load();
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      return;
    }
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let rec: LogRecord;
      try {
        rec = JSON.parse(t) as LogRecord;
      } catch {
        continue;
      }
      if (rec.type === 'present') this.byHandle.set(rec.choice.senderHandle, rec.choice);
      else if (rec.type === 'clear') this.byHandle.delete(rec.senderHandle);
    }
  }

  private append(rec: LogRecord): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(rec)}\n`, 'utf8');
  }

  /**
   * Record a list just presented to someone.
   *
   * A new list REPLACES any previous one for that sender: two live lists would
   * make a bare "2" ambiguous, and there is no honest way to guess which was
   * meant.
   */
  present(input: {
    senderHandle: string;
    subject: string;
    kind: string;
    options: ChoiceOption[];
    now?: Date;
  }): PendingChoice {
    const now = input.now ?? new Date();
    const choice: PendingChoice = {
      senderHandle: input.senderHandle,
      subject: input.subject,
      kind: input.kind,
      options: input.options,
      presentedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + CHOICE_TTL_MS).toISOString(),
    };
    this.append({ type: 'present', choice });
    this.byHandle.set(input.senderHandle, choice);
    return choice;
  }

  /**
   * Map an ordinal back to what was offered.
   *
   * 🔴 EVERY FAILURE PATH RETURNS A REASON TO RE-ASK, AND NEVER A GUESS. V1's
   * behavioural requirement B37 is exactly this: a lost pick cache must re-ask,
   * never fabricate. Falling back to "probably the first one" is how a user ends
   * up with a film they did not choose.
   */
  resolve(senderHandle: string, n: number, now = new Date()): ChoiceResolution {
    const choice = this.byHandle.get(senderHandle);
    if (!choice) {
      return {
        ok: false,
        reason: 'none',
        detail:
          'There is no list waiting for this person. Do not guess what they meant — ask what they ' +
          'want, or search again and present a fresh list.',
      };
    }
    if (Date.parse(choice.expiresAt) <= now.getTime()) {
      return {
        ok: false,
        reason: 'expired',
        detail:
          `The list about "${choice.subject}" was presented at ${choice.presentedAt} and has expired. ` +
          'Say so and offer to search again. Do not pick from it.',
      };
    }
    const option = choice.options.find((o) => o.n === n);
    if (!option) {
      return {
        ok: false,
        reason: 'out-of-range',
        detail:
          `There is no option ${n}. The list about "${choice.subject}" has ` +
          `${choice.options.length} option(s): ${choice.options.map((o) => `${o.n}. ${o.label}`).join('; ')}.`,
      };
    }
    return { ok: true, choice, option };
  }

  /** What is currently waiting for this person, if anything. */
  pending(senderHandle: string, now = new Date()): PendingChoice | undefined {
    const c = this.byHandle.get(senderHandle);
    if (!c) return undefined;
    return Date.parse(c.expiresAt) > now.getTime() ? c : undefined;
  }

  /**
   * Forget the list for one sender.
   *
   * Note that `resolve` deliberately does NOT clear: people change their minds
   * ("actually, number 2"), and a store that consumed the list on first use
   * would break the second pick. Idempotency for a repeated pick belongs in the
   * acting tool, whose outcome enum already distinguishes ALREADY_HAVE from
   * STARTED — not here.
   */
  clear(senderHandle: string, at = new Date()): void {
    if (!this.byHandle.has(senderHandle)) return;
    this.append({ type: 'clear', senderHandle, at: at.toISOString() });
    this.byHandle.delete(senderHandle);
  }
}

/**
 * Resolve a pick AND check it came from the list this tool actually meant.
 *
 * ── 🔴 WHY A KIND CHECK IS NOT BOOKKEEPING ──────────────────────────────────
 *
 * `resolve` is deliberately kind-agnostic: it maps an ordinal back to an object
 * and does not care what kind that object is. That was harmless while every
 * consumer took an explicit number a person had chosen from a list they had just
 * been shown.
 *
 * It stopped being harmless the day the consumers began defaulting to option 1
 * with no argument. `add_audiobook` reads an `infoHash` off whatever it resolves
 * and hands it to qBittorrent under the AUDIOBOOK category with no shape check
 * at all — so a pending EBOOK list resolved cleanly, a `.epub` was filed into
 * `/downloads/audiobooks`, the host cron fed it to Audiobookshelf, and the tool
 * reported STARTED. Nothing failed anywhere.
 *
 * ⚠️ A LIST OF THE WRONG KIND FAILS CLOSED, INCLUDING A LEGACY ONE. Options
 * stored before the kinds were split carry `release`, which matches neither
 * consumer now and is refused rather than guessed at. `choices.jsonl` is
 * durable, so those exist — but they expire within `CHOICE_TTL_MS`, and one hour
 * of "search again" beats one ebook filed as an audiobook.
 */
export function resolveOfKind(
  store: ChoiceStore,
  senderHandle: string,
  n: number,
  kind: string,
  now = new Date(),
): ChoiceResolution {
  const r = store.resolve(senderHandle, n, now);
  if (!r.ok) return r;
  if (r.choice.kind !== kind) {
    return {
      ok: false,
      reason: 'none',
      detail:
        `The list waiting for this person is a "${r.choice.kind}" list about "${r.choice.subject}", ` +
        `not a "${kind}" one, so nothing here can act on it. Do NOT guess — search again for what ` +
        'they actually asked for.',
    };
  }
  return r;
}
