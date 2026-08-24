import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ArrClient, type FetchImpl } from '../src/media/arr.js';
import { pickBest, type Candidate } from '../src/media/matching.js';

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
