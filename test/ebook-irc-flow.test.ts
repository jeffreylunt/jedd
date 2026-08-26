import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChoiceStore } from '../src/choices.js';
import { FollowupStore } from '../src/followups.js';
import { runDueFollowups } from '../src/followup-runner.js';
import { KindleRegistry } from '../src/kindle.js';
import { IrcEbooks } from '../src/media/irc-ebooks.js';
import { makeSendEbook } from '../src/tools/send-ebook.js';
import { testConfig } from './helpers.js';

const JEFF = '+18015550123';
const tmp = () => join(mkdtempSync(join(tmpdir(), 'jedd-irc-')), 'f.jsonl');

/** A real EPUB header, as measured from a live #ebooks bot. */
const EPUB = Buffer.concat([
  Buffer.from(
    '504b03041400160800004' + '7b9a3526f61ab2c140000001400000008000000' + '6d696d6574797065' +
      Buffer.from('application/epub+zip', 'latin1').toString('hex'),
    'hex',
  ),
  Buffer.alloc(400, 0x41),
]);

/** An IRC client stub — the real one is exercised in irc-sandbox.test.ts. */
function fakeIrc(over: Partial<Record<'fetch', unknown>> = {}) {
  const calls: Array<{ command: string; bot: string }> = [];
  const irc = {
    calls,
    rosterHas: () => true,
    async search() {
      return { state: 'none' as const, detail: 'not used here' };
    },
    async fetch(command: string, bot: string) {
      calls.push({ command, bot });
      return { state: 'ok' as const, filename: 'A Book.epub', bytes: EPUB, detail: 'ok' };
    },
    ...over,
  };
  return irc as unknown as IrcEbooks & { calls: typeof calls };
}

function ctx(opts: { value: Record<string, unknown>; followups?: FollowupStore }) {
  const kindle = new KindleRegistry(tmp());
  kindle.save(JEFF, 'a_b@kindle.com', ['a_b@kindle.com']);
  const choices = new ChoiceStore(tmp());
  choices.present({
    senderHandle: JEFF,
    subject: 'a book',
    kind: 'release',
    options: [
      { n: 1, label: String(opts.value['title'] ?? 'opt'), value: opts.value },
      { n: 2, label: 'Some Other Book.epub', value: { source: 'irc', command: '!Bsk Other.epub', bot: 'Bsk', title: 'Some Other Book.epub' } },
    ],
  });
  return {
    role: 'guest' as const,
    senderHandle: JEFF,
    config: testConfig({ readOnly: false }),
    kindle,
    choices,
    ...(opts.followups ? { followups: opts.followups } : {}),
  };
}

test('🔴 an IRC pick is NOT fetched inside the turn — it is scheduled', async () => {
  const sent: unknown[] = [];
  const irc = fakeIrc();
  const followups = new FollowupStore(tmp());
  const tool = makeSendEbook({
    send: async (m) => {
      sent.push(m);
      return { messageId: 'x' };
    },
    irc,
  });

  const r = await tool.run(
    { choice: 1 },
    ctx({
      value: { source: 'irc', command: '!Bsk A Book.epub', bot: 'Bsk', title: 'A Book.epub' },
      followups,
    }),
  );

  assert.equal(r.ok, true);
  assert.match(r.content, /^STARTED/);
  assert.match(r.content, /NOTHING HAS BEEN SENT YET/);
  assert.match(r.content, /do not say it has been sent/);
  assert.equal(sent.length, 0, 'nothing may be mailed inside the turn');
  assert.equal(irc.calls.length, 0, 'a bot can queue for 10+ minutes; the turn must not wait');

  const pending = followups.pendingEbook(JEFF, 'A Book.epub');
  assert.ok(pending, 'the promise must be backed by a scheduled follow-up');
  assert.equal(pending.ebook?.source, 'irc');
  assert.equal(pending.ebook?.command, '!Bsk A Book.epub', 'the command is stored verbatim');
});

