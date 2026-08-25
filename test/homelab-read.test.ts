import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planRead, renderRead, READ_SERVICES } from '../src/homelab-read.js';
import { makeHomelabRead } from '../src/tools/homelab-read.js';
import { ALL_TOOLS, buildTools, toolsForRole } from '../src/tools/index.js';
import type { ToolContext } from '../src/tools/types.js';
import { testConfig } from './helpers.js';

const config = testConfig();

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { role: 'owner', senderHandle: '+18015550123', config, ...overrides };
}

/** A fetch stub that records every URL and init it was handed. */
function recordingFetch(respond: (url: string) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return respond(url);
  };
  return { calls, impl };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const text = JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { 'content-type': 'application/json', 'content-length': String(text.length), ...headers },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SIGNATURE IS THE SECURITY
// ─────────────────────────────────────────────────────────────────────────────

test('🔴 the method is GET, and there is no argument that changes it', async () => {
  const { calls, impl } = recordingFetch(() => json({ Items: [], TotalRecordCount: 0 }));
  const tool = makeHomelabRead(impl);
  // Every shape a caller could try to smuggle a method through.
  await tool.run({ service: 'sonarr', path: '/series', method: 'DELETE' }, ctx());
  await tool.run({ service: 'sonarr', path: '/series', query: { method: 'DELETE', _method: 'DELETE' } }, ctx());
  assert.equal(calls.length, 2);
  for (const c of calls) assert.equal(c.init?.method, 'GET');
});

test('🔴 the host comes from the enum — a path cannot name a different one', () => {
  for (const bad of ['http://evil.invalid/x', '//evil.invalid/x', '/x/../../http://evil.invalid']) {
    const plan = planRead('sonarr', bad, {}, config);
    assert.equal(plan.allowed, false, `${bad} was allowed`);
  }
  // CONTROL: the same gate lets a real path through, so the refusals above are
  // not just "everything is refused".
  const good = planRead('sonarr', '/series', {}, config);
  assert.equal(good.allowed, true);
  assert.ok(good.allowed && good.url.startsWith(config.sonarr.baseUrl));
});

test('🔴 the credential is chosen by code and is never the caller‘s to name', () => {
  const jf = planRead('jellyfin', '/System/Info', { api_key: 'not-mine' }, config);
  assert.ok(jf.allowed);
  assert.equal(jf.headers['X-Emby-Token'], config.jellyfin.apiKey);
  assert.equal(jf.headers['X-Api-Key'], undefined);

  const sonarr = planRead('sonarr', '/series', {}, config);
  assert.ok(sonarr.allowed);
  assert.equal(sonarr.headers['X-Api-Key'], config.sonarr.apiKey);
  assert.equal(sonarr.headers['X-Emby-Token'], undefined);
});

test('a path with a querystring in it is refused, and says to use `query`', () => {
  const plan = planRead('jellyfin', '/Search/Hints?searchTerm=x', {}, config);
  assert.equal(plan.allowed, false);
  assert.match(plan.allowed === false ? plan.reason : '', /query/i);
});

test('an unknown service is refused and names the ones that exist', () => {
  const plan = planRead('qbittorrent', '/api/v2/transfer/info', {}, config);
  assert.equal(plan.allowed, false);
  assert.match(plan.allowed === false ? plan.reason : '', /jellyfin, sonarr, radarr, prowlarr/);
});

test('a service whose credential is missing refuses BEFORE any request', async () => {
  const { calls, impl } = recordingFetch(() => json({}));
  const tool = makeHomelabRead(impl);
  const noKey = testConfig({ jellyfin: { baseUrl: 'http://jellyfin.test/jellyfin', apiKey: '' } });
  const res = await tool.run({ service: 'jellyfin', path: '/System/Info' }, ctx({ config: noKey }));
  assert.equal(res.ok, false);
  assert.match(res.content, /JELLYFIN_API_KEY/);
  assert.deepEqual(calls, [], 'a refused read must produce NO request at all');
});

