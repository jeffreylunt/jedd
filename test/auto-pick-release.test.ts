import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChoiceStore } from '../src/choices.js';
import type { FetchImpl } from '../src/media/arr.js';
import type { ExecImpl } from '../src/hp.js';
import { byScore, swarmHealth, swarmRank, HEALTHY_SWARM_SEEDERS } from '../src/media/pick-release.js';
import { rankAudiobooks, rankReleases, type Release } from '../src/media/prowlarr.js';
import { addAudiobook } from '../src/tools/add-audiobook.js';
import { makeCatalogueSearch } from '../src/tools/catalogue.js';
import { resolveChoice } from '../src/tools/choice.js';
import { makeGrabRelease, makeSearchEpisode } from '../src/tools/fill-gaps.js';
import { makeSearchAudiobook } from '../src/tools/search-release.js';
import type { ToolContext } from '../src/tools/types.js';
import { testConfig } from './helpers.js';

/**
 * NOBODY IS ASKED WHICH TORRENT ANY MORE — AND THE ONE WE TAKE IS CHOSEN ON THE
 * SWARM, NOT ON THE NAME.
 *
 * Jeff, verbatim: *"When downloading media, don't give users a choice of which
 * torrent to choose, just choose the best one."*
 *
 * ── 🔴 THE FIXTURE IN THIS FILE IS A REAL INCIDENT ──────────────────────────
 *
 * 2026-08-26 on hp: Sonarr had grabbed Fringe S02 from a pool of 2009 720p-HDTV
 * releases the quality profile approved. `time_active` 50–60 h, `num_complete`
 * **0**, **zero bytes moved, ever**. Every one of them read as respectable by
 * name. Blocklisting them and taking a 1080p AMZN WEB-DL — which the profile
 * REFUSES — finished in minutes.
 *
 * So `THE_FRINGE_SHAPE` below is not an invented edge case. It is the shape that
 * cost sixty hours, and the ordering that produced it is the one this file
 * exists to keep out.
 *
 * ── ⚠️ AND WHAT THIS DELIBERATELY DOES NOT TOUCH ────────────────────────────
 *
 * Which WORK someone meant is still their call, and the last test here pins it.
 * Kaela asked for *"Don't Say Good Luck"*, Jedd asked *"the 2026 film or the
 * 2003 show?"*, and that question was CORRECT — they are different works and
 * guessing downloads the wrong one. Release choice is not title choice.
 */

const tempFile = () => join(mkdtempSync(join(tmpdir(), 'jedd-autopick-')), 'choices.jsonl');

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  role: 'guest',
  senderHandle: '+18015550123',
  config: testConfig({ readOnly: false }),
  choices: new ChoiceStore(tempFile()),
  ...over,
});

const json = async (body: unknown, status = 200): Promise<Response> =>
  ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

// ── the Sonarr side ─────────────────────────────────────────────────────────

const SERIES = { id: 80, tvdbId: 79169, title: 'Fringe', year: 2008, monitored: true, seasons: [] };
const EPISODE = {
  id: 4242,
  seasonNumber: 2,
  episodeNumber: 1,
  title: 'A New Day in the Old Town',
  monitored: true,
  hasFile: false,
  airDateUtc: '2009-09-17T01:00:00Z',
};

interface RelSpec {
  guid: string;
  title: string;
  quality: string;
  resolution: number;
  seeders: number;
  approved: boolean;
}

const arrRelease = (r: RelSpec) => ({
  guid: r.guid,
  indexerId: 4,
  title: r.title,
  indexer: 'SomeIndexer',
  quality: { quality: { name: r.quality, resolution: r.resolution } },
  seeders: r.seeders,
  size: 2 * 1024 ** 3,
  approved: r.approved,
  rejections: r.approved ? [] : [`${r.quality} is not wanted in profile`],
  customFormatScore: 0,
  languages: [{ name: 'English' }],
});

/**
 * 🔴 THE FRINGE SHAPE.
 *
 * `DEAD_720` is what the profile likes: approved, and the release Sonarr
 * actually took. Its swarm is two people. `LIVE_1080` is what finished in
 * minutes: refused by the profile, higher resolution, and a swarm that exists.
 *
 * ⚠️ The dead one is on TWO seeders and not zero ON PURPOSE. Zero is already
 * filtered out before ranking ever runs, so a zero-seeder fixture would pass
 * with the ranking removed entirely and prove nothing about the ORDER. Two puts
 * it in the `thin` band — alive, rankable, and still the wrong answer.
 */
