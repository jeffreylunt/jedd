import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LEAGUE_KEYS, fixtureInvolves, matchQuality, teamVariants, type Fixture } from '../src/media/espn.js';
import { discriminatingVariants, kickoffWindow, programmeNamesAllTeams } from '../src/media/guide.js';
import { qualityOf, rankChannelOptions, type HealthRow } from '../src/media/channel-options.js';
import type { FetchImpl } from '../src/media/arr.js';
import { buildTools, toolsForRole } from '../src/tools/index.js';
import { makeSportsFixture, renderKickoff } from '../src/tools/sports-fixture.js';
import type { ExecImpl } from '../src/hp.js';
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

/**
 * The stream-check file, in its real shape.
 *
 * 🔴 The FAIL row is the real one from hp, reason column and all — column 4
 * holds the REASON on a fail row, not a codec, and rendering it as a codec
 * prints an HTTP error where a codec should be.
 */
const HEALTH_MTIME = 1_787_498_113; // 2026-08-23 15:15:13Z
const HEALTH_ROWS = [
  '1|UK: SKY SPORTS MAIN EVENT|OK|h264|1920x1080|60000/1001',
  '2|US: TRUTV 4K|OK|hevc|3840x2160|60000/1001',
  '3|TBS HD|OK|h264|1280x720|30000/1001',
  '7705|ESPN DEPORTES 4K|FAIL|http://znq234.live/live/x/1537742.ts: Server returned 4XX Client Error|?|?',
].join('\n');

/** An exec stub for the stream-check read. Records every command it was handed. */
function healthStub(opts: { rows?: string; exit?: number; nowEpoch?: number; noClock?: boolean } = {}) {
  const commands: { host: string; command: string }[] = [];
  const impl: ExecImpl = (_file, args, _options, callback) => {
    const host = args[args.length - 2] ?? '';
    const command = args[args.length - 1] ?? '';
    commands.push({ host, command });
    if (opts.exit) return callback({ code: opts.exit }, '', 'cat: No such file or directory');
    // Answer what was ASKED, not what the tool hoped for — a stub that prepends
    // the clock regardless would keep passing after the command lost `date +%s`.
    const head = command.includes('stat -c %Y') ? `${HEALTH_MTIME}\n` : '';
    const clock = opts.noClock ? '' : command.includes('date +%s') ? `${opts.nowEpoch ?? HEALTH_MTIME + 3600}\n` : '';
    return callback(null, `${head}${clock}${opts.rows ?? HEALTH_ROWS}\n`, '');
  };
  return { commands, impl };
}

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  role: 'guest',
  senderHandle: '+18015550123',
  config: testConfig(),
  // Default: the stream check cannot be read. Tests that care about health pass
  // their own stub. This keeps every other test off the network — an unstubbed
  // exec would ssh to shell-host.invalid for real.
  exec: healthStub({ exit: 1 }).impl,
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

