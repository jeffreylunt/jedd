import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { ArrClient, resetTransportBreaker, type FetchImpl } from '../src/media/arr.js';
import { pickBest, type Candidate } from '../src/media/matching.js';

/**
 * 🔴 THE TRANSPORT BREAKER IS PROCESS-GLOBAL, AND THESE TESTS CANNOT READ IT
 * OTHERWISE. `resetTransportBreaker()` clears every cooldown so the test order
 * does not matter — the failure that opened the breaker in one test must not
 * leak into the next, and any test that doesn't trigger a transport failure
 * would otherwise inherit whatever a previous test left in the map.
 */
beforeEach(() => {
  resetTransportBreaker();
});

/** The matcher the tools use: comparative, never a results[0] fallback. */
const match = (q: string, all: Candidate[]): Candidate[] => {
  const p = pickBest(q, all);
  return p ? [p.best] : [];
};

function client(fetchImpl: FetchImpl, kind: 'series' | 'movie' = 'series') {
  return new ArrClient(
    { baseUrl: 'http://hp.invalid:8989/sonarr/api/v3', apiKey: 'k', fetchImpl },
    kind,
  );
}

const json = (body: unknown, status = 200): Response =>
  ({ ok: status < 400, status, text: async () => JSON.stringify(body) }) as Response;

// ── 🔴 the truncation defect ─────────────────────────────────────────────────

test('🔴 THE OFFICE: an owned title is found even when it would sit far down a bounded search', () => {
  // V1 answered "do you have The Office?" from a BOUNDED lookup; the owned title
  // was at position 9 of 20, outside what the model saw, so Jedd said it was not
  // in the library. The fix is structural: filter the COMPLETE owned set, so
  // there is no window for a title to fall outside of.
  const library = [
    ...Array.from({ length: 40 }, (_, i) => ({ title: `Filler Show ${i}`, year: 2000 + i, tvdbId: i })),
    { title: 'The Office', year: 2005, tvdbId: 73244 },
    ...Array.from({ length: 40 }, (_, i) => ({ title: `Other Show ${i}`, year: 2010 + i, tvdbId: 500 + i })),
  ];
  return client(async () => json(library))
    .owned('the office', match)
    .then((r) => {
      assert.equal(r.state, 'owned');
      if (r.state !== 'owned') throw new Error('unreachable');
      assert.equal(r.matches[0]?.title, 'The Office');
    });
});

test('a title genuinely not owned is absent, and says how much was searched', async () => {
  // The inverting control: without it, "owned" would be consistent with the
  // matcher returning everything.
  const r = await client(async () => json([{ title: 'Breaking Bad', year: 2008, tvdbId: 1 }])).owned(
    'the office',
    match,
  );
  assert.equal(r.state, 'absent');
  if (r.state !== 'absent') throw new Error('unreachable');
  assert.equal(r.searched, 1);
});

// ── 🔴 unrunnable is not absent ──────────────────────────────────────────────

test('🔴 an unreachable arr is UNKNOWN, never "it is not there"', async () => {
  const r = await client(async () => {
    throw new Error('ECONNREFUSED');
  }).owned('dune', match);
  assert.equal(r.state, 'unknown');
  if (r.state !== 'unknown') throw new Error('unreachable');
  assert.match(r.detail, /could not reach/i);
});

test('🔴 an http error is UNKNOWN, never absent', async () => {
  const r = await client(async () => json(null, 500)).owned('dune', match);
  assert.equal(r.state, 'unknown');
});

test('🔴 UNKNOWN is a distinct state from ABSENT, so no caller can collapse them', async () => {
  // The failure this prevents: rendering "I could not check" as "it isn't there".
  // A false negative about something Jeff owns is measured as MORE damaging than
  // a false positive, because he can see it in Jellyfin.
  const unknown = await client(async () => json(null, 503)).owned('dune', match);
  const absent = await client(async () => json([])).owned('dune', match);
  assert.notEqual(unknown.state, absent.state);
  assert.equal(absent.state, 'absent');
});

// ── 🔴 a wrong path prefix is not a dead service ─────────────────────────────

