import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Agent } from '../src/agent.js';
import { FollowupStore, MAX_ATTEMPTS } from '../src/followups.js';
import type { LlmClient, LlmReply } from '../src/llm.js';
import { HistoryStore, MAX_REPLAY_AGE_MS, MAX_REPLAY_TURNS } from '../src/store.js';
import { testConfig } from './helpers.js';

/**
 * Durable history and the scheduler, tested on real files in a temp directory.
 *
 * Not mocked: the whole claim is "this survives a process restart", and a fake
 * filesystem would let the test pass while nothing was ever written. A second
 * `new HistoryStore(samePath)` is this suite's stand-in for a restart, and it is
 * the only thing that can actually demonstrate the property.
 */

function tempFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'jedd-store-')), name);
}

// ── durable history ──────────────────────────────────────────────────────────

test('🔴 history survives a restart', async () => {
  const path = tempFile('history.jsonl');
  const first = new HistoryStore(path);
  first.record('+18015550123', 'is anyone watching?', 'Nobody is playing anything.');
  first.record('+18015550123', 'thanks', 'Any time.');

  // The restart.
  const second = new HistoryStore(path);
  const replay = second.replay('+18015550123');
  assert.deepEqual(
    replay.messages.map((m) => m.content),
    ['is anyone watching?', 'Nobody is playing anything.', 'thanks', 'Any time.'],
  );
  assert.equal(replay.dropped, 0);
  assert.equal(replay.note, '');
});

test('history is per-sender and cannot leak between identities', () => {
  const store = new HistoryStore(tempFile('history.jsonl'));
  store.record('+18015550123', 'owner secret', 'ok');
  store.record('+15559998888', 'guest question', 'ok');
  assert.equal(store.replay('+15559998888').messages.length, 2);
  assert.equal(
    store.replay('+15559998888').messages.some((m) => String(m.content).includes('owner secret')),
    false,
  );
});

test('🔴 tool results are NEVER persisted, so a stale observation cannot come back as context', async () => {
  // The decision this pins: a tool result is a timestamped reading. Replaying
  // one presents yesterday's `docker ps` as today's, and the model has no way to
  // tell. Jedd remembers what was SAID and re-observes what is TRUE.
  const path = tempFile('history.jsonl');
  const store = new HistoryStore(path);
  const llm: LlmClient = {
    label: 'test',
    async chat(): Promise<LlmReply> {
      return { text: 'sonarr is up', toolCalls: [] };
    },
  };
  const agent = new Agent(testConfig(), llm, undefined, [], store);
  await agent.handle('+18015550123', 'is sonarr up?');

  const raw = readFileSync(path, 'utf8');
  assert.match(raw, /is sonarr up\?/);
  assert.match(raw, /sonarr is up/);
  // Nothing shaped like a tool observation should be in the file at all.
  assert.doesNotMatch(raw, /exit_code|docker ps|toolCalls|"role":"tool"/);
});

test('a fresh process replays prior turns into the model context', async () => {
  const path = tempFile('history.jsonl');
  new HistoryStore(path).record('+18015550123', 'call the arrs "the stack"', 'Got it.');

  let seen: unknown[] = [];
  const llm: LlmClient = {
    label: 'test',
    async chat(messages): Promise<LlmReply> {
      seen = messages.map((m) => m.content);
      return { text: 'ok', toolCalls: [] };
    },
  };
  const agent = new Agent(testConfig(), llm, undefined, [], new HistoryStore(path));
  await agent.handle('+18015550123', 'restart the stack');
  assert.ok(seen.includes('call the arrs "the stack"'), 'the earlier turn must be replayed');
  assert.ok(seen.includes('Got it.'));
});

// ── the replay bound, stated rather than hidden ─────────────────────────────

