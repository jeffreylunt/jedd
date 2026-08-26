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

/**
 * @param from the nick the offer comes from. It MATTERS: an offer answering a
 * fetch is only accepted from the bot that fetch asked, so a test that offers a
 * book from the wrong nick is testing the refusal, not the transfer.
 */
function dccOffer(name: string, port: number, size: number, from = 'SearchOok'): string {
  // 2130706433 = 127.0.0.1
  return `:${from}!x@y PRIVMSG jeddtest :\x01DCC SEND "${name}" 2130706433 ${port} ${size}\x01`;
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
  s.line(dccOffer('A Book.epub', 5001, 1000, 'Bsk'));
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
  s.line(dccOffer('Big.epub', 5002, 100, 'Bsk'));
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
  s.line(dccOffer('Huge.epub', 5003, 900_000_000, 'Bsk'));
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
  s.line(dccOffer('P.epub', 0, 500, 'Bsk'));
  const r = await p;
  assert.equal(r.state, 'failed');
  assert.match(r.detail, /reverse \(passive\)|incoming connection/);
  irc.stop();
});

test('a successful fetch returns the exact bytes', async () => {
  const { irc, sockets } = harness();
  const p = irc.fetch('!Bsk A Book.epub', 'Bsk');
  const s = await bringUp(sockets);
  s.line(dccOffer('A Book.epub', 5004, 300, 'Bsk'));
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

/**
 * ── 🔴 THE CONCURRENCY CLUSTER ──────────────────────────────────────────────
 *
 * One `IrcEbooks` is shared by every user, and an incoming DCC offer does not
 * say which request it answers. A code review reproduced four ways that went
 * wrong; each of these is one of them, and each was seen to FAIL before the fix.
 */

test('🔴 two callers cannot cross-deliver: a second request is REFUSED, not queued into one slot', async () => {
  const { irc, sockets } = harness();
  const a = irc.fetch('!Bsk AAA.epub', 'Bsk');
  const s = await bringUp(sockets);
  const b = await irc.fetch('!Oatmeal BBB.epub', 'Oatmeal');

  // B must NOT be able to install itself over A's slot.
  assert.equal(b.state, 'unknown');
  assert.match(b.detail, /already handling another request/);
  assert.match(b.detail, /nothing was requested/i);
  assert.ok(!s.written.some((w) => w.includes('BBB.epub')), 'B must not have asked its bot');

  // A's own book still reaches A.
  s.line(dccOffer('AAA.epub', 5100, 5, 'Bsk'));
  await tick();
  sockets[1]!.emit('data', Buffer.from('AAAAA'));
  sockets[1]!.emit('close');
  const ra = await a;
  assert.equal(ra.state, 'ok');
  if (ra.state === 'ok') assert.equal(ra.filename, 'AAA.epub');
  irc.stop();
});

test('🔴 an unsolicited DCC offer is IGNORED — a stranger cannot make us dial out', async () => {
  const { irc, sockets } = harness();
  const p = irc.search('dune');
  const s = await bringUp(sockets);
  await tick();
  const before = sockets.length;
  // Nothing is pending: the search already timed out.
  await p;
  s.line(dccOffer('free-money.epub', 6000, 10, 'Attacker'));
  await tick();
  assert.equal(sockets.length, before, 'no outbound connection may be opened for an unsolicited offer');
  irc.stop();
});

test('🔴 an offer from the WRONG bot cannot substitute the file', async () => {
  const { irc, sockets } = harness();
  const p = irc.fetch('!Bsk Real.epub', 'Bsk');
  const s = await bringUp(sockets);
  const before = sockets.length;
  // Someone else in the channel answers first with their own bytes.
  s.line(dccOffer('Real.epub', 6001, 4, 'Attacker'));
  await tick();
  assert.equal(sockets.length, before, 'we must not dial the impostor');

  // The real bot then answers and IS accepted.
  s.line(dccOffer('Real.epub', 6002, 4, 'Bsk'));
  await tick();
  sockets[before]!.emit('data', Buffer.from('GOOD'));
  sockets[before]!.emit('close');
  const r = await p;
  assert.equal(r.state, 'ok');
  if (r.state === 'ok') assert.equal(r.bytes.toString(), 'GOOD');
  irc.stop();
});

test('🔴 stop() destroys a STALLED transfer instead of leaking it', async () => {
  const { irc, sockets } = harness();
  const p = irc.fetch('!Bsk Slow.epub', 'Bsk');
  const s = await bringUp(sockets);
  s.line(dccOffer('Slow.epub', 6003, 1000, 'Bsk'));
  await tick();
  const dcc = sockets[1]!;
  dcc.emit('data', Buffer.alloc(100, 1)); // then silence, forever
  await tick();
  assert.equal(dcc.destroyed, false);
  irc.stop();
  assert.equal(dcc.destroyed, true, 'a stalled DCC socket must not survive shutdown');
  await p;
});

test('🔴 a dead socket\'s late close does not tear down the NEW connection', async () => {
  const { irc, sockets } = harness();
  const p1 = irc.search('a');
  await tick();
  const first = sockets[0]!;
  first.emit('error', new Error('ECONNRESET'));
  await p1;

  // Reconnect.
  const p2 = irc.search('b');
  await tick();
  const second = sockets[1]!;
  second.line(':srv 001 jeddtest :Welcome');
  await tick();
  second.line(':srv 353 jeddtest = #ebooks :Bsk jeddtest');
  second.line(':srv 366 jeddtest #ebooks :End');
  await tick();
  assert.equal(irc.status().joined, true);

  // The FIRST socket finally emits its close.
  first.emit('close');
  await tick();
  assert.equal(irc.status().joined, true, 'the old socket must not tear down the live one');
  await p2;
  irc.stop();
});

test('a KICKed bot stops being offered', async () => {
  const { irc, sockets } = harness();
  const p = irc.search('x');
  const s = await bringUp(sockets);
  assert.equal(irc.rosterHas('Bsk'), true);
  s.line(':op!x@y KICK #ebooks Bsk :spam');
  await tick();
  assert.equal(irc.rosterHas('Bsk'), false);
  await p;
  irc.stop();
});

test('an unterminated flood does not grow the line buffer without bound', async () => {
  const { irc, sockets } = harness();
  const p = irc.search('x');
  await tick();
  const s = sockets[0]!;
  for (let i = 0; i < 40; i++) s.emit('data', Buffer.alloc(4096, 0x41)); // no newline, ever
  await tick();
  s.line(':srv 001 jeddtest :Welcome');
  await tick();
  s.line(':srv 353 jeddtest = #ebooks :Bsk jeddtest');
  s.line(':srv 366 jeddtest #ebooks :End');
  await tick();
  assert.equal(irc.status().joined, true, 'the connection must still work after the flood');
  await p;
  irc.stop();
});

test('🔴 a COMPLETED request\'s stale timer must not clear the NEXT request\'s slot', async () => {
  /**
   * The mutex stops two slots existing at once, but not a stale TIMER. A's
   * transfer completes and clears the slot; B then installs its own; A's
   * original timeout finally fires. Without the id check it clears B's slot, and
   * B's bytes then arrive to find nothing waiting and are DROPPED — B waits out
   * its own timeout and is told "nothing arrived" about a file that did arrive.
   *
   * ⚠️ The two deadlines are deliberately far apart. With A and B on the same
   * short timeout there is no window: B expires on its own before A's stale
   * timer can be shown to matter, and the test fails for a reason that has
   * nothing to do with the bug.
   */
  const sockets: FakeSocket[] = [];
  const dial: Dialer = (_h, _p, onConnect) => {
    const sk = new FakeSocket();
    sockets.push(sk);
    queueMicrotask(onConnect);
    return sk;
  };
  const irc = new IrcEbooks({
    dial,
    joinDelayMs: 0,
    searchTimeoutMs: 50, // A: expires quickly
    offerTimeoutMs: 4000, // B: still waiting long after
    connectTimeoutMs: 200,
    maxBytes: 4096,
    nick: 'jeddtest',
  });

  // A is a SEARCH; it completes, then its 50ms timer stays armed.
  const a = irc.search('dune');
  const s = await bringUp(sockets);
  const zip = makeZip('results.txt', '!Bsk Real.epub ::INFO:: 1MB');
  s.line(dccOffer('results.txt.zip', 7000, zip.length, 'SearchOok'));
  await tick();
  sockets[1]!.emit('data', zip);
  sockets[1]!.emit('close');
  assert.equal((await a).state, 'ok');

  // B installs its own slot, then A's stale timer fires.
  const b = irc.fetch('!Bsk Real.epub', 'Bsk');
  await tick(2);
  await tick(120); // well past A's 50ms, far short of B's 4000ms

  s.line(dccOffer('Real.epub', 7001, 3, 'Bsk'));
  await tick();
  const dcc = sockets[2];
  assert.ok(dcc, "B's offer must still be accepted — A's stale timer must not have cleared the slot");
  dcc.emit('data', Buffer.from('BBB'));
  dcc.emit('close');
  const rb = await b;
  assert.equal(rb.state, 'ok');
  if (rb.state === 'ok') assert.equal(rb.bytes.toString(), 'BBB');
  irc.stop();
});

test('🔴 a results file answering SOMEONE ELSE\'S query is refused, not used', async () => {
  /**
   * MEASURED LIVE 2026-08-26: a search for "project hail mary" came back with
   * nine real EPUBs of "The Loch" by Steve Alten. SearchBot queues searches and
   * DCCs them to the requesting NICK; we had taken a stable nick that something
   * had a pending search against. Every layer below was working — the results
   * were simply not ours.
   */
  const { irc, sockets } = harness();
  const p = irc.search('project hail mary');
  const s = await bringUp(sockets);
  const foreign = [
    'Searched 15 lists for "the loch" , found 27 matches. Enjoy!',
    '!Bsk Steve Alten - [Loch 01] - The Loch.epub ::INFO:: 612KB',
  ].join('\n');
  const zip = makeZip('results.txt', foreign);
  s.line(dccOffer('SearchOok_results_for__the_loch.txt.zip', 8000, zip.length, 'SearchOok'));
  await tick();
  sockets[1]!.emit('data', zip);
  sockets[1]!.emit('close');

  const r = await p;
  // UNKNOWN, never 'none': we learned nothing about the book we asked about.
  assert.equal(r.state, 'unknown');
  assert.match(r.detail, /the loch/i);
  assert.match(r.detail, /somebody else/i);
  irc.stop();
});

test('a results file for OUR query is accepted despite spacing and case', async () => {
  const { irc, sockets } = harness();
  const p = irc.search('Project  Hail Mary');
  const s = await bringUp(sockets);
  const mine = [
    'Searched 15 lists for "project hail mary" , found 2 matches.',
    '!Bsk Project Hail Mary - Andy Weir.epub ::INFO:: 2.5MB',
  ].join('\n');
  const zip = makeZip('results.txt', mine);
  s.line(dccOffer('r.txt.zip', 8001, zip.length, 'SearchOok'));
  await tick();
  sockets[1]!.emit('data', zip);
  sockets[1]!.emit('close');
  const r = await p;
  assert.equal(r.state, 'ok');
  irc.stop();
});

test('a nick collision takes a variant instead of never registering', async () => {
  const { irc, sockets } = harness();
  const p = irc.search('x');
  await tick();
  const s = sockets[0]!;
  s.line(':srv 433 * jeddtest :Nickname is already in use');
  await tick();
  assert.ok(
    s.written.some((w) => /^NICK jeddtest1/.test(w)),
    'must try another nick rather than sit unregistered forever',
  );
  irc.stop();
  await p;
});

test('🔴 a dropped connection reconnects on its own, backing off', async () => {
  /**
   * Without this, recovery happens inside a USER'S TURN: connect() is lazy and a
   * cold join costs ~70s, so the first person to ask for a book after any drop
   * pays the whole reconnect out of their own wait.
   */
  const sockets: FakeSocket[] = [];
  const dial: Dialer = (_h, _p, onConnect) => {
    const sk = new FakeSocket();
    sockets.push(sk);
    queueMicrotask(onConnect);
    return sk;
  };
  const irc = new IrcEbooks({ dial, joinDelayMs: 0, connectTimeoutMs: 100, reconnectBaseMs: 10, nick: 'jeddtest' });
  const p = irc.search('x');
  await tick();
  sockets[0]!.emit('close');
  await p;
  // The client dials again WITHOUT anyone asking.
  await tick(60);
  assert.ok(sockets.length >= 2, 'must reconnect unprompted rather than wait for the next user');
  irc.stop();
});

test('🔴 an ops refusal is NOT reconnected against — that would be evading a ban', async () => {
  const sockets: FakeSocket[] = [];
  const dial: Dialer = (_h, _p, onConnect) => {
    const sk = new FakeSocket();
    sockets.push(sk);
    queueMicrotask(onConnect);
    return sk;
  };
  const irc = new IrcEbooks({ dial, joinDelayMs: 0, connectTimeoutMs: 100, reconnectBaseMs: 10, nick: 'jeddtest' });
  const p = irc.search('x');
  await tick();
  const s = sockets[0]!;
  s.line(':srv 001 jeddtest :Welcome');
  await tick();
  s.line(':srv 474 jeddtest #ebooks :Cannot join channel (+b)');
  await tick();
  s.emit('close');
  const before = sockets.length;
  await tick(80);
  assert.equal(sockets.length, before, 'a ban is a decision a person made; retrying politely still evades it');
  assert.match(irc.status().detail, /No reconnect will be attempted/);
  await p;
  irc.stop();
});

test('stop() cancels a pending reconnect', async () => {
  const sockets: FakeSocket[] = [];
  const dial: Dialer = (_h, _p, onConnect) => {
    const sk = new FakeSocket();
    sockets.push(sk);
    queueMicrotask(onConnect);
    return sk;
  };
  const irc = new IrcEbooks({ dial, joinDelayMs: 0, connectTimeoutMs: 100, reconnectBaseMs: 30, nick: 'jeddtest' });
  const p = irc.search('x');
  await tick();
  sockets[0]!.emit('close');
  await p;
  irc.stop();
  const before = sockets.length;
  await tick(90);
  assert.equal(sockets.length, before, 'a stopped client must not come back to life');
});

test('🔴 the search timeout has headroom over MEASURED bot latency', () => {
  /**
   * Live `@search` replies measured 2026-08-26: 17.6s, 25.4s, ~34s, 47.0s,
   * 60.9s. The original 45s default timed out the last two — reporting "the
   * search bot did not answer" about a bot that was merely slower than our cap.
   * A timeout tighter than the thing it measures manufactures its own negative.
   *
   * This asserts the default keeps room above the slowest observed reply. It is
   * a guard against someone "tidying" the number back down without the data.
   */
  const SLOWEST_OBSERVED_MS = 60_900;
  const irc = new IrcEbooks({ dial: (() => { throw new Error('unused'); }) as never });
  const used = (irc as unknown as { o: { searchTimeoutMs: number } }).o.searchTimeoutMs;
  assert.ok(
    used > SLOWEST_OBSERVED_MS,
    `search timeout ${used}ms must exceed the slowest measured reply ${SLOWEST_OBSERVED_MS}ms`,
  );
});
