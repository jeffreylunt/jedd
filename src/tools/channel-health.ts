import type { Config } from '../config.js';
import { renderOutcome, runOnHp, type ExecImpl } from '../hp.js';
import { hourMinute12 } from './sports-fixture.js';
import { fail, ok, type Tool } from './types.js';

/**
 * PER-CHANNEL LIVE TV HEALTH — the one verb a generic GET cannot replace.
 *
 * ── 🔴 WHY THIS IS A TOOL AND NOT A PATH ─────────────────────────────────────
 *
 * It is **not HTTP-reachable at any host**, so `homelab_read` cannot express it
 * no matter how good the model is at composing endpoints:
 *
 *  - The results live in a FILE on hp, `/tmp/check-streams-results.txt`, written
 *    by the stream checker. Nothing serves it.
 *  - The channel roster lives in Dispatcharr's **Postgres**, reachable only via
 *    `docker exec`. Dispatcharr's REST API returns 401 on every channel endpoint
 *    and no credential for it exists anywhere in this repo's environment.
 *
 * ── 🔴 IT NEVER PROBES. THIS IS THE WHOLE SAFETY PROPERTY. ───────────────────
 *
 * A live check is `ffprobe` per channel at ~10 s each, and that loop has wedged
 * the whole 242-channel run for THREE HOURS. So this tool reads what the last
 * run already wrote and **reports how old it is**. Both commands below are
 * literals; there is no argument, and no combination of arguments, that makes
 * this open a stream.
 *
 * ⚠️ Which means every answer here is a SNAPSHOT WITH AN AGE, and the age is
 * reported first, every time. A two-day-old "242 OK" presented as current is
 * worse than no answer: it retires the question.
 *
 * ── 🔴 THE FILTER IS APPLIED IN TYPESCRIPT, NEVER IN THE COMMAND ─────────────
 *
 * `channel` is a model-supplied STRING, and this file's second command runs on
 * the PRIVILEGED ssh identity because it needs docker. The repo's rule is that
 * no model-supplied string is ever interpolated into a command on that identity
 * (see `src/tools/docker.ts`). Rather than validating the string, we fetch all
 * ~244 rows — they are tiny — and filter them here, so the string never reaches
 * a shell at all. That makes the injection unrepresentable instead of guarded.
 */

const RESULTS_PATH = '/tmp/check-streams-results.txt';

/**
 * mtime, then the host's clock, then the file. One round trip, and the clock
 * comes from the SAME machine as the mtime — comparing hp's mtime against the
 * Mac's clock would fold any clock skew straight into the reported age.
 */
const RESULTS_CMD = `stat -c %Y ${RESULTS_PATH} && date +%s && cat ${RESULTS_PATH}`;

/**
 * The roster. `-At -F'|'` gives unaligned, tuple-only, pipe-separated rows, the
 * same shape as the results file. No credential is needed: psql connects over
 * the container's local socket as its own owner.
 */
const ROSTER_CMD =
  "docker exec dispatcharr psql -U dispatch -d dispatcharr -At -F'|' -c " +
  '"select channel_number, name, (epg_data_id is not null), hidden_from_output ' +
  'from dispatcharr_channels_channel order by channel_number"';

/** Older than this and the snapshot is called out as stale rather than merely dated. */
const STALE_AFTER_SECONDS = 24 * 60 * 60;

/** How many rows to print when the caller asked about a specific channel. */
const MAX_DETAIL_ROWS = 25;
/** How many names to print in a list of problems before summarising the rest. */
const MAX_NAMED = 20;

export interface StreamCheckRow {
  number: string;
  name: string;
  ok: boolean;
  codec: string;
  resolution: string;
  fps: string;
}

/**
 * 🔴 THE COLUMN AFTER THE VERDICT MEANS A DIFFERENT THING ON A FAIL ROW.
 *
 * Found on the first live run, not from the file's header. An OK row is
 * `num|name|OK|h264|1280x720|60000/1001`. A FAIL row reuses column 4 for the
 * REASON:
 *
 *   `7705|ESPN DEPORTES …|FAIL|http://…/1537742.ts: Server returned 4XX Client
 *    Error, but not one of 40{0,1,3,4}|?|?`
 *
 * Rendering that under a "codec" label prints a URL and an HTTP error where a
 * codec should be, which reads as corrupt data rather than as the diagnosis it
 * actually is — and the diagnosis is the single most useful field in the file.
 * So the verdict decides how the row is read, and the reason is labelled.
 */