const DEAD_720: RelSpec = {
  guid: 'guid-dead-720',
  title: 'Fringe S02E01 720p HDTV x264',
  quality: 'HDTV-720p',
  resolution: 720,
  seeders: 2,
  approved: true,
};
const LIVE_1080: RelSpec = {
  guid: 'guid-live-1080',
  title: 'Fringe S02E01 1080p AMZN WEB-DL DDP5 1 H 264',
  quality: 'WEBDL-1080p',
  resolution: 1080,
  seeders: 400,
  approved: false,
};

function sonarr(releases: RelSpec[]): { fetchImpl: FetchImpl; posts: Record<string, unknown>[] } {
  const posts: Record<string, unknown>[] = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    const u = String(url);
    if ((init?.method ?? 'GET') !== 'GET') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      posts.push(body);
      return json(body, 201);
    }
    if (u.includes('/episode?')) return json([EPISODE]);
    if (u.includes('/release?')) return json(releases.map(arrRelease));
    if (u.includes('/queue')) return json({ records: [], totalRecords: 0 });
    if (u.endsWith('/series')) return json([SERIES]);
    return json([]);
  };
  return { fetchImpl, posts };
}

const searchFringe = (releases: RelSpec[], over: Partial<ToolContext> = {}) =>
  makeSearchEpisode(sonarr(releases).fetchImpl).run(
    { title: 'Fringe', season: 2, episode: 1 },
    ctx(over),
  );

// ── 🔴 THE RANKING ──────────────────────────────────────────────────────────

test('🔴 FRINGE: the LIVE release is chosen over the better-labelled DEAD one', async () => {
  const r = await searchFringe([DEAD_720, LIVE_1080]);
  assert.equal(r.ok, true);
  assert.match(r.content, /1080p AMZN WEB-DL/, 'the one with a swarm is the one we take');
  assert.doesNotMatch(
    r.content,
    /720p HDTV/,
    'the approved-but-nearly-dead release is not even mentioned — it is not a choice on offer',
  );
});

test('🔴 MUTATION: rank on the LABEL instead of the swarm and the wrong release wins', async () => {
  /**
   * This is the control that makes the test above non-vacuous, and it is the
   * exact comparator `search_episode` shipped with until this change:
   *
   *     approved DESC, resolution DESC, seeders DESC
   *
   * Run over the same fixture it returns the release that moved zero bytes for
   * sixty hours. If someone deletes `swarmRank` from the score vector, the
   * assertion above starts failing and this one keeps passing — which is the
   * whole point of writing both.
   */
  const labelFirst = [DEAD_720, LIVE_1080].sort(
    byScore((r) => [Number(r.approved), r.resolution, r.seeders]),
  );
  assert.equal(labelFirst[0]!.guid, DEAD_720.guid, 'label-first picks the dead one — that is the bug');

  const swarmFirst = [DEAD_720, LIVE_1080].sort(
    byScore((r) => [swarmRank(r.seeders), Number(r.approved), r.resolution, r.seeders]),
  );
  assert.equal(swarmFirst[0]!.guid, LIVE_1080.guid, 'swarm-first picks the one that finishes');

  assert.notEqual(
    labelFirst[0]!.guid,
    swarmFirst[0]!.guid,
    'the two orderings must DISAGREE on this fixture, or the shipped test proves nothing',
  );
});

test('quality still decides INSIDE a band — the swarm rule does not throw the profile away', async () => {
  // Both healthy, so `approved` and resolution get to matter again. A rule that
  // ranked on raw seeders would hand every decision to popularity instead.
  const approved720: RelSpec = { ...DEAD_720, seeders: 60 };
  const r = await searchFringe([approved720, LIVE_1080]);
  assert.match(r.content, /720p HDTV/, 'with a live swarm of its own, the profile-approved one wins');
});

// ── 🔴 NO NUMBERED PICK EVER REACHES THE MODEL ──────────────────────────────

test('🔴 the tool result contains NO numbered list — the model cannot offer what it never got', async () => {
  const r = await searchFringe([DEAD_720, LIVE_1080]);
  assert.doesNotMatch(r.content, /^\s*\d+\.\s/m, 'a numbered option line is exactly what was removed');
  assert.match(r.content, /^CHOSE — /);
  assert.match(r.content, /do NOT ask which torrent/i);
  assert.match(r.content, /Nothing is downloading yet/);
});

test('the alternatives are PERSISTED even though they are never printed', async () => {
  // Withheld from the prose, not discarded: "actually, the other one" still has
  // something to resolve against.
  const path = tempFile();
  await searchFringe([DEAD_720, LIVE_1080], { choices: new ChoiceStore(path) });
  const store = new ChoiceStore(path);
  assert.equal(store.resolve('+18015550123', 1).ok, true);
  const second = store.resolve('+18015550123', 2);
  assert.ok(second.ok);
  assert.equal(second.option.value['guid'], DEAD_720.guid, 'option 2 is the one we did not take');
});

