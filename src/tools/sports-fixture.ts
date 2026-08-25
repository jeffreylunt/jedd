import type { FetchImpl } from '../media/arr.js';
import {
  EspnClient,
  LEAGUE_KEYS,
  leagueLabel,
  matchQuality,
  type Fixture,
  type LeagueKey,
} from '../media/espn.js';
import {
  ORDER_EXPLANATION,
  rankChannelOptions,
  summariseHealth,
  type ChannelOption,
  type HealthRow,
} from '../media/channel-options.js';
import { findFixtureInGuide, kickoffWindow, type GuideAnswer } from '../media/guide.js';
import { describeAge, describeFreshness, readStreamCheck } from './channel-health.js';
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

const HEALTH_LABEL: Record<ChannelOption['health'], string> = {
  ok: 'WORKING at the last check',
  failed: '🔴 FAILED the last check',
  'not-covered': 'NOT COVERED by the last check',
  unknown: 'health UNKNOWN',
};

/** One channel, its health, and every programme on it that named both teams. */
function renderOption(o: ChannelOption): string[] {
  const lines = [`  CHANNEL: ${o.channelName}  [${HEALTH_LABEL[o.health]} — ${o.healthDetail}]`];
  for (const p of o.programmes) {
    lines.push(`    "${p.name}" starts ${p.startDate.slice(0, 16)}Z`);
    if (p.overview) lines.push(`    ${p.overview.slice(0, 200)}`);
    if (p.replayMarkers.length) {
      lines.push(
        `    ⚠️ POSSIBLE REPLAY — the listing says "${p.replayMarkers.join('", "')}". Check the ` +
          'description before telling anyone this is the live match.',
      );
    }
  }
  return lines;
}

/**
 * 🔴 SAY THAT THE DECIDING FIELD IS ABSENT, AT THE MOMENT IT IS ABSENT.
 *
 * The replay marker lives only in `Overview`, and `fields=Overview,ChannelInfo`
 * is the one parameter that makes Jellyfin return it. If that stops working —
 * a server change, or an edit dropping the parameter — matching silently
 * degrades to title-only, every fixture whose teams live in the description
 * reports "no channels", and nothing anywhere says why.
 *
 * Keyed on the DATA rather than on the endpoint or the parameter string, so it
 * fires for any route into the same defect. Same shape and same reason as
 * `homelab_read`'s note; this verb needed its own because a new verb inherits
 * nothing from another tool's description.
 */
function overviewNote(guide: Extract<GuideAnswer, { state: 'searched' }>): string {
  if (guide.scanned === 0 || guide.withOverview > 0) return '';
  return (
    `  ⚠️ NONE of the ${guide.scanned} programmes in that window carried a description, so ` +
    'fields=Overview is not doing anything and matching fell back to titles alone. A fixture whose ' +
    'teams appear only in the description would be INVISIBLE here, and a replay could not be told ' +
    'from the live match. Treat a "no channels" result as UNRELIABLE until that is fixed.'
  );
}

/**
 * 🔴 "THE GUIDE COVERS THAT WINDOW" NEEDS A DENOMINATOR OR IT OVERSTATES.
 *
 * Measured 2026-08-25, and it is the same mistake this file's own author made
 * in prose before making it in code: guide depth collapses off a CLIFF, not a
 * slope. Channels with any data in a four-hour window —
 *
 *     T+0  224/243     T+1  220/243     T+2  197/243     T+3  13/243     T+4  12/243
 *
 * At T+3 the window still returns ~65 programmes, so "the guide does cover that
 * window" was literally true and thoroughly misleading: 13 of 243 channels had
 * filled in, and NONE of the fifteen UK sports channels had. Reporting the
 * fraction turns an implied "nobody is showing it" into the real finding, which
 * is "the guide has barely reached this far".
 *
 * ⚠️ The denominator is the channel count from the stream check, so it is
 * "channels the last sweep knows about", not a subscription list. Absent when
 * the sweep could not be read — and then this says nothing rather than guessing.
 */
