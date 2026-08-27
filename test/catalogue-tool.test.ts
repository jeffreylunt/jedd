import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FetchImpl } from '../src/media/arr.js';
import { makeCatalogueSearch } from '../src/tools/catalogue.js';
import type { ToolContext } from '../src/tools/types.js';
import { testConfig } from './helpers.js';

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
