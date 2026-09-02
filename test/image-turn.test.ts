import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent, composeImageTurn } from '../src/agent.js';
import { boundHistoryImages, OllamaClient, type LlmMessage } from '../src/llm.js';
import type { InboundAttachments } from '../src/connector.js';
import { testConfig } from './helpers.js';

/**
 * The half of inbound images that reaches the model: what it is told, what
 * bytes travel, and how many of them.
 */

const LIMITS = { maxCount: 3 };

function attachments(over: Partial<InboundAttachments> = {}): InboundAttachments {
  return { images: [], trouble: [], overflow: 0, ...over };
}

const IMG = { base64: 'QUJD', name: 'IMG_9465.HEIC', contentType: 'image/png' };

// ── what the model is told ───────────────────────────────────────────────────

test('a plain text message composes to itself, with no note', () => {
  assert.deepEqual(composeImageTurn('add dune', undefined, LIMITS), { text: 'add dune' });
});

test('a captionless photo gets a marker instead of an empty turn', () => {
  const out = composeImageTurn('', attachments({ images: [IMG] }), LIMITS);
  assert.match(out.text, /IMG_9465\.HEIC/);
  assert.notEqual(out.text.trim(), '', 'an empty user turn replays from history as nothing at all');
});

test("a caption is kept EXACTLY — the note never edits the person's words", () => {
  const out = composeImageTurn('get this one', attachments({ images: [IMG] }), LIMITS);
  assert.equal(out.text, 'get this one');
  assert.ok(out.note, 'the picture is announced in the note, not spliced into their sentence');
});

test('🔴 an unfetchable image produces a note that says the picture did not arrive', () => {
  const out = composeImageTurn(
    'can you read this',
    attachments({
      trouble: [{ reason: 'unfetchable', name: 'IMG_1.HEIC', detail: 'http 500' }],
    }),
    LIMITS,
  );
  assert.ok(out.note);
  assert.match(out.note, /did not come through|could NOT get/i);
  assert.match(out.note, /IMG_1\.HEIC/);
  assert.match(out.note, /SMS/, 'the sender needs to know why, because a retry will not fix it');
  assert.match(out.note, /Do not pretend you saw it/i);
  assert.equal(out.text, 'can you read this', 'the question they asked still gets answered');
});

test('🔴 the three trouble reasons produce THREE DIFFERENT sentences', () => {
  const notes = (['unsupported', 'oversize', 'unfetchable'] as const).map(
    (reason) =>
      composeImageTurn('', attachments({ trouble: [{ reason, name: 'f', detail: 'd' }] }), LIMITS)
        .note,
  );
  assert.equal(new Set(notes).size, 3, 'collapsing these tells people the wrong thing about their file');
  assert.match(notes[0]!, /not an image/i);
  assert.match(notes[1]!, /too large/i);
  assert.match(notes[2]!, /could NOT get/i);
});

test('overflow is named with a count, not implied', () => {
  const out = composeImageTurn('', attachments({ images: [IMG], overflow: 3 }), LIMITS);
  assert.ok(out.note);
  assert.match(out.note, /3 further images/);
  assert.match(out.note, /3 at a time/);
});

test('a good image and a broken one both get said', () => {
  const out = composeImageTurn(
    '',
    attachments({
      images: [IMG],
      trouble: [{ reason: 'unfetchable', name: 'other.HEIC', detail: 'empty' }],
    }),
    LIMITS,
  );
  assert.ok(out.note);
  assert.match(out.note, /IMG_9465\.HEIC/);
  assert.match(out.note, /other\.HEIC/);
});

test('an attachments record with nothing in it adds no note', () => {
  assert.deepEqual(composeImageTurn('hi', attachments(), LIMITS), { text: 'hi' });
});

// ── how many images travel ───────────────────────────────────────────────────

function userTurn(n: number, images?: string[]): LlmMessage {
  return { role: 'user', content: `m${n}`, ...(images ? { images } : {}) };
}

test('🔴 only the most recent N image turns keep their bytes', () => {
  const history: LlmMessage[] = [
    { role: 'system', content: 'sys' },
    userTurn(1, ['A']),
    { role: 'assistant', content: 'ok' },
    userTurn(2, ['B']),
    userTurn(3),
    userTurn(4, ['C']),
  ];
  const bounded = boundHistoryImages(history, 2);
  assert.equal(bounded[1]?.images, undefined, 'the oldest picture is dropped from the request');
  assert.deepEqual(bounded[3]?.images, ['B']);
  assert.deepEqual(bounded[5]?.images, ['C']);
});