function coverageNote(channelsWithData: number, health: HealthRow[] | null): string {
  if (!health || health.length === 0) return '';
  const pct = Math.round((channelsWithData / health.length) * 100);
  const base = `  Coverage: only ${channelsWithData} of ${health.length} channels have ANY programmes in that window (${pct}%).`;
  return pct < 25
    ? `${base} 🔴 The guide has BARELY filled in that far ahead, so this is a gap in the guide, not ` +
        'evidence that nobody is carrying the match. Expect channels to appear as the date gets closer.'
    : base;
}

/** Append a line only when it has content, so an inapplicable note is absent rather than blank. */
function pushIf(parts: string[], line: string): void {
  if (line) parts.push(line);
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
      'When is a team playing next, and which channels are carrying it? Combines a live fixture ' +
      'list (ESPN) across every competition it knows with the TV guide. Use this for "when do ' +
      'Crystal Palace play", "are the Jazz on tonight", "is there a game today", "what channel is ' +
      'the game on". ' +
      '🔴 PASS THE TEAM NAME AS THE PERSON SAID IT and LEAVE OUT league — it searches all ' +
      'competitions and works out which one the team is in. Do not translate a city into a team ' +
      'you know: "real salt lake" is Real Salt Lake, not the Utah Jazz. Only set league when they ' +
      'named a competition, or when they want its fixture list rather than a team. ' +
      '🔴 CALL IT AGAIN FOR ANY FOLLOW-UP THAT CHANGES THE TIME — "today", "tonight", "this ' +
      'week", "what about tomorrow" are NEW questions, and an earlier answer covered a different ' +
      'window. Never answer them from what you already said. ' +
      'It lists EVERY channel it found, not the first, with what the last stream check said about ' +
      'each and how old that check is — report that age, and do not present it as live. ' +
      'It reports the KICKOFF even when no channel is listed: the guide runs about four days deep ' +
      'despite claiming seven, so most fixtures come back with no channels yet, and that is an ' +
      'answer — never say they are not playing. A channel is named only when a guide entry was ' +
      'actually found. Every result names the competitions it searched: report that when you say ' +
      'no game was found, because "no game" is a claim about the world and what it checked is a ' +
      'list. If no competition can be reached it FAILS rather than answering from the guide alone. ' +
      'The result carries the current time; compare start times against THAT.',
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
            'OPTIONAL and usually WRONG to set. Leave it out and every competition is searched. ' +
            'Set it only when the person named a competition ("who is in the Premier League ' +
            'tonight"), never to narrow down a team you think you recognise.',
        },
        team: {
          type: 'string',
          description:
            'The team, WORDED AS THE PERSON WORDED IT — "real salt lake", "palace", "the jazz". ' +
            'Partial names work and an exact name always beats a loose one, so do not "helpfully" ' +
            'resolve it to a team you know first. Leave out only to list a competition.',
        },
        days_ahead: {
          type: 'number',
          description: `How far ahead to look for fixtures, in days (default ${DEFAULT_DAYS}, max ${MAX_DAYS}).`,
        },
      },
      required: [],
    },

    async run(args, ctx) {
      /**
       * 🔴 `league` IS OPTIONAL, AND THAT IS THE FIX FOR THE WORST DEFECT.
       *
       * It used to be REQUIRED, so the model had to choose a competition before
       * it could ask anything. Asked *"When is the next real salt lake game?"*
       * it chose `{league: 'nba', team: 'Utah Jazz'}` — it resolved a city to a
       * basketball team to satisfy a required argument, and this tool never saw
       * the words "real salt lake" at all.
       *
       * ⚠️ So the cross-sport error was NOT in the matcher; no amount of
       * ranking would have caught it, because the wrong team name arrived
       * already resolved. The repair is to stop demanding the answer as input:
       * with a name and no league, the tool searches every competition itself
       * and ranks by how well the name matches.
       */
      const rawLeague = typeof args['league'] === 'string' ? args['league'].trim().toLowerCase() : '';
      if (rawLeague && !(LEAGUE_KEYS as string[]).includes(rawLeague)) {
        return fail(
          `"${rawLeague}" is not a competition I can look up. Choose one of: ${LEAGUE_KEYS.join(', ')} ` +
            '— or leave it out entirely and I will search all of them.',
        );
      }
      const team = typeof args['team'] === 'string' ? args['team'].trim() : '';
      if (!rawLeague && !team) {
        return fail(
          'Tell me a team, a competition, or both. With a team name I search every competition I ' +
            `know (${LEAGUE_KEYS.length}); with a competition I list its next fixtures.`,
        );
      }
      const searched: LeagueKey[] = rawLeague ? [rawLeague as LeagueKey] : LEAGUE_KEYS;
      const scopeLabel = searched.map(leagueLabel).join(', ');

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

      const nowMs = now();
      const espn = new EspnClient({ fetchImpl });
      // Measured: 13 competitions in parallel is 612 ms / 3.87 MB, and the
      // dormant ones are ~1 KB each. Breadth is cheap; the gap was not.
      const answers = await Promise.all(
        searched.map((k) => espn.fixtures(k, nowMs, nowMs + days * 86_400_000)),
      );

      /**
       * 🔴 ONE UNREACHABLE COMPETITION DOES NOT SINK THE ANSWER, BUT SILENCE WOULD.
       *
       * The original rule — no fixture source, no answer — was written when
       * there was ONE source. With thirteen, failing the whole call because a
       * dormant cup endpoint blipped would be worse than useless. But a
       * competition that could not be read is a competition we cannot say
       * anything about, so the failures are NAMED and travel with the result.
       * If EVERY one failed we are back to the original case exactly, and it
       * still fails.
       */
      const okAnswers = answers.flatMap((a, i) =>
        a.state === 'results' ? [{ key: searched[i] as LeagueKey, a }] : [],
      );
      const failures = answers.flatMap((a, i) =>
        a.state === 'unknown' ? [`${leagueLabel(searched[i] as LeagueKey)} (${a.detail})`] : [],
      );
      if (okAnswers.length === 0) {
        return fail(
          `THE FIXTURE SOURCE IS UNREACHABLE, so I do not know when ${team || 'any team'} plays ` +
            `next. All ${searched.length} competition(s) failed:\n` +
            failures.map((f) => `  - ${f}`).join('\n') +
            '\nI did NOT fall back to searching the TV guide. The guide only reaches about four days ' +
            'ahead and holds no fixture list, so a guide-only answer would report a match as ABSENT ' +
            'merely because it is further out than that — the mistake this tool exists to avoid. ' +
            'Say the schedule could not be checked; do not guess at one.',
        );
      }

      /**
       * 🔴 THE COMPETITION EACH FIXTURE CAME FROM TRAVELS WITH IT.
       *
       * Without it the union is unattributable, and "Real Salt Lake at León"
       * with no "Leagues Cup" beside it is exactly the answer that reads as MLS
       * and sends someone looking in the wrong place.
       */
      const considered = okAnswers.reduce((n, { a }) => n + (a.state === 'results' ? a.considered : 0), 0);
      const all = okAnswers.flatMap(({ key, a }) =>
        a.state === 'results' ? a.fixtures.map((f) => ({ f, key })) : [],
      );

      /**
       * 🔴 BEST MATCH WINS OUTRIGHT — A LOOSE HIT NEVER SHOWS BESIDE AN EXACT ONE.
       *
       * Rank 3 exact, 2 whole-word, 1 bare substring. Taking everything above
       * zero is what lets an accident sit next to a real answer; taking only
       * the best tier means a literal team name cannot lose to a city token.
       */
      let wanted = all;
      if (team) {
        const scored = all
          .map((row) => ({ ...row, q: matchQuality(row.f, team) }))
          .filter((row) => row.q > 0);
        const best = scored.reduce((m, row) => Math.max(m, row.q), 0);
        wanted = scored.filter((row) => row.q === best);
      }
      wanted.sort((a, b) => a.f.kickoffMs - b.f.kickoffMs);

      const who = team ? `"${team}"` : `any team in ${scopeLabel}`;
      /**
       * 🔴 THE CURRENT TIME SHIPS WITH THE DATA, EVERY CALL.
       *
       * The model has no clock: the system prompt carries no date, `hp_shell
       * date` is refused by the command gate, and an outbound time API is
       * unreachable. On `homelab_read`'s first live turn it burned four tool
       * calls hunting for the date and then labelled an Aug 22 broadcast as
       * live. This verb's whole job is past-versus-future discrimination, so
       * the stamp matters more here, not less.
       *
       * Per call, not once into a system prompt — a long-lived pm2 conversation
       * outlives a prompt stamp, and a stale "now" is worse than none.
       */
      const asOf = `AS OF ${new Date(nowMs).toISOString().slice(0, 16)}Z — compare every time below against THIS, not a guess.`;
      /**
       * 🔴 THE SCOPE IS ON EVERY ANSWER, NOT ONLY THE EMPTY ONES.
       *
       * Jedd told Jeff "nothing in the MLS fixture list for RSL today" — true,
       * and an answer to a question he did not ask. He asked whether there is a
       * game. Naming the competitions searched is what makes the difference
       * between a finding and a fact about one list.
       */
      /**
       * 🔴 A COMPETITION THAT CAME BACK UNDER THE WRONG NAME IS NOT TRUSTWORTHY.
       *
       * HTTP 400 catches a malformed slug. It cannot catch a slug that is valid
       * for a DIFFERENT competition — `usa.1` mistyped to `mex.1` returns a
       * healthy 200 full of Liga MX fixtures. Only the name disagrees, so the
       * name is what is checked, and the mismatch is surfaced rather than
       * silently answering from the wrong competition.
       */
      const misnamed = okAnswers.flatMap(({ key, a }) =>
        a.state === 'results' && !a.nameMatches
          ? [`${leagueLabel(key)} → ESPN returned "${a.espnName}"`]
          : [],
      );
      const scopeLine =
        `SEARCHED ${searched.length} competition(s): ${scopeLabel}. ` +
        'Anything NOT in that list was not checked — do not report on it.' +
        (failures.length
          ? `\n🔴 ${failures.length} could NOT be read, so they are UNKNOWN rather than empty: ${failures.join('; ')}`
          : '') +
        (misnamed.length
          ? `\n🔴 ${misnamed.length} came back under an UNEXPECTED NAME, so its fixtures may be from the ` +
            `wrong competition entirely — treat them as suspect: ${misnamed.join('; ')}`
          : '');
      const sourceLine =
        `${asOf}\n${scopeLine}\nFIXTURE SOURCE (ESPN): ${considered} events across those ` +
        `competitions in ${new Date(nowMs).toISOString().slice(0, 10)} → ` +
        `${new Date(nowMs + days * 86_400_000).toISOString().slice(0, 10)}, ` +
        `${all.length} still upcoming or in progress, ${wanted.length} involving ${who}.`;

      if (!wanted.length) {
        // A real zero, and bounded as one. `considered` is reported so that "the
        // schedule is empty" and "the name did not match" are different
        // sentences rather than the same blank.
        const why = considered
          ? `ESPN listed ${considered} events across those competitions and none involve ${who}.`
          : 'ESPN listed NO events at all in any of them for that window.';
        return ok(
          `${sourceLine}\n\nNO FIXTURE FOUND for ${who} in the next ${days} days. ${why}\n` +
            '🔴 This is bounded by the WINDOW and by the COMPETITION LIST above, not by the TV ' +
            'guide. Say which competitions were searched when you report this — "no game" is a ' +
            'claim about the world, and what I checked is a list. A fixture further out than ' +
            `${days} days, or in a competition not named above, would not appear here.`,
        );
      }

      const nextRow = wanted[0] as { f: Fixture; key: LeagueKey };
      const next = nextRow.f;
      const parts: string[] = [sourceLine, ''];
      const stateNote = next.state === 'in' ? ' 🔴 IN PROGRESS NOW' : '';
      parts.push(`NEXT: ${teamLine(next)}${stateNote}  [${leagueLabel(nextRow.key)}]`);
      parts.push(`  kickoff ${renderKickoff(next.kickoffMs, nowMs)}`);
      /**
       * 🔴 ATTRIBUTED, BECAUSE ESPN GETS THIS WRONG ON CUP TIES.
       *
       * Measured 2026-08-25: `Real Salt Lake at León` in the Leagues Cup came
       * back with `venue: Dick's Sporting Goods Park, Commerce City, Colorado`
       * — Colorado Rapids' ground, in the wrong country, for a match in Mexico.
       * ESPN's venue field is evidently stale or team-derived for neutral and
       * cup fixtures.
       *
       * We cannot check it, so we do not launder it. Naming the source turns a
       * confident wrong fact into a legible wrong claim, which is the whole
       * distinction this tool is built around.
       */
      if (next.venue) parts.push(`  venue (per ESPN, UNVERIFIED — it is often wrong for cup ties): ${next.venue}`);
      parts.push('');

      const guide = await findFixtureInGuide(ctx.config, next, fetchImpl);
      const win = kickoffWindow(next);
      /**
       * Read at most ONCE per call, and only if some channel was actually
       * found. It is an ssh round trip, and a call that turns up no channels
       * has nothing to annotate.
       *
       * 🔴 A health read that FAILS never removes a channel from the list. The
       * channel was found in the guide, and that fact does not depend on a
       * second source — `rankChannelOptions(matches, null)` marks every option
       * `unknown` and the list still prints.
       */
      /**
       * 🔴 EVERY GUIDE LOOKUP HAPPENS BEFORE THE HEALTH READ.
       *
       * The health read is one ssh round trip, and it has to be one — reading
       * it per fixture would multiply it by the lookahead. It also has to
       * happen when ANY fixture found a channel, not only the next one: an
       * earlier arrangement read health from the next fixture alone, so a
       * fixture tonight with no listing and one tomorrow on three channels
       * annotated none of them. Collecting the lookups first makes that
       * unrepresentable rather than remembered.
       */
      const later = wanted.slice(1, 1 + LOOKAHEAD);
      const laterGuides: Array<{ fixture: Fixture; key: LeagueKey; guide: GuideAnswer | null }> = [];
      for (const { f, key } of later) {
        laterGuides.push({
          fixture: f,
          key,
          // `null` means NOT LOOKED UP, which is a different fact from an empty
          // search and is rendered differently below.
          guide: f.kickoffMs > nowMs + GUIDE_HORIZON_MS ? null : await findFixtureInGuide(ctx.config, f, fetchImpl),
        });
      }

      let healthRows: HealthRow[] | null = null;
      let healthNote = '';
      /**
       * 🔴 READ WHENEVER THE GUIDE WAS SEARCHED, NOT ONLY WHEN IT FOUND SOMETHING.
       *
       * It used to be gated on a channel having been found, because health was
       * the only thing it was for. The roster COUNT turned out to matter just as
       * much in the opposite case — see `coverageNote`. A "no channels" answer
       * needs a denominator, and the denominator is in the same file.
       */
      const anyGuideSearched =
        guide.state === 'searched' || laterGuides.some((l) => l.guide?.state === 'searched');
      if (anyGuideSearched) {
        const read = await readStreamCheck(ctx.config, ctx.exec);
        if (read.ok) {
          healthRows = read.snapshot.rows;
          healthNote =
            `Channel health is from the stream check that ran ${read.snapshot.when} UTC — ` +
            `${describeAge(read.snapshot.ageSeconds)}. ${describeFreshness(read.snapshot.ageSeconds)}` +
            (read.snapshot.unparsed
              ? ` ⚠️ ${read.snapshot.unparsed} line(s) of it did not parse, so the check itself may be malfunctioning.`
              : '');
        } else {
          // 🔴 UNKNOWN, never "the channels are broken". Two different answers.
          healthNote = `⚠️ Channel health is UNKNOWN — ${read.detail}. That is NOT a report that these channels are broken.`;
        }
      }
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
          /**
           * 🔴 PLURAL. The reason there is no channel is that the guide has not
           * filled in ANY of them yet, not that there is one and we could not
           * find it. Same false-zero discipline as everywhere else in this
           * file, one word different — and the singular quietly implies a
           * search that came within one of succeeding.
           */
          parts.push(
            '  NO CHANNELS LISTED YET — the guide holds NOTHING at all for that window, i.e. it does ' +
              'not reach that far ahead (it runs about four days deep despite GuideInfo claiming seven).',
          );
        } else {
          parts.push(
            '  NO CHANNELS LISTED YET — the guide has some data for that window, but no programme ' +
              'in it names both teams.',
          );
          pushIf(parts, coverageNote(guide.channels, healthRows));
        }
        pushIf(parts, overviewNote(guide));
        parts.push(
          '  🔴 A MISSING CHANNEL IS NOT A MISSING FIXTURE. The kickoff above is confirmed by the ' +
            'fixture source; only the channels are unknown. Say when the match is on and that no ' +
            'channels are listed for it yet.',
        );
        parts.push(scopeNote);
      } else {
        const { options, collapsed } = rankChannelOptions(guide.matches, healthRows);
        parts.push(
          `TV GUIDE: searched ${winText} — ${guide.scanned} programmes on ${guide.channels} channels. ` +
            `${options.length} CHANNEL(S) carrying this fixture — ALL of them are listed below, ` +
            `not just the first.`,
        );
        parts.push(`  ${summariseHealth(options)}.`);
        parts.push(`  ${ORDER_EXPLANATION}`);
        if (healthNote) parts.push(`  ${healthNote}`);
        if (collapsed) {
          // 🔴 Never a silent collapse. Two feeds of the same match are two real
          // options; only a listing returned twice is merged, and it is counted.
          parts.push(
            `  (${collapsed} byte-identical duplicate listing(s) merged — same channel, same ` +
              'programme, same start time. No distinct feed was removed.)',
          );
        }
        for (const o of options) parts.push(...renderOption(o));
        pushIf(parts, overviewNote(guide));
        parts.push(scopeNote);
      }

      if (laterGuides.length) {
        parts.push('');
        parts.push('LATER FIXTURES:');
        for (const { fixture: f, key, guide: g } of laterGuides) {
          // The competition travels with every fixture, not just the first — a
          // union whose rows are unattributable reads as one league.
          parts.push(`  ${renderKickoff(f.kickoffMs, nowMs)} — ${teamLine(f)}  [${leagueLabel(key)}]`);
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
          if (g === null) {
            parts.push('      not looked up — beyond the few days the guide reaches. This says NOTHING about whether a channel exists.');
            continue;
          }
          if (g.state !== 'searched') {
            parts.push(`      channels UNKNOWN — the guide could not be searched (${g.detail})`);
          } else if (g.matches.length) {
            // 🔴 ALL of them here too, health and all. A later fixture is not a
            // second-class answer — the ranking and the annotation are the same
            // ones the next fixture gets, from the same single health read.
            const { options, collapsed } = rankChannelOptions(g.matches, healthRows);
            parts.push(`      ${options.length} channel(s), ${summariseHealth(options)}:`);
            for (const o of options) {
              parts.push(`        ${o.channelName}  [${HEALTH_LABEL[o.health]} — ${o.healthDetail}]`);
            }
            if (collapsed) parts.push(`        (${collapsed} identical duplicate listing(s) merged)`);
          } else if (g.scanned < g.total) {
            parts.push(`      channels UNKNOWN — the scan was truncated (${g.scanned} of ${g.total} programmes read)`);
          } else if (g.scanned === 0) {
            parts.push('      no channels listed — the guide holds nothing at all for that window yet');
          } else {
            parts.push(`      no channels listed — ${g.scanned} programmes in that window, none naming both teams`);
          }
        }
      }

      return ok(parts.join('\n'));
    },
  };
}
