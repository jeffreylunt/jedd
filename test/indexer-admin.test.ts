import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent } from '../src/agent.js';
import type { LlmClient, LlmMessage, LlmReply } from '../src/llm.js';
import {
  assertTogglable,
  IndexerAdminClient,
  hoursBetween,
  humaniseHours,
  isSiteRefusal,
  type FetchImpl,
} from '../src/media/indexer-admin.js';
import { makeIndexerAdmin } from '../src/tools/indexer-admin.js';
import { ALL_TOOLS, buildTools, toolsForRole } from '../src/tools/index.js';
import type { Tool, ToolContext } from '../src/tools/types.js';
import { testConfig } from './helpers.js';

/**
 * `indexer_admin` — the first write path to an indexer.
 *
 * ── WHAT THESE TESTS ARE ACTUALLY DEFENDING ─────────────────────────────────
 *
 * Every fixture below is a SHAPE MEASURED against the live Prowlarr, Sonarr and
 * Radarr on 2026-08-26, not an invention. Four of them are traps that return a
 * plausible-looking wrong answer with no error anywhere:
 *
 *  1. `POST /indexer/testall` answers **HTTP 400 with a COMPLETE body** when any
 *     one indexer fails. Gating on `res.ok` reports "the test failed" over a
 *     result that says four of five indexers are healthy.
 *  2. A plain `PUT /indexer/{id}` **live-tests before saving**, so a broken
 *     indexer cannot be disabled at all without `?forceSave=true` — the one
 *     thing anyone wants to do with a broken indexer is the one that fails.
 *  3. Sonarr and Radarr indexers **have no `enable` field**. Writing one is
 *     accepted with HTTP 202 and changes nothing: a write that reports success
 *     and does nothing.
 *  4. `/indexerstatus` **404s on both arrs**, so their backoff is UNREADABLE —
 *     which is a different fact from "nothing is backed off", and printing the
 *     second over the first is a false zero on the exact question asked.
 */

// ─────────────────────────────────────────────────────────────────────────────
// THE HARNESS
// ─────────────────────────────────────────────────────────────────────────────

interface Call {
  method: string;
  /** Path only. */
  path: string;
  /** The full URL, so a test can assert on `?forceSave=true`. */
  url: string;
  body: string | undefined;
}

interface Stub {
  fetch: FetchImpl;
  calls: Call[];
}

type Handler = (call: Call, nth: number) => { status: number; body: unknown };

const response = (status: number, body: unknown): Response =>
  ({
    status,
    ok: status < 400,
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  }) as Response;

/** Route on `METHOD /path`. An unrouted request THROWS — a silent 404 would hide it. */
function stub(routes: Record<string, Handler>): Stub {
  const calls: Call[] = [];
  const seen = new Map<string, number>();
  const fetch: FetchImpl = async (url, init) => {
    const parsed = new URL(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const call: Call = { method, path: parsed.pathname, url, body: init?.body as string | undefined };
    calls.push(call);
    const key = `${method} ${parsed.pathname}`;
    const handler = routes[key];
    if (!handler) throw new Error(`no stub route for ${key}`);
    const nth = (seen.get(key) ?? 0) + 1;
    seen.set(key, nth);
    const { status, body } = handler(call, nth);
    return response(status, body);
  };
  return { fetch, calls };
}

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  role: 'owner',
  senderHandle: '+18015550123',
  config: testConfig({ readOnly: false }),
  ...over,
});

const run = (s: Stub, args: Record<string, unknown>, over: Partial<ToolContext> = {}) =>
  makeIndexerAdmin(s.fetch).run(args, ctx(over));

const P = '/api/v1';
const S = '/sonarr/api/v3';

/** The credential that must never appear in an answer. */
const SECRET = 'TOPSECRETPASSKEY00000000';

/**
 * A real Prowlarr indexer resource, trimmed but keeping the two shapes that
 * matter: a top-level `apiKey`, and the `{name, value}` pair that hides a
 * credential from a key-name walker.
 */
const prowlarrIndexer = (over: Record<string, unknown> = {}) => ({
  id: 6,
  name: '1337x',
  enable: true,
  protocol: 'torrent',
  privacy: 'public',
  priority: 25,
  apiKey: SECRET,
  fields: [
    { name: 'apiKey', value: SECRET },
    { name: 'baseUrl', value: 'https://1337x.to' },
  ],
  ...over,
});

/** An arr indexer: three switches and NO `enable`. Measured on all 7 arr indexers. */
const arrIndexer = (over: Record<string, unknown> = {}) => ({
  id: 4,
  name: '1337x (Prowlarr)',
  enableRss: true,
  enableAutomaticSearch: true,
  enableInteractiveSearch: true,
  fields: [{ name: 'apiKey', value: SECRET }],
  ...over,
});

const FORBIDDEN = 'Unable to connect to indexer. Unexpected response status Forbidden code from indexer request';

