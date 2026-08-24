import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * What has already been processed, and how far replay has got. Durable, because
 * both facts have to survive a restart to be worth anything.
 *
 * ── 🔴 THE WATERMARK BUG THIS EXISTS TO NOT REPEAT ───────────────────────────
 *
 * V1's stored watermark is `1783501783569848` — a MICROSECOND TIMESTAMP sitting
 * in a rowid field — while real `originalROWID`s on this server are ~2601.
 * `replayMissed` filters `originalROWID > sinceRowid`, so the comparison is
 * ALWAYS FALSE and replay can never return anything. V1's downtime recovery is
 * not "capped at 50 messages"; it is completely inert.
 *
 * And it announces that as `"Replay: no messages after rowid …"` — **the exact
 * string a healthy quiet restart prints.** The failure state and the all-clear
 * state are indistinguishable, which is why it survived in production.
 *
 * So the watermark is VALIDATED on the way in. A value that cannot be a rowid is
 * refused loudly rather than stored and quietly disabling recovery forever.
 */

/**
 * Above this, a value is a timestamp rather than a rowid.
 *
 * Real rowids here are ~2.6e3. A millisecond epoch timestamp is ~1.8e12 and a
 * microsecond one ~1.8e15. 1e10 sits far above any ROWID a chat database will
 * reach in its lifetime and far below either timestamp form, so the two cannot
 * be confused in either direction.
 */
export const MAX_PLAUSIBLE_ROWID = 10_000_000_000;

/** How many recent dedup keys to retain. The watermark covers anything older. */
export const MAX_SEEN_KEYS = 2000;

type Record_ = { type: 'seen'; key: string } | { type: 'watermark'; rowid: number };

export class SeenStore {
  private readonly keys = new Set<string>();
  private order: string[] = [];
  private mark = 0;

  constructor(private readonly path: string) {
    this.load();
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      return; // first boot
    }
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let rec: Record_;
      try {
        rec = JSON.parse(t) as Record_;
      } catch {
        continue; // one corrupt line must not make the whole file unreadable
      }
      if (rec.type === 'seen' && typeof rec.key === 'string') {
        if (!this.keys.has(rec.key)) {
          this.keys.add(rec.key);
          this.order.push(rec.key);
        }
      } else if (rec.type === 'watermark' && this.isPlausible(rec.rowid)) {
        // Validated on the way OUT of the file too: a bad value already on disk
        // must not be trusted just because it was written before this check.
        if (rec.rowid > this.mark) this.mark = rec.rowid;
      }
    }
    if (this.order.length > MAX_SEEN_KEYS) this.compact();
  }

  private isPlausible(rowid: unknown): rowid is number {
    return (
      typeof rowid === 'number' &&
      Number.isInteger(rowid) &&
      rowid > 0 &&
      rowid <= MAX_PLAUSIBLE_ROWID
    );
  }

  private append(rec: Record_): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(rec)}\n`, 'utf8');
  }

  /** Rewrite the log holding only the retained keys and the current watermark. */
  private compact(): void {
    this.order = this.order.slice(-MAX_SEEN_KEYS);
    const retained = new Set(this.order);
    for (const k of this.keys) if (!retained.has(k)) this.keys.delete(k);
    const lines = this.order.map((key) => JSON.stringify({ type: 'seen', key }));
    if (this.mark) lines.push(JSON.stringify({ type: 'watermark', rowid: this.mark }));
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${lines.join('\n')}\n`, 'utf8');
  }

  /**
   * True the FIRST time a key is seen, false every time after.
   *
   * The name is deliberate: `firstSight(k)` reads as a claim about novelty at
   * the call site, where `has(k)`/`add(k)` invites a caller to check and forget
   * to record — which is how a dedup guard stops deduping.
   */
  firstSight(key: string): boolean {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    this.order.push(key);
    this.append({ type: 'seen', key });
    if (this.order.length > MAX_SEEN_KEYS * 2) this.compact();
    return true;
  }

  watermark(): number {
    return this.mark;
  }

  /** Move the replay watermark forward. Refuses a value that cannot be a rowid. */
  advanceWatermark(rowid: number): void {
    if (!this.isPlausible(rowid)) {
      throw new Error(
        `Refusing to store ${rowid} as a replay watermark: implausible for a rowid ` +
          `(over ${MAX_PLAUSIBLE_ROWID}, it is a timestamp). Storing it would silently ` +
          'disable downtime replay forever, which is exactly the live V1 defect.',
      );
    }
    if (rowid <= this.mark) return; // never backwards
    this.mark = rowid;
    this.append({ type: 'watermark', rowid });
  }
}
