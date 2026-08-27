import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChoiceStore } from '../src/choices.js';
import type { FetchImpl } from '../src/media/arr.js';
import type { ExecImpl } from '../src/hp.js';
import { KindleRegistry } from '../src/kindle.js';
import { addAudiobook } from '../src/tools/add-audiobook.js';
import { makeGrabRelease, makeSearchEpisode } from '../src/tools/fill-gaps.js';
import { makeSearchAudiobook, makeSearchEbook } from '../src/tools/search-release.js';
import { makeSendEbook } from '../src/tools/send-ebook.js';
import { buildTools } from '../src/tools/index.js';
import type { ToolContext } from '../src/tools/types.js';
import { testConfig } from './helpers.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHICH **BOOK** IS NOT A QUESTION SWARM HEALTH CAN ANSWER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Jeff's rule — *"don't give users a choice of which torrent to choose, just
 * choose the best one"* — is a rule about choosing between COPIES OF ONE THING.
 * It is right wherever that is what the candidates are, and this repo has both
 * kinds of path:
 *
 *  - **`search_episode` is safe BY CONSTRUCTION.** It takes a title, a season
 *    and an episode, resolves them against Sonarr to one episode row, and asks
 *    Sonarr for the releases OF THAT EPISODE. Every candidate is an encoding of
 *    the same work. Ranking answers *"which copy"*, and swarm health is exactly
 *    the right instrument for that. **Nothing in this file changes it**, and the
 *    last section here proves that by running it.
 *
 *  - **`search_ebook` and `search_audiobook` are not.** They take FREE TEXT.
 *    Prowlarr and the IRC bots return whatever loosely matches, so the
 *    candidates are DIFFERENT WORKS. Ranking is then being asked *"which
 *    thing"* — a question a seeder count cannot answer and was never asked to.
 *
 * ── 🔴 THE FIXTURE IS A LIVE MEASUREMENT, 2026-08-27 ────────────────────────
 *
 * *"The Hobbit J.R.R. Tolkien"*, run against the shipped v2.0.0, ranked:
 *
 *   1. a Corey Olsen **study guide**, 24 seeders  ← AUTO-PICKED AND SENT ON
 *   2. a 1937–2017 anniversary booklet, 10
 *   3. **the actual novel**, 8
 *   4. a four-book collection, 8
 *   5. LotR + The Hobbit, 6
 *
 * **The ranking is correct.** Every one of those is healthy-band and an `.epub`,
 * so the seeder count breaks the tie and the study guide genuinely has the
 * biggest swarm. No reordering fixes this, because the defect is in the
 * QUESTION, not in the answer.
 *
 * ── ⚠️ WHAT WAS PROTECTING THIS UNTIL NOW ───────────────────────────────────
 *
 * The model noticing. It caught the study guide twice, unprompted, and refused
 * to send it. That is real, and it is the weakest kind of enforcement there is:
 * the same repo already lost *"do NOT grab 4K"* the moment it stopped being a
 * description a model read and had to become a filter in code
 * (`auto-pick-release.test.ts`). So this file asserts on RUN BEHAVIOUR — what
 * reaches the download client, what reaches the mail sender — and never on
 * whether a description says the right thing.
 *
 * ── ⚠️ AND WHAT THIS IS NOT ─────────────────────────────────────────────────
 *
 * This is the INTERIM shape. It hands back one list that mixes *"which work"*
 * and *"which copy"* into a single question, which is worse than the fix it
 * stands in for: resolve the WORK to a canonical identity first — the two-stage
 * shape `add_movie`/`add_series` already have via `tmdbId`/`tvdbId` — then
 * auto-pick on swarm health among that work's releases only, which is Jeff's
 * rule restored exactly.
 */

const tempFile = () => join(mkdtempSync(join(tmpdir(), 'jedd-work-id-')), 'choices.jsonl');
const JEFF = '+18015550123';

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  role: 'guest',
  senderHandle: JEFF,
  config: testConfig({ readOnly: false }),
  choices: new ChoiceStore(tempFile()),
  ...over,
});

