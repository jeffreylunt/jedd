import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FollowupStore, MAX_ATTEMPTS } from '../src/followups.js';
import { runDueFollowups } from '../src/followup-runner.js';
import type { ExecImpl } from '../src/hp.js';
import type { JellyfinResponse } from '../src/jellyfin.js';
import { testConfig } from './helpers.js';

/**
 * The unprompted path: what Jedd does when it wakes up on its own.
 *
 * 🔴 The property under test is not "it restores the throttle". It is that
 * **every branch can account for itself** — why it woke, to whom it is speaking,
 * what it observed — and that it **refuses rather than guesses** when it cannot
 * establish the current state. A follow-up that acts on a guess, or that goes
 * quiet having left a change on the box, is the failure this module exists to
 * prevent.
 */

const OWNER = '+18015550123';
const OURS = '{"alt_dl_limit":1048576,"alt_up_limit":262144}';
const FAST = new Array(7).fill('http=200 total=0.001100').join('\n');
const SLOW = new Array(7).fill('http=200 total=0.310000').join('\n');
const IDLE_QBIT = '{"connection_status":"connected","dl_info_speed":0,"up_info_speed":1000}';

function store(): FollowupStore {
  return new FollowupStore(join(mkdtempSync(join(tmpdir(), 'jedd-fu-')), 'followups.jsonl'));
}

function scheduleDue(s: FollowupStore, handle = OWNER) {
  return s.schedule({
    kind: 'restore-qbit-throttle',
    senderHandle: handle,
    dueAt: new Date(Date.now() - 60_000),
    reason: 'throttled qBittorrent because the host was contended and it was the cause',
    observed: 'median 310.0 ms over 7 probes',
  });
}

/** A scripted box. Defaults describe "our throttle is on and the box is quiet". */
function box(opts: {
  mode?: string;
  prefs?: string;
  latency?: string;
  qbitInfo?: string;
  modeWriteHttp?: string;
  prefsFail?: boolean;
} = {}) {
  // Stateful about the mode: a fake that always reports "still throttled" makes
  // the restore's own read-back impossible to satisfy, and every test would
  // measure a verification failure instead of the branch it meant to exercise.
  const calls: string[] = [];
  const state = { mode: opts.mode ?? '1', prefs: opts.prefs ?? OURS };
  const exec: ExecImpl = (_f, args, _o, cb) => {
    const command = args[5] ?? '';
    calls.push(command);
    let stdout = '';
    let error: unknown = null;
    if (command.includes('time_total')) stdout = opts.latency ?? FAST;
    else if (command.includes('transfer/info')) stdout = opts.qbitInfo ?? IDLE_QBIT;
    else if (command.includes('setPreferences')) {
      stdout = '200';
      if (command.includes('"alt_dl_limit":0')) state.prefs = '{"alt_dl_limit":0,"alt_up_limit":0}';
    } else if (command.includes('app/preferences')) {
      if (opts.prefsFail) error = Object.assign(new Error('x'), { code: 7 });
      stdout = state.prefs;
    } else if (command.includes('setSpeedLimitsMode')) {
      stdout = opts.modeWriteHttp ?? '200';
      if (stdout === '200') state.mode = /mode=1/.test(command) ? '1' : '0';
    } else if (command.includes('speedLimitsMode')) stdout = state.mode;
    setImmediate(() => cb(error, stdout, ''));
  };
  return { calls, state, exec };
}

function sessions(body: unknown, ok = true): (c: unknown, p: string) => Promise<JellyfinResponse> {
  return async () => (ok ? { ok: true, status: 200, body } : { ok: false, status: 0, error: 'timeout' });
}

const NOBODY: unknown[] = [{ UserName: 'jeff', NowPlayingItem: undefined }];
const WATCHING: unknown[] = [{ UserName: 'jeff', NowPlayingItem: { Name: 'the match' }, PlayState: {} }];

function deps(b: ReturnType<typeof box>, jf = sessions(NOBODY), sent: { to: string; text: string }[] = []) {
  return {
    config: testConfig({ readOnly: false, adminSshHost: 'admin-host', jellyfin: { baseUrl: 'http://jf.invalid', apiKey: 'k' } }),
    exec: b.exec,
    jellyfin: jf as never,
    send: async (to: string, text: string) => {
      sent.push({ to, text });
    },
    sent,
  };
}

