/**
 * Empirical probe of the pinned model on the live endpoint.
 *
 * Everything here is measured, not inherited. Each case prints what actually
 * came back so a claim about this model can be checked rather than trusted.
 */
const BASE = process.env.LLM_BASE_URL ?? 'http://localhost:11434';
const MODEL = process.env.LLM_MODEL ?? 'qwen3.8:27b-mlx';

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'jellyfin_sessions',
      description: 'List current Jellyfin sessions and what each is playing.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

async function chat(label, body) {
  const started = Date.now();
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, stream: false, ...body }),
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  if (!res.ok) {
    console.log(`\n### ${label}\nHTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  const json = await res.json();
  const msg = json.message ?? {};
  console.log(`\n### ${label}   (${elapsed}s)`);
  console.log(`  done_reason : ${json.done_reason}`);
  console.log(`  eval_count  : ${json.eval_count}`);
  console.log(`  content len : ${(msg.content ?? '').length}`);
  console.log(`  thinking len: ${(msg.thinking ?? '').length}`);
  console.log(`  tool_calls  : ${JSON.stringify(msg.tool_calls ?? null)?.slice(0, 300)}`);
  console.log(`  content     : ${JSON.stringify((msg.content ?? '').slice(0, 200))}`);
  return json;
}

async function ps(label) {
  const res = await fetch(`${BASE}/api/ps`);
  const json = await res.json();
  console.log(`\n### /api/ps ${label}`);
  for (const m of json.models ?? []) {
    const resident = m.size_vram === m.size;
    console.log(
      `  ${m.name}  size=${(m.size / 1e9).toFixed(2)}GB  vram=${(m.size_vram / 1e9).toFixed(2)}GB  ` +
        `FULLY_RESIDENT=${resident}  ctx=${m.context_length ?? '?'}`,
    );
  }
  if (!(json.models ?? []).length) console.log('  (no models loaded)');
}

const ASK = [{ role: 'user', content: 'Is anyone watching Jellyfin right now?' }];

// 1. Thinking ON with a SMALL budget — expect the documented empty-output trap.
await chat('thinking ON, num_predict=200 (expect EMPTY content)', {
  messages: ASK,
  tools: TOOLS,
  think: true,
  options: { num_predict: 200, num_ctx: 16384 },
  keep_alive: '30m',
});

// 2. Thinking ON with an adequate budget — expect a real answer AND a tool call.
await chat('thinking ON, num_predict=3000 (expect real output)', {
  messages: ASK,
  tools: TOOLS,
  think: true,
  options: { num_predict: 3000, num_ctx: 16384 },
  keep_alive: '30m',
});

// 3. Thinking OFF, same budget — the control, to see what thinking is buying.
await chat('thinking OFF, num_predict=3000', {
  messages: ASK,
  tools: TOOLS,
  think: false,
  options: { num_predict: 3000, num_ctx: 16384 },
  keep_alive: '30m',
});

// 4. Does tool_choice do ANYTHING? Documented as silently dropped — verify.
await chat('tool_choice:"required" on a message needing NO tool (expect it to be IGNORED)', {
  messages: [{ role: 'user', content: 'thanks man, appreciate it' }],
  tools: TOOLS,
  tool_choice: 'required',
  think: true,
  options: { num_predict: 3000, num_ctx: 16384 },
  keep_alive: '30m',
});

await ps('after generation');