test('🔴 a 200 with a non-JSON body is reported as a MISSING PATH PREFIX', async () => {
  // The bare host serves a web app, so the request "succeeds" and returns HTML.
  // "Your URL is wrong" and "the homelab is down" lead to different actions.
  const r = await client(
    async () => ({ ok: true, status: 200, text: async () => '<!doctype html><html>...' }) as Response,
  ).owned('dune', match);
  assert.equal(r.state, 'unknown');
  if (r.state !== 'unknown') throw new Error('unreachable');
  assert.match(r.detail, /MISSING PATH PREFIX/);

  // The real claim is DISCRIMINATION, so compare against a genuinely dead
  // service rather than grepping one string. (A naive doesNotMatch(/unreachable
  // service/) fails here because the message says "...NOT of an unreachable
  // service" -- the assertion would have been measuring the substring rather
  // than the meaning, which is the same shape as every other instrument error
  // today.)
  const dead = await client(async () => {
    throw new Error('ECONNREFUSED');
  }).owned('dune', match);
  assert.equal(dead.state, 'unknown');
  if (dead.state !== 'unknown') throw new Error('unreachable');
  assert.doesNotMatch(dead.detail, /MISSING PATH PREFIX/);
  assert.notEqual(r.detail, dead.detail, 'the two failures must be distinguishable');
});

test('probe distinguishes reachable from a wrong prefix', async () => {
  const good = await client(async () => json({ version: '4.0' })).probe();
  assert.equal(good.reachable, true);
  const wrong = await client(
    async () => ({ ok: true, status: 200, text: async () => '<html>' }) as Response,
  ).probe();
  assert.equal(wrong.reachable, false);
  assert.match(wrong.detail, /path prefix/i);
});

// ── the two questions use different endpoints ────────────────────────────────

test('🔴 owned() and catalogue() hit DIFFERENT endpoints', async () => {
  const urls: string[] = [];
  const c = client(async (u) => {
    urls.push(String(u));
    return json([]);
  });
  await c.owned('dune', match);
  await c.catalogue('dune');
  assert.equal(urls[0], 'http://hp.invalid:8989/sonarr/api/v3/series');
  assert.match(urls[1]!, /\/series\/lookup\?term=dune/);
});

test('the api key travels as a header, and every call is bounded', async () => {
  let init: RequestInit | undefined;
  await client(async (_u, i) => {
    init = i;
    return json([]);
  }).owned('x', match);
  assert.equal((init?.headers as Record<string, string>)['X-Api-Key'], 'k');
  assert.ok(init?.signal, 'every arr call must carry a timeout');
});

test('radarr uses the movie endpoints', async () => {
  const urls: string[] = [];
  await new ArrClient(
    { baseUrl: 'http://hp.invalid:8989/radarr/api/v3', apiKey: 'k', fetchImpl: async (u) => {
      urls.push(String(u));
      return json([]);
    } },
    'movie',
  ).owned('dune', match);
  assert.equal(urls[0], 'http://hp.invalid:8989/radarr/api/v3/movie');
});

// ── 🔴 the id space, found against the LIVE api ──────────────────────────────

test('🔴 a SERIES row carrying id, tvdbId AND tmdbId yields the tvdbId', async () => {
  // Real Sonarr row for The Office (US): id 43, tvdbId 73244, tmdbId 2316 — all
  // three present, all different, all valid-looking. A `tmdbId ?? tvdbId ?? id`
  // chain returned 2316 for a series, and Sonarr's add wants the tvdbId. Nothing
  // errors: 2316 is well-formed and either finds nothing or a DIFFERENT series.
  //
  // Every earlier fixture carried only ONE id field, so the precedence never had
  // to choose. A fixture that cannot express the ambiguity cannot test the rule.
  const r = await client(async () =>
    json([{ title: 'The Office (US)', year: 2005, id: 43, tvdbId: 73244, tmdbId: 2316 }]),
  ).owned('the office', match);
  assert.equal(r.state, 'owned');
  if (r.state !== 'owned') throw new Error('unreachable');
  assert.equal(r.matches[0]?.id, 73244, 'a series must be identified by tvdbId');
});

test('🔴 a MOVIE row carrying both yields the tmdbId', async () => {
  const r = await new ArrClient(
    {
      baseUrl: 'http://radarr.invalid/radarr/api/v3',
      apiKey: 'k',
      fetchImpl: async () => json([{ title: 'Dune', year: 2021, id: 12, tvdbId: 999, tmdbId: 438631 }]),
    },
    'movie',
  ).owned('dune', match);
  assert.equal(r.state, 'owned');
  if (r.state !== 'owned') throw new Error('unreachable');
  assert.equal(r.matches[0]?.id, 438631, 'a movie must be identified by tmdbId');
});

