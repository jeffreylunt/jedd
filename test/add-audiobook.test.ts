import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChoiceStore } from '../src/choices.js';
import type { ExecImpl } from '../src/hp.js';
import { addAudiobook } from '../src/tools/add-audiobook.js';
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
