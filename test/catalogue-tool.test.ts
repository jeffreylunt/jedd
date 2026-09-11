import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { resetTransportBreaker, type FetchImpl } from '../src/media/arr.js';
import { makeCatalogueSearch } from '../src/tools/catalogue.js';
import type { ToolContext } from '../src/tools/types.js';
import { testConfig } from './helpers.js';

/**
 * 🔴 THE TRANSPORT BREAKER IS PROCESS-GLOBAL. Without this reset, the first
 * test that triggers a transport failure (the `dead` routes) would leave the
 * breaker open for `http://radarr.invalid:7878` and `http://sonarr.invalid:8989`,
 * and the tests after it would never reach their `dead`/`json()` branches — they
 * would observe the cool-down message instead. Same call site, different test,
 * same shape as `media-arr.test.ts`.
 */
beforeEach(() => {
  resetTransportBreaker();
});

const ctx = (): ToolContext => ({
  role: 'guest',
  senderHandle: '+18015550123',
  config: testConfig(),
});

/** Route by which arr the URL belongs to, so a test can make one side fail. */
function routed(radarr: () => Response, sonarr: () => Response): FetchImpl {
  return async (url) => (String(url).includes('/radarr/') ? radarr() : sonarr());
}

const json = (body: unknown, status = 200): Response =>
  ({ ok: status < 400, status, text: async () => JSON.stringify(body) }) as Response;

const dead = (): Response => {
  throw new Error('ECONNREFUSED');
};

/**
 * The exact DOMException `AbortSignal.timeout` throws when its deadline fires
 * against a hanging connection. Reproduced live (Node 22) against
 * `10.255.255.1:9999` with `AbortSignal.timeout(50)` — name `TimeoutError`,
 * message `The operation was aborted due to timeout`, code `23`. The message
 * is what the user saw in issue #21's audit entry, so the test asserts on
 * its exact shape, not on a paraphrase.
 */
const timeout = (): never => {
  throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
};

const run = (f: FetchImpl, title = 'moneyball') =>
  makeCatalogueSearch(f).run({ title }, ctx());

// ── 🔴 the Moneyball rule, end to end through the tool ───────────────────────

test('🔴 MONEYBALL: both catalogues matching yields AMBIGUOUS and says not to add', async () => {
  const r = await run(
    routed(
      () => json([{ title: 'Moneyball', year: 2011, tmdbId: 60308 }]),
      () => json([{ title: 'Moneyball', year: 2021, tvdbId: 99 }]),
    ),
  );
  assert.equal(r.ok, true);
  assert.match(r.content, /AMBIGUOUS/);
  assert.match(r.content, /do NOT add/i);
  assert.match(r.content, /2011/);
  assert.match(r.content, /2021/);
});

test('CONTROL: a film-only title resolves to FILM and carries the id to add with', async () => {
  const r = await run(
    routed(() => json([{ title: 'Whiplash', year: 2014, tmdbId: 244786 }]), () => json([])),
    'whiplash',
  );
  assert.match(r.content, /^FILM/);
  assert.match(r.content, /244786/);
});

test('CONTROL: a show-only title resolves to SHOW', async () => {
  const r = await run(
    routed(() => json([]), () => json([{ title: 'Breaking Bad', year: 2008, tvdbId: 1396 }])),
    'breaking bad',
  );
  assert.match(r.content, /^SHOW/);
});

// ── 🔴 a half-searched catalogue is never answered as if it were whole ───────

test('🔴 RADARR down: does NOT answer as if only shows exist', async () => {
  // Answering "it's a show" when the film catalogue could not be searched is a
  // false negative wearing the clothes of an answer.
  const r = await run(routed(dead, () => json([{ title: 'Moneyball', year: 2021, tvdbId: 99 }])));
  assert.equal(r.ok, false, 'a half-searched catalogue is not a success');
  assert.match(r.content, /RADARR IS UNREACHABLE/);
  assert.match(r.content, /cannot say whether a FILM/i);
});

test('🔴 SONARR down: does NOT answer as if only films exist', async () => {
  const r = await run(routed(() => json([{ title: 'Moneyball', year: 2011, tmdbId: 60308 }]), dead));
  assert.equal(r.ok, false);
  assert.match(r.content, /SONARR IS UNREACHABLE/);
});

test('🔴 both down is UNKNOWN, never "not available"', async () => {
  const r = await run(routed(dead, dead));
  assert.equal(r.ok, false);
  assert.match(r.content, /UNKNOWN rather than "not available"/);
});

