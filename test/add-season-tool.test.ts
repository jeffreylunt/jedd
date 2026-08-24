import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FetchImpl } from '../src/media/arr.js';
import { makeAddSeason } from '../src/tools/add-season.js';
import { buildTools } from '../src/tools/index.js';
import type { ToolContext } from '../src/tools/types.js';
import { testConfig } from './helpers.js';

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  role: 'guest',
  senderHandle: '+18015550123',
  config: testConfig({ readOnly: false }),
  ...over,
});

const json = async (body: unknown, status = 200): Promise<Response> =>
  ({ ok: status < 400, status, text: async () => JSON.stringify(body) }) as Response;

/** One Sonarr `/series` row. `stats` is per season: [have, total, monitored]. */
function seriesRow(opts: {
  id?: number;
  tvdbId?: number;
  title?: string;
  monitored?: boolean;
  stats: Record<number, [number, number, boolean]>;
}) {
  return {
    id: opts.id ?? 77,
    tvdbId: opts.tvdbId ?? 79169,
    title: opts.title ?? 'Seinfeld',
    year: 1989,
    monitored: opts.monitored ?? true,
    // A field nothing here reads, present to prove the PUT does not drop it.
    rootFolderPath: '/external/jellyfin/Videos/TV',
    qualityProfileId: 9,
    seasons: Object.entries(opts.stats).map(([n, [have, total, monitored]]) => ({
      seasonNumber: Number(n),
      monitored,
      statistics: { episodeFileCount: have, totalEpisodeCount: total },
    })),
  };
}

interface Recorded {
  puts: { path: string; body: Record<string, unknown> }[];
  commands: Record<string, unknown>[];
  gets: string[];
}

/**
 * A Sonarr that behaves. `putResponse` lets a test bend only the read-back,
 * which is the surface every honesty claim in this tool rests on.
 */
function sonarr(
  row: Record<string, unknown>,
  opts: {
    putResponse?: (sent: Record<string, unknown>) => Promise<Response>;
    commandResponse?: () => Promise<Response>;
    listResponse?: () => Promise<Response>;
  } = {},
): { fetchImpl: FetchImpl; rec: Recorded } {
  const rec: Recorded = { puts: [], commands: [], gets: [] };
  const fetchImpl: FetchImpl = async (url, init) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (method === 'GET') {
      rec.gets.push(u);
      if (opts.listResponse && u.endsWith('/series')) return opts.listResponse();
      if (u.endsWith('/series')) return json([row]);
      if (/\/series\/\d+$/.test(u)) return json(row);
      return json([]);
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (method === 'PUT') {
      rec.puts.push({ path: u, body });
      return opts.putResponse ? opts.putResponse(body) : json(body);
    }
    rec.commands.push(body);
    return opts.commandResponse ? opts.commandResponse() : json({ id: 1 });
  };
  return { fetchImpl, rec };
}

const run = (f: FetchImpl, seasons: number[], title = 'seinfeld', over: Partial<ToolContext> = {}) =>
  makeAddSeason(f).run({ title, seasons }, ctx(over));

/** Seinfeld as Jeff actually hit it: S1 held, S2-S9 unmonitored and empty. */
const SEINFELD = seriesRow({
  stats: { 1: [24, 24, true], 2: [0, 12, false], 3: [0, 23, false], 4: [0, 24, false] },
});

// ── 🔴 THE REGRESSION, END TO END ───────────────────────────────────────────

test('🔴 SEINFELD S3: a season of a show already in the library is monitored AND searched', async () => {
  // The live case. V2 had no verb for this at all and told Jeff to go and do it
  // himself in Sonarr; V1 has had one since 2026-08-20.
  const { fetchImpl, rec } = sonarr(SEINFELD);
  const r = await run(fetchImpl, [3]);

  assert.equal(r.ok, true);
  assert.match(r.content, /^STARTED/);
  assert.match(r.content, /S3 monitored and searching/);

  assert.equal(rec.puts.length, 1, 'exactly one series update');
  const sent = rec.puts[0]!.body['seasons'] as { seasonNumber: number; monitored: boolean }[];
  assert.deepEqual(
    sent.map((s) => [s.seasonNumber, s.monitored]),
    [
      [1, true],
      [2, false],
      [3, true],
      [4, false],
    ],
    '🔴 ONLY S3 flipped — S2 and S4 must be left exactly as they were',
  );

  assert.deepEqual(rec.commands, [{ name: 'SeasonSearch', seriesId: 77, seasonNumber: 3 }]);
});

