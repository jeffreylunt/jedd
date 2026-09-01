import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { resetTransportBreaker, type FetchImpl } from '../src/media/arr.js';
import { bucket, MAX_SEGMENTS, parseShowSeasons, summariseShow } from '../src/media/seasons.js';
import { makeLibrarySearch } from '../src/tools/library.js';
import type { ToolContext } from '../src/tools/types.js';
import { testConfig } from './helpers.js';

/**
 * 🔴 THE TRANSPORT BREAKER IS PROCESS-GLOBAL. `library_search` reaches Sonarr
 * with the URL `testConfig()` carries, and a sibling file's transport failure
 * against the same URL would otherwise be observed here as the cool-down
 * message rather than the stubbed response.
 */
beforeEach(() => {
  resetTransportBreaker();
});

/** A Sonarr `/series` season row, in the shape the live instance actually returns. */
const season = (n: number, files: number, total: number, monitored = true) => ({
  seasonNumber: n,
  monitored,
  statistics: {
    episodeFileCount: files,
    // 🔴 Present and DIFFERENT from totalEpisodeCount, because the live rows are.
    // A fixture where the two agree cannot catch code that reads the wrong one.
    episodeCount: monitored || files > 0 ? total : 0,
    totalEpisodeCount: total,
    percentOfEpisodes: total ? (files / total) * 100 : 0,
  },
});

const show = (title: string, seasons: unknown[], year = 2008) => ({ title, year, seasons });

// ── bucketing ────────────────────────────────────────────────────────────────

test('🔴 a season with ZERO episodes listed is `empty`, never `complete`', () => {
  // 0 >= 0 is true. Ordering the total check first is the entire guard, and the
  // live library has 44 such seasons on one show.
  assert.equal(bucket({ season: 3, have: 0, total: 0, monitored: false }), 'empty');
});

test('CONTROL: the same shape with episodes listed and held IS complete', () => {
  assert.equal(bucket({ season: 3, have: 10, total: 10, monitored: true }), 'complete');
  assert.equal(bucket({ season: 3, have: 4, total: 10, monitored: true }), 'partial');
  assert.equal(bucket({ season: 3, have: 0, total: 10, monitored: true }), 'missing');
});

// ── parsing ──────────────────────────────────────────────────────────────────

test('🔴 the denominator is totalEpisodeCount, NOT the monitoring-dependent episodeCount', () => {
  // The live signature: unmonitored season, 130 episodes listed, episodeCount 0.
  // Reading episodeCount would make this "0/0 complete" — a claim that Jeff owns
  // a season he does not.
  const parsed = parseShowSeasons(
    show('Sesame Street', [{ seasonNumber: 1, monitored: false, statistics: { episodeFileCount: 0, episodeCount: 0, totalEpisodeCount: 130 } }]),
  );
  assert.equal(parsed?.seasons[0]?.total, 130);
  assert.equal(bucket(parsed!.seasons[0]!), 'missing');
});

test('a row with no seasons array, or a non-object, parses to nothing rather than throwing', () => {
  assert.equal(parseShowSeasons(null), null);
  assert.equal(parseShowSeasons({ year: 2008 }), null);
  assert.deepEqual(parseShowSeasons({ title: 'X' })?.seasons, []);
});

// ── the compression that the live data forced ────────────────────────────────

test('🔴 VOLUME: 56 seasons collapse to three segments, not 56 lines', () => {
  // The real Sesame Street row: everything missing except S55, which is partial.
  const seasons = [season(0, 0, 258, false)];
  for (let n = 1; n <= 54; n++) seasons.push(season(n, 0, 130, false));
  seasons.push(season(55, 28, 35, false));
  seasons.push(season(56, 0, 13, false));

  const line = summariseShow(parseShowSeasons(show('Sesame Street', seasons, 1969))!);

  assert.equal(line.split('\n').length, 1, 'one show is one line');
  assert.ok(line.length < 300, `stayed short (${line.length} chars): ${line}`);
  assert.match(line, /S1-S54 missing/);
  assert.match(line, /S55 28\/35/);
  assert.match(line, /S56 missing/);
  // The naive renderer's signature: a season number for every season.
  assert.equal(line.match(/S\d+/g)?.length, 4);
});

