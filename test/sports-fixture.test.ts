import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LEAGUE_KEYS, fixtureInvolves, teamVariants, type Fixture } from '../src/media/espn.js';
import { discriminatingVariants, kickoffWindow, programmeNamesAllTeams } from '../src/media/guide.js';
import type { FetchImpl } from '../src/media/arr.js';
import { buildTools, toolsForRole } from '../src/tools/index.js';
import { makeSportsFixture, renderKickoff } from '../src/tools/sports-fixture.js';
import type { ToolContext } from '../src/tools/types.js';
import { testConfig } from './helpers.js';

/**
 * 🔴 THE TWO FALSE ZEROS THIS TOOL SITS BETWEEN.
 *
 *  1. A fixture the guide does not reach must report the KICKOFF and say the
 *     channel is not listed. Never "no game".
 *  2. A fixture source that cannot be reached must SAY SO. It must never
 *     degrade quietly to a guide-only answer, because that reinstates (1) while
 *     still looking like a working tool.
 *
 * (2) is asserted on the ABSENCE OF A CALL, not on the wording of the reply. A
 * message that happens not to mention the guide is not evidence that the guide
 * was not read; only the call count is.
 */

const NOW = Date.parse('2026-08-25T18:00:00Z');
const KICKOFF = '2026-08-28T19:00Z';

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  role: 'guest',
  senderHandle: '+18015550123',
  config: testConfig(),
  ...over,
});

const res = (body: unknown, status = 200): Response =>
  ({ ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }) as Response;

/** One ESPN event, shaped exactly like the live response measured on 2026-08-25. */
function espnEvent(
  over: {
    date?: string;
    home?: string;
    away?: string;
    state?: string;
    id?: string;
    broadcasts?: unknown;
  } = {},
) {
  const home = over.home ?? 'Crystal Palace';
  const away = over.away ?? 'Manchester City';
  /**
   * ⚠️ The SHORT names are real ESPN values, not `displayName` repeated.
   *
   * ESPN gives "Manchester City" and "Man City"; the guide writes "Man City".
   * A fixture that made every variant identical would have made the matcher
   * look broken here and, worse, could have made a BROKEN matcher look fine —
   * the whole point of collecting variants is that the two sources disagree
   * about a club's name.
   */
  const SHORT: Record<string, string> = {
    'Manchester City': 'Man City',
    'Crystal Palace': 'C Palace',
    'Nottingham Forest': 'Nottm Forest',
  };
  const teamOf = (n: string, homeAway: string) => ({
    homeAway,
    team: {
      id: '1',
      displayName: n,
      shortDisplayName: SHORT[n] ?? n,
      name: n.split(' ').slice(-1)[0],
      location: n,
      abbreviation: n.slice(0, 3).toUpperCase(),
    },
  });
  return {
    id: over.id ?? '401879294',
    date: over.date ?? KICKOFF,
    name: `${away} at ${home}`,
    shortName: 'MNC @ CRY',
    status: { type: { state: over.state ?? 'pre', name: 'STATUS_SCHEDULED', completed: over.state === 'post' } },
    competitions: [
      {
        id: '1',
        // 🔴 ESPN's own broadcast field, populated with something that would be
        // WRONG to report. If any of it reaches the reply, the "channel names
        // come from the guide" rule has been broken.
        broadcasts: over.broadcasts ?? [{ market: 'national', names: ['ESPN-INVENTED-CARRIER'] }],
        venue: { id: '135', fullName: 'Selhurst Park', address: { city: 'London', country: 'England' } },
        competitors: [teamOf(home, 'home'), teamOf(away, 'away')],
      },
    ],
  };
}

const espnBody = (events: unknown[]) => ({ leagues: [{ name: 'English Premier League' }], events });

/** A Jellyfin `/LiveTv/Programs` page. */
const guideBody = (items: unknown[], total?: number) => ({
  Items: items,
  TotalRecordCount: total ?? items.length,
});

function programme(over: Partial<Record<string, unknown>> = {}) {
  return {
    Name: 'PL: Crystal Palace v Man City',
    Overview: 'Coverage from Match Week 3 of the Premier League.',
    ChannelName: 'UK: SKY SPORTS MAIN EVENT',
    ChannelId: 'abc123',
    StartDate: '2026-08-28T18:30:00.0000000Z',
    ...over,
  };
}