test('🔴 truncation is ANNOUNCED — V1 silently lost everything past 50 messages', () => {
  const store = new HistoryStore(tempFile('history.jsonl'));
  for (let i = 0; i < MAX_REPLAY_TURNS + 5; i++) {
    store.record('+18015550123', `question ${i}`, `answer ${i}`);
  }
  const replay = store.replay('+18015550123');
  assert.equal(replay.messages.length, MAX_REPLAY_TURNS * 2);
  assert.equal(replay.dropped, 5);
  assert.match(replay.note, /no longer in your history/);
  assert.match(replay.note, /say so rather than guessing/);

  // CONTROL: at the bound, nothing is dropped and nothing is announced — so the
  // note means "something is missing" and not merely "history exists".
  const small = new HistoryStore(tempFile('history.jsonl'));
  for (let i = 0; i < MAX_REPLAY_TURNS; i++) small.record('+1', `q${i}`, `a${i}`);
  assert.equal(small.replay('+1').dropped, 0);
  assert.equal(small.replay('+1').note, '');
});

test('the AGE bound drops old turns and says so', () => {
  const store = new HistoryStore(tempFile('history.jsonl'));
  const old = new Date(Date.now() - MAX_REPLAY_AGE_MS - 60_000);
  store.record('+1', 'ancient', 'ancient reply', old);
  store.record('+1', 'recent', 'recent reply');
  const replay = store.replay('+1');
  assert.equal(replay.dropped, 1);
  assert.equal(
    replay.messages.some((m) => m.content === 'ancient'),
    false,
  );
  assert.match(replay.note, /1 earlier turn/);
});

test('an unparseable timestamp is dropped and counted, never treated as recent', () => {
  const path = tempFile('history.jsonl');
  writeFileSync(
    path,
    `${JSON.stringify({ type: 'turn', id: 'x', at: 'not-a-date', senderHandle: '+1', userText: 'u', replyText: 'r' })}\n`,
  );
  const replay = new HistoryStore(path).replay('+1');
  assert.equal(replay.messages.length, 0);
  assert.equal(replay.dropped, 1);
});

test('a corrupt line does not make the whole conversation unloadable', () => {
  const path = tempFile('history.jsonl');
  const store = new HistoryStore(path);
  store.record('+1', 'before', 'ok');
  writeFileSync(path, `${readFileSync(path, 'utf8')}{ this is not json\n`);
  store.record('+1', 'after', 'ok');
  const reloaded = new HistoryStore(path).replay('+1');
  assert.equal(reloaded.messages.length, 4, 'both good turns must survive one bad line');
});

// ── eviction and repair ──────────────────────────────────────────────────────

test('🔴 a poisoned turn can be evicted WITHOUT wiping the conversation', () => {
  // The V1 trap: a bad reply keeps poisoning history after the bug is fixed,
  // because the model reads its own past wrong answer as established context.
  const path = tempFile('history.jsonl');
  const store = new HistoryStore(path);
  store.record('+1', 'do we have Dune?', 'Yes, both films are in the library.');
  const bad = store.record('+1', 'and Sinners?', 'Yes, I already downloaded Sinners.');
  store.record('+1', 'great', 'Any time.');

  assert.equal(store.evict(bad, 'fabricated a download that never happened'), true);

  const replay = store.replay('+1');
  const contents = replay.messages.map((m) => m.content);
  assert.equal(contents.includes('Yes, I already downloaded Sinners.'), false, 'the bad reply is gone');
  assert.ok(contents.includes('Yes, both films are in the library.'), 'the turn before survives');
  assert.ok(contents.includes('Any time.'), 'the turn after survives');

  // And it stays evicted across a restart.
  assert.equal(
    new HistoryStore(path)
      .replay('+1')
      .messages.some((m) => m.content === 'Yes, I already downloaded Sinners.'),
    false,
  );
});

test('eviction is APPENDED — the audit trail keeps what was actually said', () => {
  const path = tempFile('history.jsonl');
  const store = new HistoryStore(path);
  const id = store.record('+1', 'q', 'a wrong answer');
  store.evict(id, 'wrong');
  const raw = readFileSync(path, 'utf8');
  assert.match(raw, /a wrong answer/, 'the original must remain in the log');
  assert.match(raw, /"type":"evict"/);
});