test('a row missing its kind-specific id yields 0 rather than a foreign id', async () => {
  // 59 of 60 real rows had tmdbId, so a precedence chain would silently change
  // id space for one row in the same list. 0 is unusable and obviously so.
  const r = await client(async () => json([{ title: 'Odd Show', year: 2020, id: 7, tmdbId: 555 }])).owned(
    'odd show',
    match,
  );
  assert.equal(r.state, 'owned');
  if (r.state !== 'owned') throw new Error('unreachable');
  assert.equal(r.matches[0]?.id, 0);
});

// ── shapes taken from the LIVE lookup endpoints, 2026-08-24 ──────────────────

test('🔴 MONEYBALL is genuinely ambiguous in PRODUCTION data, not just in a fixture', async () => {
  // Verbatim from the live endpoints:
  //   /series/lookup?term=moneyball -> Moneyball (2021) tvdbId 411987 tmdbId 137592 id 202
  //   /movie/lookup?term=moneyball  -> Moneyball (2011) tmdbId 60308  imdbId tt1210166
  // So the ambiguity rule fires on the real defect case, and the kind-based id
  // selection is required on the LOOKUP path too -- a Sonarr lookup row carries
  // tmdbId as well, so the old ?? chain would have returned 137592 for a series.
  const series = await client(async () =>
    json([{ title: 'Moneyball', year: 2021, id: 202, tvdbId: 411987, tmdbId: 137592 }]),
  ).catalogue('moneyball');
  assert.equal(series.state, 'results');
  if (series.state !== 'results') throw new Error('unreachable');
  assert.equal(series.candidates[0]?.id, 411987, 'a series lookup row must yield tvdbId');

  const movie = await new ArrClient(
    {
      baseUrl: 'http://radarr.invalid/radarr/api/v3',
      apiKey: 'k',
      fetchImpl: async () => json([{ title: 'Moneyball', year: 2011, tmdbId: 60308, imdbId: 'tt1210166' }]),
    },
    'movie',
  ).catalogue('moneyball');
  assert.equal(movie.state, 'results');
  if (movie.state !== 'results') throw new Error('unreachable');
  assert.equal(movie.candidates[0]?.id, 60308);
});

// ── 🔴 FAIL FAST WHILE A SERVICE IS KNOWN DOWN ────────────────────────────────
//
// The 2026-08-31 audit entry pinned the shape: a catalogue_search against an
// unreachable Radarr waited 20s, the model then issued two more calls in the
// same turn, and EACH one waited 20s. The breaker addresses the second and
// third, deliberately — the first failure still pays the full timeout, because
// a single slow call is not the defect.

const UNREACHABLE_URL = 'http://breaker-target.invalid:7878/radarr/api/v3';

function breakerClient(fetchImpl: FetchImpl) {
  return new ArrClient({ baseUrl: UNREACHABLE_URL, apiKey: 'k', fetchImpl }, 'movie');
}

test('🔴 the FIRST transport failure still pays the full timeout (does not silently swallow it)', async () => {
  // A breaker that skipped the first failure would hide the signal: the model
  // would be told "Radarr is fine, nothing matched" and the user's report would
  // never say RADARR IS UNREACHABLE. This pins that the first call STILL
  // reaches the fetchImpl and still surfaces the underlying error verbatim.
  let called = 0;
  const r = await breakerClient(async () => {
    called++;
    throw new Error('ECONNREFUSED');
  }).catalogue('dune');
  assert.equal(called, 1, 'the first call must reach the fetchImpl');
  assert.equal(r.state, 'unknown');
  if (r.state !== 'unknown') throw new Error('unreachable');
  assert.match(r.detail, /could not reach/);
});

test('🔴 the SECOND transport failure within the cooldown does NOT reach fetchImpl', async () => {
  // This is the actual repair: catalogue_search → add_movie → catalogue_search
  // in one turn paid three 20s waits. After the first, the breaker must
  // short-circuit and the fetchImpl must NOT be called.
  let called = 0;
  const c = breakerClient(async () => {
    called++;
    throw new Error('ECONNREFUSED');
  });
  await c.catalogue('dune');
  assert.equal(called, 1, 'first call reaches fetchImpl');
  const r = await c.catalogue('dune');
  assert.equal(called, 1, 'second call is short-circuited by the breaker');
  assert.equal(r.state, 'unknown');
  if (r.state !== 'unknown') throw new Error('unreachable');
  assert.match(r.detail, /NOT retrying yet/);
});

