import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testConfig } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { ModelTimeoutError } from '../src/turn-notice.js';
import {
  OpenAiClient,
  createLlmClient,
  probeLlm,
  type LlmMessage,
} from '../src/llm.js';
import type { Tool } from '../src/tools/types.js';

/**
 * The OpenAI-compatible client (oMLX and anything else that speaks the same
 * API), tested against a scripted fetch — same seam style as
 * `bluebubbles-client.test.ts`: a fake that answers a REQUEST rather than a
 * mocked global, so a test can assert on the exact body sent.
 */

interface Call {
  url: string;
  init: RequestInit | undefined;
  body: Record<string, unknown> | undefined;
}

function scripted(
  respond: (call: Call) => { status?: number; body?: unknown } | undefined,
): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      init,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    };
    calls.push(call);
    const r = respond(call);
    if (!r) throw new Error(`unscripted request: ${call.url}`);
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    } as Response;
  }) as typeof fetch;
  return { impl, calls };
}

const NOOP_TOOLS: Tool[] = [];

function userMsg(text: string): LlmMessage {
  return { role: 'user', content: text };
}

// ── URL normalisation ────────────────────────────────────────────────────────

test('🔴 a baseUrl already ending in /v1 does not produce /v1/v1', async () => {
  const { impl, calls } = scripted(() => ({ body: { choices: [{ message: { content: 'hi' } }] } }));
  const client = new OpenAiClient(
    testConfig({ llm: { provider: 'openai', baseUrl: 'http://host:8000/v1', model: 'm' } }),
    impl,
  );
  await client.chat([userMsg('hi')], NOOP_TOOLS);
  assert.equal(calls[0]!.url, 'http://host:8000/v1/chat/completions');
});

test('a bare-host baseUrl gets /v1 appended', async () => {
  const { impl, calls } = scripted(() => ({ body: { choices: [{ message: { content: 'hi' } }] } }));
  const client = new OpenAiClient(
    testConfig({ llm: { provider: 'openai', baseUrl: 'http://host:8000', model: 'm' } }),
    impl,
  );
  await client.chat([userMsg('hi')], NOOP_TOOLS);
  assert.equal(calls[0]!.url, 'http://host:8000/v1/chat/completions');
});

test('a trailing slash on the baseUrl does not break normalisation', async () => {
  const { impl, calls } = scripted(() => ({ body: { choices: [{ message: { content: 'hi' } }] } }));
  const client = new OpenAiClient(
    testConfig({ llm: { provider: 'openai', baseUrl: 'http://host:8000/v1/', model: 'm' } }),
    impl,
  );
  await client.chat([userMsg('hi')], NOOP_TOOLS);
  assert.equal(calls[0]!.url, 'http://host:8000/v1/chat/completions');
});

// ── request shape ─────────────────────────────────────────────────────────────

test('the request carries temperature/max_tokens/thinking, and none of the Ollama-only fields', async () => {
  const { impl, calls } = scripted(() => ({ body: { choices: [{ message: { content: 'hi' } }] } }));
  const client = new OpenAiClient(
    testConfig({ llm: { provider: 'openai', baseUrl: 'http://host:8000/v1', model: 'omlx-model' } }),
    impl,
  );
  await client.chat([userMsg('hi')], NOOP_TOOLS);
  const body = calls[0]!.body!;
  assert.equal(body['model'], 'omlx-model');
  assert.equal(body['temperature'], 0.2);
  assert.equal(body['max_tokens'], 3000);
  assert.deepEqual(body['chat_template_kwargs'], { enable_thinking: true });
  assert.equal(body['options'], undefined, 'options is an Ollama-only field');
  assert.equal(body['keep_alive'], undefined, 'keep_alive is an Ollama-only field');
  assert.equal(body['think'], undefined, 'think is Ollama-only; oMLX takes chat_template_kwargs');
});

