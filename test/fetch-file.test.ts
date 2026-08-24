import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { ExecImpl } from '../src/hp.js';
import { fetchFileFromHp, isSafeHostPath } from '../src/media/fetch-file.js';

const CONTENT = Buffer.from('a real epub would be here, but bytes are bytes');
const SHA = createHash('sha256').update(CONTENT).digest('hex');
const B64 = CONTENT.toString('base64');

/** Script the two ssh calls: the stat/sha probe, then the base64 read. */
function ssh(meta: string, body: string, codes: [number?, number?] = []) {
  const commands: string[] = [];
  let i = 0;
  const exec: ExecImpl = (_f, args, _o, cb) => {
    commands.push(args[args.length - 1]!);
    const n = i++;
    const code = codes[n];
    cb(code ? { code } : null, n === 0 ? meta : body, '');
  };
  return { exec, commands };
}

const base = { adminSshHost: 'admin.invalid', hostPath: '/home/jeff/gluetun/downloads/ebooks/x.epub' };

// ── 🔴 verification is the point ─────────────────────────────────────────────

test('a clean read returns the bytes and the checksum', async () => {
  const { exec } = ssh(`${CONTENT.length}\n${SHA}`, B64);
  const r = await fetchFileFromHp({ ...base, exec });
  assert.equal(r.state, 'ok');
  if (r.state !== 'ok') throw new Error('unreachable');
  assert.equal(r.bytes.toString(), CONTENT.toString());
  assert.equal(r.name, 'x.epub');
});

test('🔴 a TRUNCATED transfer is caught here, not by Amazon', async () => {
  // A truncated read makes a corrupt epub, which Amazon rejects as E001. Our own
  // detector would catch it and call it a DELIVERY failure -- the wrong diagnosis
  // for a TRANSPORT bug, sending the next person to look at Amazon.
  const { exec } = ssh(`${CONTENT.length}\n${SHA}`, B64.slice(0, 20));
  const r = await fetchFileFromHp({ ...base, exec });
  assert.equal(r.state, 'corrupt');
  if (r.state !== 'corrupt') throw new Error('unreachable');
  assert.match(r.detail, /TRUNCATED/);
  assert.match(r.detail, /transport fault, NOT a problem with the book or with Amazon/);
});

test('🔴 a same-length but CORRUPT transfer is caught by the checksum', async () => {
  // Length alone is not enough: a byte-for-byte substitution passes it.
  const wrong = Buffer.alloc(CONTENT.length, 0x41).toString('base64');
  const { exec } = ssh(`${CONTENT.length}\n${SHA}`, wrong);
  const r = await fetchFileFromHp({ ...base, exec });
  assert.equal(r.state, 'corrupt');
  if (r.state !== 'corrupt') throw new Error('unreachable');
  assert.match(r.detail, /CORRUPT: checksum/);
});

test('the checksum is taken on hp BEFORE the bytes move', async () => {
  // Measuring after transfer would derive the expectation from the thing being
  // tested, and both would agree on a truncated file.
  const { exec, commands } = ssh(`${CONTENT.length}\n${SHA}`, B64);
  await fetchFileFromHp({ ...base, exec });
  assert.match(commands[0]!, /sha256sum/);
  assert.match(commands[1]!, /base64 -w0/);
});

// ── states that are not corruption ───────────────────────────────────────────

test('🔴 a missing file names the PATH problem rather than blaming the download', async () => {
  const { exec } = ssh('MISSING', '');
  const r = await fetchFileFromHp({ ...base, exec });
  assert.equal(r.state, 'missing');
  if (r.state !== 'missing') throw new Error('unreachable');
  assert.match(r.detail, /PATH problem/);
  assert.match(r.detail, /not a missing download/);
});

test('a zero-byte file is corrupt, not ok', async () => {
  const { exec } = ssh(`0\n${SHA}`, '');
  assert.equal((await fetchFileFromHp({ ...base, exec })).state, 'corrupt');
});

test('an ssh failure is UNKNOWN, distinct from missing and corrupt', async () => {
  const { exec } = ssh('', '', [255]);
  assert.equal((await fetchFileFromHp({ ...base, exec })).state, 'unknown');
});

test('an oversized file is refused before it is read', async () => {
  const { exec, commands } = ssh(`999999999\n${SHA}`, B64);
  const r = await fetchFileFromHp({ ...base, exec, maxBytes: 1024 });
  assert.equal(r.state, 'unknown');
  assert.equal(commands.length, 1, 'the base64 read must not have happened');
});

// ── the path reaches a shell ─────────────────────────────────────────────────

test('🔴 only a plain absolute path is accepted', () => {
  assert.equal(isSafeHostPath('/home/jeff/gluetun/downloads/ebooks/Red Rising Trilogy EPUB'), true);
  for (const bad of ['relative/path', '/a/../../etc/passwd', '/a\nb', '/a\0b']) {
    assert.equal(isSafeHostPath(bad), false, `${JSON.stringify(bad)} must be refused`);
  }
});

test('a path with spaces and quotes survives quoting', async () => {
  const { exec, commands } = ssh(`${CONTENT.length}\n${SHA}`, B64);
  await fetchFileFromHp({
    ...base,
    hostPath: "/downloads/ebooks/Jo's Book (2024) EPUB",
    exec,
  });
  assert.match(commands[0]!, /'\/downloads\/ebooks\/Jo'\\''s Book \(2024\) EPUB'/);
});