export function describeRow(r: StreamCheckRow): string {
  const detail = r.ok
    ? `${r.codec || '?'} ${r.resolution || '?'} ${r.fps || '?'}`
    : r.codec.trim()
      ? `reason: ${r.codec.trim()}`
      : 'no reason recorded';
  return `${r.ok ? 'OK  ' : 'FAIL'} ${r.number} ${r.name} — ${detail}`;
}

export interface RosterRow {
  number: string;
  name: string;
  hasEpg: boolean;
  hidden: boolean;
}

/**
 * `num|name|OK/FAIL|codec|WxH|fps`.
 *
 * ⚠️ A line that does not parse is COUNTED AND REPORTED, never dropped. A parser
 * that silently skips malformed rows turns a checker that started writing
 * garbage into a checker that looks like it found fewer channels.
 */
export function parseStreamCheck(text: string): { rows: StreamCheckRow[]; unparsed: number } {
  const rows: StreamCheckRow[] = [];
  let unparsed = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('|');
    if (parts.length < 3) {
      unparsed++;
      continue;
    }
    const verdict = (parts[2] ?? '').trim().toUpperCase();
    if (verdict !== 'OK' && verdict !== 'FAIL') {
      unparsed++;
      continue;
    }
    rows.push({
      number: (parts[0] ?? '').trim(),
      name: (parts[1] ?? '').trim(),
      ok: verdict === 'OK',
      codec: (parts[3] ?? '').trim(),
      resolution: (parts[4] ?? '').trim(),
      fps: (parts[5] ?? '').trim(),
    });
  }
  return { rows, unparsed };
}

/** `channel_number|name|t/f|t/f` out of psql. */
export function parseRoster(text: string): RosterRow[] {
  const rows: RosterRow[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('|');
    if (parts.length < 4) continue;
    rows.push({
      // psql renders `channel_number` as a double: "1" or "1.5". Kept as text so
      // it compares byte-for-byte with the results file's own column.
      number: (parts[0] ?? '').trim(),
      name: (parts[1] ?? '').trim(),
      hasEpg: (parts[2] ?? '').trim() === 't',
      hidden: (parts[3] ?? '').trim() === 't',
    });
  }
  return rows;
}

/** Human age. Reported to the minute; nothing here needs seconds. */
export function describeAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'an UNKNOWN time ago';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  // Minutes are dropped once the age is measured in days — nobody needs them —
  // and a zero component is omitted rather than rendered as "3h 0m".
  const parts = [d ? `${d}d` : '', h ? `${h}h` : '', !d && m ? `${m}m` : ''].filter(Boolean);
  return `${parts.join(' ') || '0m'} ago`;
}