// ── 🔴 THE GRAB TAKES THE CHOSEN ONE WITH NO ARGUMENT ───────────────────────

test('🔴 grab_release called with NO arguments grabs the release that was chosen', async () => {
  const path = tempFile();
  await searchFringe([DEAD_720, LIVE_1080], { choices: new ChoiceStore(path) });

  const { fetchImpl, posts } = sonarr([DEAD_720, LIVE_1080]);
  const r = await makeGrabRelease(fetchImpl).run({}, ctx({ choices: new ChoiceStore(path) }));
  assert.equal(r.ok, true, r.content);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!['guid'], LIVE_1080.guid, 'the one with the swarm, without anybody being asked');
});

test('an explicit number is still honoured — "no, the other one" remains serviceable', async () => {
  const path = tempFile();
  await searchFringe([DEAD_720, LIVE_1080], { choices: new ChoiceStore(path) });

  const { fetchImpl, posts } = sonarr([DEAD_720, LIVE_1080]);
  await makeGrabRelease(fetchImpl).run({ choice: 2 }, ctx({ choices: new ChoiceStore(path) }));
  assert.equal(posts[0]!['guid'], DEAD_720.guid, 'a person who names a number overrides the ranking');
});

// ── 🔴 THE POLICY THAT USED TO LIVE IN A DESCRIPTION ────────────────────────

test('🔴 4K is excluded IN CODE now that a comparator is doing the choosing', async () => {
  /**
   * *"Do NOT offer or grab 4K / 2160p releases"* was an instruction in
   * `search_episode`'s description, and it worked because a model read the list.
   * A comparator does not read descriptions: a 2160p remux with a big swarm wins
   * every key. So it is a filter now, and this is what proves it.
   */
  const huge: RelSpec = {
    guid: 'guid-2160',
    title: 'Fringe S02E01 2160p UHD BluRay REMUX',
    quality: 'Bluray-2160p',
    resolution: 2160,
    seeders: 900,
    approved: false,
  };
  const r = await searchFringe([huge, LIVE_1080]);
  assert.match(r.content, /1080p AMZN WEB-DL/);
  assert.doesNotMatch(r.content, /2160p/, 'the biggest swarm in the list does not get to win');
  assert.match(r.content, /1 above 1080p/, 'and it is COUNTED, not dropped in silence');
});

// ── 🔴 AUDIOBOOKS AND EBOOKS TAKE THE SAME RULE ─────────────────────────────

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);

const prowlarrRelease = (o: Record<string, unknown>) => ({
  title: 'Book',
  infoHash: HASH_A,
  seeders: 20,
  size: 500 * 1024 ** 2,
  indexer: 'SomeIndexer',
  ...o,
});

test('🔴 search_audiobook chooses one release and shows no list', async () => {
  const r = await makeSearchAudiobook(async () =>
    json([
      prowlarrRelease({ title: 'Dune (thin swarm)', infoHash: HASH_A, seeders: 2 }),
      prowlarrRelease({ title: 'Dune (healthy swarm)', infoHash: HASH_B, seeders: 300 }),
    ]),
  ).run({ query: 'Dune' }, ctx());
  assert.equal(r.ok, true);
  assert.match(r.content, /^CHOSE — /);
  assert.match(r.content, /Dune \(healthy swarm\)/);
  assert.doesNotMatch(r.content, /^\s*\d+\.\s/m, 'no numbered options');
  assert.doesNotMatch(r.content, /thin swarm/, 'the runner-up is not offered');
});

test('🔴 add_audiobook called with NO arguments grabs the chosen release', async () => {
  const path = tempFile();
  await makeSearchAudiobook(async () =>
    json([prowlarrRelease({ title: 'Dune', infoHash: HASH_B, seeders: 300 })]),
  ).run({ query: 'Dune' }, ctx({ choices: new ChoiceStore(path) }));

  const cmds: string[] = [];
  const replies = ['', 'Ok.\n200', ''];
  let i = 0;
  const exec: ExecImpl = (_f, args, _o, cb) => {
    cmds.push(args[args.length - 1]!);
    cb(null, replies[Math.min(i++, replies.length - 1)]!, '');
  };

  const r = await addAudiobook.run({}, ctx({ choices: new ChoiceStore(path), exec }));
  assert.equal(r.ok, true, r.content);
  assert.ok(
    cmds.some((c) => c.includes(HASH_B)),
    `the chosen infoHash reached the download client: ${cmds.join(' | ')}`,
  );
});

