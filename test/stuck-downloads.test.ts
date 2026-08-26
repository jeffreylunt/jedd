import assert from 'node:assert/strict';
import { test } from 'node:test';
import { qbitVerdict, byHash, type QbitTorrent } from '../src/media/qbit-torrents.js';
import { makeStuckDownloads } from '../src/tools/stuck-downloads.js';
import { buildTools, toolsForRole } from '../src/tools/index.js';
import type { ToolContext } from '../src/tools/types.js';
import { testConfig } from './helpers.js';

/**
 * `stuck_downloads` — and the verdict that decides what may be touched.
 *
 * 🔴 EVERY FIXTURE HERE IS A REAL ROW from qBittorrent on 2026-08-26, because
 * the whole difficulty of this job is that the dangerous cases are numerically
 * IDENTICAL to the actionable one. All four of these read `0 seeds, 0 dlspeed,
 * 0 progress`, and three of them must never be touched:
 *
 *   stalledDL / metaDL @ 49h  -> STALLED      the only actionable class
 *   queuedDL          @ 47h  -> NOT STARTED  never began; its 0 is not an observation
 *   stoppedDL         @ 0h   -> HELD         a human stopped it; 17-seed live swarm
 *   missingFiles      @ 121h -> UNMANAGED    not arr-managed at all
 *
 * A test suite built from invented fixtures would separate these trivially and
 * prove nothing.
 */

const torrent = (over: Partial<QbitTorrent> = {}): QbitTorrent => ({
  hash: 'a'.repeat(40),
  name: 'Fringe.S02E18.720p.HDTV.X264-DIMENSION',
  state: 'stalledDL',
  progress: 0,
  timeActiveSeconds: 49 * 3600,
  numComplete: 0,
  numSeeds: 0,
  dlspeed: 0,
  amountLeft: 1_000_000,
  size: 1_000_000,
  priority: 1,
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE VERDICT — the load-bearing decision
// ─────────────────────────────────────────────────────────────────────────────

test('🔴 MUTATION TARGET: metaDL at 49h IS a stall — the one a "stalledDL" filter misses', () => {
  /**
   * Live on 2026-08-26 there were THREE `stalledDL` and THREE `metaDL`, all at
   * 48-49h with nothing moving. A filter written against the word "stalled"
   * finds half of them and reports the job done.
   */
  assert.equal(qbitVerdict(torrent({ state: 'stalledDL' })).kind, 'stalled');
  assert.equal(qbitVerdict(torrent({ state: 'metaDL' })).kind, 'stalled');
  assert.equal(qbitVerdict(torrent({ state: 'downloading', dlspeed: 0, progress: 0 })).kind, 'stalled');
});

test('🔴 MUTATION TARGET: queuedDL is NOT a stall, however long it has been active', () => {
  /**
   * The trap that is live in the queue right now. Two `queuedDL` rows sit at 46
   * and 48 hours `time_active` — numerically indistinguishable from the stalls
   * above. Measured 2026-08-23: 19 of 26 rows were queuedDL, four with live
   * swarms, and a literal reading blocklist-deletes all 19.
   *
   * The STATE is the discriminator, not the clock. Asserting the long-active
   * case is the whole point — a rule keyed on `time_active === 0` passes the
   * easy fixture and destroys these two.
   */
  assert.equal(qbitVerdict(torrent({ state: 'queuedDL', timeActiveSeconds: 0 })).kind, 'not-started');
  assert.equal(qbitVerdict(torrent({ state: 'queuedDL', timeActiveSeconds: 47.8 * 3600 })).kind, 'not-started');
  // …even with a live swarm it has never connected to.
  assert.equal(
    qbitVerdict(torrent({ state: 'queuedDL', timeActiveSeconds: 47 * 3600, numComplete: 13 })).kind,
    'not-started',
  );
});

test('🔴 MUTATION TARGET: stoppedDL is HELD — a human stopped it', () => {
  // Measured 2026-08-25: 15 torrents bulk-stopped by hand in the WebUI read as
  // 15 stalls. Acting destroyed nothing only because someone checked.
  const v = qbitVerdict(torrent({ state: 'stoppedDL', timeActiveSeconds: 0, numComplete: 17 }));
  assert.equal(v.kind, 'held');
  // qBit 5.x renamed pausedDL -> stoppedDL. The OLD name must still be caught,
  // or a rollback silently reclassifies every hold as a stall.
  assert.equal(qbitVerdict(torrent({ state: 'pausedDL' })).kind, 'held');
});

test('🔴 MUTATION TARGET: every UP state is FINISHED — blocklisting one destroys the file', () => {
  // Measured 2026-08-15: 47 of 48 torrents were in UP states and ZERO were
  // download-side. A run matching the word "stalled" would have targeted 15
  // completed files and poisoned their releases.
  for (const state of ['queuedUP', 'stalledUP', 'uploading', 'forcedUP', 'pausedUP']) {
    assert.equal(qbitVerdict(torrent({ state, progress: 1 })).kind, 'finished', state);
  }
});

test('🔴 missingFiles is UNMANAGED — the state an INVERTED filter would sweep up', () => {
  /**
   * The reason every state set is written out rather than negated. `missingFiles`
   * is neither an UP state nor a DL state, so "not in the download states" counts
   * it and false-alarms — measured 2026-08-21 on an audiobook whose .m4b had been
   * deleted off disk. It is not arr-managed and is outside this job's remit.
   */
  const v = qbitVerdict(torrent({ state: 'missingFiles', timeActiveSeconds: 121 * 3600 }));
  assert.equal(v.kind, 'unmanaged');
  // An unrecognised future state must land here too, not in `stalled`.
  assert.equal(qbitVerdict(torrent({ state: 'someNewQbitState' })).kind, 'unmanaged');
});

test('a young active torrent is STARTING, not stalled; and a moving one is PROGRESSING', () => {
  assert.equal(qbitVerdict(torrent({ timeActiveSeconds: 2 * 3600 })).kind, 'starting');
  assert.equal(qbitVerdict(torrent({ dlspeed: 900_000 })).kind, 'progressing');
  assert.equal(qbitVerdict(torrent({ progress: 0.12, dlspeed: 0 })).kind, 'progressing');
});

test('a stall reports the SWARM seed count, not the connected one', () => {
  // `num_seeds` is who we are connected to — 0 by definition for a dead torrent.
  // `num_complete` is what the tracker says the swarm has, which is the fact
  // that decides whether a different release would do any better.
  const v = qbitVerdict(torrent({ numSeeds: 0, numComplete: 4 }));
  assert.equal(v.kind, 'stalled');
  assert.equal(v.kind === 'stalled' ? v.swarmSeeds : -1, 4);
});

test('🔴 the join is CASE-INSENSITIVE — qBit lower-cases hashes, the arrs upper-case them', () => {
  // A join on the raw strings matches nothing, and the failure is silent: every
  // arr row simply appears to have no qBit record.
  const map = byHash([torrent({ hash: 'ABCDEF' + '0'.repeat(34) })]);
  assert.ok(map.get('abcdef' + '0'.repeat(34)), 'an upper-case hash must find its torrent');
});

// ─────────────────────────────────────────────────────────────────────────────
// THE TOOL
// ─────────────────────────────────────────────────────────────────────────────

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  role: 'owner',
  senderHandle: '+18015550123',
  config: testConfig({ readOnly: false }),
  ...over,
});

