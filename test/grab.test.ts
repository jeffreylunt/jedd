import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExecImpl } from '../src/hp.js';
import { grabStatus, grabTorrent, toHostPath } from '../src/media/grab.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';

/** Capture every ssh command, and script each reply in order. */
function ssh(replies: { stdout: string; code?: number }[]) {
  const commands: string[] = [];
  let i = 0;
  const exec: ExecImpl = (_file, args, _opts, cb) => {
    commands.push(args[args.length - 1]!);
    const r = replies[Math.min(i, replies.length - 1)];
    i += 1;
    cb(r?.code ? { code: r.code } : null, r?.stdout ?? '', '');
  };
  return { exec, commands };
}

const base = {
  adminSshHost: 'admin-host.invalid',
  qbitBaseUrl: 'http://172.20.0.1:8080',
  infoHash: HASH,
  title: 'The Anxious Generation',
  category: 'ebooks',
};

const ok200 = { stdout: 'Ok.\n200' };

// ── 🔴 the privileged-identity defence ───────────────────────────────────────

test('🔴 an invalid infoHash NEVER reaches a command line', async () => {
  // The hash is interpolated into a shell command on the ADMIN ssh identity, and
  // it comes from Prowlarr, which aggregates third-party indexers.
  const { exec, commands } = ssh([ok200]);
  for (const bad of [`${HASH.slice(0, 39)};rm -rf /`, 'not-a-hash', '', 'g'.repeat(40)]) {
    const r = await grabTorrent({ ...base, infoHash: bad, exec });
    assert.equal(r.state, 'failed', `${bad} must be refused`);
  }
  assert.equal(commands.length, 0, 'a refused grab must make NO ssh call at all');
});

test('the magnet is built from the hash, never a Prowlarr URL', async () => {
  // qBittorrent cannot reach Prowlarr; a proxy URL fails SILENTLY.
  const { exec, commands } = ssh([{ stdout: '' }, ok200, { stdout: '' }]);
  await grabTorrent({ ...base, exec });
  const add = commands.find((c) => c.includes('/torrents/add'))!;
  assert.match(add, /magnet%3A%3Fxt%3Durn%3Abtih%3Aabcdef/i);
  assert.doesNotMatch(add, /prowlarr/i);
});

// ── 🔴 the four states ───────────────────────────────────────────────────────

test('🔴 409 is ALREADY-HAVE, which is success — never "retry"', async () => {
  // V1's ebook path read the duplicate-add rejection as a download FAILURE and
  // advised a retry: the one action guaranteed never to work.
  const { exec } = ssh([{ stdout: '' }, { stdout: 'Torrent is already in the download list.\n409' }]);
  const r = await grabTorrent({ ...base, exec });
  assert.equal(r.state, 'already-have');
  assert.doesNotMatch(r.detail, /retry|try again/i);
});

test('🔴 an unreachable qBittorrent is UNKNOWN — the grab MAY have landed', async () => {
  const { exec } = ssh([{ stdout: '' }, { stdout: '', code: 255 }]);
  const r = await grabTorrent({ ...base, exec });
  assert.equal(r.state, 'unknown');
  assert.match(r.detail, /MAY have landed/i);
});

test('a refusal is FAILED, distinct from unknown and already-have', async () => {
  const { exec } = ssh([{ stdout: '' }, { stdout: 'Fails.\n415' }]);
  assert.equal((await grabTorrent({ ...base, exec })).state, 'failed');
});

test('🔴 all four states are reachable and distinct', async () => {
  const results = [];
  for (const replies of [
    [{ stdout: '' }, ok200, { stdout: '' }],
    [{ stdout: '' }, { stdout: 'already in the download list\n409' }],
    [{ stdout: '' }, { stdout: 'Fails.\n415' }],
    [{ stdout: '' }, { stdout: '', code: 255 }],
  ]) {
    const { exec } = ssh(replies);
    results.push((await grabTorrent({ ...base, exec })).state);
  }
  assert.deepEqual(results, ['started', 'already-have', 'failed', 'unknown']);
});

// ── the surrounding calls ────────────────────────────────────────────────────

test('the category is created before the add', async () => {
  // A fresh qBittorrent has no categories, and an unknown one puts the file
  // where the SMTP step will never look -- a failure that produces a file
  // nobody reads rather than an error.
  const { exec, commands } = ssh([{ stdout: '' }, ok200, { stdout: '' }]);
  await grabTorrent({ ...base, exec });
  assert.match(commands[0]!, /createCategory/);
  assert.match(commands[1]!, /torrents\/add/);
});

