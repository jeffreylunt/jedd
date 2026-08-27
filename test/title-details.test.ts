import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChoiceStore } from '../src/choices.js';
import type { FetchImpl } from '../src/media/arr.js';
import { buildTools } from '../src/tools/index.js';
import { makeTitleDetails } from '../src/tools/title-details.js';
import { makeTrending } from '../src/tools/trending.js';
import type { ToolContext } from '../src/tools/types.js';
import { testConfig } from './helpers.js';

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  role: 'guest',
  senderHandle: '+18015550123',
  config: testConfig(),
  ...over,
});

const json = async (body: unknown, status = 200): Promise<Response> =>
  ({ ok: status < 400, status, text: async () => JSON.stringify(body) }) as Response;

const tempFile = () => join(mkdtempSync(join(tmpdir(), 'jedd-details-')), 'choices.jsonl');

const LIONESS = {
  id: 113962,
  name: 'Lioness',
  first_air_date: '2023-07-23',
  vote_average: 8.076,
  vote_count: 400,
  number_of_seasons: 3,
  number_of_episodes: 24,
  status: 'Returning Series',
  genres: [{ name: 'Drama' }, { name: 'War & Politics' }],
  networks: [{ name: 'Paramount+' }],
  created_by: [{ name: 'Taylor Sheridan' }],
  overview:
    "Cruz Manuelos, a rough-around-the-edges but passionate young Marine, is recruited to join the CIA's " +
    'Lioness Engagement Team to help bring down a terrorist organization from within.',
  credits: {
    cast: Array.from({ length: 15 }, (_, i) => ({ name: `Actor ${i + 1}`, character: `Role ${i + 1}` })),
    crew: [],
  },
};

const TOY_STORY = {
  id: 1084244,
  title: 'Toy Story 5',
  release_date: '2026-06-17',
  runtime: 102,
  status: 'Released',
  vote_average: 8.2,
  vote_count: 900,
  tagline: "It's on.",
  genres: [{ name: 'Animation' }],
  overview: 'The toys are back.',
  credits: { cast: [{ name: 'Tom Hanks', character: 'Woody' }], crew: [{ job: 'Director', name: 'Andrew Stanton' }] },
};

/** A TMDB that routes by path, so a test can bend one endpoint at a time. */
function tmdb(routes: Record<string, () => Promise<Response>>): { fetchImpl: FetchImpl; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl: FetchImpl = async (url) => {
    const u = String(url);
    urls.push(u);
    for (const [frag, handler] of Object.entries(routes)) {
      if (u.includes(frag)) return handler();
    }
    return json({ status_message: 'unrouted' }, 404);
  };
  return { fetchImpl, urls };
}

const search = (results: unknown[]) => () => json({ page: 1, results });

// ── the live question that prompted this tool ───────────────────────────────

test('🔴 LIONESS: "tell me more about X" returns plot, cast and season count', async () => {
  // The actual exchange: Jeff asked, and Jedd had no tool that returned detail.
  const { fetchImpl } = tmdb({
    '/search/multi': search([{ media_type: 'tv', id: 113962, name: 'Lioness', first_air_date: '2023-07-23' }]),
    '/tv/113962': () => json(LIONESS),
  });
  const r = await makeTitleDetails(fetchImpl).run({ title: 'Lioness' }, ctx());
  assert.equal(r.ok, true);
  assert.match(r.content, /Lioness \(2023\) — show, Returning Series/);
  assert.match(r.content, /Seasons: 3, 24 episodes/);
  assert.match(r.content, /On: Paramount\+/);
  assert.match(r.content, /Created by: Taylor Sheridan/);
  assert.match(r.content, /Rated 8\.1\/10 from 400 votes/);
  assert.match(r.content, /Cruz Manuelos/);
});