test('🔴 the follow-up actually fetches, validates and DELIVERS, then says so', async () => {
  const mailed: Array<{ to: string; attachments: Array<{ content: Buffer }> }> = [];
  const spoke: Array<{ to: string; text: string }> = [];
  const irc = fakeIrc();
  const followups = new FollowupStore(tmp());
  const kindle = new KindleRegistry(tmp());
  kindle.save(JEFF, 'a_b@kindle.com', ['a_b@kindle.com']);

  followups.schedule({
    kind: 'ebook-deliver',
    senderHandle: JEFF,
    dueAt: new Date(Date.now() - 1000),
    reason: 'started fetching "A Book.epub" for them',
    observed: 'queued a request to Bsk',
    ebook: { source: 'irc', command: '!Bsk A Book.epub', bot: 'Bsk', title: 'A Book.epub' },
  });

  const out = await runDueFollowups(followups, {
    config: testConfig({ readOnly: false }),
    send: async (to, text) => {
      spoke.push({ to, text });
    },
    kindle,
    mail: async (m) => {
      mailed.push(m as never);
      return { messageId: 'x' };
    },
    irc,
  });

  assert.equal(out.length, 1);
  assert.equal(out[0]?.sent, true);
  assert.equal(irc.calls[0]?.command, '!Bsk A Book.epub');
  assert.equal(mailed.length, 1, 'the book must actually be mailed');
  assert.equal(mailed[0]?.to, 'a_b@kindle.com', 'address from the registry, read at FIRE time');
  assert.ok(mailed[0]?.attachments[0]?.content.equals(EPUB));
  assert.match(spoke[0]!.text, /on its way to your Kindle/);
});

test('🔴 a bot that never answers TELLS the person — it does not go quiet', async () => {
  const spoke: string[] = [];
  const irc = fakeIrc({
    fetch: async () => ({ state: 'failed' as const, detail: 'Bsk never sent the book — nothing arrived.' }),
  });
  const followups = new FollowupStore(tmp());
  const kindle = new KindleRegistry(tmp());
  kindle.save(JEFF, 'a_b@kindle.com', ['a_b@kindle.com']);
  followups.schedule({
    kind: 'ebook-deliver',
    senderHandle: JEFF,
    dueAt: new Date(Date.now() - 1000),
    reason: 'started fetching "Ghost.epub" for them',
    observed: 'queued',
    ebook: { source: 'irc', command: '!Bsk Ghost.epub', bot: 'Bsk', title: 'Ghost.epub' },
  });

  const out = await runDueFollowups(followups, {
    config: testConfig({ readOnly: false }),
    send: async (_to, text) => {
      spoke.push(text);
    },
    kindle,
    mail: async () => ({ messageId: 'x' }),
    irc,
  });

  assert.equal(out[0]?.sent, true, 'silence here is the defect this whole leg exists to fix');
  assert.match(spoke[0]!, /could not send/i);
  assert.match(spoke[0]!, /stopped trying/);
});

test('🔴 a book whose bytes are NOT a book is discarded and REPORTED, never mailed', async () => {
  const mailed: unknown[] = [];
  const spoke: string[] = [];
  const irc = fakeIrc({
    fetch: async () => ({
      state: 'ok' as const,
      filename: 'A Book.epub',
      // A Windows executable wearing the name of a book.
      bytes: Buffer.concat([Buffer.from('MZ\x90\x00', 'latin1'), Buffer.alloc(3000, 0)]),
      detail: 'ok',
    }),
  });
  const followups = new FollowupStore(tmp());
  const kindle = new KindleRegistry(tmp());
  kindle.save(JEFF, 'a_b@kindle.com', ['a_b@kindle.com']);
  followups.schedule({
    kind: 'ebook-deliver',
    senderHandle: JEFF,
    dueAt: new Date(Date.now() - 1000),
    reason: 'started fetching for them',
    observed: 'queued',
    ebook: { source: 'irc', command: '!Bsk A Book.epub', bot: 'Bsk', title: 'A Book.epub' },
  });

  await runDueFollowups(followups, {
    config: testConfig({ readOnly: false }),
    send: async (_to, text) => {
      spoke.push(text);
    },
    kindle,
    mail: async (m) => {
      mailed.push(m);
      return { messageId: 'x' };
    },
    irc,
  });

  assert.equal(mailed.length, 0, 'an executable must never reach a Kindle');
  assert.match(spoke[0]!, /WINDOWS EXECUTABLE/);
  assert.match(spoke[0]!, /could not send/i);
});

