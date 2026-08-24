import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CATEGORY,
  ProwlarrClient,
  isValidInfoHash,
  magnetFor,
  rankReleases,
  type FetchImpl,
} from '../src/media/prowlarr.js';

const HASH = 'a'.repeat(40);
const json = (b: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: async () => b }) as Response;

const client = (impl: FetchImpl) =>
  new ProwlarrClient({ baseUrl: 'http://p.invalid/prowlarr/api/v1', apiKey: 'k', fetchImpl: impl });

// ── 🔴 the infoHash is the whole point ───────────────────────────────────────

test('🔴 a release with no infoHash is DISCARDED, not offered', async () => {
  // qBittorrent lives in gluetun's netns and CANNOT reach Prowlarr. Handing it a
  // proxy URL fails silently -- pending_count:1 and nothing ever materialises.
  // Offering such a release is offering a choice the user cannot have.
  const r = await client(async () =>
    json([{ title: 'A Book', downloadUrl: 'http://prowlarr/proxy/1', seeders: 9 }]),
  ).search('a book', CATEGORY.ebook);
  assert.equal(r.state, 'none');
  if (r.state !== 'none') throw new Error('unreachable');
  assert.match(r.detail, /none carried an infoHash/);
});

test('discarded-but-present is distinguishable from genuinely-nothing', async () => {
  const nothing = await client(async () => json([])).search('x', CATEGORY.ebook);
  assert.equal(nothing.state, 'none');
  if (nothing.state !== 'none') throw new Error('unreachable');
  assert.match(nothing.detail, /found nothing/);
});

test('🔴 an infoHash must be exactly 40 hex characters', () => {
  // It is interpolated into a shell command on the PRIVILEGED ssh identity, so
  // this validation is the entire defence -- same as isValidContainerName.
  assert.equal(isValidInfoHash(HASH), true);
  for (const bad of ['a'.repeat(39), 'a'.repeat(41), `${'a'.repeat(39)};rm -rf /`, 'g'.repeat(40), '', null]) {
    assert.equal(isValidInfoHash(bad), false, `${JSON.stringify(bad)} must be refused`);
  }
});

test('🔴 magnetFor REFUSES to build from anything unvalidated', () => {
  assert.throws(() => magnetFor('not-a-hash', 'x'), /refusing to build a magnet/);
  assert.throws(() => magnetFor(`${'a'.repeat(40)} && curl evil`, 'x'));
  assert.match(magnetFor(HASH, 'A Book'), /^magnet:\?xt=urn:btih:a{40}&dn=A%20Book$/);
});

// ── 🔴 a failure to look is not a finding ────────────────────────────────────

test('🔴 an unreachable Prowlarr is UNKNOWN, never "nothing found"', async () => {
  const r = await client(async () => {
    throw new Error('ETIMEDOUT');
  }).search('x', CATEGORY.ebook);
  assert.equal(r.state, 'unknown');
  if (r.state !== 'unknown') throw new Error('unreachable');
  assert.match(r.detail, /NOT a finding that nothing exists/);
});

test('an http error and a non-JSON body are both UNKNOWN', async () => {
  assert.equal((await client(async () => json(null, 500)).search('x', 7020)).state, 'unknown');
  assert.equal(
    (
      await client(async () =>
        ({ ok: true, status: 200, json: async () => { throw new Error('nope'); } }) as unknown as Response,
      ).search('x', 7020)
    ).state,
    'unknown',
  );
});

// ── the search itself ────────────────────────────────────────────────────────

test('the ebook category and the api key are sent, and the call is bounded', async () => {
  let url = '';
  let init: RequestInit | undefined;
  await client(async (u, i) => {
    url = String(u);
    init = i;
    return json([]);
  }).search('the anxious generation', CATEGORY.ebook);
  assert.match(url, /categories=7020/);
  assert.match(url, /query=the%20anxious%20generation/);
  assert.equal((init?.headers as Record<string, string>)['X-Api-Key'], 'k');
  assert.ok(init?.signal, 'a cold search takes 35-45s but it still must be bounded');
});

test('🔴 exactly ONE request is made — no retry loop', async () => {
  // Repeated searches trip per-indexer failure-backoff, which temporarily
  // DISABLES indexers. A retry loop degrades the thing it retries against.
  let calls = 0;
  await client(async () => {
    calls += 1;
    throw new Error('slow');
  }).search('x', CATEGORY.ebook);
  assert.equal(calls, 1);
});

// ── ranking ──────────────────────────────────────────────────────────────────

test('alive releases outrank dead ones, then by seeders', () => {
  const mk = (title: string, seeders: number) => ({
    title, seeders, infoHash: HASH, sizeBytes: 1, indexer: 'i',
  });
  const ranked = rankReleases([mk('dead', 0), mk('few', 3), mk('many', 40)]);
  assert.deepEqual(ranked.map((r) => r.title), ['many', 'few', 'dead']);
});