/** A filler programme that names nobody, so a window can be non-empty and still not match. */
const filler = (n: number) => ({
  Name: `Filler ${n}`,
  Overview: 'Nothing to do with football.',
  ChannelName: `AU: NITV 4K`,
  ChannelId: 'zzz',
  StartDate: '2026-08-28T18:30:00.0000000Z',
});

interface Spy {
  fetchImpl: FetchImpl;
  espnCalls: string[];
  guideCalls: string[];
}

/**
 * One stub for both hosts, so the test can count each independently.
 *
 * ⚠️ Any URL that is neither ESPN nor Jellyfin THROWS rather than returning a
 * default. A stub that quietly answers an unexpected host would let a third
 * source appear without any test noticing.
 */
function spy(opts: { espn?: () => Response | Promise<Response>; guide?: () => Response | Promise<Response> }): Spy {
  const espnCalls: string[] = [];
  const guideCalls: string[] = [];
  const fetchImpl: FetchImpl = async (url) => {
    if (url.includes('site.api.espn.com')) {
      espnCalls.push(url);
      if (!opts.espn) throw new Error('the test did not expect an ESPN call');
      return opts.espn();
    }
    if (url.includes('jellyfin.test')) {
      guideCalls.push(url);
      if (!opts.guide) throw new Error('the test did not expect a guide call');
      return opts.guide();
    }
    throw new Error(`unexpected host in ${url}`);
  };
  return { fetchImpl, espnCalls, guideCalls };
}

const fixtureOf = (teams: string[][]): Fixture => ({
  id: 'x',
  name: 'x',
  kickoff: KICKOFF,
  kickoffMs: Date.parse(KICKOFF),
  teams: teams.map((variants) => ({ displayName: variants[0] ?? '', variants, homeAway: 'home' as const })),
  venue: null,
  state: 'pre',
});

const run = (s: Spy, args: Record<string, unknown> = { league: 'epl', team: 'Crystal Palace' }) =>
  makeSportsFixture(s.fetchImpl, () => NOW).run(args, ctx());

// ── 🔴 CRITERION 2. NO FIXTURE SOURCE, NO ANSWER. ───────────────────────────

test('🔴 UNREACHABLE fixture source FAILS and NEVER reads the guide', async () => {
  const s = spy({
    espn: () => {
      throw new Error('ECONNREFUSED');
    },
  });
  const r = await run(s);

  assert.equal(r.ok, false, 'a missing fixture source is not a successful answer');
  // The guarantee, asserted where it is observable: the fall-through did not
  // happen. This is what a "warning and continue" refactor would break, and the
  // return value alone would not show it.
  assert.equal(s.guideCalls.length, 0, 'the guide must NOT be consulted when the fixture source failed');
  assert.equal(s.espnCalls.length, 1);
  assert.match(r.content, /FIXTURE SOURCE IS UNREACHABLE/);
  assert.match(r.content, /ECONNREFUSED/);
  assert.match(r.content, /did NOT fall back/i);
  // 🔴 The reply must not contain the false-zero phrasing even as an aside: a
  // model reading its own tool result should find nothing here to echo.
  assert.doesNotMatch(r.content, /no game/i);
  assert.doesNotMatch(r.content, /not playing/i);
});

test('🔴 a fixture source returning 200 WITH NO EVENTS ARRAY is a failure, not an empty schedule', async () => {
  // `body.events?.length ?? 0` would read this as zero fixtures and answer
  // "they are not playing" — a shape change rendered as a finding.
  const s = spy({ espn: () => res({ leagues: [] }) });
  const r = await run(s);
  assert.equal(r.ok, false);
  assert.equal(s.guideCalls.length, 0);
  assert.match(r.content, /no events array/);
});

test('🔴 a fixture source returning HTML is a failure, and quotes what came back', async () => {
  const s = spy({ espn: () => res('<!doctype html><html>ESPN is down</html>') });
  const r = await run(s);
  assert.equal(r.ok, false);
  assert.equal(s.guideCalls.length, 0);
  assert.match(r.content, /not a JSON object/);
  assert.match(r.content, /doctype/);
});

