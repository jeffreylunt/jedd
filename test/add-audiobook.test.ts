import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChoiceStore } from '../src/choices.js';
import type { ExecImpl } from '../src/hp.js';
import { addAudiobook, makeAddAudiobook } from '../src/tools/add-audiobook.js';
import { testConfig } from './helpers.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const tmp = () => join(mkdtempSync(join(tmpdir(), 'jedd-ab-')), 'f.jsonl');

function ssh() {
  const commands: string[] = [];
  const replies = [{ stdout: '' }, { stdout: 'Ok.\n200' }, { stdout: '' }];
  let i = 0;
  const exec: ExecImpl = (_f, args, _o, cb) => {
    commands.push(args[args.length - 1]!);
    cb(null, replies[Math.min(i++, replies.length - 1)]!.stdout, '');
  };
  return { exec, commands };
}

function ctx(exec: ExecImpl) {
  const choices = new ChoiceStore(tmp());
  choices.present({
    senderHandle: '+1555', subject: 'Dune', kind: 'audiobook-release',
    options: [{ n: 1, label: 'Dune Unabridged', value: { infoHash: HASH, title: 'Dune Unabridged' } }],
  });
  return { role: 'guest' as const, senderHandle: '+1555', config: testConfig({ readOnly: false }), choices, exec };
}

// ── 🔴 the mover is what delivers, and we must not claim its work ────────────

test('🔴 a started grab reports the MECHANISM and refuses to claim Audiobookshelf', async () => {
  // A host cron outside V2 does the move. If it stops, downloads still complete
  // and nothing reaches Audiobookshelf, with no error anywhere in V2.
  const { exec } = ssh();
  const r = await addAudiobook.run({ choice: 1 }, ctx(exec));
  assert.equal(r.ok, true);
  assert.match(r.content, /^STARTED/);
  assert.match(r.content, /do NOT tell them it is in Audiobookshelf/i);
  assert.match(r.content, /not ours and we cannot see it/i);
});

test('🔴 the grab uses BOTH the category the mover watches AND an explicit savepath', async () => {
  // The category is what the mover looks at; the savepath is what actually
  // places the file, because a category alone does not.
  const { exec, commands } = ssh();
  await addAudiobook.run({ choice: 1 }, ctx(exec));
  const add = commands.find((c) => c.includes('/torrents/add'))!;
  assert.match(add, /category=audiobooks/);
  assert.match(add, /savepath=%2Fdownloads%2Faudiobooks/);
});

test('the category is created before the add, as for ebooks', async () => {
  const { exec, commands } = ssh();
  await addAudiobook.run({ choice: 1 }, ctx(exec));
  assert.match(commands[0]!, /createCategory/);
});

test('a lost option list re-asks rather than grabbing something', async () => {
  const { exec, commands } = ssh();
  const r = await addAudiobook.run({ choice: 7 }, ctx(exec));
  assert.equal(r.ok, false);
  assert.match(r.content, /OUT-OF-RANGE/);
  assert.equal(commands.length, 0, 'nothing may be grabbed for an option that was not offered');
});

test('it is a guest-visible WRITE and is gated by the kill switch', async () => {
  assert.equal(addAudiobook.minRole, 'guest');
  assert.equal(addAudiobook.writes, true);
  const r = await addAudiobook.run({ choice: 1 }, { ...ctx(ssh().exec), config: testConfig({ readOnly: true }) });
  assert.equal(r.ok, false);
  assert.match(r.content, /Writes are disabled/);
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 A PICK WITH NO infoHash IS RESOLVED, NOT REFUSED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Prowlarr publishes `infoHash` for The Pirate Bay and not for 1337x. Dungeon
 * Crawler Carl is carried ONLY by 1337x, so before this the entire series was
 * unfetchable — the search found the book, named it, and then had nothing to
 * hand qBittorrent.
 *
 * The `downloadUrl` 301s to a magnet carrying the hash and 21 trackers. Reading
 * that redirect happens HERE, on the Mac, which can reach Prowlarr — qBittorrent
 * never has to, and it could not: it lives in gluetun's netns.
 */

const DCC_HASH = 'F1A841C4EB55D2ECEEBDCAB876724BBF1A99CC8E';
const DCC_MAGNET = `magnet:?xt=urn:btih:${DCC_HASH}&dn=The+Dungeon+Anarchists+Cookbook&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337`;

const redirectTo = (location: string | null): Response =>
  ({ ok: false, status: 301, headers: { get: (k: string) => (k.toLowerCase() === 'location' ? location : null) } }) as unknown as Response;

function ctxNoHash(exec: ExecImpl) {
  const choices = new ChoiceStore(tmp());
  choices.present({
    senderHandle: '+1555', subject: 'DCC', kind: 'audiobook-release',
    options: [{
      n: 1,
      label: 'The Dungeon Anarchists Cookbook',
      // Exactly what a 1337x row stores: no infoHash, a download link.
      value: { infoHash: '', title: 'The Dungeon Anarchists Cookbook', downloadUrl: 'http://prowlarr/proxy/1' },
    }],
  });
  return { role: 'guest' as const, senderHandle: '+1555', config: testConfig({ readOnly: false }), choices, exec };
}

test('🔴 a 1337x pick with no infoHash is resolved from its download link and grabbed', async () => {
  const { exec, commands } = ssh();
  const r = await makeAddAudiobook(async () => redirectTo(DCC_MAGNET)).run({ choice: 1 }, ctxNoHash(exec));
  assert.equal(r.ok, true, r.content);
  assert.match(r.content, /^STARTED — /);
  // 🔴 The magnet that reached qBittorrent is the indexer's own, trackers and
  // all — not a bare xt=urn:btih: that would have to find peers over DHT.
  const add = commands.find((c) => c.includes('torrents/add'));
  assert.ok(add, 'nothing was added');
  assert.match(add, /tracker\.opentrackr\.org/);
  assert.match(add.toLowerCase(), new RegExp(DCC_HASH.toLowerCase()));
});

test('🔴 a resolve that fails says THIS COPY could not start, not that the book is unavailable', async () => {
  const { exec, commands } = ssh();
  const r = await makeAddAudiobook(async () => {
    throw new Error('ECONNREFUSED');
  }).run({ choice: 1 }, ctxNoHash(exec));
  assert.equal(r.ok, false);
  assert.match(r.content, /^COULD NOT FETCH — /);
  assert.match(r.content, /NOT that the book is unavailable/);
  assert.equal(commands.filter((c) => c.includes('torrents/add')).length, 0, 'nothing may be added');
});

test('🔴 a hostile redirect cannot smuggle a different torrent past the grab', async () => {
  // The Location header is third-party text that ends up on a privileged shell
  // command line. A hash that is not 40 hex must never reach it.
  const { exec, commands } = ssh();
  const r = await makeAddAudiobook(async () => redirectTo('magnet:?xt=urn:btih:notahash&dn=x')).run(
    { choice: 1 },
    ctxNoHash(exec),
  );
  assert.equal(r.ok, false);
  assert.equal(commands.filter((c) => c.includes('torrents/add')).length, 0);
});

test('CONTROL: a pick that already HAS an infoHash still grabs without any resolve', async () => {
  const { exec } = ssh();
  let fetched = 0;
  const r = await makeAddAudiobook(async () => {
    fetched += 1;
    return redirectTo(DCC_MAGNET);
  }).run({ choice: 1 }, ctx(exec));
  assert.equal(r.ok, true);
  assert.equal(fetched, 0, 'a release that is already grabbable must not be re-resolved');
});