test('🔴 a stored option with NO source still works — the durable-file migration', async () => {
  // Every option written to choices.jsonl before IRC existed lacks `source`.
  // Without an explicit default, the first pick after this deploy would match
  // neither branch. This is the regression that would have shipped silently.
  const sent: unknown[] = [];
  const followups = new FollowupStore(tmp());
  const tool = makeSendEbook({
    send: async (m) => {
      sent.push(m);
      return { messageId: 'x' };
    },
  });
  const r = await tool.run(
    { choice: 1 },
    ctx({
      value: { infoHash: 'a'.repeat(40), title: 'Legacy Pick.epub' }, // no `source`
      followups,
    }),
  );
  /**
   * It must take the PROWLARR path CARRYING ITS HASH.
   *
   * ⚠️ An earlier version of this test asserted only that the message did not
   * mention an "IRC command" — which passed with the default REMOVED, because
   * the failure it actually produces is "did not carry a torrent hash". The
   * assertion has to name the symptom the missing default really causes, or it
   * tests nothing. Confirmed by mutation.
   */
  assert.ok(
    !/did not carry a torrent hash/.test(r.content),
    `a legacy option lost its infoHash — the source default is not working: ${r.content}`,
  );
  assert.ok(!/IRC command/.test(r.content), `should not be treated as an IRC pick: ${r.content}`);
  assert.equal(sent.length, 0);
});

test('🔴 a .mobi pick is refused before any fetch, and names the EPUB to use instead', async () => {
  const sent: unknown[] = [];
  const irc = fakeIrc();
  const tool = makeSendEbook({
    send: async (m) => {
      sent.push(m);
      return { messageId: 'x' };
    },
    irc,
  });
  const r = await tool.run(
    { choice: 1 },
    ctx({ value: { source: 'irc', command: '!Wench x.mobi', bot: 'Wench', title: 'Andy Weir - PHM.mobi' } }),
  );
  assert.equal(r.ok, false);
  assert.match(r.content, /^REFUSED/);
  assert.match(r.content, /2022/);
  assert.match(r.content, /Option 2 is an EPUB/, 'a refusal that names the way out beats a bare no');
  assert.equal(irc.calls.length, 0, 'nothing may be fetched');
  assert.equal(sent.length, 0);
});

test('a delivery with no saved address fails HONESTLY rather than closing quietly', async () => {
  const spoke: string[] = [];
  const followups = new FollowupStore(tmp());
  followups.schedule({
    kind: 'ebook-deliver',
    senderHandle: JEFF,
    dueAt: new Date(Date.now() - 1000),
    reason: 'started fetching for them',
    observed: 'queued',
    ebook: { source: 'irc', command: '!Bsk A.epub', bot: 'Bsk', title: 'A.epub' },
  });

  await runDueFollowups(followups, {
    config: testConfig({ readOnly: false }),
    send: async (_to, text) => {
      spoke.push(text);
    },
    kindle: new KindleRegistry(tmp()), // empty
    mail: async () => ({ messageId: 'x' }),
    irc: fakeIrc(),
  });

  assert.equal(spoke.length, 1);
  assert.match(spoke[0]!, /do not have a Send-to-Kindle address/);
});