test('🔴 bounding COPIES — the stored history keeps its images', () => {
  // If it stripped in place the loss would be permanent, and raising the limit
  // later would silently do nothing for conversations already in memory.
  const turn = userTurn(1, ['A']);
  const history: LlmMessage[] = [turn, userTurn(2, ['B'])];
  boundHistoryImages(history, 1);
  assert.deepEqual(turn.images, ['A']);
});

test('text turns and their order are untouched by bounding', () => {
  const history: LlmMessage[] = [
    { role: 'system', content: 'sys' },
    userTurn(1, ['A']),
    { role: 'tool', content: 'result', toolName: 't' },
  ];
  const bounded = boundHistoryImages(history, 0);
  assert.equal(bounded.length, 3);
  assert.deepEqual(
    bounded.map((m) => m.content),
    ['sys', 'm1', 'result'],
  );
  assert.equal(bounded[1]?.images, undefined);
});

// ── the wire ─────────────────────────────────────────────────────────────────

async function capture(messages: LlmMessage[]): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ message: { content: 'ok' } }), { status: 200 });
  }) as typeof fetch;
  try {
    const client = new OllamaClient(testConfig());
    await client.chat(messages, []);
  } finally {
    globalThis.fetch = original;
  }
  return body;
}

test('🔴 images reach the wire as BARE base64 on the user message', async () => {
  const body = await capture([{ role: 'user', content: 'what is this', images: ['QUJD'] }]);
  const msgs = body['messages'] as { role: string; content: string; images?: string[] }[];
  assert.deepEqual(msgs[0]?.images, ['QUJD']);
  assert.doesNotMatch(
    msgs[0]!.images![0]!,
    /^data:/,
    'a data: URL is accepted by the HTTP layer and then silently fails to decode',
  );
});

test('🔴 a text-only turn sends NO images key at all', async () => {
  const body = await capture([{ role: 'user', content: 'hello' }]);
  const msgs = body['messages'] as Record<string, unknown>[];
  assert.equal('images' in msgs[0]!, false, 'an empty array changes every existing request to say nothing');
});

test('an assistant turn never carries images', async () => {
  const body = await capture([
    { role: 'assistant', content: 'prev', images: ['QUJD'] } as LlmMessage,
    { role: 'user', content: 'now' },
  ]);
  const msgs = body['messages'] as Record<string, unknown>[];
  assert.equal('images' in msgs[0]!, false);
});

// ── end to end through the agent ─────────────────────────────────────────────

test('🔴 agent.handle puts the image on the user turn and the note above it', async () => {
  const seen: LlmMessage[][] = [];
  const llm = {
    label: 'stub',
    chat: async (messages: LlmMessage[]) => {
      seen.push(messages.map((m) => ({ ...m })));
      return { text: 'a blue square', toolCalls: [] };
    },
  };
  const agent = new Agent(testConfig(), llm, undefined, []);
  await agent.handle('+18015550123', '', {
    images: [IMG],
    trouble: [{ reason: 'oversize', name: 'big.png', detail: '40 MB' }],
    overflow: 0,
  });

  const sent = seen[0]!;
  const user = sent[sent.length - 1]!;
  assert.equal(user.role, 'user');
  assert.deepEqual(user.images, ['QUJD']);

  const note = sent[sent.length - 2]!;
  assert.equal(note.role, 'system', 'the note must precede the user turn, not follow it');
  assert.match(note.content, /too large/i);
});

test('🔴 a turn with a failed image still RUNS and still answers', async () => {
  // Silence is the one outcome that is always wrong: from the sender's side it
  // is identical to being ignored.
  let asked = false;
  const llm = {
    label: 'stub',
    chat: async () => {
      asked = true;
      return { text: 'your message came through but the photo did not', toolCalls: [] };
    },
  };
  const agent = new Agent(testConfig(), llm, undefined, []);
  const r = await agent.handle('+18015550123', 'is this the right one?', {
    images: [],
    trouble: [{ reason: 'unfetchable', name: 'IMG.HEIC', detail: 'empty file' }],
    overflow: 0,
  });
  assert.equal(asked, true);
  assert.notEqual(r.replyText.trim(), '');
});

test('🔴 base64 never reaches the persisted turn record', async () => {
  const llm = { label: 'stub', chat: async () => ({ text: 'ok', toolCalls: [] }) };
  const agent = new Agent(testConfig(), llm, undefined, []);
  const r = await agent.handle('+18015550123', '', { images: [IMG], trouble: [], overflow: 0 });
  assert.doesNotMatch(
    JSON.stringify(r),
    /QUJD/,
    'history.jsonl is a text log; a megabyte of base64 per photo would destroy it',
  );
});