test('a rejected league slug is reported as a slug problem, not as "no fixtures"', async () => {
  // Measured: ESPN answers HTTP 400 for a bad sport or league slug, so this is
  // distinguishable from an empty schedule and must be said differently.
  const s = spy({ espn: () => res({ error: 'bad request' }, 400) });
  const r = await run(s);
  assert.equal(r.ok, false);
  assert.equal(s.guideCalls.length, 0);
  assert.match(r.content, /http 400/);
  assert.match(r.content, /slug/);
});

// ── 🔴 CRITERION 1. OUT OF GUIDE RANGE REPORTS THE KICKOFF. ─────────────────

test('🔴 a fixture BEYOND the guide reports the KICKOFF and says the channel is not listed yet', async () => {
  const s = spy({
    espn: () => res(espnBody([espnEvent()])),
    // The measured state for a fixture past the guide's ~4-day depth: the
    // window exists and holds nothing at all.
    guide: () => res(guideBody([], 0)),
  });
  const r = await run(s);

  assert.equal(r.ok, true, 'this is an ANSWER — the kickoff is known');
  assert.match(r.content, /NEXT: Manchester City at Crystal Palace/);
  assert.match(r.content, /2026-08-28T19:00Z/, 'the kickoff must be in the reply');
  assert.match(r.content, /NO CHANNEL LISTED YET/);
  assert.match(r.content, /does not reach that far ahead/);
  assert.match(r.content, /A MISSING CHANNEL IS NOT A MISSING FIXTURE/);
  // 🔴 The false zero, as the words the model must not be handed.
  assert.doesNotMatch(r.content, /not playing/i);
  assert.doesNotMatch(r.content, /no fixture found/i);
});

test('🔴 a guide that COVERS the window but lists no match says so DIFFERENTLY from an empty window', async () => {
  // Two very different facts — "the guide does not reach that far" and "the
  // guide reaches it and nobody is showing it" — must not collapse into one
  // sentence, or nobody can tell whether to ask again tomorrow.
  const s = spy({
    espn: () => res(espnBody([espnEvent()])),
    guide: () => res(guideBody([filler(1), filler(2), filler(3)])),
  });
  const r = await run(s);
  assert.equal(r.ok, true);
  assert.match(r.content, /3 programmes on 1 channels/);
  assert.match(r.content, /does cover that window/);
  assert.doesNotMatch(r.content, /does not reach that far ahead/);
  assert.match(r.content, /2026-08-28T19:00Z/);
});

test('🔴 a TRUNCATED guide scan is NOT reported as a clean zero', async () => {
  // `limit` IS honoured by /LiveTv/Programs (controlled: limit=5 returned 5 of
  // TotalRecordCount 101), so a window bigger than the cap silently returns a
  // partial page. "Not listed" from a partial page is an unfinished search.
  const s = spy({
    espn: () => res(espnBody([espnEvent()])),
    guide: () => res(guideBody([filler(1)], 900)),
  });
  const r = await run(s);
  assert.equal(r.ok, true);
  assert.match(r.content, /SCAN TRUNCATED/);
  assert.match(r.content, /1 of 900/);
  assert.match(r.content, /NOT conclusive/);
});

test('🔴 a guide that cannot be READ still reports the kickoff', async () => {
  // The guide failing costs the channel half only. Suppressing the fixture
  // because the second source broke would be the false zero again, arrived at
  // from the other direction.
  const s = spy({ espn: () => res(espnBody([espnEvent()])), guide: () => res('nope', 500) });
  const r = await run(s);
  assert.equal(r.ok, true);
  assert.match(r.content, /2026-08-28T19:00Z/);
  assert.match(r.content, /could NOT be searched/);
  assert.match(r.content, /kickoff above still stands/);
  assert.doesNotMatch(r.content, /not playing/i);
});

test('🔴 a guide 200 with no Items array is UNKNOWN, not "no channel"', async () => {
  const s = spy({ espn: () => res(espnBody([espnEvent()])), guide: () => res({ TotalRecordCount: 0 }) });
  const r = await run(s);
  assert.equal(r.ok, true);
  assert.match(r.content, /could NOT be searched/);
  assert.match(r.content, /no Items array/);
});

