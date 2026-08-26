import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChoiceStore } from '../src/choices.js';
import type { FetchImpl } from '../src/media/prowlarr.js';
import { addAudiobook } from '../src/tools/add-audiobook.js';
import { ALL_TOOLS, assertChoiceProducersExist, buildTools, registerable } from '../src/tools/index.js';
import { makeSearchAudiobook, makeSearchEbook } from '../src/tools/search-release.js';
import type { Tool, ToolContext } from '../src/tools/types.js';
import { testConfig } from './helpers.js';

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  role: 'guest',
  senderHandle: '+18015550123',
  config: testConfig({ readOnly: false }),
  choices: new ChoiceStore(tempFile()),
  ...over,
});

const tempFile = () => join(mkdtempSync(join(tmpdir(), 'jedd-release-')), 'choices.jsonl');

const json = async (body: unknown, status = 200): Promise<Response> =>
  ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

const release = (o: Partial<Record<string, unknown>> = {}) => ({
  title: 'Project Hail Mary',
  infoHash: HASH_A,
  seeders: 20,
  size: 500 * 1024 ** 2,
  indexer: 'SomeIndexer',
  ...o,
});

const run = (f: FetchImpl, args: Record<string, unknown>, over: Partial<ToolContext> = {}) =>
  makeSearchAudiobook(f).run(args, ctx(over));

// ── 🔴 THE REGRESSION: the producer that did not exist ──────────────────────

test('🔴 READY PLAYER ONE: an audiobook search returns a numbered list add_audiobook can resolve', async () => {
  // Jeff, live: "Can you get the ready player one audiobook?" -> "I don't have
  // an audiobook search tool." add_audiobook was registered and uncallable.
  const path = tempFile();
  const store = new ChoiceStore(path);
  const r = await run(
    async () => json([release({ title: 'Ready Player One', infoHash: HASH_A })]),
    { query: 'Ready Player One' },
    { choices: store },
  );
  assert.equal(r.ok, true);
  assert.match(r.content, /1\. Ready Player One/);
  assert.match(r.content, /call add_audiobook with their number/);
  assert.match(r.content, /Nothing is downloading yet/);

  // 🔴 The point of the whole exercise: the consumer can now resolve the pick.
  const picked = new ChoiceStore(path).resolve('+18015550123', 1);
  assert.equal(picked.ok, true);
  assert.equal(picked.ok && picked.option.value['infoHash'], HASH_A);
});

test('🔴 the stored option is EXACTLY the shape add_audiobook already reads', async () => {
  // The consumer ships and its contract is what the model has been told, so the
  // producer matches it rather than the other way round.
  const path = tempFile();
  await run(
    async () => json([release({ infoHash: HASH_A, guid: `magnet:?xt=urn:btih:${HASH_A}&tr=x` })]),
    { query: 'x' },
    { choices: new ChoiceStore(path) },
  );
  const picked = new ChoiceStore(path).resolve('+18015550123', 1);
  assert.ok(picked.ok);
  assert.deepEqual(picked.option.value, {
    // `source` was added when IRC became a second source. It is the discriminant
    // `send_ebook` switches on, so the consumer never has to guess which fetcher
    // a pick belongs to.
    source: 'prowlarr',
    infoHash: HASH_A,
    title: 'Project Hail Mary',
    magnetUri: `magnet:?xt=urn:btih:${HASH_A}&tr=x`,
  });
});

test('the indexer\'s OWN magnet is preferred, and absent when there is none', async () => {
  const path = tempFile();
  await run(async () => json([release({ guid: 'https://indexer/download/1' })]), { query: 'x' }, {
    choices: new ChoiceStore(path),
  });
  const picked = new ChoiceStore(path).resolve('+18015550123', 1);
  assert.ok(picked.ok);
  assert.equal('magnetUri' in picked.option.value, false, 'a non-magnet guid is not stored as one');
});

test('search_ebook is the same producer pointed at the ebook category and send_ebook', async () => {
  let url = '';
  const r = await makeSearchEbook(async (u) => {
    url = String(u);
    return json([release()]);
  }).run({ query: 'Project Hail Mary' }, ctx());
  assert.equal(r.ok, true);
  assert.match(url, /categories=7020/, 'ebooks are Prowlarr category 7020');
  assert.match(r.content, /call send_ebook with their number/);
});

