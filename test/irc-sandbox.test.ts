import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { test } from 'node:test';
import { IrcEbooks, type Dialer, type IrcSocketLike } from '../src/media/irc-ebooks.js';

/**
 * 🔴 THE SANDBOX PROOF.
 *
 * `irc-ebooks.ts` runs inside the agent process, and under pm2 a throw from it
 * restarts Jedd — which deploys whatever is on the working tree. The module
 * claims that nothing escapes it. **A sandbox that has never been hit is a
 * claim**, so this file hits it: socket errors, a dialer that throws, malformed
 * protocol lines, a mid-transfer disconnect, an oversized transfer, and a bot
 * that never answers.
 *
 * The mutation that proves these tests bite: delete the `try/catch` in
 * `IrcEbooks.guard()` and re-run. Verified 2026-08-26 — removing it turns the
 * "dialer that throws" and "socket error" cases into unhandled rejections.
 */

class FakeSocket implements IrcSocketLike {
  handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
  written: string[] = [];
  destroyed = false;
  write(d: string | Buffer): void {
    this.written.push(d.toString('utf8'));
  }
  destroy(): void {
    this.destroyed = true;
  }
  on(event: string, cb: (...a: never[]) => void): void {
    (this.handlers[event] ??= []).push(cb as (...a: unknown[]) => void);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const h of [...(this.handlers[event] ?? [])]) h(...args);
  }
  line(s: string): void {
    this.emit('data', Buffer.from(`${s}\r\n`, 'binary'));
  }
}

function harness(opts: { failDial?: boolean } = {}) {
  const sockets: FakeSocket[] = [];
  const dial: Dialer = (_h, _p, onConnect) => {
    if (opts.failDial) throw new Error('ECONNREFUSED');
    const s = new FakeSocket();
    sockets.push(s);
    queueMicrotask(onConnect);
    return s;
  };
  const irc = new IrcEbooks({
    dial,
    joinDelayMs: 0,
    searchTimeoutMs: 60,
    offerTimeoutMs: 60,
    maxBytes: 4096,
    connectTimeoutMs: 200,
    nick: 'jeddtest',
  });
  return { irc, sockets };
}

const tick = (n = 4) => new Promise<void>((r) => setTimeout(r, n));

/** Drive a fake server through registration and JOIN. */
async function bringUp(sockets: FakeSocket[]): Promise<FakeSocket> {
  await tick();
  const s = sockets[0]!;
  s.line(':srv 001 jeddtest :Welcome');
  await tick();
  s.line(':srv 353 jeddtest = #ebooks :Bsk @Oatmeal +Ook Firebound jeddtest');
  s.line(':srv 366 jeddtest #ebooks :End of NAMES');
  await tick();
  return s;
}