// ── the happy path ───────────────────────────────────────────────────────────

test('🔴 the box recovered and nobody is watching: lift the throttle and SAY SO', async () => {
  const s = store();
  scheduleDue(s);
  const sent: { to: string; text: string }[] = [];
  const b = box();
  const outcomes = await runDueFollowups(s, deps(b, sessions(NOBODY), sent));

  assert.equal(outcomes[0]?.action, 'restored');
  assert.equal(outcomes[0]?.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.to, OWNER);

  // It must be able to account for itself: why it woke, what it saw then, what
  // it sees now, and what it did.
  const text = sent[0]!.text;
  assert.match(text, /Following up on my own initiative/);
  assert.match(text, /throttled qBittorrent because the host was contended/);
  assert.match(text, /310\.0 ms/, 'must say what it observed when it acted');
  assert.match(text, /back on its normal speed limits/, 'must report the verified outcome');

  // And it is finished, so it never fires again.
  assert.equal(s.due(new Date()).length, 0);
});

test('the restore is verified, not assumed — a failed mode write is not success', async () => {
  const s = store();
  const f = scheduleDue(s);
  const sent: { to: string; text: string }[] = [];
  const b = box({ modeWriteHttp: '500' });
  const outcomes = await runDueFollowups(s, deps(b, sessions(NOBODY), sent));
  assert.notEqual(outcomes[0]?.action, 'restored');
  assert.equal(sent.length, 0, 'the first inconclusive attempt defers rather than shouting');
  assert.equal(s.all().find((x) => x.id === f.id)?.status, 'pending');
});

// ── refusing rather than guessing ────────────────────────────────────────────

test('🔴 cannot tell whether anyone is watching: do NOT lift it', async () => {
  // Lifting puts load back on the box, so this is the direction that can disturb
  // a viewer. UNKNOWN refuses, exactly as everywhere else.
  const s = store();
  scheduleDue(s);
  const sent: { to: string; text: string }[] = [];
  const b = box();
  const outcomes = await runDueFollowups(s, deps(b, sessions(null, false), sent));
  assert.equal(outcomes[0]?.action, 'deferred');
  assert.equal(
    b.calls.some((c) => c.includes('setSpeedLimitsMode')),
    false,
    'must not touch the throttle when playback state is unknown',
  );
});

test('🔴 somebody is watching: hold the throttle, and eventually explain why', async () => {
  const s = store();
  const f = scheduleDue(s);
  const sent: { to: string; text: string }[] = [];
  const b = box();
  const d = deps(b, sessions(WATCHING), sent);

  // It defers while someone is watching, silently, because there is nothing the
  // user needs to do.
  for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
    s.all().find((x) => x.id === f.id)!.dueAt = new Date(Date.now() - 1000).toISOString();
    const o = await runDueFollowups(s, d);
    assert.equal(o[0]?.action, 'deferred');
    assert.equal(sent.length, 0);
  }

  // Then it gives up and SAYS so, rather than going quiet with a change left on
  // the box that nobody knows about.
  s.all().find((x) => x.id === f.id)!.dueAt = new Date(Date.now() - 1000).toISOString();
  const final = await runDueFollowups(s, d);
  assert.equal(final[0]?.action, 'abandoned');
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /still throttled/);
  assert.match(sent[0]!.text, /watching/);
  assert.equal(
    b.calls.some((c) => c.includes('setSpeedLimitsMode')),
    false,
  );
});

test('🔴 cannot read qBittorrent at all: never conclude there is nothing to clean up', async () => {
  const s = store();
  const f = scheduleDue(s);
  const sent: { to: string; text: string }[] = [];
  const b = box({ mode: 'garbage' });
  const d = deps(b, sessions(NOBODY), sent);
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    s.all().find((x) => x.id === f.id)!.dueAt = new Date(Date.now() - 1000).toISOString();
    await runDueFollowups(s, d);
  }
  assert.equal(sent.length, 1, 'it must eventually report that it could not tell');
  assert.match(sent[0]!.text, /CANNOT TELL/);
  assert.match(sent[0]!.text, /may still be limited/);
});

