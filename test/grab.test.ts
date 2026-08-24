import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExecImpl } from '../src/hp.js';
import { grabTorrent } from '../src/media/grab.js';

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