test('tools are only sent when there are any, in OpenAI function-tool shape', async () => {
  const { impl, calls } = scripted(() => ({ body: { choices: [{ message: { content: 'hi' } }] } }));
  const client = new OpenAiClient(testConfig({ llm: { provider: 'openai', baseUrl: 'http://host:8000/v1', model: 'm' } }), impl);

  await client.chat([userMsg('hi')], NOOP_TOOLS);
  assert.equal(calls[0]!.body!['tools'], undefined);

  const tool: Tool = {
    name: 'get_weather',
    description: 'Get the weather',
    parameters: { type: 'object', properties: {} },
    minRole: 'guest',
    isWrite: false,
    run: async () => ({ text: '' }),
  } as unknown as Tool;
  await client.chat([userMsg('hi')], [tool]);
  assert.deepEqual(calls[1]!.body!['tools'], [
    { type: 'function', function: { name: 'get_weather', description: 'Get the weather', parameters: { type: 'object', properties: {} } } },
  ]);
});

test('an Authorization header is sent only when an apiKey is configured', async () => {
  const { impl, calls } = scripted(() => ({ body: { choices: [{ message: { content: 'hi' } }] } }));
  const withKey = new OpenAiClient(
    testConfig({ llm: { provider: 'openai', baseUrl: 'http://host:8000/v1', model: 'm', apiKey: 'sk-test' } }),
    impl,
  );
  await withKey.chat([userMsg('hi')], NOOP_TOOLS);
  const headers1 = calls[0]!.init!.headers as Record<string, string>;
  assert.equal(headers1['Authorization'], 'Bearer sk-test');

  const noKey = new OpenAiClient(testConfig({ llm: { provider: 'openai', baseUrl: 'http://host:8000/v1', model: 'm' } }), impl);
  await noKey.chat([userMsg('hi')], NOOP_TOOLS);
  const headers2 = calls[1]!.init!.headers as Record<string, string>;
  assert.equal(headers2['Authorization'], undefined);
});

// ── images ────────────────────────────────────────────────────────────────────

test('🔴 an image is sent as an OpenAI content part with its REAL mime type', async () => {
  const { impl, calls } = scripted(() => ({ body: { choices: [{ message: { content: 'ok' } }] } }));
  const client = new OpenAiClient(testConfig({ llm: { provider: 'openai', baseUrl: 'http://host:8000/v1', model: 'm' } }), impl);
  const msg: LlmMessage = {
    role: 'user',
    content: 'what is this',
    images: ['QUJD'],
    imageMimeTypes: ['image/heic'],
  };
  await client.chat([msg], NOOP_TOOLS);
  const sent = calls[0]!.body!['messages'] as Array<{ role: string; content: unknown }>;
  assert.deepEqual(sent[0]!.content, [
    { type: 'text', text: 'what is this' },
    { type: 'image_url', image_url: { url: 'data:image/heic;base64,QUJD' } },
  ]);
});

test('a missing mime type falls back to a guess rather than an invalid data URL', async () => {
  const { impl, calls } = scripted(() => ({ body: { choices: [{ message: { content: 'ok' } }] } }));
  const client = new OpenAiClient(testConfig({ llm: { provider: 'openai', baseUrl: 'http://host:8000/v1', model: 'm' } }), impl);
  const msg: LlmMessage = { role: 'user', content: 'x', images: ['QUJD'] };
  await client.chat([msg], NOOP_TOOLS);
  const sent = calls[0]!.body!['messages'] as Array<{ content: Array<{ image_url?: { url: string } }> }>;
  assert.match(sent[0]!.content[1]!.image_url!.url, /^data:image\/[a-z]+;base64,QUJD$/);
});

// ── message role mapping ──────────────────────────────────────────────────────