test('🔴 UNMONITORED GAPS ARE CALLED OUT — a gap nobody is fetching never fills itself', () => {
  const line = summariseShow(
    parseShowSeasons(show('Sesame Street', [season(1, 0, 130, false), season(2, 0, 130, false)], 1969))!,
  );
  assert.match(line, /None of the gaps is monitored/i);
  assert.match(line, /NOTHING is being fetched/i);
});

test('CONTROL: when every gap IS monitored the answer says Sonarr is still looking', () => {
  const line = summariseShow(parseShowSeasons(show('Gabby', [season(1, 10, 10), season(2, 2, 7)]))!);
  assert.match(line, /still looking/i);
  assert.doesNotMatch(line, /None of the gaps/i);
});

test('a MIXED show names exactly the unmonitored gaps, as ranges', () => {
  const line = summariseShow(
    parseShowSeasons(
      show('Mixed', [season(1, 0, 10, false), season(2, 0, 10, false), season(3, 0, 10, true), season(4, 10, 10)]),
    )!,
  );
  assert.match(line, /Not monitored[^:]*: S1-S2\./);
});

test('the real partial shape reads as counts, and the totals are the sum of the seasons', () => {
  // Gabby's Dollhouse, live: 1-7 complete, 8/9/10 partial, 11-13 complete.
  const seasons = [
    season(0, 0, 1, false),
    season(1, 10, 10), season(2, 8, 8), season(3, 7, 7), season(4, 8, 8),
    season(5, 6, 6), season(6, 6, 6), season(7, 6, 6),
    season(8, 2, 7), season(9, 3, 6), season(10, 3, 6),
    season(11, 6, 6), season(12, 5, 5), season(13, 5, 5),
  ];
  const line = summariseShow(parseShowSeasons(show("Gabby's Dollhouse", seasons, 2021))!);
  assert.match(line, /13 seasons/);
  assert.match(line, /S1-S7 complete, S8 2\/7, S9 3\/6, S10 3\/6, S11-S13 complete/);
  assert.match(line, /75\/86 episodes/); // sums exclude season 0
});

test('specials appear only when we actually hold some, and never in the season count', () => {
  const withNone = summariseShow(parseShowSeasons(show('A', [season(0, 0, 20, false), season(1, 5, 5)]))!);
  assert.doesNotMatch(withNone, /special/i);
  assert.match(withNone, /1 season,/);
  const withSome = summariseShow(parseShowSeasons(show('A', [season(0, 3, 20, false), season(1, 5, 5)]))!);
  assert.match(withSome, /Plus 3\/20 specials/);
  assert.match(withSome, /1 season,/);
});

test('🔴 a show that is partial the whole way down is still bounded', () => {
  const seasons = [];
  for (let n = 1; n <= 30; n++) seasons.push(season(n, 1, 10));
  const line = summariseShow(parseShowSeasons(show('Endless', seasons))!);
  assert.equal(line.match(/S\d+/g)!.length, MAX_SEGMENTS + 2, 'capped, plus the tail range endpoints');
  assert.match(line, /mixed \(20\/200\)/);
});

test('a show Sonarr lists with no real seasons says so rather than dividing by nothing', () => {
  const line = summariseShow(parseShowSeasons(show('New', [season(0, 0, 2, false)]))!);
  assert.match(line, /no seasons/i);
});

// ── through the tool ─────────────────────────────────────────────────────────

const ctx = (): ToolContext => ({ role: 'guest', senderHandle: '+18015550123', config: testConfig() });

const json = (body: unknown, status = 200): Response =>
  ({ ok: status < 400, status, text: async () => JSON.stringify(body) }) as Response;

const sonarrSeries = (rows: unknown[]): FetchImpl => async () => json(rows);

const jellyfinItems = (items: unknown[]) => async () => ({ ok: true, status: 200, body: { Items: items } });

/** The live shape: an owned row is a file on disk. */
const owned = (Name: string, ProductionYear: number) => ({ Name, ProductionYear, Type: 'Series', LocationType: 'FileSystem' });
/** The live shape: an IPTV on-demand entry that Jellyfin also types as `Series`. */
const channel = (Name: string, ProductionYear: number) => ({
  Name, ProductionYear, Type: 'Series', SourceType: 'Channel', LocationType: 'Remote',
});

const fringe = show('Fringe', [
  season(1, 20, 20), season(2, 22, 22), season(3, 22, 22), season(4, 6, 22), season(5, 0, 13),
]);

