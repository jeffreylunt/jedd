import type { FetchImpl } from '../media/arr.js';
import {
  EspnClient,
  LEAGUE_KEYS,
  fixtureInvolves,
  leagueLabel,
  type Fixture,
  type LeagueKey,
} from '../media/espn.js';
import { findFixtureInGuide, kickoffWindow } from '../media/guide.js';
import { fail, ok, type Tool } from './types.js';

/**
 * "When do Crystal Palace play next, and what channel is it on?"
 *
 * ── THE DEFECT THIS TOOL EXISTS TO REMOVE ────────────────────────────────────
 *
 * The guide is the only thing that knows about channels, and it reaches about
 * four days (measured: 5,614 programmes on 2026-08-26, 296 by 2026-08-29, then
 * 8/day of placeholder text that is not guide data at all). Ask a guide-only
 * tool about a fixture six days out and it searches, finds nothing, and answers
 * **"no game"**. The fixture exists. The guide simply does not reach it.
 *
 * So the tool correlates two sources that answer different halves:
 *
 *   ESPN scoreboard  → the fixture exists, kickoff is at T.   (weeks ahead)
 *   Jellyfin guide   → and this channel is carrying it.        (~4 days)
 *
 * 🔴 **A FIXTURE OUTSIDE THE GUIDE'S REACH REPORTS THE KICKOFF AND SAYS THE
 * CHANNEL IS NOT LISTED YET.** Never "no game". That false zero is the entire
 * reason this exists, and it is the outcome for most questions asked here,
 * because most fixtures are more than four days out.
 *
 * ── 🔴 AND THE INVERSE: NO FIXTURE SOURCE MEANS NO ANSWER ────────────────────
 *
 * ESPN's API is unofficial and can change or vanish without notice. When it
 * does, this tool **fails**. It does not degrade to searching the guide alone,
 * because that is the old behaviour wearing a new tool's clothes: it would
 * reintroduce the exact false zero above while still looking like it works. An
 * error is a better outcome than a confident wrong answer.
 *
 * That guarantee is STRUCTURAL, not a rule someone has to remember: the guide
 * call lives below an early return, so there is no path from an ESPN failure to
 * a guide read. `test/sports-fixture.test.ts` asserts on the ABSENCE of the
 * guide call, because "it did not fall through" is not observable from the
 * return value.
 *
 * ── 🔴 A CHANNEL NAME ONLY EVER COMES FROM A GUIDE RECORD ────────────────────
 *
 * ESPN populates `broadcasts` for its US leagues (MLS → "Apple TV", NFL → "NFL
 * Net") and leaves it EMPTY for the Premier League. Either way it names a US
 * carrier that has nothing to do with what this house can tune, so it is read
 * and discarded in `espn.ts` rather than passed up here. If no guide record was
 * found, no channel is named at all.
 *
 * ── REPLAY DISAMBIGUATION FALLS OUT, AND IT WAS CHECKED ──────────────────────
 *
 * On 2026-08-25 the guide carried `PL: Everton v Crystal Palace` at 22:00 on
 * `NZ: SKY SPORTS 7 4K` — a rebroadcast of a match played ten days earlier. A
 * naive tool answers *"Palace are on tonight at 22:00 on Sky Sports 7"*, which
 * is false. Two independent mechanisms make it unreachable here, and both were
 * verified rather than assumed:
 *
 *  1. ESPN drops every event whose own `status.type.state` is `post`, so a
 *     finished match is never the fixture we look up.
 *  2. The guide is only ever searched in a window around the SURVIVING
 *     kickoff — 90 minutes before to 15 after. Measured: the 22:00 replay is
 *     present in a 2026-08-25 window and absent from the 2026-08-28 fixture
 *     window, which is the window this tool would search.
 *
 * A third, weaker net catches a replay airing inside the kickoff window itself:
 * replay-ish words in the prose are FLAGGED on the programme. They are not
 * filtered — there is no structured repeat marker that works (`previously-shown`
 * is on 52% of the feed and on none of the four measured replays), and prose is
 * not reliable enough to silently drop the one programme someone asked about.
 */

/** Local wall-clock, pinned rather than inherited. */
const DISPLAY_TZ = 'America/Denver';

const DEFAULT_DAYS = 30;
const MIN_DAYS = 1;
const MAX_DAYS = 120;

/** How many further fixtures to list after the next one. */
const LOOKAHEAD = 3;

/**
 * How far ahead a guide lookup is worth attempting.
 *
 * The guide runs about four days deep (measured: 5,614 programmes on
 * 2026-08-26, 296 by 2026-08-29). Five days is that plus a margin, so a fixture
 * inside it gets a real answer and one outside it is honestly labelled
 * unchecked rather than searched-and-empty. Bounded because each lookup is a
 * request: at most `LOOKAHEAD + 1` of them per call.
 */
