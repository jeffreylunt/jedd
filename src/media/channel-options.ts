import type { GuideProgramme } from './guide.js';

/**
 * EVERY channel carrying a fixture, ranked, with health joined on.
 *
 * ── 🔴 ALL OF THEM, NOT THE FIRST ────────────────────────────────────────────
 *
 * Jeff: *"if there is more than one channel a game or event is on, the bot
 * should be able to list all of them."* The naive shape is `.find()` and a
 * single answer, and on this lineup that is wrong far more often than right —
 * the same fixture routinely appears on regional feeds, HD and SD variants,
 * alternate-language feeds and a 4K feed. Measured on 2026-08-25: `Los Angeles
 * Dodgers at Atlanta Braves` was carried by **seven** distinct channels in one
 * kickoff window (TBS HD, TBS WEST, TRUTV HD, US: TRUTV 4K, SPORTSNET LA
 * DODGERS HD, CA: TSN 1 ᴿᴬᵂ, TNT SPORTS 1).
 *
 * ── 🔴 A LIST OF OPTIONS IS WORSE THAN USELESS IF THE FIRST IS BROKEN ────────
 *
 * So each channel carries what the last stream sweep said about it. That data
 * is already on disk and costs one ssh round trip; it is never probed live,
 * because a live check is ~10 s per channel and has wedged the 242-channel loop
 * for three hours.
 *
 * The join is by EXACT channel name, measured before it was relied on: of 213
 * distinct guide channel names in a live window, **207 (97%) matched a
 * stream-check row byte for byte**. The six that did not are ephemeral
 * per-event channels (`MLS: LAFC vs Portland (8:30 PM)`) that the sweep never
 * covered — reported as NOT COVERED, which is true, rather than as broken or as
 * fine. No fuzzy matching: a wrong join would attach one channel's health to
 * another, which is a confident wrong answer about the thing being asked.
 *
 * ── ORDERING IS DELIBERATE AND IS STATED IN THE OUTPUT ───────────────────────
 *
 * Health first, then quality: **a working HD feed beats a 4K feed that failed
 * the last sweep**. Iteration order decides nothing.
 */

/** The subset of a stream-check row this join needs. */
export interface HealthRow {
  number: string;
  name: string;
  ok: boolean;
  /** 🔴 On a FAIL row this column holds the REASON, not a codec. */
  codec: string;
  resolution: string;
}

export type HealthState = 'ok' | 'failed' | 'not-covered' | 'unknown';

export interface ChannelOption {
  /** 🔴 Verbatim from the guide record. Never from the fixture source. */
  channelName: string;
  /** Every programme on this channel that named both teams. */
  programmes: GuideProgramme[];
  health: HealthState;
  /** Measured detail from the sweep — codec/resolution, or the failure reason. */
  healthDetail: string;
  quality: Quality;
}

export type Quality = '4K' | 'HD' | 'unstated';

/**
 * Quality read from the CHANNEL NAME, not from the sweep.
 *
 * ⚠️ Deliberately not taken from the sweep's measured `resolution`, even though
 * that is better evidence: a channel the sweep never covered has none, and
 * ranking would then depend on whether we happened to have health data — two
 * different facts collapsing into one axis. The measured resolution is reported
 * as its own fact in `healthDetail` instead.
 */
export function qualityOf(channelName: string): Quality {
  const n = channelName.toUpperCase();
  if (/\b(4K|UHD)\b/.test(n)) return '4K';
  if (/\b(HD|FHD)\b/.test(n) || /ᴴᴰ/.test(channelName)) return 'HD';
  return 'unstated';
}

const HEALTH_RANK: Record<HealthState, number> = {
  ok: 0,
  // 🔴 "Not covered" outranks "unknown": we know the sweep ran and simply never
  // saw this channel, which is a smaller gap than not having the sweep at all.
  'not-covered': 1,
  unknown: 2,
  // 🔴 Last, always. This is the entire point of the join.
  failed: 3,
};

const QUALITY_RANK: Record<Quality, number> = { '4K': 0, HD: 1, unstated: 2 };

/** One line naming the ordering, so it is visible rather than incidental. */
export const ORDER_EXPLANATION =
  'Ordered by HEALTH first (working, then not-covered, then unknown, then FAILED), then by quality ' +
  '(4K, HD, unstated), then by name. A working HD feed is listed above a 4K feed that failed the ' +
  'last sweep.';

export interface RankedChannels {
  options: ChannelOption[];
  /**
   * How many byte-identical duplicate programme rows were collapsed.
   *
   * 🔴 NEVER SILENTLY. Jeff: two feeds of the same match are two real options,
   * not noise. Only rows identical in channel, programme name AND start time are
   * merged — those are the same listing returned twice, not a second option —
   * and the count is reported so a collapse is never invisible.
   */
  collapsed: number;
}

/**
 * Group the guide matches by channel, attach health, and rank.
 *
 * `health` is `null` when the sweep could not be read at all — every channel is
 * then `unknown`, and the caller says so. 🔴 A health read that failed must
 * never remove a channel from the list: the channel was found in the guide, and
 * that fact does not depend on a second source.
 */
export function rankChannelOptions(matches: GuideProgramme[], health: HealthRow[] | null): RankedChannels {
  const byName = new Map<string, GuideProgramme[]>();
  let collapsed = 0;
  for (const m of matches) {
    const list = byName.get(m.channelName) ?? [];
    if (list.some((p) => p.name === m.name && p.startDate === m.startDate)) {
      collapsed++;
      continue;
    }
    list.push(m);
    byName.set(m.channelName, list);
  }

  const healthByName = health ? new Map(health.map((r) => [r.name, r])) : null;

  const options: ChannelOption[] = [...byName.entries()].map(([channelName, programmes]) => {
    const row = healthByName?.get(channelName);
    let state: HealthState;
    let detail: string;
    if (!healthByName) {
      state = 'unknown';
      detail = 'the stream check could not be read';
    } else if (!row) {
      state = 'not-covered';
      detail = 'this channel was not in the last stream check at all';
    } else if (row.ok) {
      state = 'ok';
      detail = [row.codec, row.resolution].filter(Boolean).join(' ') || 'no detail recorded';
    } else {
      state = 'failed';
      // 🔴 Column 4 is the REASON on a FAIL row, not a codec. Labelling it as a
      // codec prints an HTTP error where a codec should be and reads as corrupt
      // data rather than as the diagnosis it is.
      detail = row.codec.trim() ? `reason: ${row.codec.trim()}` : 'no reason recorded';
    }
    return { channelName, programmes, health: state, healthDetail: detail, quality: qualityOf(channelName) };
  });

  options.sort(
    (a, b) =>
      HEALTH_RANK[a.health] - HEALTH_RANK[b.health] ||
      QUALITY_RANK[a.quality] - QUALITY_RANK[b.quality] ||
      a.channelName.localeCompare(b.channelName),
  );
  return { options, collapsed };
}

/** How the health of a set of options reads at a glance. */
export function summariseHealth(options: ChannelOption[]): string {
  const n = (s: HealthState) => options.filter((o) => o.health === s).length;
  const bits = [
    n('ok') ? `${n('ok')} working at the last check` : '',
    n('failed') ? `${n('failed')} FAILED the last check` : '',
    n('not-covered') ? `${n('not-covered')} not covered by the check` : '',
    n('unknown') ? `${n('unknown')} of unknown health` : '',
  ].filter(Boolean);
  return bits.join(', ');
}
