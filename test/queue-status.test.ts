import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FetchImpl } from '../src/media/arr.js';
import { classify, parseQueue, STALL_AGE_HOURS, type Verdict } from '../src/media/queue.js';
import { makeCheckStatus } from '../src/tools/check-status.js';
import type { ToolContext } from '../src/tools/types.js';
import { testConfig } from './helpers.js';

const NOW = new Date('2026-08-24T18:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

/** One arr queue record, defaulted to the healthy shape and overridden per case. */
function record(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    downloadId: 'HASH1',
    title: 'Fringe.S02E18.720p.HDTV.X264-DIMENSION',
    series: { title: 'Fringe' },
    size: 1_000,
    sizeleft: 500,
    status: 'downloading',
    trackedDownloadStatus: 'ok',
    trackedDownloadState: 'downloading',
    added: hoursAgo(1),
    statusMessages: [],
    ...over,
  };
}

function releases(records: Record<string, unknown>[], service: 'sonarr' | 'radarr' = 'sonarr') {
  return parseQueue({ records, totalRecords: records.length }, service);
}

function verdictOf(over: Record<string, unknown> = {}): Verdict {
  return classify(releases([record(over)])[0]!, NOW).verdict;
}

/** A fetch stub recording every URL, so a second code path shows up as a second URL shape. */
function arrStub(bodies: { sonarr?: unknown; radarr?: unknown; sonarrFails?: boolean; radarrFails?: boolean }) {
  const urls: string[] = [];
  const fetchImpl: FetchImpl = async (url) => {
    const u = String(url);
    urls.push(u);
    const isSonarr = u.includes('sonarr');
    if ((isSonarr && bodies.sonarrFails) || (!isSonarr && bodies.radarrFails)) {
      return new Response('boom', { status: 500 });
    }
    const body = isSonarr ? (bodies.sonarr ?? { records: [], totalRecords: 0 }) : (bodies.radarr ?? { records: [], totalRecords: 0 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, urls };
}

function ctx(): ToolContext {
  return { role: 'owner', senderHandle: '+18015550123', config: testConfig() };
}

// ── the live inversion this tool was written against ─────────────────────────

test('a STOPPED torrent that the arr still calls ok/downloading is not reported as downloading', () => {
  // Measured live 2026-08-24: 15 Sonarr rows in exactly this shape, and all 15
  // were stoppedDL at 0% in qBittorrent, untouched for two days.
  const v = verdictOf({
    status: 'paused',
    trackedDownloadStatus: 'ok',
    trackedDownloadState: 'downloading',
    size: 1_172_958_759,
    sizeleft: 1_172_958_759,
    added: hoursAgo(48),
  });
  assert.equal(v.kind, 'stopped');
});

test('the STOPPED remedy names restarting it, not retrying or waiting', () => {
  const a = classify(
    releases([record({ status: 'paused', sizeleft: 1_000, added: hoursAgo(48) })])[0]!,
    NOW,
  );
  assert.equal(a.response.jeddCanFix, false);
  assert.match(a.response.wouldResolve, /start it again/i);
});

// ── grouping happens before counting ─────────────────────────────────────────

test('a season pack of nine rows is ONE release, and the count says one', async () => {
  const rows = Array.from({ length: 9 }, (_, i) =>
    record({ id: i + 1, downloadId: 'PACK', title: 'Peppa.Pig.S03.COMPLETE', series: { title: 'Peppa Pig' } }),
  );
  const parsed = releases(rows);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.rows, 9);

  const { fetchImpl } = arrStub({ sonarr: { records: rows, totalRecords: 9 } });
  const res = await makeCheckStatus(fetchImpl, () => NOW).run({}, ctx());
  assert.match(res.content, /^1 release\(s\)/m);
  assert.match(res.content, /1 release covering 9 episodes/);
});

test('distinct releases are still counted separately', () => {
  const parsed = releases([record({ id: 1, downloadId: 'A' }), record({ id: 2, downloadId: 'B' })]);
  assert.equal(parsed.length, 2);
});

test('rows with no downloadId do not collapse into one phantom release', () => {
  const parsed = releases([record({ id: 1, downloadId: '' }), record({ id: 2, downloadId: '' })]);
  assert.equal(parsed.length, 2);
});

// ── the age gate ─────────────────────────────────────────────────────────────

test('a zero-byte release younger than the gate is STARTING, not stalled', () => {
  assert.equal(verdictOf({ sizeleft: 1_000, added: hoursAgo(STALL_AGE_HOURS - 1) }).kind, 'starting');
});

test('the same release past the gate is STALLED', () => {
  assert.equal(verdictOf({ sizeleft: 1_000, added: hoursAgo(STALL_AGE_HOURS + 1) }).kind, 'stalled');
});

test('metadata-lagged rows (size 0) are STARTING while young — the 3:32am false alarm', () => {
  assert.equal(verdictOf({ size: 0, sizeleft: 0, added: hoursAgo(1) }).kind, 'starting');
});

test('size 0 past the gate is NO PEERS, and the remedy rules out retrying the same release', () => {
  const a = classify(releases([record({ size: 0, sizeleft: 0, added: hoursAgo(48) })])[0]!, NOW);
  assert.equal(a.verdict.kind, 'no-peers');
  assert.match(a.response.wouldResolve, /cannot fix that/i);
  assert.match(a.response.wouldResolve, /DIFFERENT release/i);
});

test('progress outranks the age gate — moving bytes are never stalled however old', () => {
  const v = verdictOf({ size: 1_000, sizeleft: 1, added: hoursAgo(500) });
  assert.equal(v.kind, 'progressing');
  assert.equal(v.kind === 'progressing' && v.percent, 99);
});

// ── the import stages are a different failure class ──────────────────────────

test('an import warning outranks every download classification', () => {
  // Bytes have moved AND it is old AND it is paused — all download-shaped
  // signals — but the file is down and the import is what is stuck.
  const a = classify(
    releases([
      record({
        trackedDownloadStatus: 'warning',
        status: 'paused',
        sizeleft: 0,
        added: hoursAgo(48),
        statusMessages: [{ title: 'Found archive file, might need to be extracted' }],
      }),
    ])[0]!,
    NOW,
  );
  assert.equal(a.verdict.kind, 'import-blocked');
  assert.match(a.response.wouldResolve, /IMPORT is what is stuck/i);
  // The remedy must not be a download remedy.
  assert.doesNotMatch(a.response.wouldResolve, /different release|start it again/i);
});

test('importing is reported as finished downloading', () => {
  assert.equal(verdictOf({ trackedDownloadState: 'importPending', sizeleft: 0 }).kind, 'importing');
});

// ── no remedy claims Jedd can fix it, over EVERY class ───────────────────────

test('every verdict class exists in the matrix and none claims Jedd can fix it', () => {
  const cases: Record<string, unknown>[] = [
    { sizeleft: 500 }, // progressing
    { trackedDownloadState: 'importing', sizeleft: 0 }, // importing
    { trackedDownloadStatus: 'error' }, // import-blocked
    { status: 'paused', sizeleft: 1_000, added: hoursAgo(48) }, // stopped
    { sizeleft: 1_000 }, // starting
    { sizeleft: 1_000, added: hoursAgo(48) }, // stalled
    { size: 0, sizeleft: 0, added: hoursAgo(48) }, // no-peers
  ];
  const seen = new Set<string>();
  for (const c of cases) {
    const a = classify(releases([record(c)])[0]!, NOW);
    seen.add(a.verdict.kind);
    assert.equal(a.response.jeddCanFix, false, `${a.verdict.kind} claimed Jedd can fix it`);
    assert.ok(a.response.wouldResolve.length > 0, `${a.verdict.kind} offered no response at all`);
  }
  // 🔴 A matrix that silently stops covering a class is worse than no matrix.
  assert.deepEqual(
    [...seen].sort(),
    ['import-blocked', 'importing', 'no-peers', 'progressing', 'stalled', 'starting', 'stopped'],
  );
});

// ── one source of truth, proven by the URLs ──────────────────────────────────

test('the named-title question and the subject-less one issue the SAME requests', async () => {
  const rows = [
    record({ id: 1, downloadId: 'A', series: { title: 'Fringe' } }),
    record({ id: 2, downloadId: 'B', title: 'Ted.Lasso.S02E02', series: { title: 'Ted Lasso' } }),
  ];
  const general = arrStub({ sonarr: { records: rows, totalRecords: 2 } });
  const named = arrStub({ sonarr: { records: rows, totalRecords: 2 } });

  const a = await makeCheckStatus(general.fetchImpl, () => NOW).run({}, ctx());
  const b = await makeCheckStatus(named.fetchImpl, () => NOW).run({ title: 'Ted Lasso' }, ctx());

  // 🔴 If a title ever gets its own endpoint, cache or filter parameter, this
  // fails — which is the only way the two answers could come to disagree.
  assert.deepEqual(named.urls.sort(), general.urls.sort());
  // The narrow answer is a subset of the broad one, never something else.
  assert.match(a.content, /Fringe/);
  assert.match(a.content, /Ted Lasso/);
  assert.match(b.content, /Ted Lasso/);
  assert.doesNotMatch(b.content, /Fringe/);
});

test('every call reads the queue again — there is no cache to go stale', async () => {
  const stub = arrStub({ sonarr: { records: [record()], totalRecords: 1 } });
  const tool = makeCheckStatus(stub.fetchImpl, () => NOW);
  await tool.run({}, ctx());
  const afterFirst = stub.urls.length;
  await tool.run({}, ctx());
  assert.equal(stub.urls.length, afterFirst * 2);
});

test('the queue read asks for the subject titles, not just release names', async () => {
  const stub = arrStub({});
  await makeCheckStatus(stub.fetchImpl, () => NOW).run({}, ctx());
  assert.ok(stub.urls.some((u) => u.includes('includeSeries=true')));
  assert.ok(stub.urls.some((u) => u.includes('includeMovie=true')));
});

// ── unreadable is never empty ────────────────────────────────────────────────

test('an unreadable Sonarr is a caveat, never "nothing is downloading"', async () => {
  const stub = arrStub({ sonarrFails: true, radarr: { records: [], totalRecords: 0 } });
  const res = await makeCheckStatus(stub.fetchImpl, () => NOW).run({}, ctx());
  assert.match(res.content, /Could not read the sonarr queue/);
  assert.match(res.content, /MISSING from this answer — not absent/);
});

test('a readable half still reports its rows when the other half is down', async () => {
  const stub = arrStub({
    sonarrFails: true,
    radarr: { records: [record({ movie: { title: 'Heat' }, title: 'Heat.1995.1080p', series: undefined })], totalRecords: 1 },
  });
  const res = await makeCheckStatus(stub.fetchImpl, () => NOW).run({}, ctx());
  assert.match(res.content, /Heat/);
});

test('both halves unreadable is a FAILURE, not an empty queue', async () => {
  const stub = arrStub({ sonarrFails: true, radarrFails: true });
  const res = await makeCheckStatus(stub.fetchImpl, () => NOW).run({}, ctx());
  assert.equal(res.ok, false);
  assert.match(res.content, /could not look/i);
  assert.doesNotMatch(res.content, /Nothing is downloading/);
});

test('a genuinely empty queue says so, and says where it looked', async () => {
  const stub = arrStub({});
  const res = await makeCheckStatus(stub.fetchImpl, () => NOW).run({}, ctx());
  assert.equal(res.ok, true);
  assert.match(res.content, /Nothing is downloading/);
  assert.match(res.content, /sonarr and radarr/);
});

test('a truncated queue read says it is truncated', async () => {
  const stub = arrStub({ sonarr: { records: [record()], totalRecords: 9_999 } });
  const res = await makeCheckStatus(stub.fetchImpl, () => NOW).run({}, ctx());
  assert.match(res.content, /truncated/);
});

test('the tool is read-only and available to guests', () => {
  const t = makeCheckStatus();
  assert.equal(t.writes, false);
  assert.equal(t.minRole, 'guest');
});

// ── the shape the live queue actually has ────────────────────────────────────

test('fifteen identical stopped releases collapse to ONE line with ONE remedy', async () => {
  // The exact shape of the live Sonarr queue on 2026-08-24. Rendered one line
  // per release it was ~2,700 tokens of near-identical prose; the answer being
  // CORRECT is not the same as the answer being usable.
  const rows = Array.from({ length: 15 }, (_, i) =>
    record({
      id: i + 1,
      downloadId: `HASH${i}`,
      title: `Fringe.S02E${i + 8}.720p.HDTV`,
      status: 'paused',
      size: 1_172_958_759,
      sizeleft: 1_172_958_759,
      added: hoursAgo(49),
    }),
  );
  const stub = arrStub({ sonarr: { records: rows, totalRecords: 15 } });
  const res = await makeCheckStatus(stub.fetchImpl, () => NOW).run({}, ctx());

  // The count is still fifteen RELEASES — grouping the prose must not hide the unit.
  assert.match(res.content, /^15 release\(s\)/m);
  assert.match(res.content, /Fringe: 15 releases/);
  const remedies = res.content.split('\n').filter((l) => l.includes('start it again in qBittorrent'));
  assert.equal(remedies.length, 1, 'the remedy must appear once, not once per release');
  assert.ok(res.content.length < 600, `answer was ${res.content.length} chars — it is a wall again`);
});

test('different verdicts on the same show stay separate lines', async () => {
  const rows = [
    record({ id: 1, downloadId: 'A', status: 'paused', sizeleft: 1_000, added: hoursAgo(49) }),
    record({ id: 2, downloadId: 'B', sizeleft: 250, added: hoursAgo(1) }),
  ];
  const stub = arrStub({ sonarr: { records: rows, totalRecords: 2 } });
  const res = await makeCheckStatus(stub.fetchImpl, () => NOW).run({}, ctx());
  assert.match(res.content, /STOPPED/);
  assert.match(res.content, /DOWNLOADING 75%/);
});

test('a progress range is shown when releases in a group differ', async () => {
  const rows = [
    record({ id: 1, downloadId: 'A', sizeleft: 900 }),
    record({ id: 2, downloadId: 'B', sizeleft: 100 }),
  ];
  const stub = arrStub({ sonarr: { records: rows, totalRecords: 2 } });
  const res = await makeCheckStatus(stub.fetchImpl, () => NOW).run({}, ctx());
  assert.match(res.content, /DOWNLOADING 10–90%/);
});

test('many groups are capped and the answer says how many it left out', async () => {
  const rows = Array.from({ length: 20 }, (_, i) =>
    record({ id: i + 1, downloadId: `H${i}`, series: { title: `Show ${i}` }, sizeleft: 1_000, added: hoursAgo(49) }),
  );
  const stub = arrStub({ sonarr: { records: rows, totalRecords: 20 } });
  const res = await makeCheckStatus(stub.fetchImpl, () => NOW).run({}, ctx());
  assert.match(res.content, /and 8 more group\(s\) not shown/);
});