test('an assistant tool-call turn and its tool reply round-trip in OpenAI shape', async () => {
  const { impl, calls } = scripted(() => ({ body: { choices: [{ message: { content: 'done' } }] } }));
  const client = new OpenAiClient(testConfig({ llm: { provider: 'openai', baseUrl: 'http://host:8000/v1', model: 'm' } }), impl);
  const history: LlmMessage[] = [
    userMsg('what is the weather'),
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'Paris' } }],
    },
    { role: 'tool', content: '{"temp":20}', toolCallId: 'call_1', toolName: 'get_weather' },
  ];
  await client.chat(history, NOOP_TOOLS);
  const sent = calls[0]!.body!['messages'] as Array<Record<string, unknown>>;
  assert.deepEqual(sent[1]!['tool_calls'], [
    { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
  ]);
  assert.equal(sent[2]!['role'], 'tool');
  assert.equal(sent[2]!['tool_call_id'], 'call_1');
  assert.equal(sent[2]!['content'], '{"temp":20}');
});

// ── response parsing ──────────────────────────────────────────────────────────

test('content is parsed from choices[0].message.content, reasoning_content is dropped', async () => {
  const { impl } = scripted(() => ({
    body: { choices: [{ message: { content: 'the answer', reasoning_content: 'thinking out loud' } }] },
  }));
  const client = new OpenAiClient(testConfig({ llm: { provider: 'openai', baseUrl: 'http://host:8000/v1', model: 'm' } }), impl);
  const reply = await client.chat([userMsg('hi')], NOOP_TOOLS);
  assert.equal(reply.text, 'the answer');
  assert.equal(JSON.stringify(reply).includes('thinking out loud'), false);
});

test('🔴 tool_calls are parsed into LlmToolCall[] with JSON-decoded arguments', async () => {
  const { impl } = scripted(() => ({
    body: {
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            reasoning_content: '…',
            tool_calls: [{ id: 'call_0a', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }],
          },
        },
      ],
    },
  }));
  const client = new OpenAiClient(testConfig({ llm: { provider: 'openai', baseUrl: 'http://host:8000/v1', model: 'm' } }), impl);
  const reply = await client.chat([userMsg('weather?')], NOOP_TOOLS);
  assert.equal(reply.text, '');
  assert.deepEqual(reply.toolCalls, [{ id: 'call_0a', name: 'get_weather', arguments: { city: 'Paris' } }]);
});

test('malformed tool-call argument JSON degrades to empty args rather than throwing', async () => {
  const { impl } = scripted(() => ({
    body: {
      choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: 'x', arguments: '{not json' } }] } }],
    },
  }));
  const client = new OpenAiClient(testConfig({ llm: { provider: 'openai', baseUrl: 'http://host:8000/v1', model: 'm' } }), impl);
  const reply = await client.chat([userMsg('hi')], NOOP_TOOLS);
  assert.deepEqual(reply.toolCalls, [{ id: 'c1', name: 'x', arguments: {} }]);
});

test('🔴 finish_reason length with no content and no tool call throws — the budget was eaten by reasoning', async () => {
  const { impl } = scripted(() => ({ body: { choices: [{ finish_reason: 'length', message: { content: '' } }] } }));
  const client = new OpenAiClient(testConfig({ llm: { provider: 'openai', baseUrl: 'http://host:8000/v1', model: 'm' } }), impl);
  await assert.rejects(() => client.chat([userMsg('hi')], NOOP_TOOLS), /finish_reason=length/);
});

test('CONTROL: finish_reason length WITH a tool call does not throw', async () => {
  const { impl } = scripted(() => ({
    body: {
      choices: [
        { finish_reason: 'length', message: { tool_calls: [{ id: 'c1', function: { name: 'x', arguments: '{}' } }] } },
      ],
    },
  }));
  const client = new OpenAiClient(testConfig({ llm: { provider: 'openai', baseUrl: 'http://host:8000/v1', model: 'm' } }), impl);
  const reply = await client.chat([userMsg('hi')], NOOP_TOOLS);
  assert.equal(reply.toolCalls.length, 1);
});