/** A unix timestamp line, or null. Empty and non-numeric are both null, never 0. */
function epoch(line: string | undefined): number | null {
  const t = (line ?? '').trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * 🔴 ONE READER, TWO TOOLS. `sports_fixture` JOINS HEALTH ONTO ITS CHANNELS.
 *
 * Jeff: *"if there is more than one channel a game or event is on, the bot should
 * be able to list all of them."* A list of options is worse than useless if the
 * first one is known-broken, and the health data is already sitting in this file
 * — so `sports_fixture` annotates every channel it found with what the last
 * sweep said about it.
 *
 * It calls THIS rather than re-reading the file, because everything that makes
 * the read honest is here and none of it is obvious: the mtime and the clock
 * come from the SAME machine (comparing hp's mtime against the Mac's would fold
 * clock skew into the age), `Number('')` is 0 rather than NaN so an empty first
 * line would silently become 1970, and an unparseable line is COUNTED rather
 * than dropped. A second implementation would get at least one of those wrong.
 *
 * ⚠️ Unprivileged identity, literal command, no argument. It cannot be made to
 * open a stream — probing is ~10 s per channel and has wedged the 242-channel
 * loop for three hours.
 */
export interface StreamCheckSnapshot {
  rows: StreamCheckRow[];
  unparsed: number;
  /** NaN when the clock could not be read. Never treat that as fresh. */
  ageSeconds: number;
  /** When the check ran, `YYYY-MM-DD HH:MM` UTC, or 'unknown'. */
  when: string;
}

export type StreamCheckRead = { ok: true; snapshot: StreamCheckSnapshot } | { ok: false; detail: string };

export async function readStreamCheck(config: Config, exec?: ExecImpl): Promise<StreamCheckRead> {
  const results = await runOnHp(config.shellSshHost, RESULTS_CMD, 30_000, exec);
  if (results.exitCode !== 0) {
    // 🔴 UNREADABLE IS UNKNOWN, NEVER "NO CHANNELS ARE HEALTHY".
    return { ok: false, detail: `could not read ${RESULTS_PATH} on hp: ${renderOutcome(results)}` };
  }
  const lines = results.stdout.split('\n');
  const mtime = epoch(lines[0]);
  const now = epoch(lines[1]);
  const { rows, unparsed } = parseStreamCheck(lines.slice(2).join('\n'));
  if (rows.length === 0) {
    return {
      ok: false,
      detail: `${RESULTS_PATH} was read but holds no parseable channel rows (${unparsed} unparseable line(s))`,
    };
  }
  return {
    ok: true,
    snapshot: {
      rows,
      unparsed,
      ageSeconds: mtime !== null && now !== null ? now - mtime : NaN,
      // 🔴 12-hour with a zone, same rule as every other time a reader sees —
      // Jeff: "always give the time zone" and "make it in 12 hour time too".
      // This string is quoted straight into replies by both tools that use it.
      when: mtime !== null ? formatSnapshotTime(new Date(mtime * 1000)) : 'unknown',
    },
  };
}

/**
 * 🔴 THREE AGE STATES, AND AN UNKNOWN ONE MUST NOT TAKE THE REASSURING BRANCH.
 *
 * The first version tested `isFinite(age) && age > threshold`, so an unreadable
 * clock — NaN, or a negative age from skew — fell through to the sentence
 * written for a FRESH result. The whole contract of this data is that the age
 * gates whether it may be quoted as current, so an unknown age has to be at
 * least as cautious as a stale one, never less.
 */
/** `2026-08-23 3:15 PM UTC` — reader-facing, so 12-hour and zoned. */
function formatSnapshotTime(at: Date): string {
  return `${at.toISOString().slice(0, 10)} ${hourMinute12(at.getUTCHours(), at.getUTCMinutes())} UTC`;
}

export function describeFreshness(ageSeconds: number): string {
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0) {
    return '⚠️ I could NOT work out how old this is, so treat it as stale: it may describe how things were at any point in the past.';
  }
  return ageSeconds > STALE_AFTER_SECONDS
    ? '⚠️ STALE: this is more than a day old, so it describes how things WERE, not how they are.'
    : 'This is a snapshot, not a live probe.';
}

/** Does this row match what the caller asked about? Exact number, or name substring. */
function matches(needle: string, number: string, name: string): boolean {
  const n = needle.trim().toLowerCase();
  if (!n) return true;
  return number.trim().toLowerCase() === n || name.toLowerCase().includes(n);
}