// ── 🔴 CRITERION 3. THE CHANNEL COMES FROM THE GUIDE OR NOWHERE. ────────────

test('🔴 a found channel is named VERBATIM from the guide record', async () => {
  const s = spy({
    espn: () => res(espnBody([espnEvent()])),
    guide: () => res(guideBody([filler(1), programme()])),
  });
  const r = await run(s);
  assert.equal(r.ok, true);
  assert.match(r.content, /CHANNEL: UK: SKY SPORTS MAIN EVENT/);
  assert.match(r.content, /PL: Crystal Palace v Man City/);
});

test("🔴 ESPN's own `broadcasts` field NEVER reaches the reply — found or not found", async () => {
  // ESPN populates this for its US leagues ("Apple TV", "NFL Net") and leaves it
  // empty for the Premier League. Either way it names a US carrier unrelated to
  // what this house can tune. The fixture in these tests carries a sentinel.
  for (const guide of [() => res(guideBody([])), () => res(guideBody([programme()]))]) {
    const s = spy({ espn: () => res(espnBody([espnEvent()])), guide });
    const r = await run(s);
    assert.doesNotMatch(r.content, /ESPN-INVENTED-CARRIER/, 'a channel name must come from the guide');
  }
});

test('a matched programme whose guide record has NO channel name says so instead of naming nothing', async () => {
  const s = spy({
    espn: () => res(espnBody([espnEvent()])),
    guide: () => res(guideBody([programme({ ChannelName: null })])),
  });
  const r = await run(s);
  assert.match(r.content, /did not name a channel/);
});

test('a programme naming only ONE of the two teams is not a match', async () => {
  const s = spy({
    espn: () => res(espnBody([espnEvent()])),
    guide: () => res(guideBody([programme({ Name: 'PL Tonight: Crystal Palace preview', Overview: 'Panel chat.' })])),
  });
  const r = await run(s);
  assert.match(r.content, /NO CHANNEL LISTED YET/);
  assert.doesNotMatch(r.content, /CHANNEL: UK/);
});

test('both teams in the OVERVIEW alone still match — the Search/Hints blind spot', async () => {
  // `/Search/Hints` matches Name only, which is why this tool uses
  // /LiveTv/Programs with fields=Overview. `Final: Crystal Palace v Rayo
  // Vallecano` really is in the guide under the title `UEFA Conference League`.
  const s = spy({
    espn: () => res(espnBody([espnEvent()])),
    guide: () =>
      res(
        guideBody([
          programme({ Name: 'Premier League', Overview: 'Crystal Palace take on Manchester City at Selhurst Park.' }),
        ]),
      ),
  });
  const r = await run(s);
  assert.match(r.content, /CHANNEL: UK: SKY SPORTS MAIN EVENT/);
});

// ── REPLAY DISAMBIGUATION ───────────────────────────────────────────────────

test('🔴 a COMPLETED match is never offered as the next fixture', async () => {
  const s = spy({
    espn: () =>
      res(
        espnBody([
          espnEvent({ id: 'old', date: '2026-08-15T14:00Z', home: 'Everton', away: 'Crystal Palace', state: 'post' }),
          espnEvent(),
        ]),
      ),
    guide: () => res(guideBody([])),
  });
  const r = await run(s);
  assert.match(r.content, /NEXT: Manchester City at Crystal Palace/);
  assert.doesNotMatch(r.content, /Everton/);
});

test("🔴 ESPN's `state` OUTRANKS the clock: a FUTURE-dated finished match is still dropped", async () => {
  /**
   * ⚠️ THIS IS THE CASE THE PREVIOUS TEST DOES NOT REACH, AND A MUTATION FOUND IT.
   *
   * The event above is dated ten days in the past, so the window's lower bound
   * drops it whether or not the `state === 'post'` guard exists — deleting that
   * guard left the suite GREEN. Two guards overlapped and only one was pinned.
   *
   * The guard's own contribution is exactly this: when ESPN's lifecycle field
   * and its date DISAGREE — a rescheduled fixture whose result is already
   * recorded, an abandoned tie, a stale row — the field wins. "Finished" and
   * "not yet played" are the same arithmetic on a timestamp and completely
   * different answers, which is why the state is read rather than derived.
   */
  const s = spy({
    espn: () =>
      res(
        espnBody([
          espnEvent({ id: 'weird', date: '2026-08-26T14:00Z', home: 'Everton', away: 'Crystal Palace', state: 'post' }),
          espnEvent(),
        ]),
      ),
    guide: () => res(guideBody([])),
  });
  const r = await run(s);
  assert.match(r.content, /NEXT: Manchester City at Crystal Palace/, 'the finished match is dated SOONER and must still lose');
  assert.doesNotMatch(r.content, /Everton/);
});

