import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { ArrClient, resetTransportBreaker, type FetchImpl } from '../src/media/arr.js';

/**
 * 🔴 THE TRANSPORT BREAKER IS PROCESS-GLOBAL. Without a per-test reset, a
 * sibling file's transport failure would carry over and the failure-shaped
 * tests here would observe the breaker message instead of their own stubbed
 * response.
 */
beforeEach(() => {
  resetTransportBreaker();
});

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

test('🔴 a duplicate add with complete seasons is ALREADY-HAVE — never "retry"', async () => {
  // V1's ebook path read a duplicate-add rejection as a download FAILURE and
  // told the user to retry: the one action guaranteed never to work.
  // After 2026-09-22, "already added" re-reads the library: complete seasons
  // stay already-have; incomplete ones SeasonSearch (covered below).
  const seriesRow = {
    id: 207,
    title: 'Peppa Pig',
    tvdbId: peppa.tvdbId,
    monitored: true,
    seasons: peppa.seasons.map((n) => ({
      seasonNumber: n,
      monitored: true,
      statistics: { episodeFileCount: 52, totalEpisodeCount: 52 },
    })),
  };
  const impl: FetchImpl = async (url, init) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (method === 'POST' && u.endsWith('/series')) {
      return {
        ok: false,
        status: 400,
        text: async () => '[{"errorMessage":"This series has already been added"}]',
      } as Response;
    }
    if (method === 'GET' && u.endsWith('/series')) {
      return { ok: true, status: 200, text: async () => JSON.stringify([seriesRow]) } as Response;
    }
    throw new Error(`unexpected ${method} ${u}`);
  };
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
  const completeSeries = {
    id: 207,
    title: peppa.title,
    tvdbId: peppa.tvdbId,
    monitored: true,
    seasons: peppa.seasons.map((n) => ({
      seasonNumber: n,
      monitored: true,
      statistics: { episodeFileCount: 10, totalEpisodeCount: 10 },
    })),
  };
  const alreadyHaveImpl: FetchImpl = async (url, init) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (method === 'POST' && u.endsWith('/series')) {
      return {
        ok: false,
        status: 400,
        text: async () => '[{"errorMessage":"already been added"}]',
      } as Response;
    }
    if (method === 'GET' && u.endsWith('/series')) {
      return { ok: true, status: 200, text: async () => JSON.stringify([completeSeries]) } as Response;
    }
    throw new Error(`unexpected ${method} ${u}`);
  };
  const outcomes = await Promise.all([
    sonarr(capturing(201).impl).addSeries(peppa),
    sonarr(alreadyHaveImpl).addSeries(peppa),
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

test('🔴 movie already in Radarr WITHOUT a file re-searches — not "nothing to do"', async () => {
  // Measured 2026-09-19: The Breadwinner (2026) was monitored with hasFile=false;
  // add_movie returned already-have and Jedd told Jeff nothing to do.
  const sent: Sent[] = [];
  const impl: FetchImpl = async (url, init) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    sent.push({ url: u, method, body });
    if (method === 'POST' && u.endsWith('/movie')) {
      return {
        ok: false,
        status: 400,
        text: async () => '[{"errorMessage":"This movie has already been added"}]',
      } as Response;
    }
    if (method === 'GET' && u.endsWith('/movie')) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify([{ id: 613, tmdbId: 1440050, title: 'The Breadwinner', hasFile: false }]),
      } as Response;
    }
    if (method === 'POST' && u.endsWith('/command')) {
      return { ok: true, status: 201, text: async () => JSON.stringify({ id: 1 }) } as Response;
    }
    throw new Error(`unexpected ${method} ${u}`);
  };
  const r = await radarr(impl).addMovie({
    tmdbId: 1440050,
    title: 'The Breadwinner',
    rootFolder: '/movies',
    qualityProfileId: 6,
  });
  assert.equal(r.state, 'started');
  assert.match(r.detail, /no file|searching/i);
  assert.doesNotMatch(r.detail, /nothing to do/i);
  const cmd = sent.find((s) => s.url.endsWith('/command'));
  assert.ok(cmd, 'must POST MoviesSearch');
  assert.equal(cmd!.body['name'], 'MoviesSearch');
  assert.deepEqual(cmd!.body['movieIds'], [613]);
});

test('🔴 movie already in Radarr WITH a file is already-have', async () => {
  const impl: FetchImpl = async (url, init) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (method === 'POST' && u.endsWith('/movie')) {
      return {
        ok: false,
        status: 400,
        text: async () => '[{"errorMessage":"This movie has already been added"}]',
      } as Response;
    }
    if (method === 'GET' && u.endsWith('/movie')) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify([{ id: 42, tmdbId: 60308, title: 'Moneyball', hasFile: true }]),
      } as Response;
    }
    throw new Error(`unexpected ${method} ${u}`);
  };
  const r = await radarr(impl).addMovie({
    tmdbId: 60308,
    title: 'Moneyball',
    rootFolder: '/movies',
    qualityProfileId: 6,
  });
  assert.equal(r.state, 'already-have');
  assert.match(r.detail, /file on disk/i);
});

