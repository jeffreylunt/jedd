import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChoiceStore } from '../src/choices.js';
import type { FetchImpl } from '../src/media/arr.js';
import { POPULAR_KINDS } from '../src/media/tmdb.js';
import { resolveChoice } from '../src/tools/choice.js';
import { buildTools } from '../src/tools/index.js';
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

/** A well-formed TMDB page, so every UNKNOWN case has something to be unlike. */
const page = (results: unknown[]): Promise<Response> =>
  json({ page: 1, results, total_pages: 1, total_results: results.length });

const dead: FetchImpl = () => {
  throw new Error('ECONNREFUSED');
};

const run = (f: FetchImpl, kind = 'trending', over: Partial<ToolContext> = {}) =>
  makeTrending(f).run({ kind }, ctx(over));

const tempFile = () => join(mkdtempSync(join(tmpdir(), 'jedd-trending-')), 'choices.jsonl');

// ── 🔴 THE UNKNOWN RULE. An unreachable TMDB is never "nothing is popular". ──

test('🔴 UNREACHABLE TMDB is UNKNOWN, not an empty answer', async () => {
  const r = await run(dead);
  assert.equal(r.ok, false, 'a gap must not be reported as a successful answer');
  assert.match(r.content, /UNKNOWN/);
  assert.match(r.content, /ECONNREFUSED/);
  assert.doesNotMatch(r.content, /nothing is trending/i);
});

test('🔴 a REJECTED TOKEN is UNKNOWN, and says the credential was the problem', async () => {
  // "TMDB is down" and "our token is bad" lead to completely different actions,
  // and a 401 rendered as "nothing is popular" would hide a dead credential for
  // as long as nobody happened to check.
  const r = await run(() => json({ status_message: 'Invalid API key' }, 401));
  assert.equal(r.ok, false);
  assert.match(r.content, /UNKNOWN/);
  assert.match(r.content, /http 401/);
  assert.match(r.content, /token was rejected/i);
});

test('🔴 a 200 WITH NO RESULTS ARRAY is UNKNOWN — the false zero this shape produces', async () => {
  // `body.results?.length ?? 0` would read this as zero and answer "nothing is
  // popular". A body we cannot parse is a gap in what we know, not a finding.
  const r = await run(() => json({ page: 1, total_results: 0 }));
  assert.equal(r.ok, false);
  assert.match(r.content, /UNKNOWN/);
  assert.match(r.content, /no results array/);
});

test('🔴 a 200 that is not JSON is UNKNOWN and quotes what came back instead', async () => {
  const r = await run(async () => ({ ok: true, status: 200, text: async () => '<!doctype html><html>' }) as Response);
  assert.equal(r.ok, false);
  assert.match(r.content, /UNKNOWN/);
  assert.match(r.content, /not JSON/);
});

test('a body that cannot be READ says so, rather than blaming the JSON', async () => {
  // Folded into one try/catch, a connection dropped mid-body yields raw = '' and
  // the message "the body is not JSON", which sends whoever debugs it after a
  // response-shape change that never happened. Both are UNKNOWN either way, so
  // only the DETAIL distinguishes them -- which is the whole point of it.
  const r = await run(async () =>
    ({
      ok: true,
      status: 200,
      text: async () => {
        throw new Error('terminated');
      },
    }) as unknown as Response);
  assert.equal(r.ok, false);
  assert.match(r.content, /could not be read: terminated/);
  assert.doesNotMatch(r.content, /not JSON/);
});

test('🔴 an ABSENT TMDB TOKEN is UNKNOWN, and explicitly denies being an empty answer', async () => {
  const r = await makeTrending(dead).run({ kind: 'trending' }, ctx({ config: testConfig({ tmdb: { readToken: '' } }) }));
  assert.equal(r.ok, false);
  assert.match(r.content, /not "nothing is popular"/);
});

