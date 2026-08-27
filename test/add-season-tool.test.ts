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
    rootFolderPath: '/media/tv',
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
 * 🔴 A STATEFUL Sonarr: the PUT REPLACES the stored series, and every later GET
 * returns what was stored.
 *
 * The first version of this helper echoed the PUT body back and served the
 * ORIGINAL row from GET — which quietly made it the wrong instrument the moment
 * the tool started verifying with a fresh read. A fake whose write does not
 * persist cannot tell a write that landed from one that did not, which is the
 * only question this tool asks.
 *
 * `putResponse` / `afterResponse` bend the two reads independently:
 *   putResponse   — what the PUT itself answers (status codes, refusals)
 *   afterResponse — what the VERIFYING GET sees, i.e. what really persisted.
 * That second seam is how a lost update is expressed: Sonarr accepted us, and
 * the world afterwards does not match.
 */
function sonarr(
  row: Record<string, unknown>,
  opts: {
    putResponse?: (sent: Record<string, unknown>) => Promise<Response>;
    afterResponse?: (stored: Record<string, unknown>) => Promise<Response>;
    commandResponse?: () => Promise<Response>;
    listResponse?: () => Promise<Response>;
  } = {},
): { fetchImpl: FetchImpl; rec: Recorded } {
  const rec: Recorded = { puts: [], commands: [], gets: [] };
  let stored = row;
  let writes = 0;
  const fetchImpl: FetchImpl = async (url, init) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (method === 'GET') {
      rec.gets.push(u);
      if (opts.listResponse && u.endsWith('/series')) return opts.listResponse();
      if (u.endsWith('/series')) return json([stored]);
      if (/\/series\/\d+$/.test(u)) {
        // The VERIFYING read is any single-series GET after a write.
        if (writes > 0 && opts.afterResponse) return opts.afterResponse(stored);
        return json(stored);
      }
      return json([]);
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (method === 'PUT') {
      rec.puts.push({ path: u, body });
      writes += 1;
      const res = opts.putResponse ? await opts.putResponse(body) : await json(body);
      // A refused write changes nothing, exactly as Sonarr behaves.
      if (res.ok) stored = body;
      return res;
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
  assert.equal(body['rootFolderPath'], '/media/tv');
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
    // Sonarr answers 200 and the world afterwards is unchanged: S3 still off.
    afterResponse: () => json(SEINFELD),
  });
  const r = await run(fetchImpl, [3]);
  assert.equal(r.ok, false);
  assert.match(r.content, /did not come back monitored/);
  assert.match(r.content, /nothing was queued/);
  assert.equal(rec.commands.length, 0, 'and no search is fired for a season that did not switch on');
});

test('🔴 a 200 whose read-back has NO season list is UNKNOWN, not success', async () => {
  const { fetchImpl } = sonarr(SEINFELD, { afterResponse: () => json({ ok: true }) });
  const r = await run(fetchImpl, [3]);
  assert.equal(r.ok, false);
  assert.match(r.content, /UNKNOWN/);
  assert.match(r.content, /could not be re-read afterwards/);
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
    afterResponse: () => json(seriesRow({ stats: { 2: [0, 12, false], 3: [0, 23, true] } })),
  });
  const r = await run(fetchImpl, [3]);
  assert.equal(r.ok, true);
  assert.match(r.content, /S2 also changed state or vanished, which was not asked for/);
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

// ── findings from review: every one gets a test that can fail ───────────────

