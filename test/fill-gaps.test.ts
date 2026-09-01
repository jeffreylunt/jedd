import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { ChoiceStore } from '../src/choices.js';
import { resetTransportBreaker, type FetchImpl } from '../src/media/arr.js';
import { makeFindGaps, makeGrabRelease, makeSearchEpisode } from '../src/tools/fill-gaps.js';
import { buildTools } from '../src/tools/index.js';
import type { ToolContext } from '../src/tools/types.js';
import { testConfig } from './helpers.js';

/**
 * 🔴 THE TRANSPORT BREAKER IS PROCESS-GLOBAL. Several tests in this file
 * exercise Sonarr failures (release search, queue, episodes), and the tools
 * here reach the same `http://sonarr.invalid:8989/...` URL the whole test
 * process uses. Without a reset the second test sees the breaker message from
 * the first, and the assertion that pins "Sonarr answered with X" fails for a
 * reason that has nothing to do with the test.
 */
beforeEach(() => {
  resetTransportBreaker();
});

const tempFile = () => join(mkdtempSync(join(tmpdir(), 'jedd-gaps-')), 'choices.jsonl');

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  role: 'guest',
  senderHandle: '+18015550123',
  config: testConfig({ readOnly: false }),
  choices: new ChoiceStore(tempFile()),
  ...over,
});

const json = async (body: unknown, status = 200): Promise<Response> =>
  ({ ok: status < 400, status, text: async () => JSON.stringify(body) }) as Response;

const SERIES = {
  id: 80,
  tvdbId: 79169,
  title: 'Seinfeld',
  year: 1989,
  monitored: true,
  seasons: [{ seasonNumber: 3, monitored: true, statistics: { episodeFileCount: 1, totalEpisodeCount: 23 } }],
};

const ep = (o: Record<string, unknown> = {}) => ({
  id: 13399,
  seasonNumber: 3,
  episodeNumber: 1,
  title: 'The Note',
  monitored: true,
  hasFile: false,
  airDateUtc: '1991-09-19T01:00:00Z',
  ...o,
});

const rel = (o: Record<string, unknown> = {}) => ({
  guid: 'magnet:?xt=urn:btih:3F1D6AC7',
  indexerId: 4,
  title: 'Seinfeld S03E01 The Note 720p HDTV',
  indexer: 'The Pirate Bay',
  quality: { quality: { name: 'HDTV-720p', resolution: 720 } },
  seeders: 13,
  size: 150 * 1024 ** 2,
  approved: true,
  rejections: [],
  customFormatScore: 0,
  languages: [{ name: 'English' }],
  ...o,
});

/** Routes the four Sonarr endpoints these tools use. */
function sonarr(
  o: {
    series?: unknown[];
    episodes?: unknown[];
    releases?: unknown[] | (() => Promise<Response>);
    queue?: unknown;
    onPost?: (body: Record<string, unknown>) => Promise<Response>;
  } = {},
): { fetchImpl: FetchImpl; posts: Record<string, unknown>[]; urls: string[] } {
  const posts: Record<string, unknown>[] = [];
  const urls: string[] = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    const u = String(url);
    urls.push(u);
    if ((init?.method ?? 'GET') !== 'GET') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      posts.push(body);
      return o.onPost ? o.onPost(body) : json(body, 201);
    }
    if (u.includes('/episode?')) return json(o.episodes ?? [ep()]);
    if (u.includes('/release?')) {
      if (typeof o.releases === 'function') return o.releases();
      return json(o.releases ?? [rel()]);
    }
    if (u.includes('/queue')) return json(o.queue ?? { records: [], totalRecords: 0 });
    if (u.endsWith('/series')) return json(o.series ?? [SERIES]);
    return json([]);
  };
  return { fetchImpl, posts, urls };
}

// ── find_gaps ───────────────────────────────────────────────────────────────