test('CONTROL: a healthy TMDB DOES answer, so none of the UNKNOWN checks are vacuous', async () => {
  const r = await run(() =>
    page([
      { id: 1084244, media_type: 'movie', title: 'Toy Story 5', release_date: '2026-06-17', vote_average: 8.184 },
      { id: 95350, media_type: 'tv', name: 'Lanterns', first_air_date: '2026-08-16', vote_average: 8.181 },
    ]),
  );
  assert.equal(r.ok, true);
  assert.match(r.content, /1\. Toy Story 5 \(2026\) — film, rated 8\.2\/10 \[tmdbId 1084244\]/);
  assert.match(r.content, /2\. Lanterns \(2026\) — show, rated 8\.2\/10$/, 'and the show line ends there');
  assert.doesNotMatch(r.content, /95350/, 'the show carries no id; the film beside it still does');
});

// ── 🔴 THE ID SPACES. A tmdbId is addable for a FILM and wrong for a SHOW. ───

test('🔴 a FILM option carries `id`, byte-identical to what catalogue_search stores', async () => {
  // Radarr keys films by tmdbId, which IS the id TMDB returned, so this flows
  // straight into add_movie with no second lookup.
  const path = tempFile();
  const choices = new ChoiceStore(path);
  await run(() => page([{ id: 244786, media_type: 'movie', title: 'Whiplash', release_date: '2014-10-10' }]), 'trending', { choices });

  const picked = await resolveChoice.run({ choice: 1 }, ctx({ choices: new ChoiceStore(path) }));
  assert.equal(picked.ok, true);
  const value = JSON.parse(picked.content.slice(picked.content.indexOf('{'))) as Record<string, unknown>;
  assert.deepEqual(value, { arr: 'movie', id: 244786, title: 'Whiplash' });
});

test('🔴 a SHOW EMITS ITS TMDB ID NOWHERE — not in the line, the label, or the value', async () => {
  // Two compounding reasons, and a renamed key guards against neither:
  //   - Sonarr keys shows by tvdbId, so this integer would add a DIFFERENT show.
  //   - TMDB's movie and tv ids are SEPARATE SEQUENCES, so tv id 1396 is also a
  //     real MOVIE id -- making a show's tmdbId a valid, wrong argument to
  //     add_movie, which nothing forbids.
  // So the assertion is on the NUMBER, everywhere it could reach the model, not
  // on the name of a field. An earlier version kept it under `tmdbId` beside a
  // warning; that test passed while the footgun was loaded.
  const path = tempFile();
  const shown = await run(
    () => page([{ id: 1396, media_type: 'tv', name: 'Lanterns', first_air_date: '2026-08-16' }]),
    'trending',
    { choices: new ChoiceStore(path) },
  );
  assert.doesNotMatch(shown.content, /1396/, 'the rendered line must not carry the number either');

  const picked = await resolveChoice.run({ choice: 1 }, ctx({ choices: new ChoiceStore(path) }));
  assert.doesNotMatch(picked.content, /1396/, 'nor the stored label that resolve_choice reprints');
  const value = JSON.parse(picked.content.slice(picked.content.indexOf('{'))) as Record<string, unknown>;
  assert.deepEqual(
    value,
    {
      arr: 'series',
      title: 'Lanterns',
      year: 2026,
      needs: 'a tvdbId — call catalogue_search with this title',
    },
    'a show option carries a title, a year, and no id',
  );
  /**
   * ⚠️ This assertion used to be "no numeric field may survive, whatever it is
   * called", and it fired when `year` was added for `title_details`. Loosening
   * it to allow any number would have reopened the exact hole it exists to
   * close, so it now forbids THE ID specifically, under any key — which is what
   * was always meant. A year cannot be misrouted; an id can.
   */
  assert.equal(
    Object.values(value).includes(1396),
    false,
    'the TMDB id must not appear under ANY key, however it is named',
  );
});