const json = (body: unknown, status = 200): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

/**
 * 🔴 THE WIRE SHAPE, WHICH IS NOT THE INTERNAL SHAPE.
 *
 * `torrent()` above builds the parsed struct (`timeActiveSeconds`, `numComplete`)
 * — right for unit-testing `qbitVerdict`, and WRONG for a stubbed HTTP response,
 * which must carry qBit's own snake_case names. Feeding the internal shape
 * through the real parser made every field read 0, so a 49-hour stall arrived as
 * a 0-hour one and classified as `starting`. The suite caught it; the point is
 * that a stub sitting on the wrong side of a field-name boundary produces
 * plausible rows that are silently all-defaults.
 */
const wire = (t: QbitTorrent) => ({
  hash: t.hash,
  name: t.name,
  state: t.state,
  progress: t.progress,
  time_active: t.timeActiveSeconds,
  num_complete: t.numComplete,
  num_seeds: t.numSeeds,
  dlspeed: t.dlspeed,
  amount_left: t.amountLeft,
  size: t.size,
  priority: t.priority,
});

/**
 * Routes on host so the qBit read and the two arr reads are separable.
 *
 * ⚠️ Sonarr and Radarr are routed APART. An earlier version returned one body to
 * both, so a single record parsed TWICE — once with a `series` subject, once
 * with a `movie` one — and the tool correctly reported two releases. A stub that
 * cannot tell the two services apart cannot test a tool that reads both.
 */
const stub = (qbit: () => Response, sonarr: () => Response, radarr: () => Response = () => json({ records: [], totalRecords: 0 })) =>
  async (url: string) =>
    url.includes('qbit-lan') ? qbit() : url.includes('sonarr') ? sonarr() : radarr();

const emptyArr = () => json({ records: [], totalRecords: 0 });