test('🔴 the host is still contended: leave the throttle where it is', async () => {
  const s = store();
  scheduleDue(s);
  const b = box({ latency: SLOW, qbitInfo: '{"dl_info_speed":8388608,"up_info_speed":5242880}' });
  const outcomes = await runDueFollowups(s, deps(b, sessions(NOBODY)));
  // Still contended and qBit is still busy, so the shed is still doing its job.
  assert.notEqual(outcomes[0]?.action, 'restored');
  assert.equal(
    b.calls.some((c) => c.includes('setSpeedLimitsMode')),
    false,
  );
});

// ── not ours, and nothing to do ──────────────────────────────────────────────

test('the throttle is already off: resolve quietly and send NOTHING', async () => {
  // "A follow-up that fires when nobody is listening is worse than none." There
  // is nothing here a person needs to act on.
  const s = store();
  scheduleDue(s);
  const sent: { to: string; text: string }[] = [];
  const outcomes = await runDueFollowups(s, deps(box({ mode: '0' }), sessions(NOBODY), sent));
  assert.equal(outcomes[0]?.action, 'nothing-to-do');
  assert.equal(sent.length, 0, 'no news is not news');
  assert.equal(s.due(new Date()).length, 0);
});

test("🔴 somebody else's throttle is in force: do not touch it, and say so", async () => {
  const s = store();
  scheduleDue(s);
  const sent: { to: string; text: string }[] = [];
  const b = box({ prefs: '{"alt_dl_limit":3000000,"alt_up_limit":900000}' });
  const outcomes = await runDueFollowups(s, deps(b, sessions(NOBODY), sent));
  assert.equal(outcomes[0]?.action, 'abandoned');
  assert.equal(sent.length, 1, 'the user should know my throttle is no longer what is in force');
  assert.match(sent[0]!.text, /not mine/);
  assert.equal(
    b.calls.some((c) => c.includes('setSpeedLimitsMode')),
    false,
  );
});

// ── who it is allowed to speak to ────────────────────────────────────────────

test('🔴 the recipient\'s authorisation is re-derived NOW, not trusted from the record', async () => {
  // The record was written by a different process, possibly days ago. A stored
  // "this person is the owner" is an identity assertion travelling through time.
  const s = store();
  scheduleDue(s, '+15559998888'); // not the owner
  const sent: { to: string; text: string }[] = [];
  const b = box({ prefs: '{"alt_dl_limit":3000000,"alt_up_limit":900000}' });
  const outcomes = await runDueFollowups(s, deps(b, sessions(NOBODY), sent));
  assert.equal(sent.length, 0, 'must not send an admin follow-up to a non-owner');
  assert.equal(outcomes[0]?.action, 'not-delivered');

  // CONTROL: the identical case addressed to the owner DOES send, so the silence
  // above is about authorisation and not about the branch never speaking.
  const s2 = store();
  scheduleDue(s2, OWNER);
  const sent2: { to: string; text: string }[] = [];
  await runDueFollowups(s2, deps(box({ prefs: '{"alt_dl_limit":3000000,"alt_up_limit":900000}' }), sessions(NOBODY), sent2));
  assert.equal(sent2.length, 1);
});

// ── robustness ───────────────────────────────────────────────────────────────

test('one throwing follow-up does not stop the others', async () => {
  const s = store();
  scheduleDue(s);
  scheduleDue(s);
  const exploding: ExecImpl = () => {
    throw new Error('boom');
  };
  const outcomes = await runDueFollowups(s, {
    ...deps(box()),
    exec: exploding,
  });
  assert.equal(outcomes.length, 2);
  assert.ok(outcomes.every((o) => o.action === 'abandoned'));
});

test('nothing due means nothing happens', async () => {
  const s = store();
  s.schedule({
    kind: 'restore-qbit-throttle',
    senderHandle: OWNER,
    dueAt: new Date(Date.now() + 3_600_000),
    reason: 'r',
    observed: 'o',
  });
  const sent: { to: string; text: string }[] = [];
  const b = box();
  const outcomes = await runDueFollowups(s, deps(b, sessions(NOBODY), sent));
  assert.equal(outcomes.length, 0);
  assert.equal(b.calls.length, 0, 'a follow-up that is not due must not even probe');
  assert.equal(sent.length, 0);
});