test('🔴 the PUT sends the WHOLE series object back, not a patch', async () => {
  // Sonarr's PUT replaces the resource: a partial body drops root folder,
  // quality profile and tags, quietly reconfiguring the show we were asked to
  // add one season to.
  const { fetchImpl, rec } = sonarr(SEINFELD);
  await run(fetchImpl, [3]);
  const body = rec.puts[0]!.body;
  assert.equal(body['rootFolderPath'], '/external/jellyfin/Videos/TV');
  assert.equal(body['qualityProfileId'], 9);
  assert.equal(body['tvdbId'], 79169);
  assert.equal(body['id'], 77);
});

test('🔴 MONITORING IS NOT DOWNLOADING: a failed search is NOT reported as started', async () => {
  // Sonarr does not search a season because it was switched on. Collapsing these
  // two reports "on its way" for a show doing nothing at all — and "monitored"
  // looks exactly like "coming" to anyone glancing at the UI.
  const { fetchImpl, rec } = sonarr(SEINFELD, { commandResponse: () => json({ error: 'nope' }, 500) });
  const r = await run(fetchImpl, [3]);

  assert.equal(r.ok, false, 'a season that is not searching is not a success');
  assert.match(r.content, /MONITORED BUT NOT SEARCHING/);
  assert.match(r.content, /NOTHING IS DOWNLOADING/);
  assert.match(r.content, /Do not say it is on its way/);
  assert.equal(rec.puts.length, 1, 'CONTROL: the monitoring change really was made');
});

test('a season that switched on but could not be searched is named, beside the ones that did', async () => {
  let n = 0;
  const { fetchImpl } = sonarr(seriesRow({ stats: { 2: [0, 12, false], 3: [0, 23, false] } }), {
    commandResponse: async () => (++n === 1 ? json({ id: 1 }) : json({}, 500)),
  });
  const r = await run(fetchImpl, [2, 3]);
  assert.equal(r.ok, true);
  assert.match(r.content, /S2 monitored and searching/);
  assert.match(r.content, /S3 switched on but could NOT be searched, so nothing is downloading/);
});

// ── 🔴 SUCCESS IS READ BACK, NEVER ASSUMED ──────────────────────────────────

test('🔴 a PUT that ACCEPTS but does not actually monitor is a FAILURE, not a success', async () => {
  // Sonarr answers 200 with a series whose season is still off. Reporting the
  // seasons we SENT would call this a win — that is reporting our own intention.
  const { fetchImpl, rec } = sonarr(SEINFELD, {
    putResponse: () => json(SEINFELD), // unchanged: S3 still monitored:false
  });
  const r = await run(fetchImpl, [3]);
  assert.equal(r.ok, false);
  assert.match(r.content, /did not come back monitored/);
  assert.match(r.content, /nothing was queued/);
  assert.equal(rec.commands.length, 0, 'and no search is fired for a season that did not switch on');
});

test('🔴 a 200 whose read-back has NO season list is UNKNOWN, not success', async () => {
  const { fetchImpl } = sonarr(SEINFELD, { putResponse: () => json({ ok: true }) });
  const r = await run(fetchImpl, [3]);
  assert.equal(r.ok, false);
  assert.match(r.content, /UNKNOWN/);
  assert.match(r.content, /cannot confirm what changed/);
});

// ── 🔴 UNREACHABLE SONARR IS UNKNOWN, NEVER A FALSE SUCCESS ─────────────────

test('🔴 an unreachable Sonarr on the READ is UNKNOWN and changes nothing', async () => {
  const r = await run(() => {
    throw new Error('ECONNREFUSED');
  }, [3]);
  assert.equal(r.ok, false);
  assert.match(r.content, /UNKNOWN/);
  assert.match(r.content, /NOTHING was changed/);
});

test('🔴 an unreachable Sonarr on the WRITE is UNKNOWN — the change may or may not have landed', async () => {
  const { fetchImpl } = sonarr(SEINFELD, {
    putResponse: () => {
      throw new Error('ECONNRESET');
    },
  });
  const r = await run(fetchImpl, [3]);
  assert.equal(r.ok, false);
  assert.match(r.content, /UNKNOWN/);
  assert.match(r.content, /Do not say the season was or was not started/);
});

test('a Sonarr that REFUSES the update reports FAILED, distinctly from UNKNOWN', async () => {
  const { fetchImpl } = sonarr(SEINFELD, { putResponse: () => json({ message: 'bad request' }, 400) });
  const r = await run(fetchImpl, [3]);
  assert.equal(r.ok, false);
  assert.match(r.content, /FAILED/);
  assert.match(r.content, /http 400/);
  assert.doesNotMatch(r.content, /UNKNOWN/);
});