test('🔴 find_gaps lists the monitored-and-missing episodes of ONE series', async () => {
  const { fetchImpl, urls } = sonarr({
    episodes: [ep(), ep({ id: 2, episodeNumber: 2, title: 'The Truth' }), ep({ id: 3, episodeNumber: 3, hasFile: true })],
  });
  const r = await makeFindGaps(fetchImpl).run({ title: 'Seinfeld' }, ctx());
  assert.equal(r.ok, true);
  assert.match(r.content, /2 MISSING from "Seinfeld"/);
  assert.match(r.content, /S03E01 The Note \(1991\)/);
  assert.doesNotMatch(r.content, /S03E03/, 'an episode on disk is not a gap');
  assert.ok(urls.some((u) => u.includes('/episode?seriesId=80')));
});

test('🔴 it uses /episode?seriesId= and NEVER /wanted/missing?seriesId=', async () => {
  /**
   * Measured live: `wanted/missing?seriesId=80` SILENTLY IGNORES the filter and
   * returns 1651 records carrying seriesId 191 and 73. Well-formed, plausible,
   * and about the whole library — so a per-series answer drawn from it is wrong
   * in a way nothing about the response reveals.
   */
  const { fetchImpl, urls } = sonarr();
  await makeFindGaps(fetchImpl).run({ title: 'Seinfeld' }, ctx());
  assert.equal(urls.some((u) => u.includes('wanted/missing')), false);
});

test('an UNMONITORED missing episode is not a gap, but is reported separately', async () => {
  // "Nothing is looking for it" and "we have it" are different states, and only
  // one of them means the person needs to do nothing.
  const { fetchImpl } = sonarr({
    episodes: [ep({ hasFile: true }), ep({ id: 2, episodeNumber: 2, monitored: false, hasFile: false })],
  });
  const r = await makeFindGaps(fetchImpl).run({ title: 'Seinfeld' }, ctx());
  assert.match(r.content, /NO GAPS/);
  assert.match(r.content, /1 more are missing but NOT monitored/);
  assert.match(r.content, /add_season/);
});

test('the gap list is capped and says so', async () => {
  const many = Array.from({ length: 22 }, (_, i) => ep({ id: i + 1, episodeNumber: i + 1, title: `Ep ${i + 1}` }));
  const r = await makeFindGaps(fetchImpl_of({ episodes: many })).run({ title: 'Seinfeld' }, ctx());
  assert.match(r.content, /22 MISSING/);
  assert.match(r.content, /showing 15 of 22/);
});

function fetchImpl_of(o: Parameters<typeof sonarr>[0]): FetchImpl {
  return sonarr(o).fetchImpl;
}

test('a season filter scopes the answer', async () => {
  const { fetchImpl } = sonarr({
    episodes: [ep(), ep({ id: 2, seasonNumber: 4, episodeNumber: 1, title: 'S4 ep' })],
  });
  const r = await makeFindGaps(fetchImpl).run({ title: 'Seinfeld', season: 4 }, ctx());
  assert.match(r.content, /S04E01/);
  assert.doesNotMatch(r.content, /S03E01/);
});

test('🔴 an unreachable Sonarr is UNKNOWN, not "nothing is missing"', async () => {
  const r = await makeFindGaps(() => {
    throw new Error('ECONNREFUSED');
  }).run({ title: 'Seinfeld' }, ctx());
  assert.equal(r.ok, false);
  assert.match(r.content, /UNKNOWN/);
});

test('a show not in the library says so and points at add_series', async () => {
  const { fetchImpl } = sonarr({ series: [] });
  const r = await makeFindGaps(fetchImpl).run({ title: 'Firefly' }, ctx());
  assert.match(r.content, /NOT IN THE LIBRARY/);
  assert.match(r.content, /add_series/);
});

// ── search_episode ──────────────────────────────────────────────────────────