const json = async (body: unknown): Promise<Response> =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

// ── 🔴 THE HOBBIT, AS MEASURED ──────────────────────────────────────────────

const STUDY_GUIDE_HASH = 'a'.repeat(40);
const NOVEL_HASH = 'b'.repeat(40);

/**
 * ⚠️ EVERY ONE OF THESE IS HEALTHY-BAND AND AN `.epub`, ON PURPOSE.
 *
 * If the wrong work were thin-swarmed or a `.rar`, the existing comparator would
 * already demote it and this fixture would prove nothing — it would be a test of
 * the ranking, which works. The whole point is that the study guide wins every
 * key the comparator has, fairly, and is still the wrong book.
 */
const HOBBIT = [
  { title: 'Exploring J.R.R. Tolkien - The Hobbit - Corey Olsen.epub', infoHash: STUDY_GUIDE_HASH, seeders: 24 },
  { title: 'The Hobbit 1937-2017 80th Anniversary Booklet.epub', infoHash: 'c'.repeat(40), seeders: 10 },
  { title: 'J.R.R. Tolkien - The Hobbit.epub', infoHash: NOVEL_HASH, seeders: 8 },
  { title: 'J.R.R. Tolkien - The Hobbit and LotR 4-Book Collection.epub', infoHash: 'd'.repeat(40), seeders: 8 },
  { title: 'The Lord of the Rings and The Hobbit.epub', infoHash: 'e'.repeat(40), seeders: 6 },
].map((r) => ({ ...r, size: 2 * 1024 ** 2, indexer: 'SomeIndexer' }));

const hobbitProwlarr: FetchImpl = async () => json(HOBBIT);

const optionLine = (content: string, n: number): string =>
  content.split('\n').find((l) => l.trim().startsWith(`${n}. `)) ?? `<no option ${n}>`;

// ═══ 1. THE SEARCH ASKS ═════════════════════════════════════════════════════

test('🔴 HOBBIT: the search returns the whole list and tells the model to ASK WHICH BOOK', async () => {
  const r = await makeSearchEbook(hobbitProwlarr).run({ query: 'The Hobbit J.R.R. Tolkien' }, ctx());
  assert.equal(r.ok, true);

  // All five reach the model, so it has something to show and something to ask
  // about. Withholding them is what made the study guide unchallengeable.
  for (let n = 1; n <= 5; n++) assert.match(optionLine(r.content, n), /\.epub/, `option ${n} is printed`);
  assert.match(optionLine(r.content, 3), /- The Hobbit\.epub/, 'the novel is on the list');

  assert.match(r.content, /ASK WHICH BOOK THEY MEANT/);
  assert.match(r.content, /DIFFERENT WORKS/);
  assert.match(r.content, /Option 1 is NOT "the best one"/);
  assert.match(r.content, /Nothing is being sent yet/);
});

test('🔴 MUTATION: the fixture really does put the WRONG WORK at the top of the ranking', async () => {
  /**
   * The control that makes the test above non-vacuous. If the ranking happened
   * to put the novel first on this fixture, "the search asks" would be a
   * statement about prose and nothing else — the old auto-pick would have sent
   * the right book anyway and there would be no defect to fix.
   *
   * It does not. Option 1 is the study guide, which is exactly what the shipped
   * v2.0.0 auto-picked, and what ANY reinstated default-to-1 would take.
   */
  const path = tempFile();
  await makeSearchEbook(hobbitProwlarr).run(
    { query: 'The Hobbit J.R.R. Tolkien' },
    ctx({ choices: new ChoiceStore(path) }),
  );
  const stored = new ChoiceStore(path).resolve(JEFF, 1);
  assert.ok(stored.ok);
  assert.equal(
    stored.option.value['infoHash'],
    STUDY_GUIDE_HASH,
    'option 1 is the STUDY GUIDE — so anything that defaults to option 1 sends the wrong book',
  );
  assert.notEqual(stored.option.value['infoHash'], NOVEL_HASH);
});