test('🔴 every candidate dead is ALL DEAD, which is not "nothing was found"', async () => {
  // Two different zeros. One of them means the book does not exist and the other
  // means every copy of it is unseeded, and only one is worth searching again for.
  const r = await makeSearchAudiobook(async () =>
    json([
      prowlarrRelease({ title: 'Dune A', infoHash: HASH_A, seeders: 0 }),
      prowlarrRelease({ title: 'Dune B', infoHash: HASH_B, seeders: 0 }),
    ]),
  ).run({ query: 'Dune' }, ctx());
  assert.equal(r.ok, true);
  assert.match(r.content, /ALL DEAD/);
  assert.match(r.content, /do not say nothing was found/i);
});

test('the prowlarr rankers lead on the band, not on the label', () => {
  const mk = (title: string, seeders: number): Release => ({
    title,
    infoHash: HASH_A,
    seeders,
    sizeBytes: 1,
    indexer: 'i',
  });
  assert.equal(rankReleases([mk('thin', 2), mk('healthy', 50)])[0]!.title, 'healthy');

  // The audiobook ranker had `graphicAudio matches` and `unabridged` ahead of
  // everything but a bare alive/dead test. A thin swarm now outranks both.
  const ranked = rankAudiobooks(
    [mk('Dune Unabridged', 2), mk('Dune abridged', 50)],
    { wantGraphicAudio: false },
  );
  assert.equal(ranked[0]!.title, 'Dune abridged', 'an abridged copy that exists beats one that does not');
});

// ── 🔴 THE SCOPE BOUNDARY: TITLE CHOICE IS STILL THEIRS ─────────────────────

test('🔴 KAELA: an ambiguous TITLE still asks which work they meant', async () => {
  /**
   * 2026-08-26: Kaela asked for *"Don't Say Good Luck"* and Jedd replied *"1.
   * the 2026 film, 2. the 2003 show — which did you mean?"* **That question was
   * right and must stay.** A film and a show sharing a name are different works;
   * choosing for someone downloads the wrong thing entirely, and no amount of
   * swarm health makes it the right one.
   *
   * This is proven by running the tool, not by reading it.
   */
  const path = tempFile();
  const fetchImpl: FetchImpl = async (url) =>
    String(url).includes('/radarr/')
      ? json([{ title: "Don't Say Good Luck", year: 2026, tmdbId: 111 }])
      : json([{ title: "Don't Say Good Luck", year: 2003, tvdbId: 222 }]);

  const r = await makeCatalogueSearch(fetchImpl).run(
    { title: "Don't Say Good Luck" },
    ctx({ choices: new ChoiceStore(path) }),
  );
  assert.equal(r.ok, true);
  assert.match(r.content, /AMBIGUOUS/);
  assert.match(r.content, /2026/);
  assert.match(r.content, /2003/);
  assert.match(r.content, /^\s*\d+\.\s/m, 'a numbered choice — the one kind we still present');

  // And their answer resolves, so the flow completes rather than merely asking.
  const picked = await resolveChoice.run({ choice: 2 }, ctx({ choices: new ChoiceStore(path) }));
  assert.equal(picked.ok, true);
  assert.match(picked.content, /2003/);
  assert.match(picked.content, /"arr":"series"/);
});

test('CONTROL: the two flows are genuinely different code paths, not one rule read twice', () => {
  // `catalogue_search` presents `media-choice`; the release searches present
  // `release` / `sonarr-release`. If they ever shared a kind, silencing one
  // would silence the other, and the test above would stop being a guard.
  const catalogue = makeCatalogueSearch(async () => json([]));
  const episode = makeSearchEpisode(async () => json([]));
  assert.deepEqual(catalogue.presentsChoiceKinds, ['media-choice']);
  assert.deepEqual(episode.presentsChoiceKinds, ['sonarr-release']);
});

// ── the band itself ─────────────────────────────────────────────────────────

test('the swarm bands are dead / thin / healthy, and dead is anything not positive', () => {
  assert.equal(swarmHealth(0), 'dead');
  assert.equal(swarmHealth(-1), 'dead');
  assert.equal(swarmHealth(Number.NaN), 'dead', 'a missing seeder count is not evidence of health');
  assert.equal(swarmHealth(1), 'thin');
  assert.equal(swarmHealth(HEALTHY_SWARM_SEEDERS - 1), 'thin');
  assert.equal(swarmHealth(HEALTHY_SWARM_SEEDERS), 'healthy');
  assert.ok(swarmRank(HEALTHY_SWARM_SEEDERS) > swarmRank(1));
  assert.ok(swarmRank(1) > swarmRank(0));
});