test("🔴 the guide is searched around the FIXTURE's kickoff, so tonight's replay is out of range", async () => {
  // The measured replay: `PL: Everton v Crystal Palace` at 2026-08-25T22:00Z on
  // NZ: SKY SPORTS 7 4K, a rebroadcast of a match played ten days earlier. The
  // next real fixture is 2026-08-28T19:00Z. Disambiguation is meant to fall out
  // of the window rather than out of a filter — so assert on the WINDOW.
  const s = spy({ espn: () => res(espnBody([espnEvent()])), guide: () => res(guideBody([])) });
  await run(s);
  assert.equal(s.guideCalls.length, 1);
  const url = s.guideCalls[0] as string;
  const min = decodeURIComponent(/minStartDate=([^&]+)/.exec(url)?.[1] ?? '');
  const max = decodeURIComponent(/maxStartDate=([^&]+)/.exec(url)?.[1] ?? '');
  const kickoffMs = Date.parse(KICKOFF);
  assert.ok(Date.parse(min) < kickoffMs && Date.parse(max) > kickoffMs, 'the window must bracket the kickoff');
  const replayMs = Date.parse('2026-08-25T22:00:00Z');
  assert.ok(replayMs < Date.parse(min), "tonight's replay must fall outside the searched window");
  // And the parameter that makes the channel name exist at all.
  assert.match(url, /fields=Overview%2CChannelInfo|fields=Overview,ChannelInfo/);
  // ⚠️ `searchTerm` is a proven silent no-op on this endpoint; passing it would
  // return the whole guide while looking like a filter.
  assert.doesNotMatch(url, /searchTerm/);
});

test('🔴 the guide is NEVER asked to enumerate channels', async () => {
  const s = spy({ espn: () => res(espnBody([espnEvent()])), guide: () => res(guideBody([])) });
  await run(s);
  for (const url of s.guideCalls) {
    assert.doesNotMatch(url, /\/LiveTv\/Channels/, '/LiveTv/Channels iterates the tuner and wedged Jellyfin site-wide');
  }
});

test('a replay-ish listing INSIDE the kickoff window is FLAGGED, not silently dropped', async () => {
  const s = spy({
    espn: () => res(espnBody([espnEvent()])),
    guide: () =>
      res(
        guideBody([
          programme({ Name: 'PL: Crystal Palace v Man City Hls', Overview: 'Highlights from Match Week 3.' }),
        ]),
      ),
  });
  const r = await run(s);
  assert.match(r.content, /CHANNEL: UK: SKY SPORTS MAIN EVENT/, 'still reported — prose is not reliable enough to drop it');
  assert.match(r.content, /POSSIBLE REPLAY/);
  assert.match(r.content, /highlights/);
});

test('"Match Week" alone is NOT treated as a replay marker', async () => {
  // Live coverage says it too. Using it would suppress the real broadcast.
  const s = spy({
    espn: () => res(espnBody([espnEvent()])),
    guide: () => res(guideBody([programme()])),
  });
  const r = await run(s);
  assert.match(r.content, /CHANNEL: UK: SKY SPORTS MAIN EVENT/);
  assert.doesNotMatch(r.content, /POSSIBLE REPLAY/);
});

// ── NO FIXTURE AT ALL, BOUNDED HONESTLY ─────────────────────────────────────

