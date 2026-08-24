import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LlmMessage } from './llm.js';

/**
 * Durable per-sender conversation history.
 *
 * ── WHY AN APPEND-ONLY LOG ───────────────────────────────────────────────────
 *
 * Eviction and repair are themselves APPENDED, never applied by rewriting the
 * file. A poisoned turn is neutralised for REPLAY while remaining visible in the
 * log, so the record of what Jedd actually said stays honest. The alternative —
 * editing history in place — makes the audit trail a thing that can be quietly
 * corrected, which is the opposite of what it is for.
 *
 * ── 🔴 WHAT IS NOT STORED, AND WHY THAT IS THE IMPORTANT DECISION ────────────
 *
 * **Tool results are NOT persisted and are never replayed.** Only the user's
 * text and Jedd's reply survive a restart.
 *
 * A tool result is an OBSERVATION WITH A TIMESTAMP: `docker ps` output, a
 * latency measurement, a Jellyfin session list. Replaying one into a later
 * conversation presents yesterday's reading as today's context, and the model
 * has no way to tell that it is stale — it looks exactly like something it just
 * observed. The whole architecture rests on "ground every claim in a tool
 * result", and silently ageing those results poisons the one thing the model is
 * told to trust.
 *
 * So after a restart Jedd remembers what was SAID and re-observes what is TRUE.
 * That is also why the replay bound below can be generous without being risky.
 */

/** One durable turn. `id` is what eviction and repair address. */
export interface StoredTurn {
  id: string;
  at: string;
  senderHandle: string;
  userText: string;
  replyText: string;
  /** set when this turn was repaired; the original stays in the log. */
  repairedFrom?: string;
  /** set when this turn is evicted from replay. */
  evicted?: { at: string; reason: string };
}

type LogRecord =
  | { type: 'turn'; id: string; at: string; senderHandle: string; userText: string; replyText: string }
  | { type: 'evict'; id: string; at: string; reason: string }
  | { type: 'repair'; id: string; at: string; replyText: string; reason: string };

/**
 * ── THE DOWNTIME-RECOVERY BOUND, DECIDED EXPLICITLY ──────────────────────────
 *
 * V1 replayed only the last 50 messages and **silently lost everything older**,
 * so a conversation that continued across a long outage came back with a hole in
 * it that nobody could see.
 *
 * Two bounds, and the second one is the point: replay is capped by COUNT and by
 * AGE, and **when either bound drops anything, the replayed history says so out
 * loud.** A truncated history that announces its truncation is a different thing
 * from one that pretends to be complete — the model can tell the user "we talked
 * about this before but I no longer have it" instead of confidently continuing
 * from a conversation it half-remembers.
 */
export const MAX_REPLAY_TURNS = 20;
export const MAX_REPLAY_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface ReplayResult {
  messages: LlmMessage[];
  /** How many stored turns the bounds dropped. Zero means the replay is complete. */
  dropped: number;
  /** Human-readable note about the truncation, or '' when nothing was dropped. */
  note: string;
}

export class HistoryStore {
  private readonly turns: StoredTurn[] = [];

  constructor(private readonly path: string) {
    this.load();
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      return; // no history yet is a normal first boot, not an error
    }
    const byId = new Map<string, StoredTurn>();
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec: LogRecord;
      try {
        rec = JSON.parse(trimmed) as LogRecord;
      } catch {
        // A corrupt line is skipped rather than throwing: one bad append must
        // not make the whole conversation unloadable. It stays in the file.
        continue;
      }
      if (rec.type === 'turn') {
        const turn: StoredTurn = {
          id: rec.id,
          at: rec.at,
          senderHandle: rec.senderHandle,
          userText: rec.userText,
          replyText: rec.replyText,
        };
        byId.set(rec.id, turn);
        this.turns.push(turn);
      } else if (rec.type === 'evict') {
        const target = byId.get(rec.id);
        if (target) target.evicted = { at: rec.at, reason: rec.reason };
      } else if (rec.type === 'repair') {
        const target = byId.get(rec.id);
        if (target) {
          target.repairedFrom = target.replyText;
          target.replyText = rec.replyText;
        }
      }
    }
  }

  private append(rec: LogRecord): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(rec)}\n`, 'utf8');
  }

  /** Record one completed turn. Returns its id, which is what eviction addresses. */
  record(senderHandle: string, userText: string, replyText: string, at = new Date()): string {
    const id = `${at.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const rec = { type: 'turn' as const, id, at: at.toISOString(), senderHandle, userText, replyText };
    this.append(rec);
    this.turns.push({ id, at: rec.at, senderHandle, userText, replyText });
    return id;
  }

  /**
   * Drop one turn from replay without wiping the conversation around it.
   *
   * The V1 trap this exists for: **a bad reply keeps poisoning history after the
   * bug that produced it is fixed.** The model reads its own past wrong answer
   * as established context and repeats it, so every fix is undone by its own
   * transcript until someone can reach in and remove the turn.
   */
  evict(id: string, reason: string, at = new Date()): boolean {
    const target = this.turns.find((t) => t.id === id);
    if (!target) return false;
    this.append({ type: 'evict', id, at: at.toISOString(), reason });
    target.evicted = { at: at.toISOString(), reason };
    return true;
  }

  /** Replace a turn's reply, keeping the conversation shape. Original stays in the log. */
  repair(id: string, replyText: string, reason: string, at = new Date()): boolean {
    const target = this.turns.find((t) => t.id === id);
    if (!target) return false;
    this.append({ type: 'repair', id, at: at.toISOString(), replyText, reason });
    target.repairedFrom = target.replyText;
    target.replyText = replyText;
    return true;
  }

  /** Every turn for one sender, oldest first, evicted ones included. For operators. */
  all(senderHandle: string): StoredTurn[] {
    return this.turns.filter((t) => t.senderHandle === senderHandle);
  }

  /**
   * The messages to replay for this sender, with the bounds applied and any
   * truncation stated rather than hidden.
   */
  replay(senderHandle: string, now = new Date()): ReplayResult {
    const mine = this.turns.filter((t) => t.senderHandle === senderHandle && !t.evicted);
    const cutoff = now.getTime() - MAX_REPLAY_AGE_MS;
    const fresh = mine.filter((t) => {
      const ts = Date.parse(t.at);
      // An unparseable timestamp is not silently treated as recent. It is
      // dropped and counted, so it shows up in the truncation note.
      return Number.isFinite(ts) && ts >= cutoff;
    });
    const kept = fresh.slice(-MAX_REPLAY_TURNS);
    const dropped = mine.length - kept.length;

    const messages: LlmMessage[] = [];
    for (const turn of kept) {
      messages.push({ role: 'user', content: turn.userText });
      if (turn.replyText) messages.push({ role: 'assistant', content: turn.replyText });
    }
    return {
      messages,
      dropped,
      note: dropped
        ? `[${dropped} earlier turn(s) with this person are no longer in your history — they were ` +
          'dropped by the replay bound, not forgotten by them. If they refer to something you cannot ' +
          'see, say so rather than guessing at what was said.'
        : '',
    };
  }
}