test('the grab is queue-jumped', async () => {
  const { exec, commands } = ssh([{ stdout: '' }, ok200, { stdout: '' }]);
  await grabTorrent({ ...base, exec });
  assert.ok(commands.some((c) => c.includes('topPrio')), 'an ebook must not sit behind hours of video');
});

test('🔴 a failed queue-jump does NOT downgrade a successful grab', async () => {
  const { exec } = ssh([{ stdout: '' }, ok200, { stdout: '', code: 1 }]);
  const r = await grabTorrent({ ...base, exec });
  assert.equal(r.state, 'started', 'the torrent was added; priority is cosmetic');
  assert.match(r.detail, /could not change its queue position/i);
});

// ── completion polling ───────────────────────────────────────────────────────

const info = (t: Record<string, unknown>) => ({ stdout: JSON.stringify([t]) });

test('🔴 a torrent qBittorrent never heard of is MISSING, not unknown', async () => {
  // The grab did not land -- actionable. Different from "I could not ask".
  const { exec } = ssh([{ stdout: '[]' }]);
  const r = await grabStatus({ ...base, exec });
  assert.equal(r.state, 'missing');
  if (r.state !== 'missing') throw new Error('unreachable');
  assert.match(r.detail, /did not land/);
});

test('🔴 being unable to ask is UNKNOWN, never missing', async () => {
  const { exec } = ssh([{ stdout: '', code: 255 }]);
  const r = await grabStatus({ ...base, exec });
  assert.equal(r.state, 'unknown');
  assert.match(r.detail, /Not a finding that it is absent/);
});

test('a finished torrent reports complete with its content path', async () => {
  const { exec } = ssh([
    info({ name: 'The Anxious Generation', progress: 1, content_path: '/downloads/ebooks/tag.epub', state: 'stalledUP' }),
  ]);
  const r = await grabStatus({ ...base, exec });
  assert.equal(r.state, 'complete');
  if (r.state !== 'complete') throw new Error('unreachable');
  assert.equal(r.contentPath, '/downloads/ebooks/tag.epub');
});

test('🔴 progress decides completion, not the state string', async () => {
  // qBittorrent spells "finished" many ways: uploading, stalledUP, pausedUP,
  // forcedUP. Matching on the string is how a complete download reads as stuck.
  for (const state of ['uploading', 'stalledUP', 'pausedUP', 'forcedUP', 'queuedUP']) {
    const { exec } = ssh([info({ name: 'x', progress: 1, content_path: '/downloads/x.epub', state })]);
    assert.equal((await grabStatus({ ...base, exec })).state, 'complete', `${state} must read as complete`);
  }
  const { exec } = ssh([info({ name: 'x', progress: 0.4, content_path: '/downloads/x.epub', state: 'stalledDL' })]);
  const partial = await grabStatus({ ...base, exec });
  assert.equal(partial.state, 'downloading');
  if (partial.state !== 'downloading') throw new Error('unreachable');
  assert.match(partial.detail, /40% done/);
});

test('complete-but-no-path is NOT reported as complete', async () => {
  // Without a path there is nothing to send, so calling it complete would hand
  // the next step an empty string.
  const { exec } = ssh([info({ name: 'x', progress: 1, content_path: '', state: 'uploading' })]);
  assert.equal((await grabStatus({ ...base, exec })).state, 'downloading');
});

// ── 🔴 the container/host path split ─────────────────────────────────────────

const MOUNTS = [{ containerPrefix: '/downloads', hostPrefix: '/home/jeff/gluetun/downloads' }];

test('🔴 qBittorrent\'s real reported path is translated to one that exists on hp', () => {
  // Verbatim from the live API today. /downloads does NOT exist on the host.
  assert.equal(
    toHostPath('/downloads/ebooks/Red Rising Trilogy by Pierce Brown EPUB', MOUNTS),
    '/home/jeff/gluetun/downloads/ebooks/Red Rising Trilogy by Pierce Brown EPUB',
  );
});

test('🔴 an UNMAPPED path returns null, never the original', () => {
  // Sonarr's torrents live on a different mount entirely -- also observed live.
  // Returning the container path would hand the next step something that cannot
  // exist here, and the failure would read as a missing DOWNLOAD rather than a
  // missing MAPPING.
  assert.equal(toHostPath('/external/Downloads/Fringe.S02E18.mkv', MOUNTS), null);
});

test('🔴 prefix matching respects path boundaries', () => {
  // A blanket startsWith would rewrite /downloads-old into the wrong mount.
  assert.equal(toHostPath('/downloads-old/x.epub', MOUNTS), null);
  assert.equal(toHostPath('/downloads', MOUNTS), '/home/jeff/gluetun/downloads');
});