test('asking about a show returns the SEASON breakdown, not just "it is in the library"', async () => {
  const r = await makeLibrarySearch({
    jellyfin: jellyfinItems([owned('Fringe', 2008)]),
    fetchImpl: sonarrSeries([fringe]),
  }).run({ query: 'fringe' }, ctx());
  assert.equal(r.ok, true);
  assert.match(r.content, /IN LIBRARY/);
  assert.match(r.content, /S1-S3 complete, S4 6\/22, S5 missing/);
});

test('🔴 SONARR UNREACHABLE IS UNKNOWN — never rendered as "no seasons"', async () => {
  const r = await makeLibrarySearch({
    jellyfin: jellyfinItems([owned('Fringe', 2008)]),
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  }).run({ query: 'fringe' }, ctx());
  assert.equal(r.ok, true);
  assert.match(r.content, /IN LIBRARY/);
  assert.match(r.content, /UNKNOWN/);
  assert.doesNotMatch(r.content, /missing/);
});

test('🔴 NOT IN JELLYFIN but tracked by Sonarr is NOT a bare "we do not have it"', async () => {
  const r = await makeLibrarySearch({
    jellyfin: jellyfinItems([]),
    fetchImpl: sonarrSeries([show('Mister Rogers', [season(1, 0, 130), season(2, 0, 65)], 1968)]),
  }).run({ query: 'mister rogers' }, ctx());
  assert.equal(r.ok, true);
  assert.match(r.content, /Sonarr IS tracking it/);
  assert.match(r.content, /S1-S2 missing/);
});

test('CONTROL: absent from both says so, and says how much was searched', async () => {
  const r = await makeLibrarySearch({
    jellyfin: jellyfinItems([]),
    fetchImpl: sonarrSeries([fringe]),
  }).run({ query: 'the wire' }, ctx());
  assert.match(r.content, /NOT IN THE LIBRARY/);
  assert.match(r.content, /not tracking it either \(searched 1 shows\)/);
});

test('a Jellyfin failure is a failure even when Sonarr answered', async () => {
  const r = await makeLibrarySearch({
    jellyfin: async () => ({ ok: false, status: 500, error: 'HTTP 500' }),
    fetchImpl: sonarrSeries([fringe]),
  }).run({ query: 'fringe' }, ctx());
  assert.equal(r.ok, false);
  assert.match(r.content, /UNKNOWN/);
  assert.match(r.content, /S1-S3 complete/);
});

test('an unrelated Sonarr library contributes nothing to a film query', async () => {
  const r = await makeLibrarySearch({
    jellyfin: jellyfinItems([{ Name: 'Whiplash', ProductionYear: 2014, Type: 'Movie', LocationType: 'FileSystem' }]),
    fetchImpl: sonarrSeries([fringe]),
  }).run({ query: 'whiplash' }, ctx());
  assert.match(r.content, /IN LIBRARY/);
  assert.doesNotMatch(r.content, /Seasons held/);
  assert.doesNotMatch(r.content, /Fringe/);
});

// ── 🔴 the live finding: a remote channel row is not something we hold ───────

test('🔴 LIVE FINDING: IPTV channel rows do not count as IN LIBRARY', async () => {
  // Exactly what the real Jellyfin returned for "sesame street": one owned
  // series and two identical remote channel entries, all typed `Series`.
  const r = await makeLibrarySearch({
    jellyfin: jellyfinItems([
      owned('Sesame Street', 1969),
      channel('NF - Sesame Street (2025) (US)', 2025),
      channel('NF - Sesame Street (2025) (US)', 2025),
    ]),
    fetchImpl: sonarrSeries([show('Sesame Street', [season(1, 5, 5)], 1969)]),
  }).run({ query: 'sesame street' }, ctx());
  assert.match(r.content, /IN LIBRARY — 1 match\(es\)/, 'the count is of things we HOLD');
  assert.match(r.content, /NOT something we hold/);
  // Deduped: the two identical channel rows are one name.
  assert.equal(r.content.match(/NF - Sesame Street/g)?.length, 1);
});

test('🔴 a title present ONLY as a channel row is NOT in the library', async () => {
  const r = await makeLibrarySearch({
    jellyfin: jellyfinItems([channel('NF - Some Show (US)', 2025)]),
    fetchImpl: sonarrSeries([]),
  }).run({ query: 'some show' }, ctx());
  assert.match(r.content, /NOT IN THE LIBRARY/);
  assert.match(r.content, /NOT something we hold/);
});