/** A one-entry ZIP, built the way SearchBot's results arrive. */
function makeZip(name: string, text: string): Buffer {
  const data = deflateRawSync(Buffer.from(text, 'utf8'));
  const nameBuf = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32BE(0x504b0304, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(text.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const localAll = Buffer.concat([local, nameBuf, data]);

  const cd = Buffer.alloc(46);
  cd.writeUInt32BE(0x504b0102, 0);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(data.length, 20);
  cd.writeUInt32LE(text.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt32LE(0, 42);
  const cdAll = Buffer.concat([cd, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32BE(0x504b0506, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdAll.length, 12);
  eocd.writeUInt32LE(localAll.length, 16);

  return Buffer.concat([localAll, cdAll, eocd]);
}

function dccOffer(name: string, port: number, size: number): string {
  // 2130706433 = 127.0.0.1
  return `:SearchOok!x@y PRIVMSG jeddtest :\x01DCC SEND "${name}" 2130706433 ${port} ${size}\x01`;
}

test('🔴 a dialer that THROWS becomes a state, not an exception', async () => {
  const { irc } = harness({ failDial: true });
  const r = await irc.search('dune');
  assert.equal(r.state, 'unknown');
  assert.match(r.detail, /ECONNREFUSED|not available/);
});

test('🔴 a socket error mid-session becomes a state, not an exception', async () => {
  const { irc, sockets } = harness();
  const p = irc.search('dune');
  await tick();
  sockets[0]!.emit('error', new Error('ECONNRESET'));
  const r = await p;
  assert.equal(r.state, 'unknown');
});

test('🔴 a malformed protocol line does not kill the connection', async () => {
  const { irc, sockets } = harness();
  const p = irc.search('dune');
  await tick();
  const s = sockets[0]!;
  s.line(':srv 001 jeddtest :Welcome');
  await tick();
  // Garbage of several shapes, including a DCC line that cannot be read.
  s.line('@@@ not irc at all');
  s.line(':a!b PRIVMSG jeddtest :\x01DCC SEND broken\x01');
  s.line(':srv 353 jeddtest = #ebooks :Bsk jeddtest');
  s.line(':srv 366 jeddtest #ebooks :End');
  await tick();
  assert.equal(irc.status().joined, true, 'garbage must not prevent the join');
  const r = await p;
  assert.equal(r.state, 'unknown'); // timed out waiting for results, honestly
  irc.stop();
});

test('🔴 a throw INSIDE the data handler is contained — the inner catch is real', async () => {
  const { irc, sockets } = harness();
  const p = irc.search('dune');
  await tick();
  const s = sockets[0]!;
  // A socket-like that yields a non-Buffer. `chunk.toString('binary')` throws a
  // TypeError from inside onData, which is a different containment path from
  // guard(): guard wraps the AWAITED call, this fires on an EVENT with no
  // caller on the stack, so an escape here becomes an uncaught exception and
  // under pm2 that restarts Jedd.
  assert.doesNotThrow(() => s.emit('data', undefined));
  await tick();
  // ...and the connection is still usable afterwards.
  s.line(':srv 001 jeddtest :Welcome');
  await tick();
  s.line(':srv 353 jeddtest = #ebooks :Bsk jeddtest');
  s.line(':srv 366 jeddtest #ebooks :End');
  await tick();
  assert.equal(irc.status().joined, true, 'a bad chunk must not poison the session');
  await p;
  irc.stop();
});

test('a completed search parses, filters, and reports what it left out', async () => {
  const { irc, sockets } = harness();
  const p = irc.search('project hail mary');
  const s = await bringUp(sockets);

  const listing = [
    '!Bsk Project Hail Mary - Andy Weir.epub ::INFO:: 2.5MB',
    '!Oatmeal Project Hail Mary - Andy Weir.epub ::INFO:: 654.35KB',
    '!Ghost Some Book.epub ::INFO:: 1MB', // bot NOT in the roster
    '!Ook Andy Weir - Project Hail Mary (epub).rar  ::INFO:: 9MB',
  ].join('\n');
  const zip = makeZip('results.txt', listing);

  s.line(dccOffer('results.txt.zip', 5000, zip.length));
  await tick();
  const dcc = sockets[1]!;
  dcc.emit('data', zip);
  dcc.emit('close');

  const r = await p;
  assert.equal(r.state, 'ok');
  if (r.state !== 'ok') return;
  assert.deepEqual(r.results.map((x) => x.bot).sort(), ['Bsk', 'Oatmeal']);
  assert.match(r.detail, /not currently online/, 'the absent bot must be reported, not hidden');
  assert.match(r.detail, /archives|dead formats/);
  irc.stop();
});

test('🔴 a bot that is NOT in the channel is refused BEFORE anything is requested', async () => {
  const { irc, sockets } = harness();
  const p = irc.fetch('!Ghost Some Book.epub', 'Ghost');
  const s = await bringUp(sockets);
  const r = await p;
  assert.equal(r.state, 'failed');
  assert.match(r.detail, /not in #ebooks/);
  assert.match(r.detail, /Nothing was requested/);
  assert.ok(
    !s.written.some((w) => w.includes('Ghost Some Book')),
    'a refusal that still sent the request would be the bug',
  );
  irc.stop();
});

test('🔴 a bot that never answers FAILS honestly instead of looking like progress', async () => {
  const { irc, sockets } = harness();
  const p = irc.fetch('!Bsk A Book.epub', 'Bsk');
  await bringUp(sockets);
  const r = await p;
  assert.equal(r.state, 'failed');
  assert.match(r.detail, /never sent the book/);
  assert.match(r.detail, /Nothing arrived/);
  irc.stop();
});

test('🔴 a mid-transfer disconnect DISCARDS the partial file', async () => {
  const { irc, sockets } = harness();
  const p = irc.fetch('!Bsk A Book.epub', 'Bsk');
  const s = await bringUp(sockets);
  s.line(dccOffer('A Book.epub', 5001, 1000));
  await tick();
  const dcc = sockets[1]!;
  dcc.emit('data', Buffer.alloc(400, 1)); // less than promised
  dcc.emit('close');
  const r = await p;
  assert.equal(r.state, 'failed');
  assert.match(r.detail, /400 of 1000/);
  assert.match(r.detail, /discarded/);
  irc.stop();
});

test('🔴 an oversized transfer is aborted while reading, not trusted from the offer', async () => {
  const { irc, sockets } = harness();
  const p = irc.fetch('!Bsk Big.epub', 'Bsk');
  const s = await bringUp(sockets);
  // The offer UNDERSTATES the size: 100 bytes promised, megabytes sent.
  s.line(dccOffer('Big.epub', 5002, 100));
  await tick();
  const dcc = sockets[1]!;
  dcc.emit('data', Buffer.alloc(9000, 7));
  const r = await p;
  assert.equal(r.state, 'failed');
  assert.match(r.detail, /limit mid-transfer|Aborted/);
  irc.stop();
});

test('an offer larger than the cap is refused before dialling', async () => {
  const { irc, sockets } = harness();
  const p = irc.fetch('!Bsk Huge.epub', 'Bsk');
  const s = await bringUp(sockets);
  s.line(dccOffer('Huge.epub', 5003, 900_000_000));
  const r = await p;
  assert.equal(r.state, 'failed');
  assert.match(r.detail, /over the .* limit/);
  assert.equal(sockets.length, 1, 'no DCC connection should have been opened');
  irc.stop();
});

test('🔴 passive DCC (port 0) fails with a reason instead of hanging', async () => {
  const { irc, sockets } = harness();
  const p = irc.fetch('!Bsk P.epub', 'Bsk');
  const s = await bringUp(sockets);
  s.line(dccOffer('P.epub', 0, 500));
  const r = await p;
  assert.equal(r.state, 'failed');
  assert.match(r.detail, /reverse \(passive\)|incoming connection/);
  irc.stop();
});

test('a successful fetch returns the exact bytes', async () => {
  const { irc, sockets } = harness();
  const p = irc.fetch('!Bsk A Book.epub', 'Bsk');
  const s = await bringUp(sockets);
  s.line(dccOffer('A Book.epub', 5004, 300));
  await tick();
  const dcc = sockets[1]!;
  const payload = Buffer.alloc(300, 0x5a);
  dcc.emit('data', payload);
  dcc.emit('close');
  const r = await p;
  assert.equal(r.state, 'ok');
  if (r.state === 'ok') {
    assert.equal(r.filename, 'A Book.epub');
    assert.ok(r.bytes.equals(payload));
  }
  irc.stop();
});

test('🔴 the request goes to the CHANNEL, verbatim, not to the bot', async () => {
  const { irc, sockets } = harness();
  const p = irc.fetch('!Firebound %0D13448072AD% Andy Weir - Project Hail Mary (Retail).epub', 'Firebound');
  const s = await bringUp(sockets);
  const sent = s.written.find((w) => w.includes('Firebound %0D'));
  assert.ok(sent, 'the command must be sent');
  assert.match(sent, /^PRIVMSG #ebooks :!Firebound %0D13448072AD% /, 'to the channel, prefix intact');
  await p;
  irc.stop();
});

test('🔴 a newline in a query cannot inject a second IRC command', async () => {
  const { irc, sockets } = harness();
  const p = irc.search('dune\r\nJOIN #secret');
  const s = await bringUp(sockets);
  await tick();
  const joins = s.written.filter((w) => w.startsWith('JOIN'));
  assert.equal(joins.length, 1, 'only our own JOIN #ebooks');
  const search = s.written.find((w) => w.includes('@search'))!;
  // The payload stays INSIDE one PRIVMSG. `#secret` surviving as message text is
  // harmless; a second CRLF-terminated line would have been the vulnerability.
  assert.equal(search.split('\r\n').filter(Boolean).length, 1, 'must be a single IRC line');
  assert.match(search, /^PRIVMSG #ebooks :@search dune +JOIN #secret\r\n$/);
  await p;
  irc.stop();
});

test('a channel ban is recorded as an access decision, not retried', async () => {
  const { irc, sockets } = harness();
  const p = irc.search('x');
  await tick();
  const s = sockets[0]!;
  s.line(':srv 001 jeddtest :Welcome');
  await tick();
  s.line(':srv 474 jeddtest #ebooks :Cannot join channel (+b)');
  await tick();
  assert.match(irc.status().detail, /reported, not worked around/);
  const r = await p;
  assert.equal(r.state, 'unknown');
  irc.stop();
});

test('roster tracking follows JOIN and PART while connected', async () => {
  const { irc, sockets } = harness();
  const p = irc.search('x');
  const s = await bringUp(sockets);
  assert.equal(irc.rosterHas('Bsk'), true);
  s.line(':Bsk!x@y PART #ebooks');
  await tick();
  assert.equal(irc.rosterHas('Bsk'), false, 'a bot that left must stop being offered');
  s.line(':Newbot!x@y JOIN #ebooks');
  await tick();
  assert.equal(irc.rosterHas('newbot'), true);
  await p;
  irc.stop();
});