test('a film carries runtime and director instead of seasons and networks', async () => {
  const { fetchImpl } = tmdb({
    '/search/multi': search([{ media_type: 'movie', id: 1084244, title: 'Toy Story 5', release_date: '2026-06-17' }]),
    '/movie/1084244': () => json(TOY_STORY),
  });
  const r = await makeTitleDetails(fetchImpl).run({ title: 'Toy Story 5' }, ctx());
  assert.match(r.content, /Runtime: 102 min/);
  assert.match(r.content, /Director: Andrew Stanton/);
  assert.match(r.content, /Tagline: It's on\./);
  assert.doesNotMatch(r.content, /Seasons:/);
});

// ── 🔴 THE OVERVIEW IS WHOLE OR ABSENT ──────────────────────────────────────

test('🔴 the overview is passed through WHOLE — no ellipsis ever reaches the model', async () => {
  // A cut paragraph and a short one are indistinguishable to the model, and
  // shown the front half of a plot it will supply the back half. That
  // fabrication risk was the stated reason for shipping without descriptions at
  // all; the remedy is the whole text, not the absence of the capability.
  const long = `${'A very long plot summary. '.repeat(40)}END OF SUMMARY`;
  const { fetchImpl } = tmdb({
    '/search/multi': search([{ media_type: 'movie', id: 1, title: 'Long', release_date: '2020-01-01' }]),
    '/movie/1': () => json({ ...TOY_STORY, id: 1, title: 'Long', overview: long }),
  });
  const r = await makeTitleDetails(fetchImpl).run({ title: 'Long' }, ctx());
  assert.ok(r.content.includes(long), 'the overview must appear in full');
  assert.match(r.content, /END OF SUMMARY/);
  assert.doesNotMatch(r.content, /…|\.\.\./, 'no ellipsis, in any form');
});

test('an EMPTY overview is a real answer, and is not confused with a failure', async () => {
  const { fetchImpl } = tmdb({
    '/search/multi': search([{ media_type: 'movie', id: 1, title: 'Bare', release_date: '2020-01-01' }]),
    '/movie/1': () => json({ ...TOY_STORY, id: 1, title: 'Bare', overview: '' }),
  });
  const r = await makeTitleDetails(fetchImpl).run({ title: 'Bare' }, ctx());
  assert.equal(r.ok, true, 'TMDB having no description is a finding, not a gap');
  assert.match(r.content, /lists no description/);
  assert.doesNotMatch(r.content, /UNKNOWN/);
});

test('a capped cast list SAYS it is capped', async () => {
  const { fetchImpl } = tmdb({
    '/search/multi': search([{ media_type: 'tv', id: 113962, name: 'Lioness', first_air_date: '2023-07-23' }]),
    '/tv/113962': () => json(LIONESS),
  });
  const r = await makeTitleDetails(fetchImpl).run({ title: 'Lioness' }, ctx());
  assert.match(r.content, /Cast \(8 of 15 listed\)/);
  assert.match(r.content, /Actor 1 as Role 1/);
  assert.doesNotMatch(r.content, /Actor 9/);
});

// ── 🔴 A TYPED REFERENCE, NEVER A BARE ID ───────────────────────────────────

test('🔴 a SERIES pick is resolved BY TITLE — its stored `id` is a tvdbId and is never used', async () => {
  /**
   * catalogue_search stores {arr:'series', id:<tvdbId>, title}. Feeding that to
   * /tv/{id} fetches a DIFFERENT show and describes it in full confidence — the
   * Moneyball defect arriving through this door. tvdbId 79169 is Seinfeld;
   * TMDB tv 79169 is something else entirely.
   */
  const store = new ChoiceStore(tempFile());
  store.present({
    senderHandle: '+18015550123',
    subject: 'test',
    kind: 'media-choice',
    options: [{ n: 1, label: 'Lioness (2023) — show', value: { arr: 'series', id: 79169, title: 'Lioness', year: 2023 } }],
  });
  const { fetchImpl, urls } = tmdb({
    '/search/multi': search([{ media_type: 'tv', id: 113962, name: 'Lioness', first_air_date: '2023-07-23' }]),
    '/tv/113962': () => json(LIONESS),
  });
  const r = await makeTitleDetails(fetchImpl).run({ choice: 1 }, ctx({ choices: store }));
  assert.equal(r.ok, true);
  assert.match(r.content, /Lioness \(2023\)/);
  assert.equal(
    urls.some((u) => u.includes('/tv/79169')),
    false,
    '🔴 the tvdbId must never be used as a TMDB id',
  );
  assert.ok(urls.some((u) => u.includes('/search/multi')), 'it went through a name lookup instead');
});

test('a FILM pick uses its id directly — Radarr tmdbId IS the TMDB id', async () => {
  const store = new ChoiceStore(tempFile());
  store.present({
    senderHandle: '+18015550123',
    subject: 'test',
    kind: 'media-choice',
    options: [{ n: 1, label: 'Toy Story 5', value: { arr: 'movie', id: 1084244, title: 'Toy Story 5' } }],
  });
  const { fetchImpl, urls } = tmdb({ '/movie/1084244': () => json(TOY_STORY) });
  const r = await makeTitleDetails(fetchImpl).run({ choice: 1 }, ctx({ choices: store }));
  assert.equal(r.ok, true);
  assert.match(r.content, /Toy Story 5/);
  assert.equal(urls.some((u) => u.includes('/search/multi')), false, 'no lookup needed for a film');
});

test('🔴 end to end: whats_popular presents, title_details describes the pick', async () => {
  // The flow Jeff actually walked: browse, then ask about one of them. The show
  // carries no id, so this is also the proof that the id-free option is enough.
  const path = tempFile();
  const popular: FetchImpl = async () =>
    json({ page: 1, results: [{ id: 113962, media_type: 'tv', name: 'Lioness', first_air_date: '2023-07-23' }] });
  const listed = await makeTrending(popular).run({ kind: 'trending' }, ctx({ choices: new ChoiceStore(path) }));
  assert.match(listed.content, /1\. Lioness \(2023\) — show/);
  assert.doesNotMatch(listed.content, /113962/, 'CONTROL: the id was never shown');

  const { fetchImpl } = tmdb({
    '/search/multi': search([{ media_type: 'tv', id: 113962, name: 'Lioness', first_air_date: '2023-07-23' }]),
    '/tv/113962': () => json(LIONESS),
  });
  const r = await makeTitleDetails(fetchImpl).run({ choice: 1 }, ctx({ choices: new ChoiceStore(path) }));
  assert.equal(r.ok, true);
  assert.match(r.content, /Cruz Manuelos/);
});

test('the YEAR on the stored option picks the right one of several same-named titles', async () => {
  const store = new ChoiceStore(tempFile());
  store.present({
    senderHandle: '+18015550123',
    subject: 'test',
    kind: 'media-choice',
    options: [{ n: 1, label: 'Lioness (2023) — show', value: { arr: 'series', title: 'Lioness', year: 2023 } }],
  });
  const { fetchImpl } = tmdb({
    '/search/multi': search([
      { media_type: 'tv', id: 999, name: 'Lioness', first_air_date: '2019-01-01' },
      { media_type: 'tv', id: 113962, name: 'Lioness', first_air_date: '2023-07-23' },
    ]),
    '/tv/113962': () => json(LIONESS),
    '/tv/999': () => json({ ...LIONESS, id: 999, name: 'Lioness', first_air_date: '2019-01-01' }),
  });
  const r = await makeTitleDetails(fetchImpl).run({ choice: 1 }, ctx({ choices: store }));
  assert.match(r.content, /Lioness \(2023\)/, 'the 2023 one, not TMDB\'s first hit');
});

test('several titles of the same name are NAMED as alternates, not silently picked', async () => {
  // Measured: "Lioness" is one show and three films on TMDB. Taking the first
  // without saying so sounds certain about a coin toss.
  const { fetchImpl } = tmdb({
    '/search/multi': search([
      { media_type: 'tv', id: 113962, name: 'Lioness', first_air_date: '2023-07-23' },
      { media_type: 'movie', id: 1071487, title: 'Lioness', release_date: '2024-01-01' },
      { media_type: 'movie', id: 91266, title: 'Lioness', release_date: '2008-01-01' },
    ]),
    '/tv/113962': () => json(LIONESS),
  });
  const r = await makeTitleDetails(fetchImpl).run({ title: 'Lioness' }, ctx());
  assert.match(r.content, /2 other title\(s\) of the same name/);
  assert.match(r.content, /offer to look again/);
});

test('people are never described — /search/multi mixes them in', async () => {
  const { fetchImpl } = tmdb({
    '/search/multi': search([
      { media_type: 'person', id: 500, name: 'Zoe Saldana' },
      { media_type: 'tv', id: 113962, name: 'Lioness', first_air_date: '2023-07-23' },
    ]),
    '/tv/113962': () => json(LIONESS),
  });
  const r = await makeTitleDetails(fetchImpl).run({ title: 'Lioness' }, ctx());
  assert.equal(r.ok, true);
  assert.match(r.content, /Lioness/);
  assert.doesNotMatch(r.content, /Zoe Saldana as a title/);
});

// ── 🔴 THE TWO ZEROS ────────────────────────────────────────────────────────

test('🔴 an unreachable TMDB is UNKNOWN, not "nothing is known about it"', async () => {
  const r = await makeTitleDetails(() => {
    throw new Error('ECONNREFUSED');
  }).run({ title: 'Lioness' }, ctx());
  assert.equal(r.ok, false);
  assert.match(r.content, /UNKNOWN/);
  assert.match(r.content, /rather than "there is nothing to tell"/);
});

test('🔴 a details body that parses to NOTHING is UNKNOWN, not an empty description', async () => {
  // 200 with a shape we cannot read is a gap in what we know. Rendering it as a
  // blank record says "there is nothing to tell you", which is a finding we have
  // not made — the same two-zeros rule as whats_popular's 100% filter.
  const { fetchImpl } = tmdb({
    '/search/multi': search([{ media_type: 'movie', id: 1, title: 'X', release_date: '2020-01-01' }]),
    '/movie/1': () => json({ renamed_id: 1, headline: 'X' }),
  });
  const r = await makeTitleDetails(fetchImpl).run({ title: 'X' }, ctx());
  assert.equal(r.ok, false);
  assert.match(r.content, /UNKNOWN/);
  assert.match(r.content, /shape has changed/);
});

test('🔴 a search that answers 200 with no results array is UNKNOWN, not "no such title"', async () => {
  const { fetchImpl } = tmdb({ '/search/multi': () => json({ page: 1 }) });
  const r = await makeTitleDetails(fetchImpl).run({ title: 'Lioness' }, ctx());
  assert.equal(r.ok, false);
  assert.match(r.content, /UNKNOWN/);
});

test('a genuinely unknown title is a real answer — NONE, not UNKNOWN', async () => {
  const { fetchImpl } = tmdb({ '/search/multi': search([]) });
  const r = await makeTitleDetails(fetchImpl).run({ title: 'Nonesuch' }, ctx());
  assert.equal(r.ok, false);
  assert.match(r.content, /nothing called "Nonesuch"/);
  assert.doesNotMatch(r.content, /UNKNOWN/, 'searched and found none is a finding');
  assert.equal(
    r.content.match(/nothing called "Nonesuch"/g)?.length,
    1,
    'and it says so ONCE — the detail already names the title',
  );
});

test('a rejected token is UNKNOWN and names the credential', async () => {
  const { fetchImpl } = tmdb({ '/search/multi': () => json({ status_message: 'invalid' }, 401) });
  const r = await makeTitleDetails(fetchImpl).run({ title: 'Lioness' }, ctx());
  assert.match(r.content, /UNKNOWN/);
  assert.match(r.content, /token was rejected/);
});

// ── arguments and registration ──────────────────────────────────────────────

test('neither a choice nor a title is a refusal that asks', async () => {
  let called = false;
  const r = await makeTitleDetails(async () => {
    called = true;
    return json({});
  }).run({}, ctx());
  assert.equal(r.ok, false);
  assert.match(r.content, /Give either the number|title they named/);
  assert.equal(called, false, 'and it makes no request');
});

test('a stale or missing list re-asks rather than guessing which title they meant', async () => {
  const r = await makeTitleDetails(async () => json({})).run(
    { choice: 3 },
    ctx({ choices: new ChoiceStore(tempFile()) }),
  );
  assert.equal(r.ok, false);
  assert.match(r.content, /NONE|EXPIRED|OUT-OF-RANGE/);
});

test('🔴 an ABSENT TMDB token is UNKNOWN, and denies being "nothing is known"', async () => {
  // The registry check below covers buildTools. This covers the in-tool guard,
  // which is the one a caller constructing the tool directly would hit — and
  // which the registry test cannot fail on, because testConfig has a token.
  let called = false;
  const r = await makeTitleDetails(async () => {
    called = true;
    return json({});
  }).run({ title: 'Lioness' }, ctx({ config: testConfig({ tmdb: { readToken: '' } }) }));
  assert.equal(r.ok, false);
  assert.match(r.content, /not "nothing is known"/);
  assert.equal(called, false, 'and it asks TMDB nothing');
});

test('title_details is a guest READ, present with writes disabled and absent without a token', async () => {
  const tool = makeTitleDetails();
  assert.equal(tool.minRole, 'guest');
  assert.equal(tool.writes, false);
  assert.ok(buildTools(testConfig({ readOnly: true })).some((t) => t.name === 'title_details'));
  assert.equal(
    buildTools(testConfig({ readOnly: false, tmdb: { readToken: '' } })).some((t) => t.name === 'title_details'),
    false,
    'no credential, no tool — same rule as whats_popular',
  );
});