export const channelHealth: Tool = {
  name: 'channel_health',
  description:
    'Per-channel Live TV health: which IPTV channels were working the last time the stream checker ' +
    'ran, with codec and resolution, plus the Dispatcharr channel roster and which channels the check ' +
    'did not cover. Use it for "is channel X working" and "how many channels are broken". ' +
    'It NEVER opens a stream — probing costs about 10 seconds per channel and has wedged the whole ' +
    '242-channel run for three hours — so this is a SNAPSHOT and the first line always says how old ' +
    'it is. Report that age with the answer; if it is stale, say so instead of presenting it as ' +
    'current. Pass `channel` to ask about one channel by name or number. For Jeff it also reports ' +
    'which channels Dispatcharr knows about that the check never covered.',
  // CONTENT: which channel works is not about a person and is not a secret, so
  // it is everyone's. The privileged half of it is gated inside `run`.
  minRole: 'guest',
  writes: false,
  parameters: {
    type: 'object',
    properties: {
      channel: {
        type: 'string',
        description:
          'Optional. A channel number (exact) or part of a channel name (case-insensitive), e.g. ' +
          '"ESPN" or "1234". Omit for the whole picture.',
      },
    },
    required: [],
  },

  async run(args, ctx) {
    const needle = typeof args['channel'] === 'string' ? args['channel'] : '';

    // 🔴 The results file first, on the UNPRIVILEGED identity: it is a plain
    // world-readable file and needs no docker, so it takes the smaller
    // capability. Shared with `sports_fixture` — see `readStreamCheck`.
    const read = await readStreamCheck(ctx.config, ctx.exec);
    if (!read.ok) {
      /**
       * 🔴 UNREADABLE IS UNKNOWN, NEVER "NO CHANNELS ARE HEALTHY".
       *
       * A missing results file means the checker has not run or was cleaned out
       * of /tmp. Rendering that as zero healthy channels is a false zero that
       * reads as a total Live TV outage.
       */
      return fail(
        `Per-channel health is UNKNOWN — this is NOT "no channels are working". The stream checker ` +
          `may not have run. ${read.detail}`,
      );
    }
    const { rows, unparsed, ageSeconds, when } = read.snapshot;
    const freshness = describeFreshness(ageSeconds);

    /**
     * ⚠️ Carried on EVERY path, not just the whole-picture one. When it appeared
     * only in the summary, a checker writing garbage answered "is ESPN working?"
     * with a confident *"no such channel"* — the exact false negative
     * `parseStreamCheck` counts unparsed lines in order to prevent.
     */
    const garbage = unparsed
      ? ` ⚠️ ${unparsed} line(s) in the results file did not parse, so the check itself may be ` +
        'malfunctioning and this list may be incomplete.'
      : '';

    const sections: string[] = [`Stream check last ran ${when} — ${describeAge(ageSeconds)}. ${freshness}${garbage}`];

    /**
     * ── 🔴 THE ROSTER HALF IS OWNER-ONLY, AND THE REASON IS THE MECHANISM ────
     *
     * *Which channel works* is CONTENT by Jeff's rule — it is not about a person
     * and not a secret — so a guest gets the answer above, from a world-readable
     * file on the unprivileged ssh identity.
     *
     * The roster is a different thing. It is `docker exec` on the **privileged**
     * identity, and that is a capability rather than a data class. The three
     * tiers classify what data is ABOUT; they say nothing about what a call
     * CAUSES, and this is the one tool where those two answers differ. Every
     * other guest-visible tool is HTTP-only.
     *
     * ⚠️ So a guest does not reach it **by construction — the call is not made**
     * — rather than by filtering its output afterwards. That also means a
     * guest never sees this command's stderr, which on failure quotes container
     * names and paths.
     *
     * 🔴 AND "I DID NOT ASK" IS NOT "I ASKED AND IT FAILED". Those render
     * differently below. Collapsing them would tell a guest the homelab is
     * broken when nothing was even attempted — a false failure, which is the
     * false zero pointing the other way.
     */
    const rosterEligible = ctx.role === 'owner';
    const roster = rosterEligible
      ? await runOnHp(ctx.config.adminSshHost, ROSTER_CMD, 30_000, ctx.exec)
      : null;
    const rosterRows = roster && roster.exitCode === 0 ? parseRoster(roster.stdout) : [];
    const rosterKnown = !!roster && roster.exitCode === 0 && rosterRows.length > 0;

    if (needle.trim()) {
      const hits = rows.filter((r) => matches(needle, r.number, r.name));
      const rosterHits = rosterRows.filter((r) => matches(needle, r.number, r.name));
      if (hits.length === 0 && rosterHits.length === 0) {
        sections.push(
          `No channel matching "${needle}" in the ${rows.length} checked` +
            (rosterKnown ? ` or in Dispatcharr's ${rosterRows.length}-channel roster.` : '.') +
            (rosterKnown
              ? ''
              : rosterEligible
                ? ' ⚠️ The Dispatcharr roster could not be read, so a channel that exists but was never checked would be invisible here.'
                : ' (I only checked the stream-check results, not the full Dispatcharr channel list.)'),
        );
        return ok(sections.join('\n'));
      }
      const checked = new Set(hits.map((h) => h.number));
      sections.push(
        hits.length
          ? `${hits.length} matching channel(s) in the last check:\n` +
            hits.slice(0, MAX_DETAIL_ROWS).map((r) => `  ${describeRow(r)}`).join('\n') +
            (hits.length > MAX_DETAIL_ROWS ? `\n  … ${hits.length - MAX_DETAIL_ROWS} more not shown` : '')
          : `NONE of the matching channels appear in the last check at all.`,
      );
      const uncheckedHits = rosterHits.filter((r) => !checked.has(r.number));
      if (rosterKnown && uncheckedHits.length) {
        sections.push(
          `⚠️ ${uncheckedHits.length} matching channel(s) exist in Dispatcharr but were NOT in the ` +
            `last check, so their state is UNKNOWN:\n` +
            uncheckedHits.slice(0, MAX_NAMED).map((r) => `  ${r.number} ${r.name}`).join('\n'),
        );
      }
      const noEpg = rosterHits.filter((r) => !r.hasEpg);
      if (rosterKnown && noEpg.length) {
        sections.push(
          `Note: ${noEpg.length} of these have NO EPG mapping in Dispatcharr, so the guide will show ` +
            `nothing for them even when the stream is fine: ${noEpg.slice(0, MAX_NAMED).map((r) => r.name).join(', ')}`,
        );
      }
      return ok(sections.join('\n'));
    }

    const failing = rows.filter((r) => !r.ok);
    sections.push(`${rows.length} channels checked: ${rows.length - failing.length} OK, ${failing.length} FAIL.`);
    if (failing.length) {
      sections.push(
        `FAILING at that time:\n` +
          failing.slice(0, MAX_NAMED).map((r) => `  ${describeRow(r)}`).join('\n') +
          (failing.length > MAX_NAMED ? `\n  … ${failing.length - MAX_NAMED} more` : ''),
      );
    }

    if (!rosterKnown) {
      sections.push(
        roster
          ? "⚠️ Dispatcharr's channel roster could NOT be read " +
            `(exit=${roster.exitCode}, stderr=${roster.stderr.trim() || '(empty)'}), so I cannot say ` +
            'whether the check covered every channel that exists. Coverage is UNKNOWN.'
          : 'This is the stream-check results file only. I did not look up the full Dispatcharr ' +
            'channel list, so a channel that exists but was never checked would not appear above — ' +
            'that is a limit of what I looked at, NOT a report that anything is wrong.',
      );
      return ok(sections.join('\n'));
    }

    const checkedNumbers = new Set(rows.map((r) => r.number));
    const noEpg = rosterRows.filter((r) => !r.hasEpg);
    const hidden = rosterRows.filter((r) => r.hidden);
    sections.push(
      `Dispatcharr roster: ${rosterRows.length} channels (${hidden.length} hidden from output, ` +
        `${noEpg.length} with no EPG mapping — the guide shows nothing for those even when the stream works).`,
    );
    /**
     * ⚠️ HIDDEN CHANNELS ARE EXCLUDED FROM THE COVERAGE GAP ON PURPOSE.
     *
     * A channel hidden from output is expected never to be checked, so listing
     * it as UNKNOWN names the same rows on every single run. Over-reporting
     * UNKNOWN is the safe direction and still the wrong one here: it dilutes the
     * list that matters until nobody reads it. The count is still stated, so the
     * exclusion is visible rather than silent.
     */
    const uncovered = rosterRows.filter((r) => !checkedNumbers.has(r.number) && !r.hidden);
    const uncoveredHidden = rosterRows.filter((r) => !checkedNumbers.has(r.number) && r.hidden).length;
    sections.push(
      (uncovered.length
        ? `NOT COVERED by the last check (present in Dispatcharr, absent from the results file), so ` +
          `UNKNOWN rather than working: ${uncovered.length}\n` +
          uncovered.slice(0, MAX_NAMED).map((r) => `  ${r.number} ${r.name}`).join('\n') +
          (uncovered.length > MAX_NAMED ? `\n  … ${uncovered.length - MAX_NAMED} more` : '')
        : 'Every visible channel in the Dispatcharr roster appears in the last check.') +
        (uncoveredHidden
          ? `\n(${uncoveredHidden} hidden channel(s) were also not checked, which is expected.)`
          : ''),
    );
    return ok(sections.join('\n'));
  },
};