test('search_audiobook uses the audiobook category', async () => {
  let url = '';
  await run(async (u) => {
    url = String(u);
    return json([release()]);
  }, { query: 'x' });
  assert.match(url, /categories=3030/, 'audiobooks are Prowlarr category 3030');
});

// ── 🔴 UNKNOWN IS NEVER "NO AUDIOBOOKS FOUND" ───────────────────────────────

test('🔴 an unreachable Prowlarr is UNKNOWN, not "nothing found"', async () => {
  const r = await run(() => {
    throw new Error('ECONNREFUSED');
  }, { query: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.content, /UNKNOWN/);
  assert.match(r.content, /NOT a finding that nothing exists/);
});

test('🔴 an http error from Prowlarr is UNKNOWN, not "none"', async () => {
  const r = await run(async () => json({}, 500), { query: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.content, /UNKNOWN/);
});

test('🔴 an unconfigured Prowlarr is UNKNOWN and says it is not an absence', async () => {
  let called = false;
  const r = await run(
    async () => {
      called = true;
      return json([]);
    },
    { query: 'x' },
    { config: testConfig({ readOnly: false, prowlarr: { baseUrl: 'http://p.invalid', apiKey: '' } }) },
  );
  assert.equal(r.ok, false);
  assert.match(r.content, /not "no audiobooks exist"/);
  assert.equal(called, false);
});

test('CONTROL: a real empty result IS a finding — NONE, not UNKNOWN', async () => {
  const r = await run(async () => json([]), { query: 'x' });
  assert.equal(r.ok, true);
  assert.match(r.content, /^NONE/);
  assert.doesNotMatch(r.content, /UNKNOWN/);
});

test('found-but-unfetchable is reported distinctly from found-nothing', async () => {
  // A release with no infoHash cannot be grabbed at all; saying "nothing found"
  // would be a different, wrong answer.
  const r = await run(async () => json([release({ infoHash: 'not-a-hash' })]), { query: 'x' });
  assert.match(r.content, /none carried an infoHash/);
});

test('a partly-unfetchable result set says how many were dropped', async () => {
  const r = await run(
    async () => json([release({ infoHash: HASH_A }), release({ infoHash: 'nope' })]),
    { query: 'x' },
  );
  assert.equal(r.ok, true);
  assert.match(r.content, /1 more had no infoHash and cannot be fetched/);
});

// ── 🔴 A FILTER THAT ATE EVERYTHING IS NOT AN ABSENCE ───────────────────────

test('🔴 GraphicAudio: when the filter removes them ALL, it says so rather than "none found"', async () => {
  const r = await run(
    async () => json([release({ title: 'Project Hail Mary [GraphicAudio]' }), release({ title: 'PHM Graphic Audio', infoHash: HASH_B })]),
    { query: 'Project Hail Mary' },
  );
  assert.equal(r.ok, true);
  assert.match(r.content, /FILTERED OUT/);
  assert.match(r.content, /found 2 audiobook release\(s\)/);
  assert.match(r.content, /EVERY one is a GraphicAudio/);
  assert.doesNotMatch(r.content, /^NONE/);
});

test('asking FOR GraphicAudio when there are none says that, not "no audiobooks"', async () => {
  const r = await run(async () => json([release()]), { query: 'x', graphic_audio: true });
  assert.match(r.content, /FILTERED OUT/);
  assert.match(r.content, /NONE of them are GraphicAudio/);
});

test('GraphicAudio releases are excluded by default and the exclusion is COUNTED', async () => {
  const r = await run(
    async () =>
      json([release({ infoHash: HASH_A }), release({ title: 'PHM GRAPHIC-AUDIO', infoHash: HASH_B })]),
    { query: 'x' },
  );
  assert.equal(r.ok, true);
  assert.match(r.content, /1 GraphicAudio release\(s\) left out/);
  assert.doesNotMatch(r.content, /GRAPHIC-AUDIO/);
});

test('graphic_audio: true keeps ONLY the dramatisations', async () => {
  const r = await run(
    async () =>
      json([release({ infoHash: HASH_A }), release({ title: 'PHM GraphicAudio', infoHash: HASH_B })]),
    { query: 'x', graphic_audio: true },
  );
  assert.match(r.content, /1\. PHM GraphicAudio/);
  assert.doesNotMatch(r.content, /1\. Project Hail Mary —/);
});

// ── list mechanics ──────────────────────────────────────────────────────────

test('dead releases sort below live ones — a zero-seeder grab never completes', async () => {
  const r = await run(
    async () =>
      json([
        release({ title: 'Dead', infoHash: HASH_A, seeders: 0 }),
        release({ title: 'Alive', infoHash: HASH_B, seeders: 9 }),
      ]),
    { query: 'x' },
  );
  assert.match(r.content, /1\. Alive/);
  assert.match(r.content, /2\. Dead/);
});

test('the list is capped at 5 and SAYS so', async () => {
  const many = Array.from({ length: 9 }, (_, i) =>
    release({ title: `Release ${i}`, infoHash: `${i}`.repeat(40).slice(0, 40), seeders: 20 - i }),
  );
  const r = await run(async () => json(many), { query: 'x' });
  assert.match(r.content, /showing the top 5 of 9/);
  assert.doesNotMatch(r.content, /6\. /);
});

test('🔴 with no choice store it refuses — a list nothing can resolve is not an offer', async () => {
  // Unlike catalogue_search there is no alternative route: add_audiobook takes
  // ONLY a pick, so an unstorable list offers a flow that cannot complete.
  const r = await run(async () => json([release()]), { query: 'x' }, { choices: undefined });
  assert.equal(r.ok, false);
  assert.match(r.content, /nowhere to record a numbered list/);
});

test('an empty query asks rather than searching for nothing', async () => {
  let called = false;
  const r = await run(
    async () => {
      called = true;
      return json([]);
    },
    { query: '   ' },
  );
  assert.equal(r.ok, false);
  assert.equal(called, false);
});

// ── 🔴 THE INVARIANT: a consumer without a producer must not boot ───────────

test('🔴 a "release" consumer with NO registered producer REFUSES to register', async () => {
  /**
   * The exact state add_audiobook and send_ebook shipped in: registered,
   * booting, in the live tool line, uncallable. Every check we had passed,
   * because they all quantify over declarations and none knew that one tool's
   * required argument is another tool's output.
   */
  const orphan = ALL_TOOLS.filter((t) => t.name === 'add_audiobook');
  assert.equal(orphan.length, 1, 'CONTROL: the consumer exists to be orphaned');
  assert.throws(
    () => registerable(orphan, testConfig({ readOnly: false })),
    /resolves a "release" choice, but NO registered tool presents one/,
  );
});

test('CONTROL: the same consumer registers fine once its producer is present', async () => {
  const pair = ALL_TOOLS.filter((t) => t.name === 'add_audiobook' || t.name === 'search_audiobook');
  assert.equal(pair.length, 2);
  assert.doesNotThrow(() => registerable(pair, testConfig({ readOnly: false })));
});

test('🔴 a tool REQUIRING a choice without declaring the kind is REFUSED, not defaulted', async () => {
  // Detected from the SCHEMA, so an author cannot forget it — the same
  // discipline as `writes`, and for the same reason.
  const undeclared: Tool = {
    name: 'mystery_consumer',
    description: 'x'.repeat(30),
    minRole: 'guest',
    writes: false,
    parameters: { type: 'object', properties: { choice: { type: 'number' } }, required: ['choice'] },
    run: async () => ({ ok: true, content: '' }),
  };
  assert.throws(() => registerable([undeclared], testConfig()), /does not declare consumesChoiceKind/);
});

test("resolve_choice's '*' is exempt, because it genuinely resolves any kind", async () => {
  const generic = ALL_TOOLS.filter((t) => t.name === 'resolve_choice');
  assert.equal(generic[0]?.consumesChoiceKind, '*');
  assert.doesNotThrow(() => registerable(generic, testConfig()));
});

test('🔴 the SHIPPED registry satisfies it, in both read-only and write modes', async () => {
  // The read-only build is checked AS the read-only build: a producer that was a
  // write tool would vanish with writes off, and that would be a real hole.
  assert.doesNotThrow(() => buildTools(testConfig({ readOnly: true })));
  assert.doesNotThrow(() => buildTools(testConfig({ readOnly: false })));
  assert.doesNotThrow(() => assertChoiceProducersExist(ALL_TOOLS));
});

test('every choice-consuming tool in the shipped registry has a live producer', async () => {
  const built = buildTools(testConfig({ readOnly: false }));
  const produced = new Set(built.flatMap((t) => t.presentsChoiceKinds ?? []));
  const consumed = built.map((t) => t.consumesChoiceKind).filter((k): k is string => !!k && k !== '*');
  assert.ok(consumed.length >= 2, `CONTROL: found only ${consumed.length} consumers`);
  for (const k of consumed) assert.ok(produced.has(k), `nothing produces "${k}"`);
});

test('add_audiobook is reachable end to end: search stores, consumer resolves', async () => {
  // Not a mock of the pick — the real consumer, reading the real store.
  const path = tempFile();
  await run(async () => json([release({ infoHash: HASH_A })]), { query: 'x' }, { choices: new ChoiceStore(path) });
  const out = await addAudiobook.run(
    { choice: 1 },
    ctx({ choices: new ChoiceStore(path), config: testConfig({ readOnly: true }) }),
  );
  // Writes are off, so it refuses — but it refuses for THAT reason, having
  // resolved the pick, rather than for "no list".
  assert.match(out.content, /Writes are disabled/);
  assert.doesNotMatch(out.content, /NONE —|no list/i);
});

// ── the SECOND axis: a tool that NAMES a producer in its description ────────

test('🔴 removing catalogue_search fails add_movie AND add_series', async () => {
  /**
   * The mutation team-lead specified. This axis catches a different set from the
   * structural one and neither subsumes the other: `add_movie` takes a
   * `tmdb_id`, not a `choice`, so the choice-kind check cannot see its
   * dependency — it is stated only in prose ("use the tmdbId from
   * catalogue_search") that nothing read until now.
   */
  for (const consumer of ['add_movie', 'add_series']) {
    const without = ALL_TOOLS.filter((t) => t.name === consumer);
    assert.throws(
      () => registerable(without, testConfig({ readOnly: false })),
      new RegExp(`Tool "${consumer}" tells the model to use "catalogue_search", which is NOT registered`),
      `${consumer} must not register without its named producer`,
    );
  }
});

test('CONTROL: both register fine WITH catalogue_search present', async () => {
  const withIt = ALL_TOOLS.filter((t) =>
    ['add_movie', 'add_series', 'catalogue_search'].includes(t.name),
  );
  assert.equal(withIt.length, 3);
  assert.doesNotThrow(() => registerable(withIt, testConfig({ readOnly: false })));
});

test('🔴 the two axes catch DIFFERENT tools — neither check is redundant', async () => {
  // A name scan cannot see add_audiobook's dependency ("an audiobook search" is
  // not a tool name); the structural check cannot see add_movie's (it takes a
  // tmdb_id, not a choice). Both are needed, and this pins that.
  const audiobook = ALL_TOOLS.find((t) => t.name === 'add_audiobook')!;
  assert.doesNotMatch(audiobook.description, /search_audiobook/, 'names no producer — only the structural check sees it');
  assert.equal(audiobook.consumesChoiceKind, 'release');

  const movie = ALL_TOOLS.find((t) => t.name === 'add_movie')!;
  assert.match(movie.description, /catalogue_search/, 'names its producer — only the name check sees it');
  assert.equal(movie.consumesChoiceKind, undefined, 'and it consumes no choice at all');
});

test('🔴 the EBOOK PAIR is atomic: no SMTP credential means neither half registers', async () => {
  // search_ebook's description says "call send_ebook with their number". With no
  // SMTP credential send_ebook does not exist, so search_ebook shipped a flow
  // whose second step was absent — books found, none sendable. Caught by the
  // name check on its first run.
  const withSmtp = buildTools(testConfig({ readOnly: false }), undefined, {
    ebook: { send: async () => ({ messageId: 'x' }) },
  }).map((t) => t.name);
  assert.ok(withSmtp.includes('send_ebook') && withSmtp.includes('search_ebook'), 'both, with a credential');

  const noSmtp = buildTools(
    testConfig({ readOnly: false, kindle: { smtpHost: 'x', smtpPort: 1, fromEmail: 'a@b', smtpPassword: '' } }),
    undefined,
    { ebook: { send: async () => ({ messageId: 'x' }) } },
  ).map((t) => t.name);
  assert.equal(noSmtp.includes('send_ebook'), false);
  assert.equal(noSmtp.includes('search_ebook'), false, 'and the producer goes with it');
});