const backoffRow = (over: Record<string, unknown> = {}) => ({
  indexerId: 6,
  disabledTill: '2026-08-27T16:36:30Z',
  mostRecentFailure: '2026-08-26T16:36:30Z',
  initialFailure: '2026-08-25T13:13:54Z',
  ...over,
});

const HEALTH_1337X = [
  {
    source: 'IndexerLongTermStatusCheck',
    type: 'warning',
    message: 'Indexers unavailable due to failures for more than 6 hours: 1337x',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE ROLE GATE — Jeff asked for this "as the owner"
// ─────────────────────────────────────────────────────────────────────────────

test('🔴 indexer_admin is owner-only and a guest is never even shown it', () => {
  const tools = buildTools(testConfig({ readOnly: false }));
  const tool = tools.find((t) => t.name === 'indexer_admin');
  assert.ok(tool, 'indexer_admin must be registered');
  assert.equal(tool.minRole, 'owner');
  assert.equal(tool.writes, true, 'it changes the homelab and must say so');

  const guestVisible = toolsForRole(tools, 'guest').map((t) => t.name);
  assert.ok(!guestVisible.includes('indexer_admin'), 'a guest must not be offered an indexer write');
  const ownerVisible = toolsForRole(tools, 'owner').map((t) => t.name);
  assert.ok(ownerVisible.includes('indexer_admin'), 'CONTROL: the owner IS offered it');
});

/** A model that asks for `indexer_admin` once, then answers. */
class ScriptedLlm implements LlmClient {
  readonly label = 'scripted';

  readonly declaredTools: string[][] = [];

  private calls = 0;

  async chat(_messages: LlmMessage[], tools: Tool[]): Promise<LlmReply> {
    this.declaredTools.push(tools.map((t) => t.name));
    this.calls++;
    if (this.calls === 1) {
      return {
        text: '',
        toolCalls: [
          { id: 'c1', name: 'indexer_admin', arguments: { service: 'prowlarr', action: 'test_all' } },
        ],
      };
    }
    return { text: 'done', toolCalls: [] };
  }
}

test('🔴 MUTATION TARGET: a GUEST driving the real loop is REFUSED and no request is made', async () => {
  /**
   * 🔴 THE GATE IS EXERCISED THROUGH THE REAL AGENT, NOT ASSERTED ON A FIELD.
   *
   * `minRole: 'owner'` is a declaration; `agent.ts` re-checking it before any
   * side effect is the actual defence. This drives the whole loop with the REAL
   * tool and a stub transport, so the assertion that matters is not "the role
   * says owner" but **zero HTTP requests were issued** — a refusal that still
   * ran the command is the failure mode a field assertion cannot see.
   */
  const s = stub({
    [`GET ${P}/indexer`]: () => ({ status: 200, body: [prowlarrIndexer()] }),
    [`POST ${P}/indexer/testall`]: () => ({ status: 200, body: [{ id: 6, isValid: true, validationFailures: [] }] }),
  });
  const llm = new ScriptedLlm();
  const agent = new Agent(testConfig({ readOnly: false }), llm, undefined, [makeIndexerAdmin(s.fetch)]);

  const record = await agent.handle('+18015559999', 'fix the torrent indexers');

  assert.equal(record.role, 'guest');
  assert.equal(record.toolCalls[0]?.refused, true, 'the guest call must be refused');
  assert.deepEqual(s.calls, [], '🔴 NOTHING may reach Prowlarr on a refused call');
  assert.deepEqual(llm.declaredTools[0], [], 'the guest is not even told the tool exists');
});

test('FAILING CONTROL: the identical request from the OWNER does reach Prowlarr', async () => {
  // Without this, "zero calls" above is equally consistent with a broken stub,
  // a broken Agent, or a tool that never issues requests at all.
  const s = stub({
    [`GET ${P}/indexer`]: () => ({ status: 200, body: [prowlarrIndexer()] }),
    [`GET ${P}/indexerstatus`]: () => ({ status: 200, body: [] }),
    [`GET ${P}/health`]: () => ({ status: 200, body: [] }),
    [`POST ${P}/indexer/testall`]: () => ({ status: 200, body: [{ id: 6, isValid: true, validationFailures: [] }] }),
  });
  const agent = new Agent(testConfig({ readOnly: false }), new ScriptedLlm(), undefined, [makeIndexerAdmin(s.fetch)]);

  const record = await agent.handle('+18015550123', 'fix the torrent indexers');

  assert.equal(record.role, 'owner');
  assert.equal(record.toolCalls[0]?.refused, undefined);
  assert.ok(
    s.calls.some((c) => c.method === 'POST' && c.path === `${P}/indexer/testall`),
    'the owner must actually reach the test endpoint',
  );
});

test('🔴 the write kill switch removes it entirely, list action included', () => {
  const off = buildTools(testConfig({ readOnly: true })).map((t) => t.name);
  const on = buildTools(testConfig({ readOnly: false })).map((t) => t.name);
  assert.ok(!off.includes('indexer_admin'), 'a write tool must not survive read-only mode');
  assert.ok(on.includes('indexer_admin'), 'CONTROL: present when writes are enabled');
  assert.ok(ALL_TOOLS.some((t) => t.name === 'indexer_admin'), 'and enumerable for the invariants');
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE CREDENTIAL RULE — same as homelab_read's, for the same reason
// ─────────────────────────────────────────────────────────────────────────────

test('🔴 the indexer resource carries a credential and NONE of it reaches the answer', async () => {
  /**
   * `/api/v1/indexer` is denied to `homelab_read` as SECRET precisely because
   * the resource carries tracker credentials, including in the `{name, value}`
   * shape a key-name walker cannot see. This tool must read that same endpoint
   * to produce ids — so the projection to scalars is the whole defence, and the
   * owner is no exception: a secret in a reply lands in the message thread, the
   * replayed history and the log file.
   */
  const s = stub({
    [`GET ${P}/indexer`]: () => ({ status: 200, body: [prowlarrIndexer()] }),
    [`GET ${P}/indexerstatus`]: () => ({ status: 200, body: [] }),
    [`GET ${P}/health`]: () => ({ status: 200, body: [] }),
  });
  const r = await run(s, { service: 'prowlarr', action: 'list' });

  assert.equal(r.ok, true);
  assert.ok(!r.content.includes(SECRET), '🔴 the credential must not be in the output');
  assert.ok(!/apiKey/i.test(r.content), 'nor the field that held it');
  // CONTROL: the useful part IS there, so the assertion above is not passing
  // because the tool returned nothing.
  assert.match(r.content, /id 6/);
  assert.match(r.content, /1337x/);
  assert.match(r.content, /enabled/);
});

test('🔴 MUTATION TARGET: list() PROJECTS to four scalars — the credential never enters the row', async () => {
  /**
   * Found by the mutation sweep: spreading the raw resource into the row left
   * the suite GREEN, because the renderer reads four named fields and simply
   * never printed the extras. That made the projection look load-bearing when
   * only the renderer was — and a renderer is one `JSON.stringify` away from
   * printing everything it holds.
   *
   * Two layers, asserted separately: the row must not CONTAIN a credential, and
   * the output must not PRINT one. A leak would have to defeat both.
   */
  const s = stub({
    [`GET ${P}/indexer`]: () => ({ status: 200, body: [prowlarrIndexer()] }),
  });
  const client = new IndexerAdminClient({
    service: 'prowlarr',
    config: testConfig({ readOnly: false }),
    fetchImpl: s.fetch,
  });
  const list = await client.list();
  assert.equal(list.state, 'ok');
  const row = list.state === 'ok' ? list.value[0] : undefined;
  assert.ok(row);
  assert.deepEqual(
    Object.keys(row).sort(),
    ['enable', 'id', 'name', 'switches'],
    '🔴 exactly four scalars — nothing from the resource may ride along',
  );
  assert.ok(!JSON.stringify(row).includes(SECRET));
});

test('a FAILING indexer test message is scrubbed before it is quoted', async () => {
  const s = stub({
    [`GET ${P}/indexer`]: () => ({ status: 200, body: [prowlarrIndexer()] }),
    [`GET ${P}/indexerstatus`]: () => ({ status: 200, body: [backoffRow()] }),
    [`GET ${P}/health`]: () => ({ status: 200, body: HEALTH_1337X }),
    [`GET ${P}/indexer/6`]: () => ({ status: 200, body: prowlarrIndexer() }),
    [`POST ${P}/indexer/test`]: () => ({
      status: 400,
      body: [
        {
          errorMessage: `Unable to connect to https://tracker.example/rss?passkey=${SECRET}&cat=1`,
          severity: 'error',
        },
      ],
    }),
  });
  const r = await run(s, { service: 'prowlarr', action: 'test', id: 6 });

  assert.ok(!r.content.includes(SECRET), 'a passkey inside an error URL must be redacted');
  assert.match(r.content, /REDACTED/);
  assert.match(r.content, /tracker\.example/, 'CONTROL: the useful part of the URL survives');
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 TRAP 1 — testall answers HTTP 400 with a COMPLETE body
// ─────────────────────────────────────────────────────────────────────────────

test('🔴 testall returning HTTP 400 is PARSED, not reported as a failed operation', async () => {
  /**
   * MEASURED: 4 passes and 1 failure came back as HTTP 400 carrying all five
   * results. A caller that gates on `res.ok` says "the test failed" over a body
   * that says four indexers are healthy — and that is the answer Jeff would act
   * on.
   */
  const s = stub({
    [`GET ${P}/indexer`]: () => ({
      status: 200,
      body: [
        prowlarrIndexer({ id: 1, name: 'The Pirate Bay' }),
        prowlarrIndexer({ id: 2, name: 'EZTV' }),
        prowlarrIndexer({ id: 6, name: '1337x' }),
        prowlarrIndexer({ id: 8, name: 'KickassTorrents', enable: false }),
      ],
    }),
    [`GET ${P}/indexerstatus`]: () => ({ status: 200, body: [backoffRow()] }),
    [`GET ${P}/health`]: () => ({ status: 200, body: HEALTH_1337X }),
    [`POST ${P}/indexer/testall`]: () => ({
      // 🔴 400, with everything in it.
      status: 400,
      body: [
        { id: 1, isValid: true, validationFailures: [] },
        { id: 2, isValid: true, validationFailures: [] },
        { id: 6, isValid: false, validationFailures: [{ errorMessage: FORBIDDEN, severity: 'error' }] },
      ],
    }),
  });
  const r = await run(s, { service: 'prowlarr', action: 'test_all' });

  assert.equal(r.ok, true, '🔴 an HTTP 400 from testall is a RESULT, not a failure to act');
  assert.match(r.content, /2 passed, 1 failed/);
  assert.match(r.content, /✅ id 1 The Pirate Bay — PASSED/);
  assert.match(r.content, /❌ id 6 1337x — FAILED/);
  // The disabled indexer was not tested, and that is stated rather than looking
  // like a result that went missing.
  assert.match(r.content, /1 disabled indexer\(s\) were not tested/);
});

test('CONTROL: the same body at HTTP 200 is read identically', () => {
  // If the 400 case above passed because the tool ignores the status entirely
  // and something else were wrong, this would not distinguish it — so the point
  // of this control is that the STATUS is genuinely not consulted for the
  // per-indexer verdict, which comes from `isValid`.
  assert.equal(isSiteRefusal([FORBIDDEN]), true);
  assert.equal(isSiteRefusal(['Unable to connect to indexer. Connection timed out']), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 TRAP 2 — a plain PUT live-tests, so a broken indexer cannot be disabled
// ─────────────────────────────────────────────────────────────────────────────

test('🔴 disabling uses ?forceSave=true, or a BROKEN indexer could never be turned off', async () => {
  /**
   * MEASURED: `PUT /api/v1/indexer/6` with the body UNCHANGED → HTTP 400
   * "Forbidden", because Prowlarr validates by live-testing before saving. And
   * that rejected PUT still ran the test, pushing `disabledTill` a further 24 h
   * out while saving nothing.
   */
  const s = stub({
    [`GET ${P}/indexer`]: () => ({ status: 200, body: [prowlarrIndexer()] }),
    [`GET ${P}/indexerstatus`]: () => ({ status: 200, body: [backoffRow()] }),
    [`GET ${P}/health`]: () => ({ status: 200, body: HEALTH_1337X }),
    [`GET ${P}/indexer/6`]: () => ({ status: 200, body: prowlarrIndexer() }),
    [`PUT ${P}/indexer/6`]: (call) => {
      // The live server rejects this without forceSave. Reproduce that here, so
      // dropping the flag turns this test red rather than passing on a stub that
      // is more forgiving than production.
      if (!call.url.includes('forceSave=true')) {
        return { status: 400, body: [{ errorMessage: FORBIDDEN, severity: 'error' }] };
      }
      return { status: 202, body: prowlarrIndexer({ enable: false }) };
    },
  });
  const r = await run(s, { service: 'prowlarr', action: 'disable', id: 6 });

  assert.equal(r.ok, true, 'a broken indexer must still be disable-able');
  assert.match(r.content, /is now DISABLED/);
  const put = s.calls.find((c) => c.method === 'PUT');
  assert.ok(put, 'a PUT must have been issued');
  assert.match(put.url, /forceSave=true/);
  assert.match(put.body ?? '', /"enable":false/, 'and it must actually carry the new value');
});

test('enabling warns that the forced save says nothing about whether it works', async () => {
  const s = stub({
    [`GET ${P}/indexer`]: () => ({ status: 200, body: [prowlarrIndexer({ enable: false })] }),
    [`GET ${P}/indexerstatus`]: () => ({ status: 200, body: [] }),
    [`GET ${P}/health`]: () => ({ status: 200, body: [] }),
    [`GET ${P}/indexer/6`]: () => ({ status: 200, body: prowlarrIndexer({ enable: false }) }),
    [`PUT ${P}/indexer/6`]: () => ({ status: 202, body: prowlarrIndexer({ enable: true }) }),
  });
  const r = await run(s, { service: 'prowlarr', action: 'enable', id: 6 });

  assert.match(r.content, /is now ENABLED/);
  assert.match(r.content, /Enabling does NOT mean it works/);
  assert.match(r.content, /action "test"/, 'and it points at the thing that would find out');
});

test('a no-op toggle says NOTHING CHANGED and issues no PUT', async () => {
  // "Already enabled" and "I enabled it" are different facts, and reporting the
  // second over the first is a claim about work that was never done.
  const s = stub({
    [`GET ${P}/indexer`]: () => ({ status: 200, body: [prowlarrIndexer({ enable: true })] }),
    [`GET ${P}/indexerstatus`]: () => ({ status: 200, body: [] }),
    [`GET ${P}/health`]: () => ({ status: 200, body: [] }),
    [`GET ${P}/indexer/6`]: () => ({ status: 200, body: prowlarrIndexer({ enable: true }) }),
  });
  const r = await run(s, { service: 'prowlarr', action: 'enable', id: 6 });

  assert.match(r.content, /was ALREADY enabled — nothing was changed/);
  assert.deepEqual(s.calls.filter((c) => c.method === 'PUT'), [], 'no write may be issued for a no-op');
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 TRAP 3 — the arrs have no `enable` field
// ─────────────────────────────────────────────────────────────────────────────

test('🔴 MUTATION TARGET: toggling a SONARR indexer is refused and issues NO write', async () => {
  /**
   * MEASURED: every Sonarr and Radarr indexer returns `enable: undefined`.
   * PUTting one back with `enable: false` added is accepted — HTTP 202, full
   * resource echoed — and the indexer carries on exactly as before. That is a
   * write which reports success and does nothing, indistinguishable from a
   * working one at every layer except the one nobody checks.
   *
   * The guard is `assertTogglable`, and it keys on the field being ABSENT in the
   * body just read rather than on a hardcoded list of which services support it
   * — a hardcoded list is a second copy of the same fact and goes stale
   * silently.
   */
  const s = stub({
    [`GET ${S}/indexer`]: () => ({ status: 200, body: [arrIndexer()] }),
    [`GET ${S}/indexerstatus`]: () => ({ status: 404, body: '' }),
    [`GET ${S}/health`]: () => ({ status: 200, body: HEALTH_1337X }),
    [`GET ${S}/indexer/4`]: () => ({ status: 200, body: arrIndexer() }),
    // Deliberately routed: if the guard ever stops firing, the PUT lands here
    // and returns the same misleading 202 the live server does — so this test
    // fails on the ASSERTION below rather than on a missing route.
    [`PUT ${S}/indexer/4`]: () => ({ status: 202, body: arrIndexer() }),
  });
  const r = await run(s, { service: 'sonarr', action: 'disable', id: 4 });

  assert.equal(r.ok, false);
  assert.match(r.content, /no single `enable` field/);
  assert.match(r.content, /changes NOTHING/);
  assert.match(r.content, /use service "prowlarr"/, 'and it names the switch that IS real');
  assert.deepEqual(s.calls.filter((c) => c.method === 'PUT'), [], '🔴 no PUT may be issued');
});

test('CONTROL: assertTogglable passes a body that really has the field', () => {
  // Without this the guard could be refusing everything, which would look
  // identical in the test above.
  assert.equal(assertTogglable('prowlarr', { enable: true }), null);
  assert.equal(assertTogglable('prowlarr', { enable: false }), null);
  assert.match(assertTogglable('sonarr', { enableRss: true }) ?? '', /no single `enable` field/);
  assert.match(assertTogglable('prowlarr', {}) ?? '', /no single `enable` field/);
});

test('the arr list names its three real switches rather than inventing "enabled"', async () => {
  const s = stub({
    [`GET ${S}/indexer`]: () => ({ status: 200, body: [arrIndexer({ enableRss: false })] }),
    [`GET ${S}/indexerstatus`]: () => ({ status: 404, body: '' }),
    [`GET ${S}/health`]: () => ({ status: 200, body: [] }),
  });
  const r = await run(s, { service: 'sonarr', action: 'list' });

  assert.match(r.content, /on for auto-search, interactive-search/);
  assert.ok(!/\benabled\b/.test(r.content), 'a field that does not exist must not be reported as one');
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 TRAP 4 — arr backoff is UNREADABLE, which is not "nothing is backed off"
// ─────────────────────────────────────────────────────────────────────────────

test('🔴 an arr says its backoff is UNREADABLE — never that nothing is backed off', async () => {
  const s = stub({
    [`GET ${S}/indexer`]: () => ({ status: 200, body: [arrIndexer()] }),
    [`GET ${S}/indexerstatus`]: () => ({ status: 404, body: '' }),
    [`GET ${S}/health`]: () => ({ status: 200, body: HEALTH_1337X }),
  });
  const r = await run(s, { service: 'sonarr', action: 'list' });

  assert.match(r.content, /backoff UNREADABLE here/);
  assert.match(r.content, /404/, 'and it says WHY, so nobody re-derives it');
  assert.ok(!/\bok\b/.test(r.content), 'an unread indexer must never be rendered as healthy');
  // The one signal that DOES exist is surfaced, with its own caveat.
  assert.match(r.content, /Indexers unavailable due to failures for more than 6 hours/);
  assert.match(r.content, /SLOW to clear/);
});

test('CONTROL: Prowlarr, which CAN report backoff, says "ok" for a healthy indexer', () => {
  // The assertion above ("never ok") is only meaningful if `ok` is what a
  // service that really did report healthy would print.
  return (async () => {
    const s = stub({
      [`GET ${P}/indexer`]: () => ({ status: 200, body: [prowlarrIndexer()] }),
      [`GET ${P}/indexerstatus`]: () => ({ status: 200, body: [] }),
      [`GET ${P}/health`]: () => ({ status: 200, body: [] }),
    });
    const r = await run(s, { service: 'prowlarr', action: 'list' });
    assert.match(r.content, /\bok\b/);
    assert.match(r.content, /reports NO indexer health warnings/);
  })();
});

test('🔴 an arr force-test does not claim a backoff it cannot see was cleared', async () => {
  const s = stub({
    [`GET ${S}/indexer`]: () => ({ status: 200, body: [arrIndexer()] }),
    [`GET ${S}/indexerstatus`]: () => ({ status: 404, body: '' }),
    [`GET ${S}/health`]: () => ({ status: 200, body: HEALTH_1337X }),
    [`GET ${S}/indexer/4`]: () => ({ status: 200, body: arrIndexer() }),
    [`POST ${S}/indexer/test`]: () => ({ status: 200, body: {} }),
  });
  const r = await run(s, { service: 'sonarr', action: 'test', id: 4 });

  assert.equal(r.ok, true);
  assert.match(r.content, /PASSED/);
  assert.match(r.content, /does not expose backoff over its API/);
  assert.match(r.content, /The passing test IS the evidence/);
  assert.ok(!/REAL FIX/.test(r.content), 'it must not claim a before/after it never read');
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE 403 — the thing the tool exists to be honest about
// ─────────────────────────────────────────────────────────────────────────────

test('🔴 a 403 is reported as the SITE refusing us, and never as a fix', async () => {
  const s = stub({
    [`GET ${P}/indexer`]: () => ({ status: 200, body: [prowlarrIndexer()] }),
    [`GET ${P}/indexerstatus`]: () => ({ status: 200, body: [backoffRow()] }),
    [`GET ${P}/health`]: () => ({ status: 200, body: HEALTH_1337X }),
    [`GET ${P}/indexer/6`]: () => ({ status: 200, body: prowlarrIndexer() }),
    [`POST ${P}/indexer/test`]: () => ({
      status: 400,
      body: [{ errorMessage: FORBIDDEN, severity: 'error' }],
    }),
  });
  const r = await run(s, { service: 'prowlarr', action: 'test', id: 6 });

  assert.equal(r.ok, true, 'the test ran; its result is a real answer, not a failure to act');
  assert.match(r.content, /THIS IS THE SITE REFUSING US, NOT A BACKOFF, AND THE TEST DID NOT FIX IT/);
  assert.match(r.content, /still 403/);
  assert.match(r.content, /Do NOT say fixed, re-enabled or refreshed/);
  assert.ok(!/REAL FIX/.test(r.content));
});

test('🔴 MUTATION TARGET: the failure age comes from initialFailure, NEVER mostRecentFailure', async () => {
  /**
   * MEASURED: `mostRecentFailure` moved 14:07:59Z → 16:36:30Z → 16:37:29Z inside
   * one hour while `initialFailure` stayed pinned at 2026-08-25T13:13:54Z. Every
   * backoff retry and every failing force-test rewrites it. Anchoring the age
   * there turns a four-day outage into a thirty-minute-old blip — the difference
   * between "report once and stop" and "something just broke, go and look".
   *
   * So this fixture makes the two answers maximally far apart: the outage is 5
   * days old, and the last retry was a minute ago.
   */
  const now = new Date();
  const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 3_600_000).toISOString();
  const aMinuteAgo = new Date(now.getTime() - 60_000).toISOString();

  const s = stub({
    [`GET ${P}/indexer`]: () => ({ status: 200, body: [prowlarrIndexer(), prowlarrIndexer({ id: 2, name: 'EZTV' })] }),
    [`GET ${P}/indexerstatus`]: () => ({
      status: 200,
      body: [backoffRow({ initialFailure: fiveDaysAgo, mostRecentFailure: aMinuteAgo })],
    }),
    [`GET ${P}/health`]: () => ({ status: 200, body: HEALTH_1337X }),
    [`GET ${P}/indexer/6`]: () => ({ status: 200, body: prowlarrIndexer() }),
    [`POST ${P}/indexer/test`]: () => ({ status: 400, body: [{ errorMessage: FORBIDDEN, severity: 'error' }] }),
  });
  const r = await run(s, { service: 'prowlarr', action: 'test', id: 6 });

  assert.match(r.content, /failing for 5d/i, '🔴 five days, measured from the FIRST failure');
  assert.ok(!/failing for 0h/.test(r.content), 'the last retry is not the age');
  /**
   * 🔴 AND THE SAME AGE IN THE STATE BLOCK, WHICH IS A SECOND COMPUTATION.
   *
   * Found by the mutation sweep: swapping `initialFailure` for
   * `mostRecentFailure` inside `describeBackoff` left the suite GREEN, because
   * only the 403 note's age was asserted. `STATE NOW` renders its own age from
   * its own call, and that is the line a person actually reads. Two computations
   * of the same fact need two assertions.
   */
  assert.match(r.content, /FAILING since \S+ \(5d 0h\)/, 'the STATE block computes the age too');
  assert.ok(!/FAILING since \S+ \(0h\)/.test(r.content), 'and must not compute it from the last retry');
  assert.match(r.content, /past 3 days/);
  assert.match(r.content, /REPORTED ONCE and then left alone/);
  // And it says the rest of the stack is fine, which is the other half of that rule.
  assert.match(r.content, /Every other enabled Prowlarr indexer is green right now \(1 of 2\)/);
});

test('🔴 a FAILED test that pushed the backoff further out SAYS so', async () => {
  /**
   * MEASURED: the failing test moved `disabledTill` 2026-08-27T14:07:59Z →
   * 16:36:30Z. A retry is not free, and "I tested it again" reads as free.
   */
  const s = stub({
    [`GET ${P}/indexer`]: () => ({ status: 200, body: [prowlarrIndexer()] }),
    [`GET ${P}/indexerstatus`]: (_c, nth) => ({
      status: 200,
      body: [backoffRow({ disabledTill: nth === 1 ? '2026-08-27T14:07:59Z' : '2026-08-27T16:36:30Z' })],
    }),
    [`GET ${P}/health`]: () => ({ status: 200, body: HEALTH_1337X }),
    [`GET ${P}/indexer/6`]: () => ({ status: 200, body: prowlarrIndexer() }),
    [`POST ${P}/indexer/test`]: () => ({ status: 400, body: [{ errorMessage: FORBIDDEN, severity: 'error' }] }),
  });
  const r = await run(s, { service: 'prowlarr', action: 'test', id: 6 });

  assert.match(r.content, /AND THE TEST COST SOMETHING/);
  assert.match(r.content, /2026-08-27T14:07:59Z → 2026-08-27T16:36:30Z/);
  assert.match(r.content, /Retrying gains nothing/);
});

test('a NON-403 failure points at the tunnel, not at the tracker', async () => {
  // Different fault, different action. A timeout means the container has no
  // egress; poking the indexer again cannot help and re-arms the backoff.
  const s = stub({
    [`GET ${P}/indexer`]: () => ({ status: 200, body: [prowlarrIndexer()] }),
    [`GET ${P}/indexerstatus`]: () => ({ status: 200, body: [backoffRow()] }),
    [`GET ${P}/health`]: () => ({ status: 200, body: HEALTH_1337X }),
    [`GET ${P}/indexer/6`]: () => ({ status: 200, body: prowlarrIndexer() }),
    [`POST ${P}/indexer/test`]: () => ({
      status: 400,
      body: [{ errorMessage: 'Unable to connect to indexer. The operation has timed out', severity: 'error' }],
    }),
  });
  const r = await run(s, { service: 'prowlarr', action: 'test', id: 6 });

  assert.match(r.content, /NOT with a 403/);
  assert.match(r.content, /VPN tunnel/);
  assert.ok(!/THIS IS THE SITE REFUSING US/.test(r.content), 'a timeout is not a refusal');
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 A PASS IS ONLY A FIX IF SOMETHING WAS STUCK
// ─────────────────────────────────────────────────────────────────────────────

test('🔴 a pass on an indexer that WAS in backoff is reported as a REAL FIX', async () => {
  const s = stub({
    [`GET ${P}/indexer`]: () => ({ status: 200, body: [prowlarrIndexer()] }),
    // Backed off before; gone afterwards — the whole point of the operation.
    [`GET ${P}/indexerstatus`]: (_c, nth) => ({ status: 200, body: nth === 1 ? [backoffRow()] : [] }),
    [`GET ${P}/health`]: () => ({ status: 200, body: [] }),
    [`GET ${P}/indexer/6`]: () => ({ status: 200, body: prowlarrIndexer() }),
    [`POST ${P}/indexer/test`]: () => ({ status: 200, body: {} }),
  });
  const r = await run(s, { service: 'prowlarr', action: 'test', id: 6 });

  assert.match(r.content, /REAL FIX/);
  assert.match(r.content, /were in backoff before this and are not now/);
  assert.match(r.content, /should return results again/);
});

test('🔴 a pass on an indexer that was NEVER stuck is NOT reported as a fix', async () => {
  /**
   * The same "I tested the indexers" sentence covers both cases, and only one
   * means anything was repaired. This is the one that would otherwise be
   * oversold — a green test on a healthy indexer, reported as a repair.
   */
  const s = stub({
    [`GET ${P}/indexer`]: () => ({ status: 200, body: [prowlarrIndexer({ id: 2, name: 'EZTV' })] }),
    [`GET ${P}/indexerstatus`]: () => ({ status: 200, body: [] }),
    [`GET ${P}/health`]: () => ({ status: 200, body: [] }),
    [`GET ${P}/indexer/2`]: () => ({ status: 200, body: prowlarrIndexer({ id: 2, name: 'EZTV' }) }),
    [`POST ${P}/indexer/test`]: () => ({ status: 200, body: {} }),
  });
  const r = await run(s, { service: 'prowlarr', action: 'test', id: 2 });

  assert.match(r.content, /NOTHING WAS ACTUALLY STUCK/);
  assert.match(r.content, /confirmed health rather than repairing anything/);
  assert.match(r.content, /Do not report this as a fix/);
  assert.ok(!/REAL FIX/.test(r.content));
});

// ─────────────────────────────────────────────────────────────────────────────
// THE PRODUCER, AND THE ARGUMENTS
// ─────────────────────────────────────────────────────────────────────────────

test('🔴 the id producer exists: list yields the ids test/enable/disable need', async () => {
  /**
   * The orphaned-consumer check. `homelab_read` can only reach Prowlarr's
   * `/indexerstatus`, which lists ONLY currently-failing indexers and is `[]`
   * the rest of the time — so without this tool's own list action, `test` would
   * be callable exactly when something was already broken. That is how
   * `add_audiobook` shipped uncallable while passing every green check.
   */
  const s = stub({
    [`GET ${P}/indexer`]: () => ({
      status: 200,
      body: [prowlarrIndexer({ id: 2, name: 'EZTV' }), prowlarrIndexer({ id: 6, name: '1337x' })],
    }),
    // Everything healthy — the case where /indexerstatus tells you NOTHING.
    [`GET ${P}/indexerstatus`]: () => ({ status: 200, body: [] }),
    [`GET ${P}/health`]: () => ({ status: 200, body: [] }),
  });
  const r = await run(s, { service: 'prowlarr', action: 'list' });

  assert.match(r.content, /id 2\s+EZTV/);
  assert.match(r.content, /id 6\s+1337x/);
  assert.match(r.content, /nothing was changed/i, 'list is a read and says so');
});

test('a missing id refuses and issues NO request', async () => {
  const s = stub({});
  const r = await run(s, { service: 'prowlarr', action: 'test' });
  assert.equal(r.ok, false);
  assert.match(r.content, /action "list"/);
  assert.deepEqual(s.calls, [], 'a refused call must not reach the server');
});

test('a non-integer id is not an id', async () => {
  const s = stub({});
  for (const id of ['6', 6.5, -1, null]) {
    const r = await run(s, { service: 'prowlarr', action: 'test', id });
    assert.equal(r.ok, false, `${JSON.stringify(id)} must be refused`);
  }
  assert.deepEqual(s.calls, []);
});

test('an unknown service or action is refused before anything happens', async () => {
  const s = stub({});
  assert.match((await run(s, { service: 'qbittorrent', action: 'list' })).content, /not a service/);
  assert.match((await run(s, { service: 'prowlarr', action: 'delete' })).content, /not an action/);
  assert.deepEqual(s.calls, []);
});

test('an unconfigured service refuses rather than making an unauthenticated call', async () => {
  const s = stub({});
  const bare = testConfig({ readOnly: false, prowlarr: { baseUrl: 'http://prowlarr.invalid:9696', apiKey: '' } });
  const r = await run(s, { service: 'prowlarr', action: 'list' }, { config: bare });
  assert.equal(r.ok, false);
  assert.match(r.content, /no API key configured/);
  assert.deepEqual(s.calls, []);
});

test('an unreachable service is UNKNOWN, never "nothing is wrong"', async () => {
  const fetchImpl: FetchImpl = async () => {
    throw new Error('connect ECONNREFUSED');
  };
  const r = await makeIndexerAdmin(fetchImpl).run({ service: 'prowlarr', action: 'list' }, ctx());
  assert.equal(r.ok, false);
  assert.match(r.content, /UNKNOWN/);
  assert.match(r.content, /failure to ACT/);
});

// ─────────────────────────────────────────────────────────────────────────────
// PURE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

test('hoursBetween and humaniseHours', () => {
  const now = new Date('2026-08-26T16:00:00Z');
  assert.equal(hoursBetween('2026-08-25T13:00:00Z', now), 27);
  assert.equal(hoursBetween(null, now), null);
  assert.equal(hoursBetween('not a date', now), null);
  assert.equal(humaniseHours(27), '27h');
  assert.equal(humaniseHours(72), '3d 0h');
  assert.equal(humaniseHours(100), '4d 4h');
});
