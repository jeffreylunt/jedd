import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Durable follow-ups: the thing that wakes up and can speak without being asked.
 *
 * ── WHY THIS EXISTS, CONCRETELY ──────────────────────────────────────────────
 *
 * `shed_host_load` throttles qBittorrent and **nothing will ever take that
 * throttle off on its own.** The tool cannot wait: the fix needs minutes or
 * hours to be judged, and a turn that ends when the tool returns has not
 * finished the job. "A turn ends when the user has been told the outcome" is not
 * deliverable inside a twenty-second settle window.
 *
 * So this module is deliberately NOT a general scheduler. It exists to close a
 * gap in a specific shipped behaviour, and the kinds are a code-owned enum.
 *
 * ── 🔴 THE RULE FOR ANYTHING THAT WAKES UP ───────────────────────────────────
 *
 * **A follow-up that fires when nobody is listening is worse than none.** So
 * every record carries, written at the moment it was scheduled:
 *   - WHY it was scheduled (`reason`)
 *   - TO WHOM it must speak (`senderHandle`)
 *   - WHAT was observed at the time (`observed`)
 *
 * and the runner must **refuse rather than guess** when it cannot establish the
 * current state. An unprompted message from a machine that cannot say why it is
 * talking to you is noise; one that acts on a guess is worse than noise.
 */

/** Code-owned. The model cannot introduce a new kind of follow-up. */
export type FollowupKind = 'restore-qbit-throttle';

export interface Followup {
  id: string;
  kind: FollowupKind;
  senderHandle: string;
  createdAt: string;
  dueAt: string;
  /** Why this was scheduled, in words, for the message it will eventually send. */
  reason: string;
  /** What was observed when it was scheduled, so the follow-up can say what changed. */
  observed: string;
  /** How many times this has come due and been deferred. Bounded — see MAX_ATTEMPTS. */
  attempts: number;
  status: 'pending' | 'done' | 'abandoned';
  outcome?: string;
}

type LogRecord =
  | { type: 'schedule'; followup: Followup }
  | { type: 'defer'; id: string; at: string; dueAt: string; note: string }
  | { type: 'resolve'; id: string; at: string; status: 'done' | 'abandoned'; outcome: string };

/**
 * How many times a follow-up may come due, fail to reach a verdict, and be
 * rescheduled before it gives up and says so.
 *
 * Bounded on purpose: an unbounded retry is how a machine ends up quietly
 * checking something forever and never telling anyone it could not finish.
 */
export const MAX_ATTEMPTS = 4;

export class FollowupStore {
  private readonly items = new Map<string, Followup>();

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
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec: LogRecord;
      try {
        rec = JSON.parse(trimmed) as LogRecord;
      } catch {
        continue;
      }
      if (rec.type === 'schedule') {
        this.items.set(rec.followup.id, { ...rec.followup });
      } else if (rec.type === 'defer') {
        const item = this.items.get(rec.id);
        if (item) {
          item.dueAt = rec.dueAt;
          item.attempts += 1;
        }
      } else if (rec.type === 'resolve') {
        const item = this.items.get(rec.id);
        if (item) {
          item.status = rec.status;
          item.outcome = rec.outcome;
        }
      }
    }
  }

  private append(rec: LogRecord): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(rec)}\n`, 'utf8');
  }

  schedule(input: {
    kind: FollowupKind;
    senderHandle: string;
    dueAt: Date;
    reason: string;
    observed: string;
    now?: Date;
  }): Followup {
    const now = input.now ?? new Date();
    const followup: Followup = {
      id: `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      kind: input.kind,
      senderHandle: input.senderHandle,
      createdAt: now.toISOString(),
      dueAt: input.dueAt.toISOString(),
      reason: input.reason,
      observed: input.observed,
      attempts: 0,
      status: 'pending',
    };
    this.append({ type: 'schedule', followup });
    this.items.set(followup.id, followup);
    return followup;
  }

  /**
   * Is there already a pending follow-up of this kind?
   *
   * Scheduling a second un-throttle for a throttle that is already being watched
   * would produce two unprompted messages about one event.
   */
  pendingOfKind(kind: FollowupKind): Followup | undefined {
    return [...this.items.values()].find((f) => f.kind === kind && f.status === 'pending');
  }

  due(now = new Date()): Followup[] {
    return [...this.items.values()]
      .filter((f) => f.status === 'pending' && Date.parse(f.dueAt) <= now.getTime())
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  }

  /** Push a follow-up out, counting the attempt. Returns false once exhausted. */
  defer(id: string, until: Date, note: string, at = new Date()): boolean {
    const item = this.items.get(id);
    if (!item) return false;
    if (item.attempts + 1 >= MAX_ATTEMPTS) return false;
    this.append({ type: 'defer', id, at: at.toISOString(), dueAt: until.toISOString(), note });
    item.dueAt = until.toISOString();
    item.attempts += 1;
    return true;
  }

  resolve(id: string, status: 'done' | 'abandoned', outcome: string, at = new Date()): void {
    const item = this.items.get(id);
    if (!item) return;
    this.append({ type: 'resolve', id, at: at.toISOString(), status, outcome });
    item.status = status;
    item.outcome = outcome;
  }

  all(): Followup[] {
    return [...this.items.values()];
  }
}