// ── 🔴 A SPECIFIC ASK IS NEVER WIDENED INTO "ALL SEASONS" ───────────────────

test('🔴 PEPPA PIG: an EMPTY season list ASKS — it never means "all of them"', async () => {
  // V1's add_tv fell through an empty clamp to every season: a guest asked for
  // "the first 3 seasons" of Peppa Pig and got 1-9, then S5 arrived at 52/52
  // while the requested S2 and S3 sat at 0/52 five months later.
  const { fetchImpl, rec } = sonarr(SEINFELD);
  const r = await run(fetchImpl, []);
  assert.equal(r.ok, false);
  assert.match(r.content, /ASK which season/);
  assert.match(r.content, /do not add every season/i);
  assert.equal(rec.puts.length, 0, 'and NOTHING was written');
  assert.equal(rec.commands.length, 0);
});

test('🔴 a season the show does not have ASKS, naming what it does have — it does not pick one', async () => {
  const { fetchImpl, rec } = sonarr(SEINFELD);
  const r = await run(fetchImpl, [77]);
  assert.equal(r.ok, false);
  assert.match(r.content, /has no season 77/);
  assert.match(r.content, /S1, S2, S3, S4/);
  assert.match(r.content, /Ask which of those/);
  assert.equal(rec.puts.length, 0);
});

test('a partly-valid ask proceeds with the real seasons and NAMES the ones that do not exist', async () => {
  const { fetchImpl, rec } = sonarr(SEINFELD);
  const r = await run(fetchImpl, [3, 77]);
  assert.equal(r.ok, true);
  assert.match(r.content, /S3 monitored and searching/);
  assert.match(r.content, /no season 77 exists for this show/);
  const sent = rec.puts[0]!.body['seasons'] as { seasonNumber: number; monitored: boolean }[];
  assert.equal(sent.filter((s) => s.monitored).length, 2, 'S1 was already on, S3 is the only flip');
});

// ── already-complete is a clean no-op ───────────────────────────────────────

test('🔴 a season already fully on disk is a NO-OP — no write, no redundant re-grab', async () => {
  const { fetchImpl, rec } = sonarr(SEINFELD);
  const r = await run(fetchImpl, [1]);
  assert.equal(r.ok, true, 'nothing to do is an answer, not a failure');
  assert.match(r.content, /NOTHING TO DO/);
  assert.match(r.content, /already fully downloaded/);
  assert.equal(rec.puts.length, 0, 'no write at all');
  assert.equal(rec.commands.length, 0, 'and above all no search');
});

test('a mixed ask gets only the incomplete season, and says the other was left alone', async () => {
  const { fetchImpl, rec } = sonarr(SEINFELD);
  const r = await run(fetchImpl, [1, 3]);
  assert.equal(r.ok, true);
  assert.match(r.content, /S3 monitored and searching/);
  assert.match(r.content, /S1 already complete, left alone/);
  assert.deepEqual(rec.commands, [{ name: 'SeasonSearch', seriesId: 77, seasonNumber: 3 }]);
});

test('🔴 a 0/0 season is NOT treated as complete — it is searched, not skipped', async () => {
  // `have >= total` is satisfied by 0/0. Ordering `total <= 0` first is the
  // whole guard, and it is the difference between "you have it" and "we never
  // looked". Shared with library_search via bucket().
  const { fetchImpl, rec } = sonarr(seriesRow({ stats: { 5: [0, 0, false] } }));
  const r = await run(fetchImpl, [5]);
  assert.equal(r.ok, true);
  assert.match(r.content, /S5 monitored and searching/);
  assert.equal(rec.commands.length, 1);
});

// ── state changes beyond what was asked for are REPORTED ────────────────────

test('🔴 an unmonitored SERIES is switched back on, and that is reported, not silent', async () => {
  // A series toggled off grabs nothing however many seasons are on — so it must
  // be flipped. It is still a change beyond the ask, so it is named.
  const row = seriesRow({ monitored: false, stats: { 3: [0, 23, false] } });
  const { fetchImpl, rec } = sonarr(row);
  const r = await run(fetchImpl, [3]);
  assert.equal(r.ok, true);
  assert.equal(rec.puts[0]!.body['monitored'], true);
  assert.match(r.content, /the show itself was unmonitored and has been switched back on/);
});

test('🔴 a season that moved WITHOUT being asked for is flagged — the blast radius is reported', async () => {
  const row = seriesRow({ stats: { 2: [0, 12, true], 3: [0, 23, false] } });
  // Sonarr answers with S2 silently turned OFF, which nobody requested.
  const { fetchImpl } = sonarr(row, {
    putResponse: () => json(seriesRow({ stats: { 2: [0, 12, false], 3: [0, 23, true] } })),
  });
  const r = await run(fetchImpl, [3]);
  assert.equal(r.ok, true);
  assert.match(r.content, /S2 also changed state, which was not asked for/);
});