test('query values are encoded, and arrays are joined with commas', () => {
  const plan = planRead(
    'jellyfin',
    '/Search/Hints',
    { searchTerm: 'Crystal Palace', fields: ['Overview', 'ChannelInfo'], limit: 20, recursive: true },
    config,
  );
  assert.ok(plan.allowed);
  assert.match(plan.url, /searchTerm=Crystal\+Palace/);
  assert.match(plan.url, /fields=Overview%2CChannelInfo/);
  assert.match(plan.url, /limit=20/);
  assert.match(plan.url, /recursive=true/);
});

test('a nested object in `query` is refused rather than sent as [object Object]', () => {
  const plan = planRead('sonarr', '/series', { filter: { nested: true } }, config);
  assert.equal(plan.allowed, false);
  assert.match(plan.allowed === false ? plan.reason : '', /query\.filter/);
});

// ─────────────────────────────────────────────────────────────────────────────
// THE DENYLIST — one case per member, each asserting the REASON, not merely
// that something refused. A test that only checks "it refused" stays green when
// a different check refuses for an unrelated reason.
// ─────────────────────────────────────────────────────────────────────────────

const DENIED: [string, string, RegExp][] = [
  ['jellyfin', '/LiveTv/Channels', /wedged Jellyfin site-wide/],
  ['jellyfin', '/LiveTv/Tuners', /wedged Jellyfin site-wide/],
  ['jellyfin', '/LiveTv/TunerHosts', /wedged Jellyfin site-wide/],
  ['jellyfin', '/LiveTv/ChannelMappings', /wedged Jellyfin site-wide/],
  ['jellyfin', '/LiveTv/ChannelMappingOptions', /wedged Jellyfin site-wide/],
  ['sonarr', '/release', /LIVE indexer search/],
  ['radarr', '/release', /LIVE indexer search/],
  ['prowlarr', '/api/v1/search', /LIVE indexer search/],
];

for (const [service, path, why] of DENIED) {
  test(`🔴 DENIED: ${service} ${path}`, () => {
    const plan = planRead(service, path, {}, config);
    assert.equal(plan.allowed, false, `${service} ${path} was ALLOWED`);
    assert.match(plan.allowed === false ? plan.reason : '', why, 'refused for the wrong reason');
  });
}

test('🔴 the denylist is case-insensitive and covers sub-paths', () => {
  for (const p of ['/livetv/channels', '/LIVETV/CHANNELS', '/LiveTv/Channels/abc123']) {
    assert.equal(planRead('jellyfin', p, {}, config).allowed, false, `${p} was allowed`);
  }
});

test('🔴 CONTROL: the reads the denylist must NOT block are allowed', () => {
  // If these ever start refusing, the denylist has swallowed the capability the
  // whole tool exists for — measured against Jellyfin's own log, none of them
  // produces a single tuner, HDHomerun, guide or stream line.
  for (const p of ['/LiveTv/Programs', '/LiveTv/GuideInfo', '/Search/Hints', '/LiveTv/Recordings']) {
    assert.equal(planRead('jellyfin', p, {}, config).allowed, true, `${p} was refused`);
  }
  assert.equal(planRead('sonarr', '/episode', {}, config).allowed, true);
  assert.equal(planRead('sonarr', '/wanted/missing', {}, config).allowed, true);
  // 🔴 The reason matching is by SEGMENT and not by raw prefix. `/releaseprofile`
  // is a harmless config read that a raw `/release` prefix would silently eat.
  assert.equal(planRead('sonarr', '/releaseprofile', {}, config).allowed, true);
  assert.equal(planRead('prowlarr', '/api/v1/indexerstatus', {}, config).allowed, true);
  assert.equal(planRead('radarr', '/movie/lookup/tmdb', {}, config).allowed, true);
});