// ═══ 2. THE CONSUMERS REFUSE TO ACT WITHOUT A PICK ══════════════════════════

/**
 * 🔴 THIS IS THE HALF THAT MAKES THE ASK REAL.
 *
 * A search that returns a list and a consumer that defaults to option 1
 * DISAGREE, and the consumer is the half that runs. The model could print five
 * works, nobody could answer, and a no-argument call would still grab the study
 * guide — the defect arriving through the argument the fix forgot to close.
 */

function recordingExec(): { exec: ExecImpl; cmds: string[] } {
  const cmds: string[] = [];
  const replies = ['', 'Ok.\n200', ''];
  let i = 0;
  const exec: ExecImpl = (_f, args, _o, cb) => {
    cmds.push(args[args.length - 1]!);
    cb(null, replies[Math.min(i++, replies.length - 1)]!, '');
  };
  return { exec, cmds };
}

test('🔴 add_audiobook with NO pick grabs NOTHING — not even option 1', async () => {
  const path = tempFile();
  await makeSearchAudiobook(hobbitProwlarr).run(
    { query: 'The Hobbit J.R.R. Tolkien' },
    ctx({ choices: new ChoiceStore(path) }),
  );

  const { exec, cmds } = recordingExec();
  const r = await addAudiobook.run({}, ctx({ choices: new ChoiceStore(path), exec }));
  assert.equal(r.ok, false);
  assert.match(r.content, /^NO PICK/);
  assert.equal(cmds.length, 0, '🔴 NOTHING REACHED THE DOWNLOAD CLIENT AT ALL');
});

test('🔴 MUTATION: restore the default and that same call grabs the STUDY GUIDE', async () => {
  /**
   * The control for the test above, and it is the mutation stated as an
   * experiment: `{ choice: 1 }` is precisely what `n = args.choice ?? 1`
   * supplied for itself, so this run IS the old code path over the new fixture.
   *
   * It grabs the study guide. That proves the refusal above is not passing
   * because the store was empty, the search failed, or the exec stub was never
   * wired — all three of which would produce the same green `cmds.length === 0`.
   */
  const path = tempFile();
  await makeSearchAudiobook(hobbitProwlarr).run(
    { query: 'The Hobbit J.R.R. Tolkien' },
    ctx({ choices: new ChoiceStore(path) }),
  );

  const { exec, cmds } = recordingExec();
  const r = await addAudiobook.run({ choice: 1 }, ctx({ choices: new ChoiceStore(path), exec }));
  assert.equal(r.ok, true, r.content);
  assert.ok(
    cmds.some((c) => c.includes(STUDY_GUIDE_HASH)),
    `the study guide is what a default-to-1 hands to qBittorrent: ${cmds.join(' | ')}`,
  );
});

test('🔴 add_audiobook still honours the number a person actually chose', async () => {
  // The refusal must not have cost the flow its ability to complete. Option 3 is
  // the novel, and picking it grabs the novel.
  const path = tempFile();
  await makeSearchAudiobook(hobbitProwlarr).run(
    { query: 'The Hobbit J.R.R. Tolkien' },
    ctx({ choices: new ChoiceStore(path) }),
  );

  const { exec, cmds } = recordingExec();
  const r = await addAudiobook.run({ choice: 3 }, ctx({ choices: new ChoiceStore(path), exec }));
  assert.equal(r.ok, true, r.content);
  assert.ok(cmds.some((c) => c.includes(NOVEL_HASH)), `the novel: ${cmds.join(' | ')}`);
  assert.ok(!cmds.some((c) => c.includes(STUDY_GUIDE_HASH)), 'and not the study guide');
});