// ── resolution and gating ───────────────────────────────────────────────────

test('a show that is NOT in the library says so, and points at the tool that can add it', async () => {
  const { fetchImpl, rec } = sonarr(SEINFELD, { listResponse: () => json([]) });
  const r = await run(fetchImpl, [3], 'firefly');
  assert.equal(r.ok, false);
  assert.match(r.content, /NOT IN THE LIBRARY/);
  assert.match(r.content, /catalogue_search/);
  assert.match(r.content, /add_series/);
  assert.equal(rec.puts.length, 0);
});

test('two matching shows is AMBIGUOUS — it asks rather than picking one to write to', async () => {
  const a = seriesRow({ id: 1, tvdbId: 11, title: 'The Office', stats: { 3: [0, 23, false] } });
  const b = seriesRow({ id: 2, tvdbId: 22, title: 'The Office (US)', stats: { 3: [0, 23, false] } });
  const rec: Recorded = { puts: [], commands: [], gets: [] };
  const fetchImpl: FetchImpl = async (url, init) => {
    if ((init?.method ?? 'GET') !== 'GET') {
      rec.puts.push({ path: String(url), body: {} });
      return json({});
    }
    return json([a, b]);
  };
  const r = await makeAddSeason(fetchImpl).run({ title: 'the office', seasons: [3] }, ctx());
  assert.equal(r.ok, false);
  assert.match(r.content, /AMBIGUOUS/);
  assert.match(r.content, /Nothing was changed/);
  assert.equal(rec.puts.length, 0);
});

test('🔴 with writes disabled it refuses, and makes no request at all', async () => {
  let called = false;
  const r = await makeAddSeason(async () => {
    called = true;
    return json([SEINFELD]);
  }).run({ title: 'seinfeld', seasons: [3] }, ctx({ config: testConfig({ readOnly: true }) }));
  assert.equal(r.ok, false);
  assert.match(r.content, /Writes are disabled/);
  assert.equal(called, false, 'a refusal that still read Sonarr would be a refusal in name only');
});

test('🔴 add_season is a guest WRITE: present with writes on, absent with them off', async () => {
  const tool = makeAddSeason();
  assert.equal(tool.minRole, 'guest');
  assert.equal(tool.writes, true);
  assert.ok(buildTools(testConfig({ readOnly: false })).some((t) => t.name === 'add_season'));
  assert.equal(
    buildTools(testConfig({ readOnly: true })).some((t) => t.name === 'add_season'),
    false,
    'the read-only kill switch must cover the newest guest write',
  );
});

// ── the follow-up, and the id space that makes it wrong ─────────────────────

test('🔴 the follow-up records the TVDB id, never Sonarr internal id', async () => {
  // progress() looks the subject up with rows.find(r => r.tvdbId === id). Sonarr's
  // internal id (77) matches nothing, and the follow-up then tells the user the
  // show "is not in the library listing at all" — a show that reads as vanished.
  const scheduled: { arr: string; id: number; seasons: number[] }[] = [];
  const followups = {
    pendingForSubject: () => false,
    schedule: (f: { subject: { arr: string; id: number; seasons: number[] } }) => scheduled.push(f.subject),
  } as unknown as ToolContext['followups'];

  const { fetchImpl } = sonarr(SEINFELD);
  const r = await run(fetchImpl, [3], 'seinfeld', { followups });
  assert.equal(r.ok, true);
  assert.deepEqual(scheduled, [{ arr: 'series', id: 79169, seasons: [3], title: 'Seinfeld' }]);
  assert.notEqual(scheduled[0]!.id, 77, 'the Sonarr internal id must never reach progress()');
});

test('🔴 no tvdbId means NO follow-up and no promise of one', async () => {
  const scheduled: unknown[] = [];
  const followups = {
    pendingForSubject: () => false,
    schedule: (f: unknown) => scheduled.push(f),
  } as unknown as ToolContext['followups'];
  const row = { ...seriesRow({ stats: { 3: [0, 23, false] } }), tvdbId: 0 };
  const { fetchImpl } = sonarr(row);
  const r = await run(fetchImpl, [3], 'seinfeld', { followups });
  assert.equal(r.ok, true, 'CONTROL: the season itself still started');
  assert.match(r.content, /S3 monitored and searching/);
  assert.equal(scheduled.length, 0);
  assert.doesNotMatch(r.content, /I will check back/);
});