test('🔴 stuck_downloads is owner-only, writes:true, and gone when writes are off', () => {
  const tools = buildTools(testConfig({ readOnly: false }));
  const t = tools.find((x) => x.name === 'stuck_downloads');
  assert.ok(t, 'must be registered');
  assert.equal(t.minRole, 'owner');
  assert.equal(t.writes, true, 'the destructive actions land in this same tool');
  assert.ok(!toolsForRole(tools, 'guest').some((x) => x.name === 'stuck_downloads'));
  assert.ok(!buildTools(testConfig({ readOnly: true })).some((x) => x.name === 'stuck_downloads'));
});

test('🔴 MUTATION TARGET: with qBittorrent unreadable it REFUSES — it does not answer from the arr', async () => {
  /**
   * The arr queue alone misses more than half of real stalls. Falling back to it
   * would reproduce that blind spot wearing the authority of a tool whose name
   * says it finds stuck downloads — a confident wrong answer, which is worse
   * than no answer.
   */
  const r = await makeStuckDownloads(
    stub(() => json('nope', 500), () => json({ records: [{ downloadId: 'A'.repeat(40) }], totalRecords: 1 })),
  ).run({ action: 'list' }, ctx());

  assert.equal(r.ok, false);
  assert.match(r.content, /could NOT read qBittorrent/);
  assert.match(r.content, /UNKNOWN, not "nothing is stuck"/);
  assert.ok(!/STALLED — /.test(r.content), 'no verdict may be rendered without ground truth');
});

test('🔴 an unreadable ARR queue is NAMED, never rendered as an empty one', async () => {
  const r = await makeStuckDownloads(
    stub(() => json([wire(torrent({ state: 'stalledDL' }))]), () => json('boom', 500)),
  ).run({ action: 'list' }, ctx());

  assert.equal(r.ok, true, 'qBit was readable, so there is still a real answer');
  assert.match(r.content, /queue could not be read/);
  assert.match(r.content, /UNKNOWN, not empty/);
});

test('the four look-alike states are separated in one listing', async () => {
  // All four read 0 seeds / 0 speed / 0 progress. This is the whole job.
  const r = await makeStuckDownloads(
    stub(
      () =>
        json(
          [
            torrent({ hash: '1'.repeat(40), state: 'metaDL', name: 'STALLED-ONE' }),
            torrent({ hash: '2'.repeat(40), state: 'queuedDL', timeActiveSeconds: 47 * 3600, name: 'QUEUED-ONE' }),
            torrent({ hash: '3'.repeat(40), state: 'stoppedDL', numComplete: 17, name: 'HELD-ONE' }),
            torrent({ hash: '4'.repeat(40), state: 'missingFiles', name: 'UNMANAGED-ONE' }),
            torrent({ hash: '5'.repeat(40), state: 'stalledUP', progress: 1, name: 'FINISHED-ONE' }),
          ].map(wire),
        ),
      emptyArr,
    ),
  ).run({ action: 'list' }, ctx());

  assert.match(r.content, /🔴 STALLED — 1\./);
  assert.match(r.content, /STALLED-ONE/);
  assert.match(r.content, /⏸ HELD — 1\./);
  assert.match(r.content, /no verb here that resumes one/);
  assert.match(r.content, /⏳ NOT STARTED — 1\./);
  assert.match(r.content, /ABSENCE OF AN OBSERVATION/);
  assert.match(r.content, /⚠️ NOT ARR-MANAGED — 1\./);
  assert.match(r.content, /📦 1 finished and seeding/);
  // 🔴 The finished torrent is COUNTED, never listed as actionable.
  assert.ok(!/FINISHED-ONE/.test(r.content), 'a finished torrent must not appear as an item');
});

test('an arr release with NO qBittorrent record is its own class, not a stall', async () => {
  // The arr thinks it is downloading and the client has never heard of it. That
  // is a different fault with a different fix, and calling it stalled would
  // point a blocklist at a torrent that does not exist.
  const r = await makeStuckDownloads(
    stub(
      () => json([]),
      () =>
        json({
          records: [
            { downloadId: 'F'.repeat(40), title: 'Ghost.Release', series: { title: 'Ghost' }, size: 1, sizeleft: 1, added: new Date().toISOString(), status: 'queued' },
          ],
          totalRecords: 1,
        }),
    ),
  ).run({ action: 'list' }, ctx());

  assert.match(r.content, /NOT IN qBITTORRENT — 1/);
  assert.match(r.content, /🔴 STALLED — 0\. Nothing is stuck\./);
});

test('an unknown action is refused', async () => {
  const r = await makeStuckDownloads(stub(() => json([]), emptyArr)).run({ action: 'delete' }, ctx());
  assert.equal(r.ok, false);
  assert.match(r.content, /not an action/);
});