test('no matching team is a WINDOW-bounded zero, and says which window', async () => {
  const s = spy({ espn: () => res(espnBody([espnEvent({ home: 'Fulham', away: 'Brentford' })])) });
  const r = await run(s, { league: 'epl', team: 'Crystal Palace', days_ahead: 7 });
  assert.equal(r.ok, true);
  assert.equal(s.guideCalls.length, 0, 'there is no fixture to look up a channel for');
  assert.match(r.content, /NO FIXTURE FOUND/);
  assert.match(r.content, /next 7 days/);
  assert.match(r.content, /1 .*events in that window and none involve/);
  assert.match(r.content, /bounded by the window, not by the TV guide/);
});

test('an EMPTY schedule and an UNMATCHED name are different sentences', async () => {
  const s = spy({ espn: () => res(espnBody([])) });
  const r = await run(s);
  assert.match(r.content, /NO .* events at all in that window/);
});

// ── THE CLOCK. The model has none. ──────────────────────────────────────────

test('🔴 kickoff is rendered in UTC, LOCAL wall-clock and RELATIVE terms', async () => {
  // There is no current time in the system prompt, so a bare ISO stamp leaves
  // the model to guess whether "Friday" is tonight or next week.
  const line = renderKickoff(Date.parse(KICKOFF), NOW);
  assert.match(line, /2026-08-28T19:00Z/, 'UTC');
  assert.match(line, /Fri/, 'local weekday');
  assert.match(line, /MDT|GMT-6/, 'local offset');
  assert.match(line, /Mountain/, 'whose local time it is');
  assert.match(line, /in 3 days/, 'relative');
});

test('a match already under way is reported as IN PROGRESS, not as a past event', async () => {
  const s = spy({
    espn: () => res(espnBody([espnEvent({ date: '2026-08-25T17:30Z', state: 'in' })])),
    guide: () => res(guideBody([])),
  });
  const r = await run(s);
  assert.match(r.content, /IN PROGRESS NOW/);
  assert.match(r.content, /started 30 min ago/);
});

// ── ARGUMENT HANDLING ───────────────────────────────────────────────────────

test('days_ahead is clamped, and a non-finite value never reaches a date', async () => {
  for (const bad of [Number.NaN, Infinity, -5, 10_000, 'lots']) {
    const s = spy({ espn: () => res(espnBody([])) });
    const r = await makeSportsFixture(s.fetchImpl, () => NOW).run(
      { league: 'epl', team: 'Palace', days_ahead: bad },
      ctx(),
    );
    assert.doesNotMatch(r.content, /NaN|Invalid Date/, `days_ahead=${String(bad)} leaked`);
    assert.equal(s.espnCalls.length, 1);
    assert.doesNotMatch(s.espnCalls[0] as string, /NaN/);
  }
});

test('an unknown league is refused by name and nothing is fetched', async () => {
  const s = spy({});
  const r = await makeSportsFixture(s.fetchImpl, () => NOW).run({ league: 'quidditch' }, ctx());
  assert.equal(r.ok, false);
  assert.equal(s.espnCalls.length, 0);
  assert.equal(s.guideCalls.length, 0);
  assert.match(r.content, /epl/);
});

test('every advertised league key is actually callable', async () => {
  for (const key of LEAGUE_KEYS) {
    const s = spy({ espn: () => res(espnBody([])) });
    const r = await makeSportsFixture(s.fetchImpl, () => NOW).run({ league: key }, ctx());
    assert.equal(r.ok, true, `${key} should be a usable league`);
    assert.equal(s.espnCalls.length, 1);
  }
});

test('omitting the team lists the whole competition', async () => {
  const s = spy({
    espn: () => res(espnBody([espnEvent(), espnEvent({ id: '2', date: '2026-08-29T14:00Z', home: 'Liverpool', away: 'Nottingham Forest' })])),
    guide: () => res(guideBody([])),
  });
  const r = await run(s, { league: 'epl' });
  assert.equal(r.ok, true);
  assert.match(r.content, /LATER FIXTURES/);
  assert.match(r.content, /Nottingham Forest at Liverpool/);
});

// ── UNITS ───────────────────────────────────────────────────────────────────