test('a non-2xx response throws with the status and body', async () => {
  const { impl } = scripted(() => ({ status: 500, body: 'server exploded' }));
  const client = new OpenAiClient(testConfig({ llm: { provider: 'openai', baseUrl: 'http://host:8000/v1', model: 'm' } }), impl);
  await assert.rejects(() => client.chat([userMsg('hi')], NOOP_TOOLS), /OpenAI-compatible HTTP 500/);
});

// ── timeout ───────────────────────────────────────────────────────────────────

test('🔴 an aborted request throws ModelTimeoutError, not the raw abort', async () => {
  const impl = (async (_url: string, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
    });
  }) as unknown as typeof fetch;
  const client = new OpenAiClient(
    testConfig({ llm: { provider: 'openai', baseUrl: 'http://host:8000/v1', model: 'm', turnTimeoutMs: 5 } }),
    impl,
  );
  await assert.rejects(() => client.chat([userMsg('hi')], NOOP_TOOLS), ModelTimeoutError);
});

// ── config + dispatch ─────────────────────────────────────────────────────────

test('LLM_PROVIDER=openai defaults LLM_BASE_URL to the oMLX default port', () => {
  const saved = { provider: process.env['LLM_PROVIDER'], base: process.env['LLM_BASE_URL'], owner: process.env['OWNER_HANDLE'] };
  try {
    process.env['OWNER_HANDLE'] = '+18015550123';
    process.env['LLM_PROVIDER'] = 'openai';
    delete process.env['LLM_BASE_URL'];
    const config = loadConfig();
    assert.equal(config.llm.provider, 'openai');
    assert.equal(config.llm.baseUrl, 'http://localhost:8000/v1');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      const key = k === 'provider' ? 'LLM_PROVIDER' : k === 'base' ? 'LLM_BASE_URL' : 'OWNER_HANDLE';
      if (v === undefined) delete process.env[key];
      else process.env[key] = v;
    }
  }
});

test('createLlmClient(openai) returns a client labelled with the model', () => {
  const client = createLlmClient(testConfig({ llm: { provider: 'openai', baseUrl: 'http://host:8000/v1', model: 'mlx-community/Qwen3.8-27B-8bit' } }));
  assert.equal(client.label, 'openai:mlx-community/Qwen3.8-27B-8bit');
});

// ── probeLlm ──────────────────────────────────────────────────────────────────

test('🔴 probeLlm checks /v1/models (not /api/tags) for the openai provider', async () => {
  const { impl, calls } = scripted(() => ({ body: { data: [{ id: 'mlx-community/Qwen3.8-27B-8bit' }] } }));
  const result = await probeLlm(
    testConfig({ llm: { provider: 'openai', baseUrl: 'http://host:8000/v1', model: 'mlx-community/Qwen3.8-27B-8bit' } }),
    impl,
  );
  assert.equal(result.ok, true);
  assert.equal(calls[0]!.url, 'http://host:8000/v1/models');
});

test('probeLlm reports the model is missing, and lists what IS there, for openai', async () => {
  const { impl } = scripted(() => ({ body: { data: [{ id: 'some-other-model' }] } }));
  const result = await probeLlm(
    testConfig({ llm: { provider: 'openai', baseUrl: 'http://host:8000/v1', model: 'mlx-community/Qwen3.8-27B-8bit' } }),
    impl,
  );
  assert.equal(result.ok, false);
  assert.match(result.detail, /no model named "mlx-community\/Qwen3\.8-27B-8bit"/);
  assert.match(result.detail, /some-other-model/);
});

test('CONTROL: probeLlm still checks /api/tags for the ollama provider (unchanged)', async () => {
  const { impl, calls } = scripted(() => ({ body: { models: [{ name: 'test-model' }] } }));
  const result = await probeLlm(testConfig({ llm: { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'test-model' } }), impl);
  assert.equal(result.ok, true);
  assert.equal(calls[0]!.url, 'http://localhost:11434/api/tags');
});