// ⚠️ The league name is the one ESPN really returns for `soccer/eng.1`,
// measured 2026-08-25 — the slug-identity check compares against it.
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
function spy(opts: {
  espn?: (url: string) => Response | Promise<Response>;
  guide?: (url: string) => Response | Promise<Response>;
}): Spy {
  const espnCalls: string[] = [];
  const guideCalls: string[] = [];
  const fetchImpl: FetchImpl = async (url) => {
    if (url.includes('site.api.espn.com')) {
      espnCalls.push(url);
      if (!opts.espn) throw new Error('the test did not expect an ESPN call');
      return opts.espn(url);
    }
    if (url.includes('jellyfin.test')) {
      guideCalls.push(url);
      if (!opts.guide) throw new Error('the test did not expect a guide call');
      return opts.guide(url);
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

const run = (
  s: Spy,
  args: Record<string, unknown> = { league: 'epl', team: 'Crystal Palace' },
  over: Partial<ToolContext> = {},
) => makeSportsFixture(s.fetchImpl, () => NOW).run(args, ctx(over));

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
  assert.match(r.content, /NO CHANNELS LISTED YET/);
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
  assert.match(r.content, /has some data for that window/);
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
  assert.match(r.content, /NO CHANNELS LISTED YET/);
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

test('🔴 the result says what it did NOT search, in both guide branches', async () => {
  /**
   * 🔴 CAUGHT ON A REAL TURN, NOT IN A TEST.
   *
   * Asked "is Crystal Palace on TV tonight?" the model answered correctly about
   * Friday's fixture and then added "Nothing involving Palace in the guide for
   * tonight" — a claim the tool never made, and a false one: the guide really
   * does list `PL: Everton v Crystal Palace` tonight at 22:00, a rebroadcast.
   *
   * A zero over one 105-minute window reads as a zero over the whole day unless
   * the result says otherwise. Both branches must say otherwise, because the
   * over-read is available from either.
   */
  for (const guide of [() => res(guideBody([filler(1)])), () => res(guideBody([programme()]))]) {
    const s = spy({ espn: () => res(espnBody([espnEvent()])), guide });
    const r = await run(s);
    assert.match(r.content, /ONLY that window was searched/);
    assert.match(r.content, /says NOTHING about the rest of the guide/);
    assert.match(r.content, /rebroadcast of an OLDER match/);
  }
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

// ── 🔴 THE RSL MISS: A FIXTURE IN A COMPETITION WE NEVER ASKED ABOUT ───────

/**
 * 🔴 THE DISCRIMINATING CASE, FROM A REAL FAILED CONVERSATION (2026-08-25).
 *
 * Jeff asked *"Isn't there a game today?"* and Jedd answered **"No — nothing in
 * the MLS fixture list for RSL today."** True, and wrong: `Real Salt Lake at
 * León` kicked off that night at 02:30Z in the **Leagues Cup**, which the tool
 * never queried. `soccer/usa.1` really does return zero events that day, so
 * every MLS-scoped answer was true and irrelevant.
 *
 * ⚠️ A TEST SET BUILT FROM MLS FIXTURES ALONE IS STRUCTURALLY INCAPABLE OF
 * FAILING ON THIS. The whole point is a competition the old code could not see,
 * so the stub serves the fixture from `soccer/concacaf.leagues.cup` and NOTHING
 * from `soccer/usa.1` — exactly what ESPN returned.
 */
const RSL_KICKOFF = '2026-08-26T02:30Z';

function espnByPath(): (url: string) => Response {
  return (url: string) => {
    if (url.includes('concacaf.leagues.cup')) {
      return res(
        espnBody([
          espnEvent({ id: 'rsl-leon', date: RSL_KICKOFF, home: 'León', away: 'Real Salt Lake' }),
        ]),
      );
    }
    // 🔴 Every other competition is genuinely EMPTY, including MLS. If this
    // returned the Colorado fixture the test would pass for the wrong reason.
    return res(espnBody([]));
  };
}

test('🔴 RSL at León resolves WITHOUT a league argument — the competition we never asked about', async () => {
  const s = spy({ espn: espnByPath(), guide: () => res(guideBody([])) });
  const r = await makeSportsFixture(s.fetchImpl, () => Date.parse('2026-08-25T20:40:00Z')).run(
    // 🔴 NO `league`. Jeff said "real salt lake"; nothing in that names a
    // competition, and requiring one is what let the model pick `nba`.
    { team: 'Real Salt Lake' },
    ctx(),
  );
  assert.equal(r.ok, true);
  // 🔴 On the NEXT line itself. Asserting /Leagues Cup/ anywhere would also be
  // satisfied by the SEARCHED scope line, which names every competition — so
  // dropping the per-fixture tag would leave the test green.
  assert.match(r.content, /NEXT: Real Salt Lake at León.*\[Leagues Cup\]/);
  assert.match(r.content, /2026-08-26T02:30Z/);
  assert.doesNotMatch(r.content, /NO FIXTURE FOUND/);
});

test("🔴 the venue is ATTRIBUTED to ESPN, because ESPN gets it wrong on cup ties", async () => {
  // Measured: ESPN returned `Real Salt Lake at León` with venue "Dick's
  // Sporting Goods Park, Commerce City, Colorado" — Colorado's ground, wrong
  // country. We cannot check it, so we must not launder it as our own fact.
  const s = spy({ espn: espnByPath(), guide: () => res(guideBody([])) });
  const r = await makeSportsFixture(s.fetchImpl, () => Date.parse('2026-08-25T20:40:00Z')).run(
    { team: 'Real Salt Lake' },
    ctx(),
  );
  assert.match(r.content, /venue \(per ESPN, UNVERIFIED/);
});

test('🔴 the EpisodeTitle is rendered — often the ONLY place the teams appear', async () => {
  /**
   * 🔴 MEASURED ON THE LIVE GUIDE, 2026-08-26.
   *
   * `FAN DUEL SPORTS WEST HD` carried Guardians/Angels as
   *   Name:         "Live: MLB Baseball"
   *   Overview:     "From Angel Stadium of Anaheim in Anaheim, Calif."
   *   EpisodeTitle: "Cleveland Guardians at Los Angeles Angels"
   *
   * The matcher already read EpisodeTitle, so the match was correct — but
   * `GuideProgramme` did not STORE it, so the rendered reply named a programme
   * whose visible title and description mention neither team. The evidence for
   * the claim was invisible in the claim.
   */
  const s = spy({
    espn: () => res(espnBody([espnEvent()])),
    guide: () =>
      res(
        guideBody([
          programme({
            Name: 'Live: Premier League',
            EpisodeTitle: 'Crystal Palace at Manchester City',
            Overview: 'From Selhurst Park.',
          }),
        ]),
      ),
  });
  const r = await run(s, undefined, { exec: healthStub().impl });
  assert.match(r.content, /"Live: Premier League" — Crystal Palace at Manchester City/);
});

test('🔴 a slug that returns the WRONG COMPETITION is flagged, not silently answered from', async () => {
  /**
   * 🔴 THE CASE HTTP STATUS CANNOT CATCH.
   *
   * A malformed slug is HTTP 400 — measured against five near-misses, all
   * rejected — so a typo does NOT look like a quiet competition. But a slug
   * that is valid for a DIFFERENT competition (`usa.1` mistyped to `mex.1`)
   * returns a healthy 200 full of the wrong fixtures. Nothing about the
   * response is anomalous; only the name disagrees.
   */
  const s = spy({
    espn: (url: string) =>
      url.includes('usa.1')
        ? res({ leagues: [{ name: 'Mexican Liga BBVA MX' }], events: [espnEvent({ home: 'León', away: 'Toluca' })] })
        : res(espnBody([])),
  });
  const r = await makeSportsFixture(s.fetchImpl, () => NOW).run({ league: 'mls', team: 'León' }, ctx());
  assert.match(r.content, /UNEXPECTED NAME/);
  assert.match(r.content, /MLS → ESPN returned "Mexican Liga BBVA MX"/);
  assert.match(r.content, /may be from the wrong competition/);
});

test('CONTROL: a competition returning its EXPECTED name carries no warning', async () => {
  // Without this the warning could be unconditional and the test above would
  // still pass. `espnBody` returns "English Premier League", which is what the
  // epl slug was measured to return.
  const s = spy({ espn: () => res(espnBody([])) });
  const r = await makeSportsFixture(s.fetchImpl, () => NOW).run({ league: 'epl' }, ctx());
  assert.doesNotMatch(r.content, /UNEXPECTED NAME/);
});

test('🔴 a 200 with NO leagues[0].name is UNKNOWN, not a quiet competition', async () => {
  const s = spy({ espn: () => res({ events: [] }) });
  const r = await makeSportsFixture(s.fetchImpl, () => NOW).run({ league: 'epl' }, ctx());
  assert.equal(r.ok, false);
  assert.match(r.content, /no leagues\[0\]\.name/);
});

test('🔴 an EMPTY fixture search names every competition it searched', async () => {
  // "Nothing in the MLS fixture list" answers a question nobody asked. An empty
  // result without its scope is uninterpretable — the same rule as coverageNote.
  const s = spy({ espn: () => res(espnBody([])) });
  const r = await makeSportsFixture(s.fetchImpl, () => NOW).run({ team: 'Nobody United' }, ctx());
  assert.equal(r.ok, true);
  assert.match(r.content, /NO FIXTURE FOUND/);
  assert.match(r.content, /searched/i);
  for (const label of ['MLS', 'Leagues Cup', 'Premier League']) {
    assert.ok(r.content.includes(label), `the empty answer must name ${label} as searched`);
  }
});

test('🔴 an EXACT team name beats a LOOSE one, and the loose one is not shown beside it', async () => {
  /**
   * 🔴 THE CASE THE CROSS-SPORT TEST DOES NOT REACH, AND A MUTATION FOUND IT.
   *
   * "Utah Jazz" scores ZERO against "real salt lake" — no substring either way
   * — so that test never exercised ranking at all, and collapsing the rank to a
   * boolean left the suite green. Ranking only matters when candidates actually
   * compete, which needs a name that CONTAINS the query without equalling it.
   * `Real Salt Lake II` is that, and is a real kind of thing: senior sides and
   * their reserve teams share a name stem.
   */
  const s = spy({
    espn: (url: string) => {
      if (url.includes('concacaf.leagues.cup')) {
        return res(espnBody([espnEvent({ id: 'rsl', date: RSL_KICKOFF, home: 'León', away: 'Real Salt Lake' })]));
      }
      if (url.includes('usa.open')) {
        return res(
          espnBody([
            espnEvent({ id: 'rsl2', date: '2026-08-26T01:00Z', home: 'Real Salt Lake II', away: 'Colorado Rapids 2' }),
          ]),
        );
      }
      return res(espnBody([]));
    },
    guide: () => res(guideBody([])),
  });
  const r = await makeSportsFixture(s.fetchImpl, () => Date.parse('2026-08-25T20:40:00Z')).run(
    { team: 'Real Salt Lake' },
    ctx(),
  );
  // The reserve fixture kicks off EARLIER, so sorting alone would surface it.
  assert.match(r.content, /NEXT: Real Salt Lake at León/);
  assert.doesNotMatch(r.content, /Real Salt Lake II/, 'a loose match must not appear while an exact one exists');
});

test('matchQuality ranks exact above whole-word above substring', () => {
  const f = (variants: string[]): Fixture => fixtureOf([variants, ['other team']]);
  assert.equal(matchQuality(f(['real salt lake']), 'real salt lake'), 3, 'exact');
  assert.equal(matchQuality(f(['real salt lake ii']), 'real salt lake'), 2, 'whole-word');
  assert.equal(matchQuality(f(['realsaltlakers']), 'real salt lake'), 0, 'not a token run');
  assert.equal(matchQuality(f(['crystal palace']), 'palace'), 2);
  assert.equal(matchQuality(f(['utah jazz']), 'real salt lake'), 0, 'no overlap at all');
  assert.equal(matchQuality(f(['programs united']), 'rams'), 1, 'bare substring is the lowest tier');
});

test('🔴 "real salt lake" NEVER resolves to a basketball team', async () => {
  // Turn 1 of the failed conversation. Cross-sport resolution on a city token.
  const s = spy({
    espn: (url: string) => {
      if (url.includes('basketball/nba')) {
        return res(espnBody([espnEvent({ id: 'jazz', date: '2026-10-13T01:00Z', home: 'Utah Jazz', away: 'San Antonio Spurs' })]));
      }
      if (url.includes('concacaf.leagues.cup')) {
        return res(espnBody([espnEvent({ id: 'rsl', date: RSL_KICKOFF, home: 'León', away: 'Real Salt Lake' })]));
      }
      return res(espnBody([]));
    },
    guide: () => res(guideBody([])),
  });
  const r = await makeSportsFixture(s.fetchImpl, () => Date.parse('2026-08-25T20:30:00Z')).run(
    { team: 'real salt lake' },
    ctx(),
  );
  assert.match(r.content, /Real Salt Lake/);
  assert.doesNotMatch(r.content, /Utah Jazz/, 'a city token must never outrank a literal team name');
});

// ── 🔴 ALL THE CHANNELS, RANKED, WITH HEALTH JOINED ON ─────────────────────

/** Four channels carrying the same fixture, exactly the shape this lineup produces. */
const multiChannel = () => {
  // ⚠️ The generic TITLE with the teams in the DESCRIPTION — the real shape,
  // and the one `/Search/Hints` cannot see. If these named the teams in the
  // title, the fixture would not exercise the path it is meant to.
  const carrying = (ChannelName: string, over: Record<string, unknown> = {}) =>
    programme({
      ChannelName,
      Name: 'Live: Premier League',
      Overview: 'Crystal Palace host Manchester City at Selhurst Park.',
      ...over,
    });
  return res(
    guideBody([
      carrying('ESPN DEPORTES 4K'),
      carrying('TBS HD'),
      carrying('US: TRUTV 4K'),
      carrying('UK: SKY SPORTS MAIN EVENT'),
      // A second programme on a channel already listed — a pre-show. NOT a
      // duplicate: different name, different start.
      carrying('TBS HD', { Name: 'Match Build-Up', StartDate: '2026-08-28T18:00:00.0000000Z' }),
    ]),
  );
};

test('🔴 EVERY carrying channel is listed, not the first', async () => {
  // Jeff: "if there is more than one channel a game or event is on, the bot
  // should be able to list all of them." The naive shape is `.find()`, and on
  // this lineup that is wrong far more often than right — measured live, the
  // Dodgers/Braves window carried SEVEN distinct channels.
  const s = spy({ espn: () => res(espnBody([espnEvent()])), guide: multiChannel });
  const r = await run(s, undefined, { exec: healthStub().impl });
  for (const c of ['ESPN DEPORTES 4K', 'TBS HD', 'US: TRUTV 4K', 'UK: SKY SPORTS MAIN EVENT']) {
    assert.match(r.content, new RegExp(`CHANNEL: ${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), `${c} is missing`);
  }
  assert.match(r.content, /4 CHANNEL\(S\)/);
  assert.match(r.content, /ALL of them are listed below, not just the first/);
});

test('🔴 a channel that FAILED the last check is listed LAST and marked, not hidden', async () => {
  // A list of options is worse than useless if the first one is broken. The
  // failing channel is 4K, so quality alone would have ranked it top.
  const s = spy({ espn: () => res(espnBody([espnEvent()])), guide: multiChannel });
  const r = await run(s, undefined, { exec: healthStub().impl });
  const order = [...r.content.matchAll(/^  CHANNEL: (.+?)  \[/gm)].map((m) => m[1]);
  assert.equal(order[order.length - 1], 'ESPN DEPORTES 4K', `ranked: ${order.join(' → ')}`);
  assert.match(r.content, /ESPN DEPORTES 4K {2}\[🔴 FAILED the last check/);
  // 🔴 The reason, not a codec. Column 4 means something different on a fail row.
  assert.match(r.content, /reason: http:\/\/znq234\.live/);
});

test('🔴 a WORKING HD feed outranks a 4K feed that failed — health before quality', async () => {
  const s = spy({ espn: () => res(espnBody([espnEvent()])), guide: multiChannel });
  const r = await run(s, undefined, { exec: healthStub().impl });
  const order = [...r.content.matchAll(/^  CHANNEL: (.+?)  \[/gm)].map((m) => m[1]);
  assert.ok(
    order.indexOf('TBS HD') < order.indexOf('ESPN DEPORTES 4K'),
    `a working HD feed must beat a failed 4K feed; got ${order.join(' → ')}`,
  );
  // Among the working ones, 4K first.
  assert.ok(order.indexOf('US: TRUTV 4K') < order.indexOf('TBS HD'), `4K first among working; got ${order.join(' → ')}`);
});

test('🔴 the ordering is STATED, not left to be inferred from iteration order', async () => {
  const s = spy({ espn: () => res(espnBody([espnEvent()])), guide: multiChannel });
  const r = await run(s, undefined, { exec: healthStub().impl });
  assert.match(r.content, /Ordered by HEALTH first/);
  assert.match(r.content, /A working HD feed is listed above a 4K feed that failed/);
  assert.match(r.content, /3 working at the last check, 1 FAILED the last check/);
});

test('🔴 the health snapshot AGE is reported, and a stale one is called stale', async () => {
  // Measured on the live file: mtime was 2.2 days behind the host clock, so
  // "working at the last check" is a different claim from "working now".
  const s = spy({ espn: () => res(espnBody([espnEvent()])), guide: multiChannel });
  const r = await run(s, undefined, { exec: healthStub({ nowEpoch: HEALTH_MTIME + 3 * 86400 }).impl });
  assert.match(r.content, /stream check that ran 2026-08-23 15:15 UTC/);
  assert.match(r.content, /3d ago/);
  assert.match(r.content, /STALE: this is more than a day old/);
});

test('🔴 an UNKNOWN snapshot age is treated as STALE, not as fresh', async () => {
  /**
   * 🔴 THE UNKNOWN BRANCH MUST BE AT LEAST AS CAUTIOUS AS THE STALE ONE.
   *
   * An earlier version of this rule tested `isFinite(age) && age > threshold`,
   * so an unreadable clock — NaN, or a negative age from skew — fell through to
   * the sentence written for a FRESH result. The whole contract of this data is
   * that its age gates whether it may be quoted as current.
   *
   * Reached here by a results file whose clock line is missing, which is what a
   * malfunctioning checker actually produces.
   */
  const s = spy({ espn: () => res(espnBody([espnEvent()])), guide: multiChannel });
  const r = await run(s, undefined, { exec: healthStub({ noClock: true }).impl });
  assert.match(r.content, /could NOT work out how old this is, so treat it as stale/);
  assert.doesNotMatch(r.content, /snapshot, not a live probe/, 'the reassuring branch is for a FRESH result only');
});

test('🔴 health is joined by EXACT channel name — a near-miss is NOT COVERED, never borrowed', async () => {
  /**
   * 🔴 A WRONG JOIN IS A CONFIDENT WRONG ANSWER ABOUT THE THING BEING ASKED.
   *
   * Guide names carry country prefixes (`NZ: SKY SPORTS 7 4K`, `CA: SPORTSNET
   * ONTARIO HD`). A substring or prefix join would attach the health of one
   * channel to a different one — and the measurement says it is not needed:
   * 207 of 213 live guide channel names matched a stream-check row byte for
   * byte. The six that did not are ephemeral per-event channels the sweep never
   * covered, which is exactly what NOT COVERED means.
   */
  const s = spy({
    espn: () => res(espnBody([espnEvent()])),
    guide: () => res(guideBody([programme({ ChannelName: 'NZ: SKY SPORTS MAIN EVENT' })])),
  });
  // The stub's health rows contain `UK: SKY SPORTS MAIN EVENT`, WORKING. A
  // fuzzy join would report this NZ channel as working on that row's evidence.
  const r = await run(s, undefined, { exec: healthStub().impl });
  assert.match(r.content, /CHANNEL: NZ: SKY SPORTS MAIN EVENT {2}\[NOT COVERED by the last check/);
  assert.doesNotMatch(r.content, /NZ: SKY SPORTS MAIN EVENT {2}\[WORKING/);
});

test('a FRESH snapshot is not described as stale', async () => {
  // CONTROL for the test above: the staleness wording must depend on the age.
  const s = spy({ espn: () => res(espnBody([espnEvent()])), guide: multiChannel });
  const r = await run(s, undefined, { exec: healthStub({ nowEpoch: HEALTH_MTIME + 600 }).impl });
  assert.match(r.content, /10m ago/);
  assert.doesNotMatch(r.content, /STALE/);
  assert.match(r.content, /snapshot, not a live probe/);
});

test('🔴 an unreadable stream check leaves every channel UNKNOWN and REMOVES NONE of them', async () => {
  // The channels were found in the guide; that fact does not depend on a second
  // source. And "unknown" is not "these channels are broken".
  const s = spy({ espn: () => res(espnBody([espnEvent()])), guide: multiChannel });
  const r = await run(s, undefined, { exec: healthStub({ exit: 1 }).impl });
  assert.match(r.content, /4 CHANNEL\(S\)/);
  assert.match(r.content, /CHANNEL: TBS HD {2}\[health UNKNOWN/);
  assert.match(r.content, /Channel health is UNKNOWN/);
  assert.match(r.content, /NOT a report that these channels are broken/);
});

test('a channel the sweep never covered is NOT COVERED, not broken and not fine', async () => {
  // Measured: 207 of 213 live guide channel names matched a stream-check row
  // exactly; the six that did not are ephemeral per-event MLS channels.
  const s = spy({
    espn: () => res(espnBody([espnEvent()])),
    guide: () => res(guideBody([programme({ ChannelName: 'MLS: LAFC vs Portland (8:30 PM)' })])),
  });
  const r = await run(s, undefined, { exec: healthStub().impl });
  assert.match(r.content, /NOT COVERED by the last check/);
  assert.doesNotMatch(r.content, /FAILED the last check/);
});

test('🔴 the stream check is read ONCE per call, on the UNPRIVILEGED identity, and never probes', async () => {
  const h = healthStub();
  const s = spy({ espn: () => res(espnBody([espnEvent()])), guide: multiChannel });
  await run(s, undefined, { exec: h.impl });
  assert.equal(h.commands.length, 1, 'one ssh round trip, not one per channel');
  assert.equal(h.commands[0]?.host, 'shell-host.invalid', 'health needs no docker, so it takes the smaller capability');
  for (const c of h.commands) {
    assert.doesNotMatch(c.command, /ffprobe|ffmpeg/, 'probing is ~10s/channel and has wedged the 242-channel loop for 3h');
  }
});

test('🔴 "the guide covers that window" carries a DENOMINATOR, or it overstates', async () => {
  /**
   * 🔴 THE SAME MISTAKE THIS FILE'S AUTHOR MADE IN PROSE, THEN IN CODE.
   *
   * I reported that the lineup holds no UK sports channels, from a Friday
   * window that returned Australian beIN only. Jeff said "I swear we do, go
   * look" — and he was right: `UK: SKY SPORTS PREMIER LEAGUE HEVC 4K` and
   * `TNT SPORTS 1-4` are all present and streaming. I had measured the GUIDE
   * and concluded something about the LINEUP.
   *
   * The tool's wording had the identical flaw. Guide depth collapses off a
   * cliff — 224/243 channels at T+0, 197 at T+2, **13 at T+3** — so at Friday's
   * kickoff the window still returns ~65 programmes and "the guide does cover
   * that window" was literally true and thoroughly misleading.
   */
  const s = spy({
    espn: () => res(espnBody([espnEvent()])),
    guide: () => res(guideBody([filler(1), filler(2)])),
  });
  const r = await run(s, undefined, { exec: healthStub().impl });
  // The stub's roster is 4 channels; the filler sits on 1 of them → 25%.
  assert.match(r.content, /only 1 of 4 channels have ANY programmes in that window/);
});

test('🔴 THIN coverage is called a gap in the GUIDE, not evidence about the lineup', async () => {
  // 13 of 243 is 5%. The sentence that stops the next reader chasing a lineup
  // problem that does not exist.
  const many = Array.from({ length: 40 }, (_, i) => `${i}|CHAN ${i}|OK|h264|1280x720|30`).join('\n');
  const s = spy({ espn: () => res(espnBody([espnEvent()])), guide: () => res(guideBody([filler(1)])) });
  const r = await run(s, undefined, { exec: healthStub({ rows: many }).impl });
  assert.match(r.content, /only 1 of 40 channels have ANY programmes in that window \(3%\)/);
  assert.match(r.content, /BARELY filled in that far ahead/);
  assert.match(r.content, /not evidence that nobody is carrying the match/);
});

test('CONTROL: healthy coverage gets the fraction but NOT the gap warning', async () => {
  // Without this, the warning could be unconditional and the test above would
  // still pass. 3 of 4 is 75%.
  const s = spy({
    espn: () => res(espnBody([espnEvent()])),
    guide: () =>
      res(
        guideBody([
          { ...filler(1), ChannelName: 'TBS HD' },
          { ...filler(2), ChannelName: 'US: TRUTV 4K' },
          { ...filler(3), ChannelName: 'UK: SKY SPORTS MAIN EVENT' },
        ]),
      ),
  });
  const r = await run(s, undefined, { exec: healthStub().impl });
  assert.match(r.content, /only 3 of 4 channels have ANY programmes in that window \(75%\)/);
  assert.doesNotMatch(r.content, /BARELY filled in/);
});

test('an unreadable sweep gives NO coverage claim rather than a guessed one', async () => {
  const s = spy({ espn: () => res(espnBody([espnEvent()])), guide: () => res(guideBody([filler(1)])) });
  const r = await run(s, undefined, { exec: healthStub({ exit: 1 }).impl });
  assert.doesNotMatch(r.content, /channels have ANY programmes/);
  assert.match(r.content, /NO CHANNELS LISTED YET/);
});

test('🔴 duplicate listings are collapsed only when IDENTICAL, and the collapse is REPORTED', async () => {
  // Jeff: two feeds of the same match are two real options, not noise. Only a
  // listing returned twice is merged — and never silently.
  const dup = programme({ ChannelName: 'TBS HD' });
  const s = spy({
    espn: () => res(espnBody([espnEvent()])),
    guide: () => res(guideBody([dup, { ...dup }, programme({ ChannelName: 'US: TRUTV 4K' })])),
  });
  const r = await run(s, undefined, { exec: healthStub().impl });
  assert.match(r.content, /1 byte-identical duplicate listing\(s\) merged/);
  assert.match(r.content, /No distinct feed was removed/);
  assert.match(r.content, /2 CHANNEL\(S\)/);
});

test('two programmes on the SAME channel are grouped under it, and neither is dropped', async () => {
  const s = spy({ espn: () => res(espnBody([espnEvent()])), guide: multiChannel });
  const r = await run(s, undefined, { exec: healthStub().impl });
  assert.match(r.content, /"Live: Premier League"/);
  assert.match(r.content, /"Match Build-Up"/);
  // One CHANNEL heading for TBS HD, carrying both programmes.
  assert.equal((r.content.match(/CHANNEL: TBS HD/g) ?? []).length, 1);
});

test('rankChannelOptions and qualityOf, as units', () => {
  const health: HealthRow[] = [
    { number: '1', name: 'GOOD HD', ok: true, codec: 'h264', resolution: '1280x720' },
    { number: '2', name: 'BAD 4K', ok: false, codec: 'Server returned 4XX', resolution: '?' },
  ];
  const p = (ChannelName: string) => ({ channelName: ChannelName, programmes: [], health: 'ok' as const });
  void p;
  const mk = (channelName: string) => ({
    channelName,
    channelId: null,
    name: 'x',
    episodeTitle: '',
    startDate: '',
    overview: '',
    replayMarkers: [],
  });
  const { options } = rankChannelOptions([mk('BAD 4K'), mk('GOOD HD'), mk('NEVER SEEN')], health);
  assert.deepEqual(options.map((o) => o.channelName), ['GOOD HD', 'NEVER SEEN', 'BAD 4K']);
  assert.deepEqual(options.map((o) => o.health), ['ok', 'not-covered', 'failed']);

  assert.equal(qualityOf('US: TRUTV 4K'), '4K');
  assert.equal(qualityOf('NZ: SKY SPORTS 7 4K'), '4K');
  assert.equal(qualityOf('TBS HD'), 'HD');
  assert.equal(qualityOf('NBA: UTAH JAZZ ᴴᴰ'), 'HD', 'the superscript form is real in this lineup');
  assert.equal(qualityOf('POKERGO'), 'unstated');
});

// ── 🔴 THE MODEL HAS NO CLOCK ──────────────────────────────────────────────

test('🔴 the current time ships WITH the data, on every call', async () => {
  /**
   * The system prompt carries no date, `hp_shell date` is refused by the
   * command gate, and an outbound time API is unreachable. On homelab_read's
   * first live turn the model burned four tool calls hunting for the date and
   * then labelled an Aug 22 broadcast as live. This verb's whole job is
   * past-versus-future discrimination, so it must not depend on the model
   * having a clock it does not have.
   */
  const s = spy({ espn: () => res(espnBody([espnEvent()])), guide: () => res(guideBody([])) });
  const r = await run(s);
  assert.match(r.content, /AS OF 2026-08-25T18:00Z/);
  assert.match(r.content, /compare every time below against THIS/);
});

test('the clock stamp is present even when there is no fixture at all', async () => {
  const s = spy({ espn: () => res(espnBody([])) });
  const r = await run(s);
  assert.match(r.content, /AS OF 2026-08-25T18:00Z/);
});

// ── 🔴 THE DECIDING FIELD, KEYED ON THE DATA ───────────────────────────────

test('🔴 a window whose records carry NO Overview says the match is unreliable', async () => {
  /**
   * `fields=Overview,ChannelInfo` is the one parameter that makes Jellyfin
   * return the description, and the replay marker lives nowhere else. If it
   * stops working, matching silently degrades to titles alone and every fixture
   * whose teams live in the description reports "no channels".
   *
   * Keyed on the DATA, not the endpoint name or the parameter string, so it
   * fires for any route into the same defect.
   */
  const s = spy({
    espn: () => res(espnBody([espnEvent()])),
    guide: () => res(guideBody([{ ...filler(1), Overview: '' }, { ...filler(2), Overview: '' }])),
  });
  const r = await run(s);
  assert.match(r.content, /NONE of the 2 programmes in that window carried a description/);
  assert.match(r.content, /fields=Overview is not doing anything/);
  assert.match(r.content, /Treat a "no channels" result as UNRELIABLE/);
});

test('CONTROL: a window WITH descriptions carries no such warning', async () => {
  const s = spy({ espn: () => res(espnBody([espnEvent()])), guide: () => res(guideBody([filler(1)])) });
  const r = await run(s);
  assert.doesNotMatch(r.content, /fields=Overview is not doing anything/);
});

// ── LATER FIXTURES: "NOT LOOKED UP" IS NOT "NOT LISTED" ────────────────────

test('🔴 a later fixture INSIDE the guide reach is actually looked up, not written off', async () => {
  /**
   * 🔴 CAUGHT ON A REAL TURN. The later-fixtures line used to read "the guide
   * does not reach these, so no channel was sought", and the model reported
   * that the later Dodgers games "have no channel listed yet". Both halves were
   * wrong: those games are well inside a four-day guide and both really do have
   * channels. A gap in what we LOOKED AT had rendered as a finding about the
   * world.
   */
  const soon = '2026-08-27T19:00Z'; // 2 days out — inside the guide
  const s = spy({
    espn: () => res(espnBody([espnEvent(), espnEvent({ id: '2', date: soon })])),
    guide: () => res(guideBody([programme()])),
  });
  const h = healthStub();
  const r = await run(s, undefined, { exec: h.impl });
  const laterBlock = r.content.slice(r.content.indexOf('LATER FIXTURES'));
  assert.match(laterBlock, /UK: SKY SPORTS MAIN EVENT/);
  assert.doesNotMatch(laterBlock, /not looked up/);
  // 🔴 A later fixture is not a second-class answer: it gets the same health
  // annotation the next fixture gets, from the SAME single read.
  assert.match(laterBlock, /1 channel\(s\), 1 working at the last check/);
  assert.match(laterBlock, /UK: SKY SPORTS MAIN EVENT {2}\[WORKING at the last check/);
  assert.equal(h.commands.length, 1, 'one health read for the whole call, not one per fixture');
});

test('🔴 health is read when only a LATER fixture found a channel, not just the next one', async () => {
  /**
   * An earlier arrangement decided whether to read health from the NEXT fixture
   * alone. A fixture tonight with no listing and one tomorrow on three channels
   * then annotated none of them. Collecting every guide lookup before the read
   * makes that unrepresentable rather than something to remember.
   */
  const soon = '2026-08-27T19:00Z';
  let call = 0;
  const s = spy({
    espn: () => res(espnBody([espnEvent(), espnEvent({ id: '2', date: soon })])),
    // The NEXT fixture finds nothing; the LATER one finds a channel.
    guide: () => (call++ === 0 ? res(guideBody([filler(1)])) : res(guideBody([programme()]))),
  });
  const h = healthStub();
  const r = await run(s, undefined, { exec: h.impl });
  assert.equal(h.commands.length, 1, 'the later fixture found a channel, so health must be read');
  assert.match(r.content, /UK: SKY SPORTS MAIN EVENT {2}\[WORKING at the last check/);
});

test('🔴 a later fixture lists ALL its channels too, not just the first', async () => {
  // The same rule as the next fixture, and it needed its own test: a mutation
  // that sliced the later list to one left the suite green, because every
  // "all of them" assertion was aimed at the NEXT fixture.
  const soon = '2026-08-27T19:00Z';
  let call = 0;
  const s = spy({
    espn: () => res(espnBody([espnEvent(), espnEvent({ id: '2', date: soon })])),
    guide: () => (call++ === 0 ? res(guideBody([filler(1)])) : multiChannel()),
  });
  const r = await run(s, undefined, { exec: healthStub().impl });
  const laterBlock = r.content.slice(r.content.indexOf('LATER FIXTURES'));
  for (const c of ['ESPN DEPORTES 4K', 'TBS HD', 'US: TRUTV 4K', 'UK: SKY SPORTS MAIN EVENT']) {
    assert.ok(laterBlock.includes(c), `${c} is missing from the later fixture`);
  }
  assert.match(laterBlock, /4 channel\(s\), 3 working at the last check, 1 FAILED the last check/);
});

test('the stream check is NOT read when the guide could not be searched at all', async () => {
  // Nothing to annotate and no denominator to report — so no ssh round trip.
  const h = healthStub();
  const s = spy({ espn: () => res(espnBody([espnEvent()])), guide: () => res('boom', 500) });
  await run(s, undefined, { exec: h.impl });
  assert.equal(h.commands.length, 0);
});

test('🔴 health is read when the NEXT fixture\'s guide FAILED but a later one succeeded', async () => {
  // The case that separates "the next fixture was searched" from "any fixture
  // was searched". Without it, a mutation narrowing the condition to the next
  // fixture alone leaves the suite green.
  const soon = '2026-08-27T19:00Z';
  let call = 0;
  const s = spy({
    espn: () => res(espnBody([espnEvent(), espnEvent({ id: '2', date: soon })])),
    guide: () => (call++ === 0 ? res('gateway timeout', 504) : multiChannel()),
  });
  const h = healthStub();
  const r = await run(s, undefined, { exec: h.impl });
  assert.equal(h.commands.length, 1, 'the later fixture was searched, so the sweep is worth reading');
  assert.match(r.content, /UK: SKY SPORTS MAIN EVENT {2}\[WORKING at the last check/);
  // And the failed next-fixture lookup still does not suppress the kickoff.
  assert.match(r.content, /2026-08-28T19:00Z/);
});

test('🔴 a later fixture BEYOND the guide reach is UNCHECKED, never "no channel"', async () => {
  const far = '2026-09-19T14:00Z'; // 25 days out
  const s = spy({
    espn: () => res(espnBody([espnEvent(), espnEvent({ id: '2', date: far })])),
    guide: () => res(guideBody([])),
  });
  const r = await run(s);
  const laterBlock = r.content.slice(r.content.indexOf('LATER FIXTURES'));
  assert.match(laterBlock, /not looked up/);
  assert.match(laterBlock, /says NOTHING about whether a channel exists/);
  assert.doesNotMatch(laterBlock, /no channels listed/);
});

test('🔴 a TRUNCATED scan on a LATER fixture is UNKNOWN there too, not a clean zero', async () => {
  // The same rule as the next fixture, and it needed its own test: a mutation
  // that deleted this branch left the suite green, because every assertion
  // about truncation was aimed at the NEXT fixture only.
  const soon = '2026-08-27T19:00Z';
  const s = spy({
    espn: () => res(espnBody([espnEvent(), espnEvent({ id: '2', date: soon })])),
    guide: () => res(guideBody([filler(1)], 900)),
  });
  const r = await run(s);
  const laterBlock = r.content.slice(r.content.indexOf('LATER FIXTURES'));
  assert.match(laterBlock, /channels UNKNOWN — the scan was truncated \(1 of 900/);
  assert.doesNotMatch(laterBlock, /no channels listed/);
});

test('the guide is queried at most once per reported fixture', async () => {
  // Each lookup is a request. Five in-reach fixtures must not become five
  // requests plus however many the lookahead grows to next.
  const dates = ['2026-08-26T12:00Z', '2026-08-27T12:00Z', '2026-08-28T12:00Z', '2026-08-29T12:00Z', '2026-08-29T18:00Z'];
  const s = spy({
    espn: () => res(espnBody([espnEvent(), ...dates.map((d, i) => espnEvent({ id: `x${i}`, date: d }))])),
    guide: () => res(guideBody([])),
  });
  await run(s);
  assert.ok(s.guideCalls.length <= 4, `expected at most 4 guide calls, got ${s.guideCalls.length}`);
  assert.ok(s.guideCalls.length >= 2, 'later fixtures inside the guide must actually be looked up');
});

test('a single day reads as "1 day", not "1 days"', () => {
  assert.match(renderKickoff(NOW + 40 * 3_600_000, NOW), /in 2 days/);
  assert.match(renderKickoff(NOW + 30 * 3_600_000, NOW), /in 30 h/);
  assert.doesNotMatch(renderKickoff(NOW + 40 * 3_600_000, NOW), /1 days/);
});

// ── NO FIXTURE AT ALL, BOUNDED HONESTLY ─────────────────────────────────────

test('no matching team is a WINDOW-bounded zero, and says which window', async () => {
  const s = spy({ espn: () => res(espnBody([espnEvent({ home: 'Fulham', away: 'Brentford' })])) });
  const r = await run(s, { league: 'epl', team: 'Crystal Palace', days_ahead: 7 });
  assert.equal(r.ok, true);
  assert.equal(s.guideCalls.length, 0, 'there is no fixture to look up a channel for');
  assert.match(r.content, /NO FIXTURE FOUND/);
  assert.match(r.content, /next 7 days/);
  assert.match(r.content, /1 events across those competitions and none involve/);
  assert.match(r.content, /bounded by the WINDOW and by the COMPETITION LIST above/);
  // 🔴 The scope must be on the answer, not implied by the caller's argument.
  assert.match(r.content, /SEARCHED 1 competition\(s\): Premier League/);
});

test('an EMPTY schedule and an UNMATCHED name are different sentences', async () => {
  const s = spy({ espn: () => res(espnBody([])) });
  const r = await run(s);
  assert.match(r.content, /NO events at all in any of them for that window/);
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
  assert.match(r.content, /NO CHANNELS LISTED YET/);
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
  assert.match(r.content, /NO CHANNELS LISTED YET/);
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
  assert.match(r.content, /NO CHANNELS LISTED YET/);
  assert.doesNotMatch(r.content, /CHANNEL: UK/);
});

test('🔴 LOCATION is never a variant — the Real Housewives near-miss', async () => {
  /**
   * 🔴 LIVE ON BRAVO WEST HD INSIDE TONIGHT'S KICKOFF WINDOW (2026-08-25).
   *
   * ESPN gives Real Salt Lake `location: "Salt Lake"`. As a match token that
   * made `The Real Housewives of Salt Lake City` satisfy the RSL half of the
   * both-teams rule; only the absence of "león" kept it out of a reply. A
   * scheduled job matching on EITHER token would have reported it to Jeff as
   * his match 45 minutes before kickoff.
   *
   * Measured before removing: 21 real guide matches with location variants,
   * 21 without. It discriminated nothing and collided with a place.
   */
  const rsl = teamVariants({
    displayName: 'Real Salt Lake',
    shortDisplayName: 'Real Salt Lake',
    name: 'Real Salt Lake',
    location: 'Salt Lake',
    abbreviation: 'RSL',
  });
  assert.ok(!rsl.includes('salt lake'), 'a CITY is not a team identity');
  assert.ok(rsl.includes('real salt lake'));

  // And the asking side still works, because the query token-matches the name.
  const f = fixtureOf([['real salt lake'], ['leon']]);
  assert.equal(matchQuality(f, 'salt lake'), 2, '"salt lake" must still find RSL');
  assert.equal(
    programmeNamesAllTeams('The Real Housewives of Salt Lake City', f),
    false,
    'a programme about the PLACE is not the fixture',
  );
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

  /**
   * The floor now has to be tested on an IDENTITY field, because `location` is
   * no longer read at all — the old case used `LA Clippers`' two-character
   * location, so dropping the floor stopped changing anything and the mutation
   * survived. A guard whose only test goes through a removed input is untested.
   *
   * ⚠️ Every short identity in the leagues we carry is exactly four characters
   * (`Nets`, `Hull`, `LAFC`, `León`, `Heat`, `Suns`, `UNAM` — measured), so the
   * floor admits all of them, which is correct. What it exists to reject is
   * shorter: AZ Alkmaar's `shortDisplayName` really is "AZ", and PSG's is
   * "PSG". `teamVariants` is general, so it is tested against that shape
   * directly.
   */
  const az = teamVariants({ displayName: 'AZ Alkmaar', shortDisplayName: 'AZ', name: 'AZ', nickname: 'AZ' });
  assert.ok(!az.includes('az'), '"az" is inside "jazz", "amazing", "Kazakhstan"…');
  assert.ok(az.includes('az alkmaar'));

  const leon = teamVariants({ displayName: 'León', shortDisplayName: 'León', name: 'León' });
  assert.deepEqual(leon, ['leon'], 'a real four-character identity must survive the floor');
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