const GUIDE_HORIZON_MS = 5 * 86_400_000;

/**
 * Kickoff in three forms, because the model has no clock.
 *
 * 🔴 There is no current time in the system prompt. A bare ISO timestamp leaves
 * the model to work out "is that tonight or next week" from nothing, and it will
 * guess. UTC, local wall-clock and a relative phrase are all rendered here so
 * that none of it is arithmetic anybody has to do.
 */
export function renderKickoff(kickoffMs: number, nowMs: number): string {
  // Minute precision, matching the form ESPN itself uses (`2026-08-28T19:00Z`),
  // so the rendered stamp and the source agree character for character.
  const iso = `${new Date(kickoffMs).toISOString().slice(0, 16)}Z`;
  let local: string;
  try {
    const formatted = new Intl.DateTimeFormat('en-GB', {
      timeZone: DISPLAY_TZ,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(new Date(kickoffMs));
    // ⚠️ Under a small-ICU node `timeZoneName: 'short'` renders as "GMT-6", not
    // "MDT". Both are unambiguous about the offset and neither says WHOSE local
    // time it is, so the zone is named alongside rather than left to be inferred.
    local = `${formatted} Mountain`;
  } catch {
    local = 'local time unavailable';
  }
  const deltaMs = kickoffMs - nowMs;
  const hours = deltaMs / 3_600_000;
  let relative: string;
  if (deltaMs < 0) {
    const ago = Math.round(-deltaMs / 60_000);
    relative = ago < 180 ? `started ${ago} min ago` : `started ${Math.round(-hours)} h ago`;
  } else if (hours < 1) {
    relative = `in ${Math.max(1, Math.round(deltaMs / 60_000))} min`;
  } else if (hours < 36) {
    relative = `in ${Math.round(hours)} h`;
  } else {
    const d = Math.round(hours / 24);
    relative = `in ${d} ${d === 1 ? 'day' : 'days'}`;
  }
  return `${iso} — ${local} (${relative})`;
}

function teamLine(f: Fixture): string {
  if (f.teams.length < 2) return f.name;
  const home = f.teams.find((t) => t.homeAway === 'home');
  const away = f.teams.find((t) => t.homeAway === 'away');
  if (home && away) return `${away.displayName} at ${home.displayName}`;
  return f.name;
}

export function makeSportsFixture(fetchImpl?: FetchImpl, now: () => number = () => Date.now()): Tool {
  return {
    name: 'sports_fixture',
    description:
      'When is a team playing next, and is a channel listed for it? Combines a live fixture list ' +
      '(ESPN) with the TV guide. Use this for "when do Crystal Palace play", "are the Jazz on ' +
      'tonight", "what channel is the game on". It reports the KICKOFF even when no channel is ' +
      'listed — the guide only reaches about four days ahead, so most fixtures are found with no ' +
      'channel yet, and that is an answer, not a "no game". A channel is only ever named when a ' +
      'guide entry was actually found. If the fixture list cannot be reached it FAILS rather than ' +
      'answering from the guide alone.',
    minRole: 'guest',
    /**
     * 🔴 CONTENT, not PERSON. What is on television is not about anybody, so
     * this sits with `library_search` on the guest side of Jeff's rule: read
     * access to the library and what is on, no access to other people's
     * information or server secrets. It reads two public-ish schedules and
     * names nobody.
     */
    writes: false,
    parameters: {
      type: 'object',
      properties: {
        league: {
          type: 'string',
          enum: LEAGUE_KEYS,
          description:
            'Which competition to look in. "epl" is the English Premier League. Pick from the ' +
            "person's wording; if they named a team but not a competition, pick the one that team " +
            'plays in.',
        },
        team: {
          type: 'string',
          description:
            'The team asked about, e.g. "Crystal Palace" or "Utah Jazz". Partial names work. Leave ' +
            'this out to list the next fixtures in the whole competition.',
        },
        days_ahead: {
          type: 'number',
          description: `How far ahead to look for fixtures, in days (default ${DEFAULT_DAYS}, max ${MAX_DAYS}).`,
        },
      },
      required: ['league'],
    },

    async run(args, ctx) {
      const rawLeague = typeof args['league'] === 'string' ? args['league'].trim().toLowerCase() : '';
      if (!(LEAGUE_KEYS as string[]).includes(rawLeague)) {
        return fail(
          `"${rawLeague}" is not a competition I can look up. Choose one of: ${LEAGUE_KEYS.join(', ')}.`,
        );
      }
      const league = rawLeague as LeagueKey;
      const label = leagueLabel(league);

      // Finiteness matters: NaN survives Math.min/Math.max and would render as
      // the text "NaN" in a date and in the message.
      const rawDays = args['days_ahead'];
      const days = Math.min(
        Math.max(
          typeof rawDays === 'number' && Number.isFinite(rawDays) ? Math.trunc(rawDays) : DEFAULT_DAYS,
          MIN_DAYS,
        ),
        MAX_DAYS,
      );
      const team = typeof args['team'] === 'string' ? args['team'].trim() : '';

      const nowMs = now();
      const espn = new EspnClient({ fetchImpl });
      const answer = await espn.fixtures(league, nowMs, nowMs + days * 86_400_000);

      // ─────────────────────────────────────────────────────────────────────
      // 🔴 THE EARLY RETURN THAT IS THE WHOLE GUARANTEE.
      //
      // Nothing below this line runs when the fixture source did not answer, so
      // there is no code path from "ESPN is unreachable" to a guide-only reply.
      // Do not turn this into a warning-and-continue: continuing would answer
      // "nothing found" from a four-day guide and call it a schedule.
      // ─────────────────────────────────────────────────────────────────────
      if (answer.state !== 'results') {
        return fail(
          `THE FIXTURE SOURCE IS UNREACHABLE, so I do not know when ${team || `any ${label} team`} ` +
            `plays next: ${answer.detail}\n` +
            'I did NOT fall back to searching the TV guide. The guide only reaches about four days ' +
            'ahead and holds no fixture list, so a guide-only answer would report a match as ABSENT ' +
            'merely because it is further out than that — the mistake this tool exists to avoid. ' +
            'Say the schedule could not be checked; do not guess at one.',
        );
      }

      const all = answer.fixtures;
      const wanted = team ? all.filter((f) => fixtureInvolves(f, team)) : all;
      const who = team ? `"${team}"` : `any ${label} team`;
      const sourceLine =
        `FIXTURE SOURCE (ESPN ${label} scoreboard): ${answer.considered} events in ` +
        `${answer.windowFrom.slice(0, 10)} → ${answer.windowTo.slice(0, 10)}, ` +
        `${all.length} still upcoming or in progress, ${wanted.length} involving ${who}.`;

      if (!wanted.length) {
        // A real zero, and bounded as one. `considered` is reported so that "the
        // schedule is empty" and "the name did not match" are different
        // sentences rather than the same blank.
        const why = answer.considered
          ? `ESPN listed ${answer.considered} ${label} events in that window and none involve ${who}.`
          : `ESPN listed NO ${label} events at all in that window.`;
        return ok(
          `${sourceLine}\n\nNO FIXTURE FOUND for ${who} in the next ${days} days. ${why}\n` +
            'This is bounded by the window, not by the TV guide — a fixture further out than ' +
            `${days} days would not appear here. Widen days_ahead, or check the team name.`,
        );
      }

      const next = wanted[0] as Fixture;
      const parts: string[] = [sourceLine, ''];
      const stateNote = next.state === 'in' ? ' 🔴 IN PROGRESS NOW' : '';
      parts.push(`NEXT: ${teamLine(next)}${stateNote}`);
      parts.push(`  kickoff ${renderKickoff(next.kickoffMs, nowMs)}`);
      if (next.venue) parts.push(`  venue ${next.venue}`);
      parts.push('');

      const guide = await findFixtureInGuide(ctx.config, next, fetchImpl);
      const win = kickoffWindow(next);
      const winText = `${new Date(win.fromMs).toISOString().slice(0, 16)}Z → ${new Date(win.toMs)
        .toISOString()
        .slice(0, 16)}Z`;

      /**
       * 🔴 WHAT THIS RESULT DOES NOT COVER, SAID OUT LOUD.
       *
       * Caught on a real turn, not in a test. Asked *"is Crystal Palace on TV
       * tonight?"* the model answered correctly about Friday's fixture and then
       * added **"Nothing involving Palace in the guide for tonight"** — a claim
       * the tool never made and that is FALSE: the guide really does list `PL:
       * Everton v Crystal Palace` tonight at 22:00, a rebroadcast.
       *
       * The tool searched one 105-minute window and reported a zero. A zero
       * over a stated window reads as a zero over the day unless the result
       * says otherwise, so it says otherwise — and the sentence that closes the
       * over-read is the same sentence that explains the replay.
       */
      const scopeNote =
        '  ⚠️ ONLY that window was searched, so this says NOTHING about the rest of the guide. ' +
        'A rebroadcast of an OLDER match involving these teams may well be listed at another time ' +
        'today; it would not be this fixture. Do not report on any time this window does not cover.';

      if (guide.state !== 'searched') {
        // 🔴 The guide failing NEVER suppresses the fixture. The kickoff above
        // is already established by a source that answered; only the channel
        // half is unknown.
        parts.push(
          `TV GUIDE: could NOT be searched — ${guide.detail}\n` +
            '  The kickoff above still stands; only the channel is unknown. Report the kickoff.',
        );
      } else if (!guide.matches.length) {
        const truncated = guide.scanned < guide.total;
        parts.push(`TV GUIDE: searched ${winText} — ${guide.scanned} programmes on ${guide.channels} channels.`);
        if (truncated) {
          // 🔴 An unfinished search is not a zero, and must not be reported as
          // one. Only reachable if a kickoff window ever exceeds the record cap.
          parts.push(
            `  ⚠️ SCAN TRUNCATED: ${guide.scanned} of ${guide.total} programmes were read, so ` +
              '"not listed" here is NOT conclusive.',
          );
        } else if (guide.scanned === 0) {
          parts.push(
            '  NO CHANNEL LISTED YET — the guide holds NOTHING at all for that window, i.e. it does ' +
              'not reach that far ahead (it runs about four days deep).',
          );
        } else {
          parts.push(
            '  NO CHANNEL LISTED YET — the guide does cover that window, but no programme in it ' +
              'names both teams.',
          );
        }
        parts.push(
          '  🔴 A MISSING CHANNEL IS NOT A MISSING FIXTURE. The kickoff above is confirmed by the ' +
            'fixture source; only the channel is unknown. Say when the match is on and that no ' +
            'channel is listed for it yet.',
        );
        parts.push(scopeNote);
      } else {
        parts.push(
          `TV GUIDE: searched ${winText} — ${guide.scanned} programmes on ${guide.channels} channels, ` +
            `${guide.matches.length} naming both teams:`,
        );
        for (const m of guide.matches) {
          parts.push(`  CHANNEL: ${m.channelName}`);
          parts.push(`    "${m.name}" starts ${m.startDate.slice(0, 16)}Z`);
          if (m.overview) parts.push(`    ${m.overview.slice(0, 200)}`);
          if (m.replayMarkers.length) {
            parts.push(
              `    ⚠️ POSSIBLE REPLAY — the listing says "${m.replayMarkers.join('", "')}". Check the ` +
                'description before telling anyone this is the live match.',
            );
          }
        }
        parts.push(scopeNote);
      }

      const later = wanted.slice(1, 1 + LOOKAHEAD);
      if (later.length) {
        parts.push('');
        parts.push('LATER FIXTURES:');
        for (const f of later) {
          parts.push(`  ${renderKickoff(f.kickoffMs, nowMs)} — ${teamLine(f)}`);
          /**
           * 🔴 "NOT LOOKED UP" AND "NOT LISTED" ARE DIFFERENT, AND CONFLATING
           * THEM PRODUCED A FALSE STATEMENT ON A REAL TURN.
           *
           * This block used to render one line — *"LATER FIXTURES (kickoff only
           * — the guide does not reach these, so no channel was sought)"* — and
           * the model duly reported that the later Dodgers games "have no
           * channel listed yet". Both halves were wrong. The 26th and 27th are
           * WELL inside a guide that runs about four days, and both really do
           * have channels (MLB NETWORK, TNT SPORTS 1), so the parenthetical was
           * false and the conclusion drawn from it was false.
           *
           * So a fixture inside the guide's reach is now actually looked up,
           * and one beyond it is labelled as UNCHECKED rather than as empty. A
           * gap in what we looked at must never render as a finding about the
           * world.
           */
          if (f.kickoffMs > nowMs + GUIDE_HORIZON_MS) {
            parts.push('      not looked up — beyond the few days the guide reaches. This says NOTHING about whether a channel exists.');
            continue;
          }
          const g = await findFixtureInGuide(ctx.config, f, fetchImpl);
          if (g.state !== 'searched') {
            parts.push(`      channel UNKNOWN — the guide could not be searched (${g.detail})`);
          } else if (g.matches.length) {
            parts.push(`      channel: ${g.matches.map((m) => m.channelName).join(' | ')}`);
          } else if (g.scanned < g.total) {
            parts.push(`      channel UNKNOWN — the scan was truncated (${g.scanned} of ${g.total} programmes read)`);
          } else if (g.scanned === 0) {
            parts.push('      no channel listed — the guide holds nothing at all for that window yet');
          } else {
            parts.push(`      no channel listed — ${g.scanned} programmes in that window, none naming both teams`);
          }
        }
      }

      return ok(parts.join('\n'));
    },
  };
}