test('🔴 the breaker names the URL and the underlying cause, so the message is actionable', async () => {
  // A breaker message that just said "temporarily unavailable" would leave the
  // model guessing at which service was down. The message MUST name the URL and
  // quote the original error so the operator can act on it without re-running.
  const c = breakerClient(async () => {
    throw Object.assign(new Error('connect EHOSTUNREACH 10.0.0.7:7878'), {
      code: 'EHOSTUNREACH',
      syscall: 'connect',
      address: '10.0.0.7',
      port: 7878,
    });
  });
  const first = await c.catalogue('dune');
  assert.equal(first.state, 'unknown');
  const r = await c.catalogue('dune');
  assert.equal(r.state, 'unknown');
  if (r.state !== 'unknown') throw new Error('unreachable');
  assert.match(r.detail, /breaker-target\.invalid/);
  assert.match(r.detail, /EHOSTUNREACH/);
});

test('CONTROL: a SUCCESSFUL first call leaves the breaker closed for the second', async () => {
  // The breaker is for TRANSPORT failures only. A 5xx is the service answering
  // and must not poison later calls — a service that 500ed once may be fine on
  // the next request. This pins both halves: an HTTP error does not trip the
  // breaker, AND a successful call after an error resets the cool-down's logic.
  let calls = 0;
  const c = breakerClient(async () => {
    calls += 1;
    if (calls === 1) return json({}, 503);
    return json([]);
  });
  const first = await c.catalogue('dune');
  assert.equal(first.state, 'unknown', 'an HTTP 503 is unknown but does NOT trip the breaker');
  const second = await c.catalogue('dune');
  assert.equal(second.state, 'results', 'and the second call is allowed to reach fetchImpl');
  assert.equal(calls, 2, 'every call goes through fetchImpl when the breaker is closed');
});

test('🔴 a transport failure from one URL does not poison a DIFFERENT URL', async () => {
  // The breaker is keyed on baseUrl so a failing Radarr does not also block
  // Sonarr — they are independent services. Without that, one service being
  // down would short-circuit every other read on the same machine.
  const radarrDown = new ArrClient(
    { baseUrl: 'http://radarr-down.invalid:7878/radarr/api/v3', apiKey: 'k', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } },
    'movie',
  );
  const downResult = await radarrDown.catalogue('dune');
  assert.equal(downResult.state, 'unknown');
  const sonarrOk = new ArrClient(
    { baseUrl: 'http://sonarr-up.invalid:8989/sonarr/api/v3', apiKey: 'k', fetchImpl: async () => json([]) },
    'series',
  );
  const r = await sonarrOk.catalogue('breaking bad');
  assert.equal(r.state, 'results', 'a different base URL is unaffected');
});

test('🔴 the breaker is OPEN after one transport failure and the message is short-circuited', async () => {
  // Pin that the breaker exposes its state and that `cooledDownFor` is the
  // read-side seam a future caller could use (e.g. a /health endpoint that
  // says "Radarr is down, last error X"). Without this, the breaker would be
  // a write-only side effect and a debug route would have to clear it first
  // to even observe its open state.
  const c = breakerClient(async () => {
    throw new Error('ECONNREFUSED');
  });
  await c.catalogue('dune');
  const { cooledDownFor } = await import('../src/media/arr.js');
  const cooled = cooledDownFor(UNREACHABLE_URL);
  assert.ok(cooled, 'after one failure the breaker is open');
  assert.match(cooled!.detail, /ECONNREFUSED/);
  assert.ok(cooled!.elapsedMs >= 0 && cooled!.elapsedMs < 30_000, 'elapsed time is within the cooldown window');
});

test('🔴 resetTransportBreaker closes the breaker so the next call goes through', async () => {
  // The breaker is for the SECOND and third calls in a burst, not for forever.
  // `resetTransportBreaker` is the public seam that closes the breaker — used
  // in production by a periodic health check that re-tries the service after a
  // quiet period, and by tests that need a clean slate. Pinning this means the
  // breaker can be cleared and the next call reaches `fetchImpl` again.
  const c = breakerClient(async () => {
    throw new Error('ECONNREFUSED');
  });
  await c.catalogue('dune');
  resetTransportBreaker();
  let called = 0;
  const fresh = breakerClient(async () => {
    called += 1;
    return json([]);
  });
  const r = await fresh.catalogue('dune');
  assert.equal(called, 1, 'after a reset, fetchImpl is reached again');
  assert.equal(r.state, 'results');
});