test('🔴 the year on a show option is a YEAR, and is not the id wearing a different name', async () => {
  // The guard above is only as good as the two numbers being distinguishable, so
  // this pins that they are: the id is nowhere, and the year is the air date's.
  const path = tempFile();
  await run(
    () => page([{ id: 2026, media_type: 'tv', name: 'Coincidence', first_air_date: '2019-04-01' }]),
    'trending',
    { choices: new ChoiceStore(path) },
  );
  const picked = await resolveChoice.run({ choice: 1 }, ctx({ choices: new ChoiceStore(path) }));
  const value = JSON.parse(picked.content.slice(picked.content.indexOf('{'))) as Record<string, unknown>;
  assert.equal(value['year'], 2019, 'the year comes from the air date');
  assert.equal(Object.values(value).includes(2026), false, 'and the id is absent even when it LOOKS like a year');
});

// ── what /trending/all actually returns ─────────────────────────────────────

test('🔴 PEOPLE are dropped from /trending/all — a person is not addable media', async () => {
  // media_type "person" is a real and common row in this endpoint. Left in, it
  // would be offered as a numbered option that the next turn tries to add.
  const r = await run(() =>
    page([
      { id: 500, media_type: 'person', name: 'Some Actor' },
      { id: 1084244, media_type: 'movie', title: 'Toy Story 5', release_date: '2026-06-17' },
    ]),
  );
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.content, /Some Actor/);
  assert.match(r.content, /1\. Toy Story 5/, 'and the survivor is renumbered from 1');
});

test('an unrecognised media_type is dropped rather than guessed at', async () => {
  const r = await run(() =>
    page([
      { id: 7, media_type: 'collection', title: 'Some Boxset' },
      { id: 8, media_type: 'movie', title: 'A Real Film' },
    ]),
  );
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.content, /Some Boxset/);
  assert.match(r.content, /1\. A Real Film/);
  assert.match(r.content, /1 of the 2 rows TMDB returned/, 'a partial drop is reported, not hidden');
});

test('🔴 ROWS IN AND NOTHING OUT IS UNKNOWN — a 100% filter is a rename, not a finding', async () => {
  // The false zero one level below the missing-`results` guard: twenty real
  // trending titles in, zero out, reported as "nothing is popular". Any TMDB
  // field rename produces exactly this.
  const r = await run(() =>
    page(Array.from({ length: 20 }, (_, i) => ({ identifier: i + 1, kind: 'movie', headline: `Film ${i}` }))),
  );
  assert.equal(r.ok, false, 'a filter that rejected everything has not answered the question');
  assert.match(r.content, /UNKNOWN/);
  assert.match(r.content, /20 row\(s\)/);
  assert.match(r.content, /identifier, kind, headline/, 'and names the fields, so the rename is diagnosable');
});

test('CONTROL: a genuinely empty TMDB list is still a real answer, not UNKNOWN', async () => {
  // considered === 0 is the honest zero. Collapsing it into the UNKNOWN above
  // would make the guard fire on the one case that IS an answer.
  const r = await run(() => page([]));
  assert.equal(r.ok, true);
  assert.match(r.content, /its list was empty/);
});

test('a row with no title, or no usable id, is dropped rather than rendered blank', async () => {
  const r = await run(() =>
    page([
      { id: 0, media_type: 'movie', title: 'Zero Id' },
      { media_type: 'movie', title: 'No Id At All' },
      { id: 12, media_type: 'movie', title: '   ' },
      { id: 13, media_type: 'movie', title: 'The Survivor' },
    ]),
  );
  assert.equal(r.ok, true);
  assert.match(r.content, /1\. The Survivor — film \[tmdbId 13\]/);
  assert.doesNotMatch(r.content, /Zero Id|No Id At All/);
});

test('an EMPTY title falls through to `name` — `??` would not, and this row would vanish', async () => {
  const r = await run(() => page([{ id: 42, media_type: 'tv', title: '', name: 'Lanterns' }]));
  assert.match(r.content, /1\. Lanterns — show/);
});

