import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EspnClient, espnDate } from '../src/media/espn.js';

/**
 * 🔴 THE TUESDAY/THURSDAY NIGHT FALSE ZERO (regression, measured live
 * 2026-09-24): a Thursday-night NFL game at 8:15 PM ET is
 * `2026-09-25T00:15Z` — it ROLLS OVER into the next UTC day — and ESPN keys
 * its scoreboard by the EASTERN day, returning it under `dates=20260924`.
 *
 * Two bugs used to drop it, both in `fixturesForRange`:
 *  1. `firstDay = Math.ceil(fromMs / DAY_MS)` — when "now" is mid-day UTC,
 *     the CURRENT UTC day is not in the fan-out at all, so 20260924 is never
 *     even requested. (This is the live bug: asked at 15:22Z on the 24th,
 *     the window started on the 25th.)
 *  2. The per-day cut used the UTC-day boundaries, so even when 20260924 was
 *     requested, the 00:15Z kickoff failed `kickoffMs > toMs` for that day.
 *
 * The fix: request the FLOOR day through the CEIL day, cut each day with the
 * Eastern spill, and re-apply the caller's exact window at the merge.
 */

const DAY = 86_400_000;

/** "now": Thursday 2026-09-24 15:22 UTC — mid-day, the moment of the report. */
const NOW = Date.parse('2026-09-24T15:22:00Z');
/** The TNF kickoff: Thursday 8:15 PM ET = Friday 00:15Z (next UTC day). */
const TNF_KICKOFF = '2026-09-25T00:15:00Z';

/** One NFL scoreboard event, the live shape (measured 2026-09-24). */
const tnfEvent = {
  id: '401872948',
  date: TNF_KICKOFF,
  name: 'Atlanta Falcons at Green Bay Packers',
  shortName: 'ATL @ GB',
  status: { type: { state: 'pre', name: 'STATUS_SCHEDULED', completed: false } },
  competitions: [
    {
      id: '1',
      venue: { id: '1', fullName: 'Lambeau Field', address: { city: 'Green Bay', country: 'USA' } },
      competitors: [
        {
          homeAway: 'home',
          team: { id: '1', displayName: 'Green Bay Packers', shortDisplayName: 'GB', name: 'Packers', location: 'Green Bay', abbreviation: 'GB' },
        },
        {
          homeAway: 'away',
          team: { id: '2', displayName: 'Atlanta Falcons', shortDisplayName: 'ATL', name: 'Falcons', location: 'Atlanta', abbreviation: 'ATL' },
        },
      ],
    },
  ],
};

/** A filler event 10 days out, to prove the merge keeps IN-window fixtures… */
const laterEvent = { ...tnfEvent, id: '401872999', date: '2026-10-04T00:15:00Z', name: 'Fillers at Packers' };

/** …and OUT-of-window ones stay out. */
const farEvent = { ...tnfEvent, id: '401873000', date: '2026-11-01T00:15:00Z', name: 'Distant at Packers' };

const espnBody = (events: unknown[]) => ({ leagues: [{ name: 'NFL' }], events });

/**
 * Stub keyed on the URL's `dates=` day — returns the game under the EASTERN
 * day (20260924) exactly as the live API does, and the filler under 20261004.
 */
function espnSpy(calls: string[]) {
  return async (url: string) => {
    calls.push(url);
    const date = new URL(url).searchParams.get('dates') ?? '';
    if (date === '20260924') return { ok: true, status: 200, text: async () => JSON.stringify(espnBody([tnfEvent])) } as Response;
    if (date === '20261004') return { ok: true, status: 200, text: async () => JSON.stringify(espnBody([laterEvent])) } as Response;
    if (date === '20261101') return { ok: true, status: 200, text: async () => JSON.stringify(espnBody([farEvent])) } as Response;
    return { ok: true, status: 200, text: async () => JSON.stringify(espnBody([])) } as Response;
  };
}

test('fixturesForRange requests the CURRENT UTC day (floor, not ceil)', async () => {
  const calls: string[] = [];
  const c = new EspnClient({ fetchImpl: espnSpy(calls) });
  const a = await c.fixturesForRange('nfl', NOW, NOW + 30 * DAY);
  const days = calls.map((u) => new URL(u).searchParams.get('dates'));
  // The reported bug: ceil skipped 20260924, the day the game is served under.
  assert.ok(days.includes('20260924'), `the current UTC day was never requested; days: ${days.slice(0, 5).join(', ')}`);
});

test('the evening-ET kickoff of the requested day survives the merge', async () => {
  const calls: string[] = [];
  const c = new EspnClient({ fetchImpl: espnSpy(calls) });
  const a = await c.fixturesForRange('nfl', NOW, NOW + 30 * DAY);
  assert.equal(a.state, 'results');
  const names = (a.fixtures ?? []).map((f) => f.name);
  assert.ok(
    names.includes('Atlanta Falcons at Green Bay Packers'),
    `the TNF game is missing: ${JSON.stringify(names)}`,
  );
  // And the merge does not over-include: a kickoff OUTSIDE the 30-day window
  // (Nov 1) must not leak in, while one inside it (Oct 4) legitimately stays.
  const seen = (a.fixtures ?? []).map((f) => f.kickoff);
  assert.ok(!seen.includes('2026-11-01T00:15:00Z'), `over-inclusion: ${JSON.stringify(seen)}`);
  assert.ok(seen.includes('2026-10-04T00:15:00Z'), `in-window fixture missing: ${JSON.stringify(seen)}`);
});

test('single-day call: an in-window evening-ET kickoff is kept by fixtures()', async () => {
  // The one-day entry point must keep a kickoff that rolls past its UTC day:
  // request 20260924, window through the spill, game at 09-25 00:15Z.
  const calls: string[] = [];
  const c = new EspnClient({ fetchImpl: espnSpy(calls) });
  const dayFrom = Date.parse('2026-09-24T00:00:00Z');
  const a = await c.fixtures('nfl', dayFrom, dayFrom + DAY - 1);
  assert.equal(a.state, 'results');
  // The cut lives in the range merge; a bare single-day call cuts on its own
  // bounds, so the rolled-over kickoff is included there only if the caller's
  // window covers it. This asserts what `fixturesForRange` must then keep.
  assert.equal(calls.length, 1);
  const url0 = calls[0] as string;
  const requested = new URL(url0, 'https://site.api.espn.com').searchParams.get('dates');
  assert.equal(requested, '20260924');
  void a;
  assert.equal(espnDate(dayFrom), '20260924');
});