test('🔴 addSeries queues explicit SeasonSearch per requested season after create', async () => {
  // Measured 2026-09-20 (*Shrinking*): searchForMissingEpisodes on add claimed
  // STARTED, then S1/S2 sat 0/N for hours until SeasonSearch via add_season.
  const sent: Sent[] = [];
  const impl: FetchImpl = async (url, init) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    sent.push({ url: u, method, body });
    if (method === 'POST' && u.endsWith('/series')) {
      return {
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ id: 207, title: peppa.title, tvdbId: peppa.tvdbId }),
      } as Response;
    }
    if (method === 'POST' && u.endsWith('/command')) {
      return { ok: true, status: 201, text: async () => JSON.stringify({ id: 1 }) } as Response;
    }
    if (method === 'GET' && u.includes('/episode')) {
      return { ok: true, status: 200, text: async () => '[]' } as Response;
    }
    throw new Error(`unexpected ${method} ${u}`);
  };
  const r = await sonarr(impl).addSeries(peppa);
  assert.equal(r.state, 'started');
  if (r.state !== 'started') throw new Error('unreachable');
  assert.deepEqual(r.confirmed, [1, 2, 3]);
  const searches = sent.filter((s) => s.url.endsWith('/command') && s.body['name'] === 'SeasonSearch');
  assert.equal(searches.length, 3);
  assert.deepEqual(
    searches.map((s) => s.body['seasonNumber']).sort((a, b) => Number(a) - Number(b)),
    [1, 2, 3],
  );
  assert.ok(searches.every((s) => s.body['seriesId'] === 207));
});

test('🔴 series already in Sonarr WITHOUT complete seasons re-monitors and SeasonSearches', async () => {
  const sent: Sent[] = [];
  const seriesRow = {
    id: 207,
    title: peppa.title,
    tvdbId: peppa.tvdbId,
    monitored: true,
    seasons: peppa.seasons.map((n) => ({
      seasonNumber: n,
      monitored: false,
      statistics: { episodeFileCount: 0, totalEpisodeCount: 52 },
    })),
  };
  const impl: FetchImpl = async (url, init) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    sent.push({ url: u, method, body });
    if (method === 'POST' && u.endsWith('/series')) {
      return {
        ok: false,
        status: 400,
        text: async () => '[{"errorMessage":"This series has already been added"}]',
      } as Response;
    }
    if (method === 'GET' && u.endsWith('/series')) {
      return { ok: true, status: 200, text: async () => JSON.stringify([seriesRow]) } as Response;
    }
    if (method === 'GET' && /\/series\/207$/.test(u)) {
      return { ok: true, status: 200, text: async () => JSON.stringify(seriesRow) } as Response;
    }
    if (method === 'PUT' && /\/series\/207$/.test(u)) {
      const seasons = (body['seasons'] as { seasonNumber: number; monitored: boolean }[]) ?? [];
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            ...seriesRow,
            monitored: true,
            seasons: seasons.map((s) => ({
              seasonNumber: s.seasonNumber,
              monitored: s.monitored,
              statistics: { episodeFileCount: 0, totalEpisodeCount: 52 },
            })),
          }),
      } as Response;
    }
    if (method === 'POST' && u.endsWith('/command')) {
      return { ok: true, status: 201, text: async () => JSON.stringify({ id: 1 }) } as Response;
    }
    if (method === 'GET' && u.includes('/episode')) {
      return { ok: true, status: 200, text: async () => '[]' } as Response;
    }
    throw new Error(`unexpected ${method} ${u}`);
  };
  const r = await sonarr(impl).addSeries(peppa);
  assert.equal(r.state, 'started');
  assert.match(r.detail, /already in Sonarr|SeasonSearch/i);
  assert.doesNotMatch(r.detail, /nothing to do/i);
  const searches = sent.filter((s) => s.url.endsWith('/command') && s.body['name'] === 'SeasonSearch');
  assert.equal(searches.length, 3);
});

test('series already complete on disk is already-have', async () => {
  const seriesRow = {
    id: 207,
    title: peppa.title,
    tvdbId: peppa.tvdbId,
    monitored: true,
    seasons: peppa.seasons.map((n) => ({
      seasonNumber: n,
      monitored: true,
      statistics: { episodeFileCount: 52, totalEpisodeCount: 52 },
    })),
  };
  const impl: FetchImpl = async (url, init) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (method === 'POST' && u.endsWith('/series')) {
      return {
        ok: false,
        status: 400,
        text: async () => '[{"errorMessage":"This series has already been added"}]',
      } as Response;
    }
    if (method === 'GET' && u.endsWith('/series')) {
      return { ok: true, status: 200, text: async () => JSON.stringify([seriesRow]) } as Response;
    }
    throw new Error(`unexpected ${method} ${u}`);
  };
  const r = await sonarr(impl).addSeries(peppa);
  assert.equal(r.state, 'already-have');
  assert.match(r.detail, /on disk/i);
});