test('🔴 LOST UPDATE: two concurrent turns on one show cannot revert each other', async () => {
  /**
   * The read-modify-write over a whole series object, run twice at once. The
   * receiver dispatches inbound messages fire-and-forget, so two turns really do
   * overlap — two guests, or one guest sending twice.
   *
   * Unserialised: A GETs, B GETs, B PUTs S3 on, A PUTs from its stale snapshot
   * and puts S3 back off. B already told someone S3 was on. Both report success
   * and the season is dark.
   */
  const store = seriesRow({ stats: { 3: [0, 23, false], 5: [0, 22, false] } });
  let stored: Record<string, unknown> = store;
  let gets = 0;
  const fetchImpl: FetchImpl = async (url, init) => {
    const u = String(url);
    if ((init?.method ?? 'GET') === 'GET') {
      gets += 1;
      // A real interleaving needs the reads to actually overlap; yield here so
      // an unlocked implementation is genuinely given the chance to fail.
      await new Promise((r) => setTimeout(r, 1));
      return u.endsWith('/series') ? json([stored]) : json(stored);
    }
    if ((init?.method ?? '') === 'PUT') {
      stored = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return json(stored);
    }
    return json({ id: 1 });
  };

  const [a, b] = await Promise.all([
    makeAddSeason(fetchImpl).run({ title: 'seinfeld', seasons: [5] }, ctx()),
    makeAddSeason(fetchImpl).run({ title: 'seinfeld', seasons: [3] }, ctx()),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.ok(gets > 0, 'CONTROL: the fake was actually exercised');

  /**
   * ⚠️ THE FINAL STATE IS THE WRONG PROBE ON ITS OWN, and asserting only it is
   * how this test would pass while the bug was live. Measured: with the lock
   * removed the revert really happens — A writes S3 back to false — but B's
   * later PUT repairs it, so the end state is correct in THIS interleaving and
   * wrong in another. An order-dependent assertion is not a guard.
   *
   * What is order-independent is that a revert HAPPENED AT ALL: the losing call
   * sees another season go dark between its snapshot and its re-read, and says
   * so. That warning is the direct observable of the lost update, and under the
   * lock neither call can produce it.
   */
  for (const [who, r] of [
    ['A', a],
    ['B', b],
  ] as const) {
    assert.doesNotMatch(
      r.content,
      /also changed state or vanished/,
      `${who} observed a concurrent revert — the two turns interleaved`,
    );
  }

  const final = (stored['seasons'] as { seasonNumber: number; monitored: boolean }[])
    .map((x) => [x.seasonNumber, x.monitored])
    .sort((x, y) => Number(x[0]) - Number(y[0]));
  assert.deepEqual(
    final,
    [
      [3, true],
      [5, true],
    ],
    'and both seasons survive',
  );
});

test('🔴 the SERIES flag is read back too: seasons under an unmonitored show are INERT, not started', async () => {
  // Seasons monitored under an unmonitored series download nothing, so claiming
  // STARTED would be the "looks like on its way, is doing nothing" failure with
  // the one flag that governs all the others.
  const row = seriesRow({ monitored: false, stats: { 3: [0, 23, false] } });
  const { fetchImpl, rec } = sonarr(row, {
    // Sonarr accepted the write, but the series flag did not stick.
    afterResponse: () => json(seriesRow({ monitored: false, stats: { 3: [0, 23, true] } })),
  });
  const r = await run(fetchImpl, [3]);
  assert.equal(r.ok, false);
  assert.match(r.content, /MONITORED BUT INERT/);
  assert.match(r.content, /NOTHING IS DOWNLOADING/);
  assert.equal(rec.commands.length, 0, 'and no search is fired for something that cannot grab');
});

test('🔴 a 5xx on the PUT is UNKNOWN — a server error is not a refusal', async () => {
  // 502 from a reverse proxy, or a 500 raised AFTER the change applied, means
  // the write may well have landed. "Nothing was started" is then unbackable.
  const { fetchImpl } = sonarr(SEINFELD, { putResponse: () => json({ error: 'bad gateway' }, 502) });
  const r = await run(fetchImpl, [3]);
  assert.equal(r.ok, false);
  assert.match(r.content, /UNKNOWN/);
  assert.match(r.content, /MAY have landed/);
  assert.doesNotMatch(r.content, /Nothing was started/);
});

test('a show Sonarr lists with NO seasons says so, instead of "It has ."', async () => {
  const { fetchImpl, rec } = sonarr({ id: 77, tvdbId: 79169, title: 'Seinfeld', monitored: true, seasons: [] });
  const r = await run(fetchImpl, [3]);
  assert.equal(r.ok, false);
  assert.match(r.content, /no seasons at all/);
  assert.doesNotMatch(r.content, /It has \./, 'a sentence with the answer missing reads as a bug');
  assert.equal(rec.puts.length, 0, 'no PUT is attempted');
  assert.equal(rec.commands.length, 0);
});

test('🔴 CLIENT LAYER: monitorSeasons refuses to PUT an empty season list', async () => {
  /**
   * `seasons: []` at an endpoint that REPLACES the resource is a destructive
   * body, and what Sonarr does with it is exactly what we have not verified.
   *
   * ⚠️ Asserted against the CLIENT, not the tool. `add_season` checks the season
   * list first, so this guard is unreachable through it — testing it through the
   * tool would have exercised the tool's message and called it coverage. It is
   * defence in depth for any future caller, and it is tested where it lives.
   */
  const { ArrClient } = await import('../src/media/arr.js');
  let puts = 0;
  const client = new ArrClient(
    {
      baseUrl: 'http://sonarr.invalid/api/v3',
      apiKey: 'k',
      fetchImpl: async (_u, i) => {
        if ((i?.method ?? 'GET') !== 'GET') puts += 1;
        return json({ id: 77, title: 'Seinfeld', monitored: true, seasons: [] });
      },
    },
    'series',
  );
  const out = await client.monitorSeasons(77, [3]);
  assert.equal(out.state, 'unknown');
  assert.match((out as { detail: string }).detail, /Refusing to PUT an empty one/);
  assert.equal(puts, 0, 'and nothing was written');
});

test('🔴 a season that VANISHED from the read-back is flagged, not invisible', async () => {
  // Iterating only the rows that came back cannot see a season that is gone —
  // the largest possible "something else changed".
  const row = seriesRow({ stats: { 2: [0, 12, true], 3: [0, 23, false] } });
  const { fetchImpl } = sonarr(row, {
    afterResponse: () => json(seriesRow({ stats: { 3: [0, 23, true] } })), // S2 is simply gone
  });
  const r = await run(fetchImpl, [3]);
  assert.equal(r.ok, true);
  assert.match(r.content, /S2 also changed state or vanished/);
});

test('a row with no seasonNumber never becomes "SNaN also changed"', async () => {
  // ⚠️ The two reads must DISAGREE about the junk rows. Identical junk on both
  // sides collides on the same NaN key and diffs to nothing, so a version that
  // does not skip them would pass — the fixture would be hiding the defect.
  const junk = (monitored: boolean) => ({ monitored, statistics: {} });
  const row = {
    ...seriesRow({ stats: { 3: [0, 23, false] } }),
    seasons: [
      { seasonNumber: 3, monitored: false, statistics: { episodeFileCount: 0, totalEpisodeCount: 23 } },
      junk(false),
    ],
  };
  const { fetchImpl } = sonarr(row, {
    afterResponse: () =>
      json({
        ...seriesRow({ stats: { 3: [0, 23, true] } }),
        seasons: [
          { seasonNumber: 3, monitored: true, statistics: {} },
          junk(true),
        ],
      }),
  });
  const r = await run(fetchImpl, [3]);
  assert.equal(r.ok, true);
  assert.match(r.content, /S3 monitored and searching/, 'CONTROL: the real season still resolved');
  assert.doesNotMatch(r.content, /NaN/);
});

test('a pre-write read failure says NOTHING WAS CHANGED, not "I cannot say"', async () => {
  // Before the PUT there is no ambiguity to hedge about: nothing was written.
  // Hedging there trains the reader to discount the hedge where it is real.
  let n = 0;
  const { fetchImpl, rec } = sonarr(SEINFELD, {});
  const routed: FetchImpl = async (url, init) => {
    // The LIST read succeeds; the single-series read before the PUT fails.
    if (/\/series\/\d+$/.test(String(url)) && ++n === 1) return json({}, 503);
    return fetchImpl(url, init);
  };
  const r = await makeAddSeason(routed).run({ title: 'seinfeld', seasons: [3] }, ctx());
  assert.equal(r.ok, false);
  assert.match(r.content, /NOTHING was changed/);
  assert.equal(rec.puts.length, 0);
});

test('too many seasons at once is refused before any write', async () => {
  const { fetchImpl, rec } = sonarr(SEINFELD);
  const r = await run(fetchImpl, Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal(r.ok, false);
  assert.match(r.content, /at most 12 at once/);
  assert.equal(rec.puts.length, 0);
  assert.equal(rec.gets.length, 0, 'and no read either — the cap is on the argument');
});

test('a FAILED result still carries what else was true', async () => {
  const { fetchImpl } = sonarr(SEINFELD, { afterResponse: () => json(SEINFELD) });
  const r = await run(fetchImpl, [1, 3, 77]);
  assert.equal(r.ok, false);
  assert.match(r.content, /did not come back monitored/);
  assert.match(r.content, /S1 already complete, left alone/);
  assert.match(r.content, /no season 77 exists/);
});