// ── 🔴 issue #21 — a real timeout is reported like every other unreachable radarr,
//                 AND the breaker opens so the next call in the same window does
//                 not pay another 20s ──────────────────────────────────────────
//
// The 2026-08-31 22:23:39Z turn timed out at `192.168.1.7:7878` for "Better Off
// Dead". The error came back as `RADARR IS UNREACHABLE (... operation was
// aborted due to timeout)`. The downstream check the operator cares about is
// that this case — a HANG, not a refused connection — trips the same breaker
// as `ECONNREFUSED`. The breaker is keyed on transport failure, not on a
// particular failure code, so the timeout path must open it too; if it did
// not, every retry the model issued in the same turn would pay another 20s.

test('🔴 issue #21: a Radarr TIMEOUT is reported as RADARR IS UNREACHABLE with the abort verbatim', async () => {
  // The `dead` helper above throws `Error('ECONNREFUSED')`. That exercises one
  // transport failure. The other one — a hang that fires `AbortSignal.timeout`
  // — produces a `DOMException` with name `TimeoutError` and the specific
  // message the audit log recorded. Without this test a future refactor that
  // keyed the breaker on `e.code === 'ECONNREFUSED'` would silently regress
  // the timeout path back to paying 20s on every retry.
  const r = await run(routed(timeout, () => json([{ title: 'Better Off Dead', year: 1985, tmdbId: 1 }])));
  assert.equal(r.ok, false, 'a timed-out catalogue is not a successful answer');
  assert.match(r.content, /RADARR IS UNREACHABLE/);
  assert.match(r.content, /cannot say whether a FILM/i);
  // The original abort message travels through so the model can quote it back.
  // `describeError` reads `e.message` by name — a refactor that switched to
  // `e.toString()` would lose the rest of the sentence.
  assert.match(r.content, /operation was aborted due to timeout/i);
});

test('🔴 issue #21: a Radarr TIMEOUT trips the breaker so the second call is short-circuited', async () => {
  // Same shape as the media-arr breaker test, but at the catalogue_search
  // layer — the place issue #21 was actually observed. The breaker is keyed
  // on baseUrl, not on a particular failure, so a hang must open it just like
  // a refused connection does. A test that only exercised `ECONNREFUSED`
  // would leave the timeout case uncovered, and a future code change could
  // quietly narrow the breaker to one of the two.
  let called = 0;
  const f = routed(
    () => {
      called++;
      throw timeout();
    },
    () => json([{ title: 'Better Off Dead', year: 1985, tmdbId: 1 }]),
  );
  const first = await run(f);
  assert.equal(first.ok, false);
  assert.equal(called, 1, 'first call still reaches fetchImpl — the 20s is the design, see fix #1');
  const second = await run(f);
  assert.equal(called, 1, 'second call is short-circuited by the breaker opened by the timeout');
  assert.equal(second.ok, false);
  assert.match(second.content, /NOT retrying yet/);
});

// ── nothing found is not the closest thing ───────────────────────────────────

test('nothing resembling the title says so, and does not offer a near-miss', async () => {
  const r = await run(
    routed(() => json([{ title: 'Ghost Dad', year: 1990, tmdbId: 1 }]), () => json([])),
    'the anxious generation',
  );
  assert.match(r.content, /NO MATCH/);
  assert.doesNotMatch(r.content, /Ghost Dad \(1990\) \(radarr/, 'must not present the near-miss as the answer');
});

// ── a near-tie is a question ─────────────────────────────────────────────────

test('🔴 a near-tie is CONTESTED and must not be added without asking', async () => {
  const r = await run(
    routed(
      () =>
        json([
          { title: 'Dune', year: 2021, tmdbId: 438631 },
          { title: 'Dune', year: 1984, tmdbId: 841 },
        ]),
      () => json([]),
    ),
    'dune',
  );
  assert.match(r.content, /CONTESTED/);
  assert.match(r.content, /do NOT add without asking/i);
});

// ── the tool's own declarations ──────────────────────────────────────────────

test('catalogue_search is a guest-visible READ', async () => {
  const t = makeCatalogueSearch();
  assert.equal(t.minRole, 'guest');
  assert.equal(t.writes, false, 'searching adds nothing');
});

test('its description tells the model NOT to use it for "do you have"', () => {
  // The two questions used one endpoint in V1 and that was the defect. The
  // separation only helps if the model knows which is which.
  assert.match(makeCatalogueSearch().description, /do NOT use it to answer "do you have/i);
});