test('🔴 THE POINT: a release the PROFILE REFUSES is still TAKEN, with the reason', async () => {
  /**
   * Jeff asked to change the quality profile to get more options. This is that,
   * without the change: the profile refuses the 1080p and we take it anyway,
   * carrying Sonarr's own refusal so nobody reads it as an error.
   *
   * ⚠️ The approved 720p is on a THIN swarm here, which is what lets the refused
   * one win. With both swarms healthy the profile's opinion decides again — see
   * the test below. That is the rule, not an accident of this fixture.
   */
  const { fetchImpl } = sonarr({
    releases: [
      rel({ seeders: 2 }),
      rel({
        guid: 'magnet:?xt=urn:btih:AAA',
        title: 'Seinfeld S03E01 1080p AMZN WEB-DL',
        quality: { quality: { name: 'WEBDL-1080p', resolution: 1080 } },
        approved: false,
        rejections: ['WEBDL-1080p is not wanted in profile'],
        seeders: 35,
      }),
    ],
  });
  const r = await makeSearchEpisode(fetchImpl).run({ title: 'Seinfeld', season: 3, episode: 1 }, ctx());
  assert.equal(r.ok, true);
  assert.match(r.content, /WEBDL-1080p/);
  assert.match(r.content, /not wanted in profile/);
  assert.match(r.content, /nothing about the settings changes/);
});

test('🔴 it NEVER mutates a quality profile — no write of any kind is made', async () => {
  // A profile change persists and would grab CAM rips and foreign-language
  // releases unattended, forever. The whole design is to not need one.
  const { fetchImpl, posts, urls } = sonarr();
  await makeSearchEpisode(fetchImpl).run({ title: 'Seinfeld', season: 3, episode: 1 }, ctx());
  assert.deepEqual(posts, [], 'search must not write');
  assert.equal(urls.some((u) => u.includes('qualityprofile')), false);
});

test('🔴 CAM / theater rips are excluded and COUNTED, never silently dropped', async () => {
  // The documented incident: `...2026.1080p.HDTS` was auto-grabbed on an
  // upcoming title with nothing legitimate available.
  const { fetchImpl } = sonarr({
    releases: [rel(), rel({ guid: 'g2', title: 'Seinfeld S03E01 1080p HDTS', approved: false, rejections: [] })],
  });
  const r = await makeSearchEpisode(fetchImpl).run({ title: 'Seinfeld', season: 3, episode: 1 }, ctx());
  assert.doesNotMatch(r.content, /HDTS/);
  assert.match(r.content, /1 CAM\/theater rip/);
});

test('🔴 non-English releases are excluded — that rejection is the system WORKING', async () => {
  // The `Not English` custom format scores -1000 and is the only thing keeping
  // Malayalam and Japanese releases out. Bypassing it is a regression.
  const { fetchImpl } = sonarr({
    releases: [
      rel(),
      rel({ guid: 'g2', title: 'Seinfeld S03E01 MULTI', approved: false, rejections: ['Not English'], customFormatScore: -1000 }),
    ],
  });
  const r = await makeSearchEpisode(fetchImpl).run({ title: 'Seinfeld', season: 3, episode: 1 }, ctx());
  assert.doesNotMatch(r.content, /MULTI/);
  assert.match(r.content, /1 non-English/);
});

test('zero-seeder releases are excluded — they can never complete', async () => {
  const { fetchImpl } = sonarr({ releases: [rel(), rel({ guid: 'g2', title: 'Dead one', seeders: 0 })] });
  const r = await makeSearchEpisode(fetchImpl).run({ title: 'Seinfeld', season: 3, episode: 1 }, ctx());
  assert.doesNotMatch(r.content, /Dead one/);
  assert.match(r.content, /1 with no seeders/);
});