test('a missing date yields no year rather than a fabricated one', async () => {
  const r = await run(() => page([{ id: 12, media_type: 'movie', title: 'Untitled Thing' }]));
  assert.match(r.content, /1\. Untitled Thing — film \[tmdbId 12\]/);
});

test('🔴 with NO choice store the tool does not promise a pick can be resolved', async () => {
  // The same rule watchIt() follows for follow-ups: never promise a
  // continuation you did not manage to record. catalogue_search omits the hint
  // when there is nowhere to store the list; so does this.
  const withStore = await run(() => page([{ id: 9, media_type: 'movie', title: 'Film' }]), 'trending', {
    choices: new ChoiceStore(tempFile()),
  });
  assert.match(withStore.content, /resolve_choice/);
  const without = await run(() => page([{ id: 9, media_type: 'movie', title: 'Film' }]));
  assert.doesNotMatch(without.content, /resolve_choice/, 'no store, no promise');
  assert.match(without.content, /1\. Film — film/, 'CONTROL: the list itself is still returned');
});

// ── the enum, and that each value REALLY reaches a different endpoint ────────

test('🔴 every kind hits a DISTINCT TMDB endpoint — the enum is not decorative', async () => {
  // A fixture that never varies cannot see a switch that maps two kinds to the
  // same path. Assert on the URL each kind actually requested.
  const seen = new Map<string, string>();
  for (const kind of POPULAR_KINDS) {
    await run((url) => {
      seen.set(kind, String(url));
      return page([]);
    }, kind);
  }
  assert.deepEqual(
    [...seen.values()],
    [
      'https://api.themoviedb.org/3/trending/all/week',
      'https://api.themoviedb.org/3/trending/movie/week',
      'https://api.themoviedb.org/3/trending/tv/week',
      'https://api.themoviedb.org/3/movie/popular',
      'https://api.themoviedb.org/3/tv/popular',
    ],
  );
  assert.equal(new Set(seen.values()).size, POPULAR_KINDS.length, 'two kinds must not share an endpoint');
});

test('the single-media endpoints do not need media_type, which they do not send', async () => {
  const r = await run(() => page([{ id: 1396, name: 'Breaking Bad', first_air_date: '2008-01-20' }]), 'popular_shows');
  assert.match(r.content, /1\. Breaking Bad \(2008\) — show/);
  const m = await run(() => page([{ id: 244786, title: 'Whiplash', release_date: '2014-10-10' }]), 'popular_movies');
  assert.match(m.content, /1\. Whiplash \(2014\) — film/);
});

test('an unknown kind is refused, and no request is made', async () => {
  let called = false;
  const r = await run(() => {
    called = true;
    return page([]);
  }, 'trending_books');
  assert.equal(r.ok, false);
  assert.equal(called, false, 'a refused argument must produce no request at all');
  assert.match(r.content, /not a list I can ask for/);
});

test('the list is capped, so a text message does not receive twenty titles', async () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, media_type: 'movie', title: `Film ${i + 1}` }));
  const r = await run(() => page(many));
  assert.match(r.content, /10\. Film 10/);
  assert.doesNotMatch(r.content, /11\. Film 11/);
  assert.match(r.content, /10 of the 20 rows TMDB returned/);
});

// ── registration ────────────────────────────────────────────────────────────

test('whats_popular is a guest-visible READ, present even with writes disabled', async () => {
  const tool = makeTrending();
  assert.equal(tool.minRole, 'guest');
  assert.equal(tool.writes, false);
  const names = buildTools(testConfig({ readOnly: true })).map((t) => t.name);
  assert.ok(names.includes('whats_popular'), 'seeing what is popular is less privileged than adding it');
});

test('🔴 with no TMDB token the tool is NOT REGISTERED — absent beats always-failing', async () => {
  const names = buildTools(testConfig({ readOnly: false, tmdb: { readToken: '' } })).map((t) => t.name);
  assert.equal(names.includes('whats_popular'), false);
});