test('an empty content path is null, matching the complete-but-no-path guard', () => {
  // One live torrent really does report an empty content_path.
  assert.equal(toHostPath('', MOUNTS), null);
});

// ── the release's own magnet ─────────────────────────────────────────────────

test("🔴 a release's own magnet is used when its hash MATCHES the validated one", async () => {
  // It carries the indexer's trackers; a synthesized magnet relies on DHT alone.
  const { exec, commands } = ssh([{ stdout: '' }, ok200, { stdout: '' }]);
  const own = `magnet:?xt=urn:btih:${HASH.toUpperCase()}&tr=udp%3A%2F%2Ftracker.example%3A80`;
  await grabTorrent({ ...base, magnetUri: own, exec });
  const add = commands.find((c) => c.includes('/torrents/add'))!;
  assert.match(add, /tracker\.example/, 'the trackers must survive');
});

test('🔴 a supplied magnet whose hash does NOT match is ignored, not trusted', async () => {
  // A URI from a third-party indexer cannot ride along with a different payload
  // than the hash we validated.
  const { exec, commands } = ssh([{ stdout: '' }, ok200, { stdout: '' }]);
  const hostile = 'magnet:?xt=urn:btih:0000000000000000000000000000000000000000&tr=udp%3A%2F%2Fevil%3A80';
  await grabTorrent({ ...base, magnetUri: hostile, exec });
  const add = commands.find((c) => c.includes('/torrents/add'))!;
  assert.doesNotMatch(add, /evil/, 'a mismatched magnet must be discarded');
  assert.match(add, /abcdef/i, 'and the validated hash used instead');
});

// ── 🔴 the live response that broke the first version ────────────────────────

test('🔴 a SUCCESSFUL add whose body contains the word "failure" is not read as failure', async () => {
  // Verbatim from the live API. The first version tested /fail/i on this body and
  // matched "failure_count" -- a field whose VALUE says zero failures. The
  // torrent really was added and the user would have been told it failed.
  const real = '{"added_torrent_ids":["abc"],"failure_count":0,"pending_count":0,"success_count":1}\n200';
  const { exec } = ssh([{ stdout: '' }, { stdout: real }, { stdout: '' }]);
  const r = await grabTorrent({ ...base, exec });
  assert.equal(r.state, 'started');
});

test('🔴 accepted-but-PENDING is a failure — the documented silent one', async () => {
  // V1 saw pending_count:1 forever when qBittorrent was handed a URL it could
  // not fetch from inside the VPN netns.
  const pending = '{"added_torrent_ids":[],"failure_count":0,"pending_count":1,"success_count":0}\n200';
  const { exec } = ssh([{ stdout: '' }, { stdout: pending }]);
  const r = await grabTorrent({ ...base, exec });
  assert.equal(r.state, 'failed');
  assert.match(r.detail, /PENDING and never started/);
});

test('a genuine zero-success add is still failed', async () => {
  const none = '{"added_torrent_ids":[],"failure_count":1,"pending_count":0,"success_count":0}\n200';
  const { exec } = ssh([{ stdout: '' }, { stdout: none }]);
  assert.equal((await grabTorrent({ ...base, exec })).state, 'failed');
});

test('the older text protocol still works', async () => {
  const { exec } = ssh([{ stdout: '' }, { stdout: 'Ok.\n200' }, { stdout: '' }]);
  assert.equal((await grabTorrent({ ...base, exec })).state, 'started');
  const { exec: e2 } = ssh([{ stdout: '' }, { stdout: 'Fails.\n200' }]);
  assert.equal((await grabTorrent({ ...base, exec: e2 })).state, 'failed');
});

test('🔴 a grab ALWAYS sends an explicit savepath — a category does not place the file', async () => {
  // Measured live: the ebooks category exists with savePath /downloads/ebooks,
  // and a torrent added WITH that category still landed in /external/Downloads.
  // qBittorrent only honours the category path under Automatic Torrent
  // Management. The download succeeds, the category looks right, and the file is
  // somewhere the send step will never look.
  const { exec, commands } = ssh([{ stdout: '' }, ok200, { stdout: '' }]);
  await grabTorrent({ ...base, exec });
  const add = commands.find((c) => c.includes('/torrents/add'))!;
  assert.match(add, /savepath=%2Fdownloads%2Febooks/, 'defaults to /downloads/<category>');
});

test('an explicit savePath overrides the category default', async () => {
  const { exec, commands } = ssh([{ stdout: '' }, ok200, { stdout: '' }]);
  await grabTorrent({ ...base, savePath: '/downloads/elsewhere', exec });
  assert.match(commands.find((c) => c.includes('/torrents/add'))!, /savepath=%2Fdownloads%2Felsewhere/);
});