test('the same book is not scheduled twice — no double delivery', async () => {
  const followups = new FollowupStore(tmp());
  const tool = makeSendEbook({ send: async () => ({ messageId: 'x' }), irc: fakeIrc() });
  const value = { source: 'irc', command: '!Bsk A Book.epub', bot: 'Bsk', title: 'A Book.epub' };
  await tool.run({ choice: 1 }, ctx({ value, followups }));
  await tool.run({ choice: 1 }, ctx({ value, followups }));
  const all = [...(followups as unknown as { items: Map<string, unknown> }).items.values()];
  assert.equal(all.length, 1, 'a second ask must not queue a second send of one book');
});

test('🔴 overlapping runner ticks cannot double-fetch or double-SEND one book', async () => {
  /**
   * The tick is `void`-called every 60s and an ebook delivery can occupy a run
   * for minutes. Until it finishes, the record is still pending with a past
   * dueAt, so every intervening tick used to pick it up again — the same book
   * requested from the bot repeatedly and EMAILED more than once. A duplicate
   * email is the one outcome here that cannot be taken back.
   */
  const mailed: unknown[] = [];
  let fetches = 0;
  const slowIrc = fakeIrc({
    fetch: async () => {
      fetches += 1;
      await new Promise((r) => setTimeout(r, 60));
      return { state: 'ok' as const, filename: 'A Book.epub', bytes: EPUB, detail: 'ok' };
    },
  });
  const followups = new FollowupStore(tmp());
  const kindle = new KindleRegistry(tmp());
  kindle.save(JEFF, 'a_b@kindle.com', ['a_b@kindle.com']);
  followups.schedule({
    kind: 'ebook-deliver',
    senderHandle: JEFF,
    dueAt: new Date(Date.now() - 1000),
    reason: 'started fetching for them',
    observed: 'queued',
    ebook: { source: 'irc', command: '!Bsk A Book.epub', bot: 'Bsk', title: 'A Book.epub' },
  });

  const deps = {
    config: testConfig({ readOnly: false }),
    send: async () => {},
    kindle,
    mail: async (m: unknown) => {
      mailed.push(m);
      return { messageId: 'x' };
    },
    irc: slowIrc,
  };

  // Two ticks land while the first delivery is still in flight.
  await Promise.all([
    runDueFollowups(followups, deps as never),
    runDueFollowups(followups, deps as never),
    runDueFollowups(followups, deps as never),
  ]);

  assert.equal(fetches, 1, 'one book, one request to the bot');
  assert.equal(mailed.length, 1, 'a duplicate email cannot be retracted');
});

test('🔴 an uncertain SMTP result is NOT retried — better one maybe-sent than two sent', async () => {
  const spoke: string[] = [];
  let sends = 0;
  const followups = new FollowupStore(tmp());
  const kindle = new KindleRegistry(tmp());
  kindle.save(JEFF, 'a_b@kindle.com', ['a_b@kindle.com']);
  followups.schedule({
    kind: 'ebook-deliver',
    senderHandle: JEFF,
    dueAt: new Date(Date.now() - 1000),
    reason: 'started fetching for them',
    observed: 'queued',
    ebook: { source: 'irc', command: '!Bsk A Book.epub', bot: 'Bsk', title: 'A Book.epub' },
  });

  const deps = {
    config: testConfig({ readOnly: false }),
    send: async (_to: string, text: string) => {
      spoke.push(text);
    },
    kindle,
    mail: async () => {
      sends += 1;
      throw new Error('socket hang up'); // neither a 5xx nor a success
    },
    irc: fakeIrc(),
  };

  await runDueFollowups(followups, deps as never);
  // The follow-up must be CLOSED, not deferred for another attempt.
  assert.equal(followups.pendingEbook(JEFF, 'A Book.epub'), undefined, 'must not be left pending to retry');
  await runDueFollowups(followups, deps as never);
  assert.equal(sends, 1, 'a second attempt could deliver the same book twice');
  assert.match(spoke[0]!, /may already have gone|twice/i);
});
