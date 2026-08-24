import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ArrClient, type FetchImpl } from '../src/media/arr.js';

/**
 * The write path, and the two defects measured in V1's production data on
 * 2026-08-24 rather than taken from a backlog.
 */

interface Sent {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

function capturing(status = 201, respBody: unknown = {}, text?: string) {
  const sent: Sent[] = [];
  const impl: FetchImpl = async (url, init) => {
    sent.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    return {
      ok: status < 400,
      status,
      text: async () => text ?? JSON.stringify(respBody),
    } as Response;
  };
  return { impl, sent };
}

const sonarr = (impl: FetchImpl) =>
  new ArrClient({ baseUrl: 'http://s.invalid/sonarr/api/v3', apiKey: 'k', fetchImpl: impl }, 'series');
const radarr = (impl: FetchImpl) =>
  new ArrClient({ baseUrl: 'http://r.invalid/radarr/api/v3', apiKey: 'k', fetchImpl: impl }, 'movie');

const peppa = {
  tvdbId: 73244,
  title: 'Peppa Pig',
  seasons: [1, 2, 3],
  availableSeasons: [1, 2, 3, 4, 5, 6, 7, 8, 9],
  rootFolder: '/tv',
  qualityProfileId: 9,
};

// ── 🔴 DEFECT 1: season scoping ──────────────────────────────────────────────

test('🔴 PEPPA PIG: asking for seasons 1-3 monitors ONLY 1-3', async () => {
  // Live instance: V1 monitored seasons 1-9 on a request for "the first 3
  // seasons", then grabbed S5 (52/52) — a season nobody asked for — while the
  // requested S2 and S3 sit at 0/52 five months later.
  const { impl, sent } = capturing();
  await sonarr(impl).addSeries(peppa);
  const seasons = sent[0]!.body['seasons'] as { seasonNumber: number; monitored: boolean }[];
  const monitored = seasons.filter((s) => s.monitored).map((s) => s.seasonNumber);
  assert.deepEqual(monitored, [1, 2, 3]);
  const unmonitored = seasons.filter((s) => !s.monitored).map((s) => s.seasonNumber);
  assert.deepEqual(unmonitored, [4, 5, 6, 7, 8, 9], 'every other season must be explicitly OFF');
});

test("🔴 addOptions.monitor is 'none' so the SERVICE cannot re-expand the scope", async () => {
  // The per-season flags are not enough on their own: Sonarr's own monitor
  // option overrides them, and its default is not 'none'. This is the actual
  // mechanism behind seasons 1-9.
  const { impl, sent } = capturing();
  await sonarr(impl).addSeries(peppa);
  const opts = sent[0]!.body['addOptions'] as Record<string, unknown>;
  assert.equal(opts['monitor'], 'none');
  assert.equal(opts['searchForMissingEpisodes'], true, 'but it must still search for what IS monitored');
});

test('a season that does not exist is refused, and NOTHING is added', async () => {
  const { impl, sent } = capturing();
  const r = await sonarr(impl).addSeries({ ...peppa, seasons: [1, 99] });
  assert.equal(r.state, 'failed');
  assert.match(r.detail, /99/);
  assert.equal(sent.length, 0, 'a refused add must make no request at all');
});

// ── 🔴 DEFECT 2 (the outcome enum) ───────────────────────────────────────────

test('🔴 a duplicate add is ALREADY-HAVE, which is success — never "retry"', async () => {
  // V1's ebook path read a duplicate-add rejection as a download FAILURE and
  // told the user to retry: the one action guaranteed never to work.
  const { impl } = capturing(400, {}, '[{"errorMessage":"This series has already been added"}]');
  const r = await sonarr(impl).addSeries(peppa);
  assert.equal(r.state, 'already-have');
  assert.doesNotMatch(r.detail, /retry|try again/i);
});

test('🔴 an unreachable service is UNKNOWN — the write MAY have landed', async () => {
  const impl: FetchImpl = async () => {
    throw new Error('ECONNREFUSED');
  };
  const r = await sonarr(impl).addSeries(peppa);
  assert.equal(r.state, 'unknown');
  assert.match(r.detail, /do NOT know whether it was added/i);
  assert.match(r.detail, /not a "no"/i);
});

test('a real refusal is FAILED, distinct from unknown and from already-have', async () => {
  const { impl } = capturing(400, {}, '[{"errorMessage":"Invalid quality profile"}]');
  const r = await sonarr(impl).addSeries(peppa);
  assert.equal(r.state, 'failed');
});

test('🔴 all four states are distinguishable — none collapses into another', async () => {
  const outcomes = await Promise.all([
    sonarr(capturing(201).impl).addSeries(peppa),
    sonarr(capturing(400, {}, '[{"errorMessage":"already been added"}]').impl).addSeries(peppa),
    sonarr(capturing(400, {}, '[{"errorMessage":"nope"}]').impl).addSeries(peppa),
    sonarr(
      (async () => {
        throw new Error('down');
      }) as FetchImpl,
    ).addSeries(peppa),
  ]);
  assert.deepEqual(
    outcomes.map((o) => o.state),
    ['started', 'already-have', 'failed', 'unknown'],
  );
});

// ── only what the service confirmed ──────────────────────────────────────────

test('a started add reports back the seasons it actually requested', async () => {
  const { impl } = capturing();
  const r = await sonarr(impl).addSeries(peppa);
  assert.equal(r.state, 'started');
  if (r.state !== 'started') throw new Error('unreachable');
  assert.deepEqual(r.confirmed, [1, 2, 3]);
  assert.match(r.detail, /season\(s\) 1, 2, 3/);
});

// ── movies ───────────────────────────────────────────────────────────────────

test('a movie add posts tmdbId to /movie and searches', async () => {
  const { impl, sent } = capturing();
  const r = await radarr(impl).addMovie({
    tmdbId: 60308,
    title: 'Moneyball',
    rootFolder: '/movies',
    qualityProfileId: 6,
  });
  assert.equal(r.state, 'started');
  assert.equal(sent[0]!.url, 'http://r.invalid/radarr/api/v3/movie');
  assert.equal(sent[0]!.body['tmdbId'], 60308);
  assert.equal((sent[0]!.body['addOptions'] as Record<string, unknown>)['searchForMovie'], true);
});

test('🔴 an add with a zero id is refused before any request', async () => {
  // A row missing its kind-specific id yields 0. Posting that would either fail
  // opaquely or add the wrong thing.
  const { impl, sent } = capturing();
  const r = await radarr(impl).addMovie({ tmdbId: 0, title: 'x', rootFolder: '/m', qualityProfileId: 6 });
  assert.equal(r.state, 'failed');
  assert.equal(sent.length, 0);
});