test('🔴 a name BOTH teams share cannot satisfy both halves — the EPIX HD false channel', async () => {
  /**
   * 🔴 MEASURED LIVE ON 2026-08-25, NOT IMAGINED.
   *
   * `Los Angeles Rams at Los Angeles Chargers` was reported as showing on EPIX
   * HD. The guide entry in that window was *Beverly Hills Cop II*: "The
   * hard-nosed Detroit cop returns to Los Angeles to help solve another case."
   * Both teams carry the variant `los angeles`, so one mention of the city
   * satisfied a rule that looks like it demands two independent facts.
   */
  const s = spy({
    espn: () =>
      res(espnBody([espnEvent({ home: 'Los Angeles Chargers', away: 'Los Angeles Rams' })])),
    guide: () =>
      res(
        guideBody([
          programme({
            Name: 'Beverly Hills Cop II',
            ChannelName: 'EPIX HD',
            Overview: 'The hard-nosed Detroit cop returns to Los Angeles to help solve another case.',
          }),
        ]),
      ),
  });
  const r = await run(s, { league: 'nfl', team: 'Chargers' });
  assert.match(r.content, /NO CHANNEL LISTED YET/);
  assert.doesNotMatch(r.content, /EPIX/, 'a shared city name is not evidence that a channel is carrying the game');
});

test('a same-city fixture is still FOUND when the listing really names both teams', async () => {
  // CONTROL for the test above: striking the shared variant must not make
  // same-city fixtures unfindable, only unguessable.
  const s = spy({
    espn: () =>
      res(espnBody([espnEvent({ home: 'Los Angeles Chargers', away: 'Los Angeles Rams' })])),
    guide: () =>
      res(
        guideBody([
          programme({
            Name: 'Live: NFL',
            ChannelName: 'US: NFL NETWORK',
            Overview: 'The Los Angeles Rams visit the Los Angeles Chargers at SoFi Stadium.',
          }),
        ]),
      ),
  });
  const r = await run(s, { league: 'nfl', team: 'Chargers' });
  assert.match(r.content, /CHANNEL: US: NFL NETWORK/);
});

test('🔴 a team name inside a LONGER WORD is not a match', async () => {
  // `rams` is inside "programs", `jets` inside "jetset". Both normalised
  // strings are space-separated tokens, so matching is token-bounded.
  const s = spy({
    espn: () => res(espnBody([espnEvent({ home: 'New York Jets', away: 'Los Angeles Rams' })])),
    guide: () =>
      res(
        guideBody([
          programme({
            Name: 'Tonight on the network',
            ChannelName: 'FILLER TV',
            Overview: 'Our jetset lifestyle programs return, with jetsetters and programsmiths.',
          }),
        ]),
      ),
  });
  const r = await run(s, { league: 'nfl', team: 'Jets' });
  assert.match(r.content, /NO CHANNEL LISTED YET/);
  assert.doesNotMatch(r.content, /FILLER TV/);
});

test('discriminatingVariants strikes shared names and leaves the distinguishing ones', () => {
  const f = fixtureOf([
    ['los angeles rams', 'rams', 'los angeles'],
    ['los angeles chargers', 'chargers', 'los angeles'],
  ]);
  assert.deepEqual(discriminatingVariants(f), [
    ['los angeles rams', 'rams'],
    ['los angeles chargers', 'chargers'],
  ]);
});

test('a team left with NO discriminating variant matches nothing, rather than everything', () => {
  // Two sides ESPN names identically. The safe direction is "no channel found",
  // never "every programme is this match".
  const f = fixtureOf([['same name'], ['same name']]);
  assert.deepEqual(discriminatingVariants(f), [[], []]);
  assert.equal(programmeNamesAllTeams('same name v same name', f), false);
});

test('programmeNamesAllTeams requires EVERY team, and is accent- and case-insensitive', () => {
  const f = fixtureOf([['crystal palace'], ['manchester city', 'man city']]);
  assert.equal(programmeNamesAllTeams('CRYSTAL PALACE v MAN CITY', f), true);
  assert.equal(programmeNamesAllTeams('Crÿstal Pálace v Manchester City', f), true);
  assert.equal(programmeNamesAllTeams('Crystal Palace v Brighton', f), false);
  assert.equal(programmeNamesAllTeams('', f), false);
  // A fixture with no teams parsed must never match everything.
  assert.equal(programmeNamesAllTeams('anything at all', fixtureOf([])), false);
});