test('🔴 a filter that removed EVERYTHING is not "none found"', async () => {
  const { fetchImpl } = sonarr({
    releases: [rel({ seeders: 0 }), rel({ guid: 'g2', title: 'S03E01 HDCAM', seeders: 3 })],
  });
  const r = await makeSearchEpisode(fetchImpl).run({ title: 'Seinfeld', season: 3, episode: 1 }, ctx());
  assert.equal(r.ok, true);
  assert.match(r.content, /FILTERED OUT/);
  assert.match(r.content, /2 release\(s\) exist/);
  assert.match(r.content, /do not say none were found/);
});

test('CONTROL: a genuinely empty indexer answer IS "none" — searched and found nothing', async () => {
  const { fetchImpl } = sonarr({ releases: [] });
  const r = await makeSearchEpisode(fetchImpl).run({ title: 'Seinfeld', season: 3, episode: 1 }, ctx());
  assert.equal(r.ok, true);
  assert.match(r.content, /^NONE/);
  assert.doesNotMatch(r.content, /UNKNOWN/);
});

test('🔴 a failed release search is UNKNOWN — a failure to LOOK, not an absence', async () => {
  const { fetchImpl } = sonarr({ releases: () => json({ error: 'indexer down' }, 500) });
  const r = await makeSearchEpisode(fetchImpl).run({ title: 'Seinfeld', season: 3, episode: 1 }, ctx());
  assert.equal(r.ok, false);
  assert.match(r.content, /UNKNOWN/);
  assert.match(r.content, /failure to LOOK/);
});

test('an episode already on disk is not searched for at all', async () => {
  const { fetchImpl, urls } = sonarr({ episodes: [ep({ hasFile: true })] });
  const r = await makeSearchEpisode(fetchImpl).run({ title: 'Seinfeld', season: 3, episode: 1 }, ctx());
  assert.match(r.content, /ALREADY HAVE IT/);
  assert.equal(urls.some((u) => u.includes('/release?')), false);
});

test('an episode that does not exist says so rather than searching', async () => {
  const { fetchImpl } = sonarr();
  const r = await makeSearchEpisode(fetchImpl).run({ title: 'Seinfeld', season: 3, episode: 99 }, ctx());
  assert.equal(r.ok, false);
  assert.match(r.content, /has no S03E99/);
});

test('approved beats profile-refused WHEN BOTH SWARMS ARE HEALTHY', async () => {
  // 99 and 13 seeders are the same band, so the quality keys get to decide. The
  // band leads; it does not throw the profile away. `auto-pick-release.test.ts`
  // holds the case where they disagree.
  const { fetchImpl } = sonarr({
    releases: [
      rel({ guid: 'g2', title: 'Refused 1080p', approved: false, rejections: ['not wanted in profile'], seeders: 99, quality: { quality: { name: 'WEBDL-1080p', resolution: 1080 } } }),
      rel({ title: 'Approved 720p' }),
    ],
  });
  const r = await makeSearchEpisode(fetchImpl).run({ title: 'Seinfeld', season: 3, episode: 1 }, ctx());
  assert.match(r.content, /Approved 720p/);
  assert.doesNotMatch(r.content, /Refused 1080p/, 'the runner-up is not offered as a choice any more');
});

// ── grab_release ────────────────────────────────────────────────────────────

test('🔴 grab_release POSTs the guid and indexerId of the pick, and nothing else', async () => {
  const path = tempFile();
  const { fetchImpl, posts } = sonarr({ queue: { records: [], totalRecords: 0 } });
  await makeSearchEpisode(fetchImpl).run(
    { title: 'Seinfeld', season: 3, episode: 1 },
    ctx({ choices: new ChoiceStore(path) }),
  );
  const out = await makeGrabRelease(fetchImpl).run({ choice: 1 }, ctx({ choices: new ChoiceStore(path) }));
  assert.deepEqual(posts, [{ guid: 'magnet:?xt=urn:btih:3F1D6AC7', indexerId: 4 }]);
  assert.equal(out.ok, true);
});