test('🔴 a failed second search kills the first list — a number is not self-describing', async () => {
  /**
   * Requiring the pick does not make a pick unambiguous. *search Dune (stored) →
   * search The Hobbit (Prowlarr down) → "yeah, 2"* would resolve **2 from the
   * Dune list** and grab a book nobody is talking about, because the number
   * means whatever list is lying around.
   *
   * The list is cleared when a search STARTS, so the failing search takes the
   * stale one with it and the pick has nothing to land on.
   */
  const path = tempFile();
  await makeSearchAudiobook(async () =>
    json([{ title: 'Dune.epub', infoHash: NOVEL_HASH, seeders: 40, size: 1, indexer: 'i' }]),
  ).run({ query: 'Dune' }, ctx({ choices: new ChoiceStore(path) }));
  assert.ok(new ChoiceStore(path).resolve(JEFF, 1).ok, 'the Dune list is there to begin with');

  const failed = await makeSearchAudiobook(() => {
    throw new Error('ECONNREFUSED');
  }).run({ query: 'The Hobbit' }, ctx({ choices: new ChoiceStore(path) }));
  assert.equal(failed.ok, false);

  const { exec, cmds } = recordingExec();
  const r = await addAudiobook.run({ choice: 1 }, ctx({ choices: new ChoiceStore(path), exec }));
  assert.equal(r.ok, false, r.content);
  assert.equal(cmds.length, 0, 'the stale Dune pick did not reach the download client');
});

test('🔴 send_ebook with NO pick grabs nothing and mails nothing', async () => {
  const path = tempFile();
  await makeSearchEbook(hobbitProwlarr).run(
    { query: 'The Hobbit J.R.R. Tolkien' },
    ctx({ choices: new ChoiceStore(path) }),
  );

  const sent: unknown[] = [];
  const { exec, cmds } = recordingExec();
  const kindle = new KindleRegistry(tempFile());
  kindle.save(JEFF, 'readerone@kindle.com', ['readerone@kindle.com']);

  const r = await makeSendEbook({
    send: async (m) => {
      sent.push(m);
      return { messageId: 'x' };
    },
  }).run({}, ctx({ choices: new ChoiceStore(path), exec, kindle }));

  assert.equal(r.ok, false);
  assert.match(r.content, /^NO PICK/);
  assert.equal(cmds.length, 0, 'nothing was grabbed');
  assert.equal(sent.length, 0, 'and nothing was mailed');
});

test('🔴 the schema REQUIRES the pick — a refusal only in the handler is one layer of guard', async () => {
  /**
   * Both layers on purpose. `required` is what the model is shown and is the
   * layer that stops the bad call being made; the handler check is what happens
   * when it is made anyway. The description-only version of this rule is the one
   * that already failed once in this repo.
   */
  const send = makeSendEbook({ send: async () => ({ messageId: 'x' }) });
  for (const tool of [addAudiobook, send]) {
    const params = tool.parameters as { required?: string[]; properties?: Record<string, unknown> };
    assert.deepEqual(params.required, ['choice'], `${tool.name} must require a pick`);
    assert.ok(params.properties?.['choice'], `${tool.name} still takes one`);
  }
});

test('the registration invariant still holds — a required choice is still a declared dependency', () => {
  // `requiresChoice` reads the PRESENCE of a `choice` property, so making it
  // required cannot have loosened it. Proven by building the real registry,
  // which throws if a consumed kind has no producer.
  const tools = buildTools(testConfig({ readOnly: false, homelabSshConfigured: true }), undefined, {
    // The ebook pair is atomic and gated on a mail sender, so both halves have
    // to be asked for or neither is registered and the check is vacuous.
    ebook: { send: async () => ({ messageId: 'x' }) },
  });
  const names = new Set(tools.map((t) => t.name));
  assert.ok(names.has('search_ebook') && names.has('send_ebook'), 'the ebook pair is registered');
  assert.ok(names.has('search_audiobook') && names.has('add_audiobook'), 'the audiobook pair is registered');
});

// ═══ 3. THE TV PATH IS UNTOUCHED ════════════════════════════════════════════

