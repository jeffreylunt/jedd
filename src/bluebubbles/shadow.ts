import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TurnRecord } from '../agent.js';
import type { Config } from '../config.js';
import type { InboundVerdict } from './payload.js';

/**
 * The shadow recorder.
 *
 * ── WHAT THIS IS FOR NOW, WHICH IS NOT WHAT IT WAS FOR ───────────────────────
 *
 * It was going to accumulate the parity corpus from live traffic. It does not
 * need to: real traffic runs at ~12 inbound messages/day, so a live shadow would
 * have taken ~67 days to reach the 806 turns already recovered retrospectively
 * from BlueBubbles' own database.
 *
 * **So its job is to prove the CONNECTOR against real traffic, not to gather the
 * evidence.** It answers: does V2 receive what V1 receives, dedup it correctly,
 * and produce a reply — without ever speaking.
 *
 * ── 🔴 IT STILL CANNOT SEND, AND NOT BECAUSE OF ANYTHING IN THIS FILE ────────
 *
 * Send-absence is structural and lives in `ShadowConnector`, which holds no
 * BlueBubbles client. Nothing here is load-bearing for that, and nothing here
 * should ever become load-bearing for it. If safety depended on a flag in this
 * module, someone would eventually flip it.
 */

export interface ShadowEntry {
  at: string;
  kind: 'v2-would-reply' | 'v1-actual-reply' | 'skipped';
  rowid: number | null;
  senderHandle: string;
  /** The user's message, for a v2 turn. */
  userText?: string;
  /** What V2 would have said, or what V1 actually said. */
  replyText?: string;
  toolCalls?: { name: string; ok: boolean; refused?: boolean }[];
  steps?: number;
  reason?: string;
}

export class ShadowRecorder {
  constructor(private readonly path: string) {}

  private append(entry: ShadowEntry): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  /**
   * Everything the loop did not get.
   *
   * The valuable half is the outbound echoes: **V1's own replies arrive on this
   * same webhook as `isFromMe: true`**, so the rows V2 must never act on are
   * exactly the rows that say what V1 answered. That pairing is free, and it is
   * why classification returns a verdict rather than a boolean.
   */
  recordSkipped(v: InboundVerdict): void {
    if (v.action !== 'skip') return;
    this.append({
      at: new Date().toISOString(),
      kind: v.isFromMe ? 'v1-actual-reply' : 'skipped',
      rowid: v.rowid,
      senderHandle: v.senderHandle,
      replyText: v.isFromMe ? v.text : undefined,
      reason: v.reason,
    });
  }

  /** What V2 would have said, had it been allowed to speak. */
  recordTurn(record: TurnRecord): void {
    this.append({
      at: record.at,
      kind: 'v2-would-reply',
      rowid: null,
      senderHandle: record.senderHandle,
      userText: record.userText,
      replyText: record.replyText,
      toolCalls: record.toolCalls.map((c) => ({ name: c.name, ok: c.ok, refused: c.refused })),
      steps: record.steps,
    });
  }
}

/**
 * Shadow mode requires read-only, and this REFUSES rather than coercing.
 *
 * Silently forcing `readOnly` would be the friendlier behaviour and the wrong
 * one: a caller who set `JEDD_ALLOW_WRITES=true` and asked for shadow mode holds
 * two contradictory beliefs, and quietly picking one leaves them believing the
 * other. The homelab is the thing at stake, so the contradiction is surfaced.
 *
 * Note what this is NOT: it is not what stops the shadow sending messages. That
 * is `ShadowConnector` having no client. This only stops it WRITING TO THE
 * HOMELAB, which is a different capability on a different axis.
 */
export function assertShadowSafe(config: Config): void {
  if (!config.readOnly) {
    throw new Error(
      'Refusing to start shadow mode with writes ENABLED. Shadow mode observes live household ' +
        'traffic and must change nothing — but JEDD_ALLOW_WRITES=true is set, so homelab write ' +
        'tools would be registered. Unset it rather than having this coerce a value you set ' +
        'deliberately. (Separately, and independently: the shadow connector holds no BlueBubbles ' +
        'client, so it cannot send messages regardless of this flag.)',
    );
  }
}