test('🔴 SONARR\'S 201 IS NOT A DOWNLOAD — the queue is re-read before claiming one', async () => {
  // The same rule as monitorSeasons' PUT echo: a response that mirrors the
  // request back is an acknowledgement, not evidence of an effect.
  const path = tempFile();
  const { fetchImpl } = sonarr({ queue: { records: [], totalRecords: 0 } });
  await makeSearchEpisode(fetchImpl).run({ title: 'Seinfeld', season: 3, episode: 1 }, ctx({ choices: new ChoiceStore(path) }));
  const out = await makeGrabRelease(fetchImpl).run({ choice: 1 }, ctx({ choices: new ChoiceStore(path) }));
  assert.match(out.content, /^ACCEPTED/);
  assert.match(out.content, /not in the download queue yet/);
  assert.match(out.content, /Do not promise it has started/);
});

test('CONTROL: when it IS in the queue, it says GRABBED', async () => {
  const path = tempFile();
  const { fetchImpl } = sonarr({
    queue: {
      totalRecords: 1,
      records: [
        {
          downloadId: 'abc',
          title: 'Seinfeld S03E01 The Note 720p HDTV',
          series: { title: 'Seinfeld' },
          size: 100,
          sizeleft: 50,
          status: 'downloading',
          trackedDownloadStatus: 'ok',
          trackedDownloadState: 'downloading',
          added: new Date().toISOString(),
          protocol: 'torrent',
        },
      ],
    },
  });
  await makeSearchEpisode(fetchImpl).run({ title: 'Seinfeld', season: 3, episode: 1 }, ctx({ choices: new ChoiceStore(path) }));
  const out = await makeGrabRelease(fetchImpl).run({ choice: 1 }, ctx({ choices: new ChoiceStore(path) }));
  assert.match(out.content, /^GRABBED/);
  assert.match(out.content, /in the download queue now/);
});

test('🔴 an unreachable Sonarr on the grab is UNKNOWN — it may or may not have landed', async () => {
  const path = tempFile();
  const { fetchImpl } = sonarr();
  await makeSearchEpisode(fetchImpl).run({ title: 'Seinfeld', season: 3, episode: 1 }, ctx({ choices: new ChoiceStore(path) }));
  const dead: FetchImpl = async (u, i) => {
    if ((i?.method ?? 'GET') !== 'GET') throw new Error('ECONNRESET');
    return fetchImpl(u, i);
  };
  const out = await makeGrabRelease(dead).run({ choice: 1 }, ctx({ choices: new ChoiceStore(path) }));
  assert.equal(out.ok, false);
  assert.match(out.content, /UNKNOWN/);
  assert.match(out.content, /do NOT know whether it started/);
});

test('a 5xx on the grab is UNKNOWN, a 4xx is FAILED', async () => {
  const path = tempFile();
  const five = sonarr({ onPost: () => json({}, 502) });
  await makeSearchEpisode(five.fetchImpl).run({ title: 'Seinfeld', season: 3, episode: 1 }, ctx({ choices: new ChoiceStore(path) }));
  const a = await makeGrabRelease(five.fetchImpl).run({ choice: 1 }, ctx({ choices: new ChoiceStore(path) }));
  assert.match(a.content, /UNKNOWN/);

  const path2 = tempFile();
  const four = sonarr({ onPost: () => json({ message: 'bad' }, 400) });
  await makeSearchEpisode(four.fetchImpl).run({ title: 'Seinfeld', season: 3, episode: 1 }, ctx({ choices: new ChoiceStore(path2) }));
  const b = await makeGrabRelease(four.fetchImpl).run({ choice: 1 }, ctx({ choices: new ChoiceStore(path2) }));
  assert.match(b.content, /FAILED/);
  assert.match(b.content, /Nothing was grabbed/);
});