/**
 * 🔴 PROVEN BY RUNNING IT, NOT BY NOTING THAT THE FILE WAS NOT EDITED.
 *
 * "I did not change that file" is a claim about a diff. This is a claim about
 * behaviour, and it is the one that matters: the episode path must still choose
 * for itself, still print no numbered list, and its consumer must still act with
 * no argument.
 */

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
const arrRelease = (o: Record<string, unknown>) => ({
  guid: 'guid-live',
  indexerId: 4,
  title: 'Fringe S02E01 1080p AMZN WEB-DL',
  indexer: 'SomeIndexer',
  quality: { quality: { name: 'WEBDL-1080p', resolution: 1080 } },
  seeders: 400,
  size: 2 * 1024 ** 3,
  approved: false,
  rejections: ['not wanted in profile'],
  customFormatScore: 0,
  languages: [{ name: 'English' }],
  ...o,
});

function sonarr(): { fetchImpl: FetchImpl; posts: Record<string, unknown>[] } {
  const posts: Record<string, unknown>[] = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    const u = String(url);
    if ((init?.method ?? 'GET') !== 'GET') {
      posts.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return json({});
    }
    if (u.includes('/episode?')) return json([EPISODE]);
    if (u.includes('/release?')) {
      return json([arrRelease({}), arrRelease({ guid: 'guid-thin', title: 'Fringe S02E01 720p HDTV', seeders: 2 })]);
    }
    if (u.includes('/queue')) return json({ records: [], totalRecords: 0 });
    if (u.endsWith('/series')) return json([SERIES]);
    return json([]);
  };
  return { fetchImpl, posts };
}

test('🔴 TV IS UNCHANGED: search_episode still CHOOSES and still shows no list', async () => {
  const r = await makeSearchEpisode(sonarr().fetchImpl).run(
    { title: 'Fringe', season: 2, episode: 1 },
    ctx(),
  );
  assert.equal(r.ok, true);
  assert.match(r.content, /^CHOSE — /);
  assert.match(r.content, /do NOT ask which torrent/i);
  assert.doesNotMatch(r.content, /^\s*\d+\.\s/m, 'no numbered options on the episode path');
  assert.doesNotMatch(r.content, /ASK WHICH BOOK/, 'and none of the book wording leaked into it');
});

test('🔴 TV IS UNCHANGED: grab_release with NO arguments still grabs the chosen release', async () => {
  const path = tempFile();
  await makeSearchEpisode(sonarr().fetchImpl).run(
    { title: 'Fringe', season: 2, episode: 1 },
    ctx({ choices: new ChoiceStore(path) }),
  );
  const { fetchImpl, posts } = sonarr();
  const r = await makeGrabRelease(fetchImpl).run({}, ctx({ choices: new ChoiceStore(path) }));
  assert.equal(r.ok, true, r.content);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!['guid'], 'guid-live', 'the swarm still decides, with nobody asked');
});

test('🔴 THE STRUCTURAL REASON, stated as a schema assertion', () => {
  /**
   * This is WHY the two paths differ, and it is checkable rather than a claim in
   * a comment. `search_episode` requires a season and an episode, so the work is
   * pinned before any release is ranked. The book searches require only free
   * text, so nothing is pinned and the ranking is asked a question about
   * identity that it cannot answer.
   *
   * ⚠️ WHEN THIS TEST STARTS FAILING BECAUSE A BOOK SEARCH GREW AN IDENTITY
   * ARGUMENT — an Open Library work id or equivalent — that is the real fix
   * landing, and the ask above should be replaced by an auto-pick at that point,
   * not before.
   */
  const req = (t: { parameters: unknown }): string[] => (t.parameters as { required?: string[] }).required ?? [];
  assert.deepEqual(req(makeSearchEpisode(async () => json([]))), ['title', 'season', 'episode']);
  assert.deepEqual(req(makeSearchEbook(async () => json([]))), ['query'], 'free text, and nothing that pins a work');
  assert.deepEqual(req(makeSearchAudiobook(async () => json([]))), ['query']);
});