test("🔴 the denylist is per-service: Sonarr's /release ban does not silence Jellyfin", () => {
  assert.equal(planRead('jellyfin', '/release', {}, config).allowed, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// THE BOUND — records and fields, never bytes, and it always says what it drops
// ─────────────────────────────────────────────────────────────────────────────

test('🔴 the header states how many of how many, even when nothing was dropped', () => {
  const out = renderRead([{ a: 1 }, { a: 2 }], { limit: 25, maxChars: 6000 });
  assert.match(out, /showing 2 of 2 record\(s\)/);
  assert.doesNotMatch(out, /NOT SHOWN/);
});

test("🔴 the SERVER's own total wins — a paged 20 of 1744 is never reported as 20 of 20", () => {
  const body = { records: Array.from({ length: 20 }, (_, i) => ({ id: i })), totalRecords: 1744 };
  const out = renderRead(body, { limit: 25, maxChars: 6000 });
  assert.match(out, /showing 20 of 1744 record\(s\)/);
  assert.match(out, /1724 NOT SHOWN/);
});

test('🔴 the output is always parseable JSON, no matter how tight the ceiling', () => {
  const body = Array.from({ length: 100 }, (_, i) => ({ id: i, blurb: 'x'.repeat(200) }));
  const out = renderRead(body, { limit: 100, maxChars: 900 });
  const payload = out.slice(out.indexOf('\n') + 1);
  // A byte clip would throw here. Dropping records cannot.
  const parsed = JSON.parse(payload);
  assert.ok(Array.isArray(parsed));
  assert.ok(parsed.length < 100, 'nothing was dropped, so the ceiling did not bind');
  assert.match(out, new RegExp(`showing ${parsed.length} of 100`));
  assert.match(out, /NOT SHOWN/);
});

test('🔴 /Sessions shape: field projection is what makes an oversized record readable', () => {
  // The measured live case — 5 sessions, 496 KB, almost all of it one key.
  const sessions = Array.from({ length: 5 }, (_, i) => ({
    UserName: `user${i}`,
    DeviceName: 'iPhone',
    NowPlayingItem: { Name: 'Silo S1E1' },
    NowPlayingQueueFullItems: Array.from({ length: 200 }, (_, j) => ({ Id: `${i}-${j}`, blob: 'y'.repeat(200) })),
  }));

  // Unprojected: one record alone blows the ceiling, so NOTHING is shown and the
  // shape is described instead — the alternative is half a record.
  const raw = renderRead(sessions, { limit: 25, maxChars: 2000 });
  assert.match(raw, /ONE record is larger than/);
  assert.match(raw, /NowPlayingQueueFullItems \(\d+ chars\)/);

  const projected = renderRead(sessions, {
    limit: 25,
    fields: ['UserName', 'NowPlayingItem'],
    maxChars: 2000,
  });
  assert.match(projected, /showing 5 of 5/);
  assert.match(projected, /Silo S1E1/);
  assert.doesNotMatch(projected, /NowPlayingQueueFullItems/);
});

test('🔴 a projection that matched NOTHING is called out, not rendered as empty records', () => {
  const out = renderRead([{ title: 'Fringe' }, { title: 'Silo' }], {
    limit: 25,
    fields: ['Name'],
    maxChars: 6000,
  });
  assert.match(out, /NONE of the requested fields exist/);
  assert.match(out, /Keys actually present: title/);
});

test('a single non-list object is rendered as one record', () => {
  const out = renderRead({ Version: '10.11.8', ServerName: 'hp' }, { limit: 25, maxChars: 6000 });
  assert.match(out, /showing 1 record \(not a list\)/);
  assert.match(out, /10\.11\.8/);
});

// ─────────────────────────────────────────────────────────────────────────────
// THE TOOL END TO END
// ─────────────────────────────────────────────────────────────────────────────

test('a happy read reports the URL it issued and the bound', async () => {
  const { calls, impl } = recordingFetch(() =>
    json({ SearchHints: [{ Name: 'PL: Everton v Crystal Palace', ChannelName: 'SKY 7' }], TotalRecordCount: 13 }),
  );
  const res = await makeHomelabRead(impl).run(
    { service: 'jellyfin', path: '/Search/Hints', query: { searchTerm: 'Crystal Palace' }, limit: 5 },
    ctx(),
  );
  assert.equal(res.ok, true);
  assert.match(res.content, /GET http:\/\/jellyfin\.test\/jellyfin\/Search\/Hints\?searchTerm=Crystal\+Palace/);
  assert.match(res.content, /showing 1 of 13 record\(s\)/);
  assert.equal(calls[0]?.init?.method, 'GET');
});

test('🔴 HTTP 200 with HTML is reported as a WRONG BASE URL, not as data and not as an outage', async () => {
  const { impl } = recordingFetch(
    () => new Response('<!doctype html><html><body>app</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  );
  const res = await makeHomelabRead(impl).run({ service: 'prowlarr', path: '/api/v1/indexerstatus' }, ctx());
  assert.equal(res.ok, false);
  assert.match(res.content, /NOT JSON/);
  assert.match(res.content, /wrong base URL/);
  assert.match(res.content, /UNKNOWN/);
});

test('an HTTP error is a failure with the status, never an empty result', async () => {
  const { impl } = recordingFetch(() => new Response('{"detail":"nope"}', { status: 401 }));
  const res = await makeHomelabRead(impl).run({ service: 'sonarr', path: '/series' }, ctx());
  assert.equal(res.ok, false);
  assert.match(res.content, /HTTP 401/);
});

test('an unreachable service is UNKNOWN, not "nothing found"', async () => {
  const impl = async () => {
    throw new Error('connect ECONNREFUSED');
  };
  const res = await makeHomelabRead(impl).run({ service: 'radarr', path: '/movie' }, ctx());
  assert.equal(res.ok, false);
  assert.match(res.content, /UNKNOWN, not an empty result/);
});

test('a DECLARED oversize content-length is refused before the body is read at all', async () => {
  const impl = async () =>
    new Response('x'.repeat(10), { status: 200, headers: { 'content-length': '13455324' } });
  const res = await makeHomelabRead(impl).run({ service: 'jellyfin', path: '/LiveTv/Programs' }, ctx());
  assert.equal(res.ok, false);
  assert.match(res.content, /13,455,324 bytes/);
  assert.match(res.content, /NOT read/);
  assert.match(res.content, /minStartDate/);
});

test('🔴 an UNDECLARED oversize body is cut off mid-stream, not buffered and then refused', async () => {
  /**
   * The live case, and the one the content-length check misses: Jellyfin chunks
   * `/LiveTv/Programs`, so it arrives with NO content-length. Measured
   * 92,968,348 bytes. Before this, the tool buffered all of it and refused 15.8 s
   * later — a cap that can only be applied after the read is not a cap.
   */
  let produced = 0;
  let cancelled = false;
  const chunk = new TextEncoder().encode('x'.repeat(100_000));
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      produced += chunk.byteLength;
      // Far more than the ceiling: if the reader does not stop, this does not end.
      if (produced > 200_000_000) return controller.close();
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  const impl = async () => new Response(body, { status: 200 });
  const res = await makeHomelabRead(impl).run({ service: 'jellyfin', path: '/LiveTv/Programs' }, ctx());

  assert.equal(res.ok, false);
  assert.match(res.content, /exceeded the 4,000,000-byte ceiling/);
  assert.match(res.content, /Nothing is shown, rather than part of it/);
  assert.ok(cancelled, 'the transfer must be cancelled, not drained');
  assert.ok(
    produced < 10_000_000,
    `read ${produced} bytes past a 4,000,000-byte ceiling — it buffered instead of stopping`,
  );
});

test('CONTROL: a body just UNDER the ceiling streams through intact', async () => {
  const payload = JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({ id: i, pad: 'y'.repeat(100) })));
  assert.ok(payload.length > 100_000 && payload.length < 4_000_000);
  const impl = async () => new Response(payload, { status: 200 });
  const res = await makeHomelabRead(impl).run({ service: 'sonarr', path: '/series', limit: 2 }, ctx());
  assert.equal(res.ok, true, 'the ceiling fired on a body that fits — the refusal above proves nothing');
  assert.match(res.content, /showing 2 of 1000/);
});

test('`limit` is clamped and never sent to the server', async () => {
  const { calls, impl } = recordingFetch(() => json(Array.from({ length: 300 }, (_, i) => ({ i }))));
  const res = await makeHomelabRead(impl).run({ service: 'sonarr', path: '/series', limit: 9999 }, ctx());
  assert.equal(res.ok, true);
  assert.match(res.content, /showing 200 of 300/);
  assert.doesNotMatch(calls[0]?.url ?? '', /limit/, '`limit` bounds the OUTPUT and must not become a query param');
});

// ─────────────────────────────────────────────────────────────────────────────
// REGISTRY
// ─────────────────────────────────────────────────────────────────────────────

test('🔴 homelab_read is OWNER-ONLY and invisible to guests', () => {
  const tools = buildTools(testConfig({ readOnly: false }), { safe: true, reason: 't', evidence: [] });
  const guest = toolsForRole(tools, 'guest').map((t) => t.name);
  const owner = toolsForRole(tools, 'owner').map((t) => t.name);
  assert.ok(owner.includes('homelab_read'));
  assert.ok(!guest.includes('homelab_read'), 'a generic GET across the media stack is not a guest capability');
  assert.ok(owner.includes('channel_health'));
  assert.ok(!guest.includes('channel_health'));
});

test('🔴 homelab_status STAYS — it is the only health tool a guest can reach', () => {
  const tools = buildTools(testConfig({ readOnly: false }), { safe: true, reason: 't', evidence: [] });
  const guest = toolsForRole(tools, 'guest').map((t) => t.name);
  assert.ok(
    guest.includes('homelab_status'),
    'retiring it under an OWNER-only generic read is a capability loss for every guest, not a cleanup',
  );
});

test('🔴 NOTHING was retired: every tool that existed before still exists', () => {
  const names = new Set(ALL_TOOLS.map((t) => t.name));
  for (const n of [
    'homelab_status',
    'livetv_status',
    'jellyfin_sessions',
    'library_search',
    'catalogue_search',
    'check_status',
    'find_gaps',
    'search_episode',
    'docker_ps',
    'docker_inspect',
    'docker_logs',
    'container_netns',
    'hp_shell',
  ]) {
    assert.ok(names.has(n), `${n} has gone missing`);
  }
});

test('the read tool declares itself a read, and the service enum matches the module', () => {
  const tool = makeHomelabRead();
  assert.equal(tool.writes, false);
  assert.equal(tool.minRole, 'owner');
  const props = tool.parameters as { properties: { service: { enum: string[] } } };
  assert.deepEqual(props.properties.service.enum, READ_SERVICES);
});

test('🔴 the cheatsheet carries all four measured traps — this is the acceptance surface', () => {
  const d = makeHomelabRead().description;
  assert.match(d, /SILENTLY IGNORES searchTerm/, 'trap 1: the searchTerm no-op');
  assert.match(d, /ALSO ignores minStartDate/, 'trap 2: hints ignores the date filter');
  assert.match(d, /HIT IS USUALLY A REPLAY/, 'trap 3: replays, with no structured flag');
  assert.match(d, /GUIDE IS ABOUT 4 DAYS DEEP/, 'trap 4: the guide is shallower than it claims');
  assert.match(d, /fields=Overview,ChannelInfo/, 'the model needs the route to the prose marker');
  assert.match(d, /Search\/Hints/, 'and the endpoint that actually filters');
});