test('🔴 a pick of the WRONG KIND is refused rather than POSTed malformed', async () => {
  // An audiobook option carries an infoHash and no guid. Sharing a choice kind
  // between the two would let one be handed to the other — so the kind is
  // checked at resolve time, ahead of the payload shape.
  const path = tempFile();
  const store = new ChoiceStore(path);
  store.present({
    senderHandle: '+18015550123',
    subject: 'an audiobook',
    kind: 'audiobook-release',
    options: [{ n: 1, label: 'Some audiobook', value: { infoHash: 'a'.repeat(40), title: 'Some audiobook' } }],
  });
  const { fetchImpl, posts } = sonarr();
  const out = await makeGrabRelease(fetchImpl).run({ choice: 1 }, ctx({ choices: new ChoiceStore(path) }));
  assert.equal(out.ok, false);
  assert.match(out.content, /not a "sonarr-release" one/);
  assert.deepEqual(posts, [], 'and nothing was POSTed');
});

test('🔴 STALE: a search that fails EARLY leaves nothing behind to be grabbed', async () => {
  /**
   * The sequence that made this necessary: search S03E01 (stored) → search
   * S03E02, Sonarr 500 → UNKNOWN → `grab_release` with no arguments. Before the
   * clear, that grabbed **E01** and reported ACCEPTED, naming the wrong episode.
   * The payload guard cannot see it: the stale option is a real `sonarr-release`
   * with a valid guid and indexerId.
   */
  const path = tempFile();
  const first = sonarr({ releases: [rel({ guid: 'guid-E01', title: 'Seinfeld S03E01 720p' })] });
  await makeSearchEpisode(first.fetchImpl).run(
    { title: 'Seinfeld', season: 3, episode: 1 },
    ctx({ choices: new ChoiceStore(path) }),
  );
  assert.equal(new ChoiceStore(path).resolve('+18015550123', 1).ok, true, 'the first search really stored one');

  const broken = sonarr({
    episodes: [ep({ id: 2, episodeNumber: 2 })],
    releases: async () => json({ message: 'boom' }, 500),
  });
  const failed = await makeSearchEpisode(broken.fetchImpl).run(
    { title: 'Seinfeld', season: 3, episode: 2 },
    ctx({ choices: new ChoiceStore(path) }),
  );
  assert.equal(failed.ok, false);
  assert.match(failed.content, /UNKNOWN/);

  const after = sonarr();
  const grab = await makeGrabRelease(after.fetchImpl).run({}, ctx({ choices: new ChoiceStore(path) }));
  assert.equal(grab.ok, false, `nothing may be grabbed from the dead list: ${grab.content}`);
  assert.deepEqual(after.posts, [], 'and nothing was POSTed');
});

test('🔴 with writes disabled it refuses and makes no request', async () => {
  let called = false;
  const out = await makeGrabRelease(async () => {
    called = true;
    return json({});
  }).run({ choice: 1 }, ctx({ config: testConfig({ readOnly: true }) }));
  assert.equal(out.ok, false);
  assert.match(out.content, /Writes are disabled/);
  assert.equal(called, false);
});

// ── registration ────────────────────────────────────────────────────────────

test('the reads are guest reads; the grab is a guest WRITE behind the kill switch', async () => {
  const ro = buildTools(testConfig({ readOnly: true })).map((t) => t.name);
  const rw = buildTools(testConfig({ readOnly: false })).map((t) => t.name);
  assert.ok(ro.includes('find_gaps') && ro.includes('search_episode'), 'reads survive read-only');
  assert.equal(ro.includes('grab_release'), false, 'the grab does not');
  assert.ok(rw.includes('grab_release'));
});

test('🔴 the sonarr-release producer/consumer pair is declared and checked', async () => {
  const tools = buildTools(testConfig({ readOnly: false }));
  const producer = tools.find((t) => t.name === 'search_episode');
  const consumer = tools.find((t) => t.name === 'grab_release');
  assert.deepEqual(producer?.presentsChoiceKinds, ['sonarr-release']);
  assert.equal(consumer?.consumesChoiceKind, 'sonarr-release');
});