test('the kickoff window brackets kickoff and is bounded on both sides', () => {
  const f = fixtureOf([['a'], ['b']]);
  const w = kickoffWindow(f);
  assert.ok(w.fromMs < f.kickoffMs);
  assert.ok(w.toMs > f.kickoffMs);
  assert.ok(f.kickoffMs - w.fromMs <= 3 * 3_600_000, 'a wide window starts catching neighbouring replays');
});

test('🔴 a three-letter ABBREVIATION is never a matchable variant', async () => {
  // "CRY", "MNC", "NE" would substring-match half the guide. A false channel
  // claim is the one outcome this tool must never produce, so the short forms
  // are dropped — and the cost is a missed match, which reports honestly.
  const s = spy({
    espn: () => res(espnBody([espnEvent()])),
    guide: () => res(guideBody([programme({ Name: 'CRY v MNC', Overview: 'Scrying and financing.' })])),
  });
  const r = await run(s);
  assert.match(r.content, /NO CHANNEL LISTED YET/);
  assert.doesNotMatch(r.content, /CHANNEL: UK/);
});

test('🔴 the ABBREVIATION field is never read, and no variant is short enough to match by accident', () => {
  /**
   * ⚠️ BOTH HALVES ARE PINNED SEPARATELY BECAUSE EACH IS SAFE WHILE THE OTHER
   * HOLDS, AND A MUTATION SWEEP PROVED IT: adding `abbreviation` to the field
   * list changed nothing while the length floor stood, and dropping the length
   * floor changed nothing while `abbreviation` was unread. Two guards, one
   * observable effect — so neither was actually being tested.
   *
   * Both are real risks against real data: ESPN's NBA rows carry
   * `abbreviation: "UTAH"` (four characters, clears the floor) and
   * `location: "LA"` for the Clippers.
   */
  const sentinel = teamVariants({
    displayName: 'Utah Jazz',
    shortDisplayName: 'Jazz',
    name: 'Jazz',
    location: 'Utah',
    // Long enough to clear the floor and impossible to derive from any other
    // field, so its presence proves the abbreviation was READ.
    abbreviation: 'SENTINELABBR',
  });
  assert.ok(!sentinel.includes('sentinelabbr'), 'a team code substring-matches guide prose by accident');
  assert.ok(sentinel.includes('utah jazz') && sentinel.includes('jazz'));

  // Real ESPN row. "la" is inside thousands of words; as a variant it would let
  // almost any programme satisfy one half of the both-teams rule.
  const clippers = teamVariants({
    displayName: 'LA Clippers',
    shortDisplayName: 'Clippers',
    name: 'Clippers',
    location: 'LA',
    abbreviation: 'LAC',
  });
  assert.ok(!clippers.includes('la'), 'a two-character variant matches by accident');
  assert.ok(!clippers.includes('lac'));
  assert.ok(clippers.includes('clippers'));
  assert.ok(
    clippers.every((v) => v.length >= 4),
    'every variant must clear the accidental-match floor',
  );
});

test('a two-character query never matches a team', () => {
  const f = fixtureOf([['crystal palace'], ['manchester city']]);
  assert.equal(fixtureInvolves(f, 'cr'), false);
  assert.equal(fixtureInvolves(f, 'palace'), true);
  assert.equal(fixtureInvolves(f, 'Crystal Palace FC'), true);
});

// ── REGISTRY ────────────────────────────────────────────────────────────────

test('sports_fixture is REGISTERED, guest-visible, and declared a read', () => {
  const tools = buildTools(testConfig());
  const t = tools.find((x) => x.name === 'sports_fixture');
  assert.ok(t, 'the tool must be reachable from buildTools, not only from its own module');
  assert.equal(t.writes, false);
  assert.equal(t.minRole, 'guest');
  assert.ok(
    toolsForRole(tools, 'guest').some((x) => x.name === 'sports_fixture'),
    'what is on television is CONTENT, so a guest may ask',
  );
});

test('sports_fixture survives the read-only build', () => {
  const tools = buildTools(testConfig({ readOnly: true }));
  assert.ok(tools.some((x) => x.name === 'sports_fixture'));
});