test('a turn can be repaired instead of removed', () => {
  const path = tempFile('history.jsonl');
  const store = new HistoryStore(path);
  const id = store.record('+1', 'what port is dispatcharr on?', 'Port 8096.');
  assert.equal(store.repair(id, 'Port 9191.', 'wrong port'), true);
  const replay = new HistoryStore(path).replay('+1');
  assert.ok(replay.messages.some((m) => m.content === 'Port 9191.'));
  assert.equal(
    replay.messages.some((m) => m.content === 'Port 8096.'),
    false,
  );
});

test('evicting or repairing an unknown id reports failure rather than pretending', () => {
  const store = new HistoryStore(tempFile('history.jsonl'));
  assert.equal(store.evict('nope', 'x'), false);
  assert.equal(store.repair('nope', 'x', 'y'), false);
});

// ── follow-up store ──────────────────────────────────────────────────────────

test('🔴 a scheduled follow-up survives a restart', () => {
  const path = tempFile('followups.jsonl');
  const first = new FollowupStore(path);
  first.schedule({
    kind: 'restore-qbit-throttle',
    senderHandle: '+18015550123',
    dueAt: new Date(Date.now() - 1000),
    reason: 'throttled qBittorrent',
    observed: 'median 310 ms',
  });

  const second = new FollowupStore(path);
  const due = second.due(new Date());
  assert.equal(due.length, 1);
  assert.equal(due[0]?.senderHandle, '+18015550123');
  // The three things it must be able to say when it wakes.
  assert.match(due[0]!.reason, /throttled qBittorrent/);
  assert.match(due[0]!.observed, /310 ms/);
  assert.ok(due[0]!.createdAt);
});

test('a follow-up is not due before its time', () => {
  const store = new FollowupStore(tempFile('followups.jsonl'));
  store.schedule({
    kind: 'restore-qbit-throttle',
    senderHandle: '+1',
    dueAt: new Date(Date.now() + 60_000),
    reason: 'r',
    observed: 'o',
  });
  assert.equal(store.due(new Date()).length, 0);
  assert.equal(store.due(new Date(Date.now() + 61_000)).length, 1);
});

test('a resolved follow-up never comes due again, across a restart', () => {
  const path = tempFile('followups.jsonl');
  const store = new FollowupStore(path);
  const f = store.schedule({
    kind: 'restore-qbit-throttle',
    senderHandle: '+1',
    dueAt: new Date(Date.now() - 1000),
    reason: 'r',
    observed: 'o',
  });
  store.resolve(f.id, 'done', 'lifted');
  assert.equal(store.due(new Date()).length, 0);
  assert.equal(new FollowupStore(path).due(new Date()).length, 0);
});

test('🔴 deferral is BOUNDED — a follow-up cannot retry forever in silence', () => {
  const store = new FollowupStore(tempFile('followups.jsonl'));
  const f = store.schedule({
    kind: 'restore-qbit-throttle',
    senderHandle: '+1',
    dueAt: new Date(),
    reason: 'r',
    observed: 'o',
  });
  let deferrals = 0;
  while (store.defer(f.id, new Date(Date.now() + 1000), 'still unknown')) deferrals++;
  assert.equal(deferrals, MAX_ATTEMPTS - 1);
  assert.equal(store.defer(f.id, new Date(), 'one more'), false, 'must eventually refuse to defer');
});

test('pendingOfKind stops a second follow-up being scheduled for one event', () => {
  const store = new FollowupStore(tempFile('followups.jsonl'));
  assert.equal(store.pendingOfKind('restore-qbit-throttle'), undefined);
  const f = store.schedule({
    kind: 'restore-qbit-throttle',
    senderHandle: '+1',
    dueAt: new Date(),
    reason: 'r',
    observed: 'o',
  });
  assert.equal(store.pendingOfKind('restore-qbit-throttle')?.id, f.id);
  store.resolve(f.id, 'done', 'lifted');
  assert.equal(store.pendingOfKind('restore-qbit-throttle'), undefined);
});
