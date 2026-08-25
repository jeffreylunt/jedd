import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  planRead,
  personVerdict,
  renderRead,
  secretVerdict,
  stripCredentials,
  READ_SERVICES,
} from '../src/homelab-read.js';
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
  // 🔴 Each case asserts WHICH guard refused. Asserting only `allowed === false`
  // let a deleted guard stay green because a different check covered for it —
  // measured on this very file, and it is why the `..` guard below is gone in
  // favour of a structural containment check.
  const cases: [string, RegExp][] = [
    // Refused one guard earlier, and the message says so — which is the point of
    // asserting the reason rather than the verdict.
    ['http://evil.invalid/x', /must start with "\/"/],
    ['//evil.invalid/x', /may not name a host/],
    ['/x/http://evil.invalid', /may not name a host/],
  ];
  for (const [bad, why] of cases) {
    const plan = planRead('sonarr', bad, {}, config, 'owner');
    assert.equal(plan.allowed, false, `${bad} was allowed`);
    assert.match(plan.allowed === false ? plan.reason : '', why, `${bad} refused for the wrong reason`);
  }
  // CONTROL: the same gate lets a real path through, so the refusals above are
  // not just "everything is refused".
  const good = planRead('sonarr', '/series', {}, config, 'owner');
  assert.equal(good.allowed, true);
  assert.ok(good.allowed && good.url.startsWith(config.sonarr.baseUrl));
});

/**
 * 🔴 THE BYPASS THAT SHIPPED, AND EVERY SPELLING OF IT.
 *
 * Every one of these was ALLOWED by the first version and reached the endpoint
 * the tool exists to keep it away from — reproduced against the live gate before
 * the fix. The denylist matched the string the caller typed; `fetch` sends the
 * string the WHATWG URL parser produces, and the two are not required to be the
 * same string. Dot-segments and percent-escapes are the two ways they diverge.
 */
const BYPASSES: [string, string, string][] = [
  ['jellyfin', '/./LiveTv/Channels', 'dot segment at the front'],
  ['jellyfin', '/LiveTv/./Channels', 'dot segment in the middle'],
  ['jellyfin', '/LiveTv/x/../Channels', 'double-dot segment'],
  ['jellyfin', '/%2e/LiveTv/Channels', 'percent-encoded dot segment'],
  ['jellyfin', '/LiveTv/%43hannels', 'percent-encoded letter — the server decodes it'],
  ['jellyfin', '/Live%54v/Channels', 'percent-encoded letter, other half'],
  ['sonarr', '/./release', 'dot segment before an indexer search'],
  ['sonarr', '/%72elease', 'percent-encoded letter before an indexer search'],
  ['prowlarr', '/api/v1/./search', 'dot segment before the 20.9s indexer search'],
  ['prowlarr', '/api/v1/%73earch', 'percent-encoded letter, same'],
];

for (const [service, path, how] of BYPASSES) {
  test(`🔴 BYPASS CLOSED (${how}): ${service} ${path}`, () => {
    const plan = planRead(service, path, {}, config, 'owner');
    assert.equal(plan.allowed, false, `${service} ${path} reached a denied endpoint`);
  });
}

test('🔴 a path cannot climb out of the API prefix while keeping the API key', () => {
  // `/sonarr/api/v3/../../../release` normalises to `/release` — off the API and
  // still authenticated. The containment check is what makes that impossible;
  // no string pattern is involved.
  const plan = planRead('sonarr', '/../../../release', {}, config, 'owner');
  assert.equal(plan.allowed, false);
  assert.match(plan.allowed === false ? plan.reason : '', /escapes Sonarr's API prefix/);
});

test('🔴 CONTROL: harmless dot-free paths still resolve, and normalisation is visible', () => {
  const plan = planRead('sonarr', '/episode', { seriesId: 80, seasonNumber: 2 }, config, 'owner');
  assert.ok(plan.allowed);
  // The exact read V1 could not express — the whole reason this tool exists.
  assert.equal(plan.url, `${config.sonarr.baseUrl}/episode?seriesId=80&seasonNumber=2`);
});

test('🔴 a path character outside the allowed set is refused, and the character is named', () => {
  // Nothing else in the gate looks at these, so this test is the ONLY thing
  // holding PATH_CHARS in place. It had no coverage at all before.
  for (const [bad, ch] of [
    ['/Live Tv/Programs', ' '],
    ['/series%20x', '%'],
    ['/series\\x', '\\'],
    ['/séries', 'é'],
  ] as [string, string][]) {
    const plan = planRead('sonarr', bad, {}, config, 'owner');
    assert.equal(plan.allowed, false, `${bad} was allowed`);
    const reason = plan.allowed === false ? plan.reason : '';
    assert.match(reason, /character I will not send/, bad);
    assert.ok(reason.includes(JSON.stringify(ch)), `did not name ${JSON.stringify(ch)} in: ${reason}`);
  }
});

test('🔴 the credential is chosen by code and is never the caller‘s to name', () => {
  const jf = planRead('jellyfin', '/System/Info', {}, config, 'owner');
  assert.ok(jf.allowed);
  assert.equal(jf.headers['X-Emby-Token'], config.jellyfin.apiKey);
  assert.equal(jf.headers['X-Api-Key'], undefined);

  const sonarr = planRead('sonarr', '/series', {}, config, 'owner');
  assert.ok(sonarr.allowed);
  assert.equal(sonarr.headers['X-Api-Key'], config.sonarr.apiKey);
  assert.equal(sonarr.headers['X-Emby-Token'], undefined);

  /**
   * 🔴 …AND `query` IS PART OF THE REQUEST TOO.
   *
   * Jellyfin honours `?api_key=` and the arrs honour `?apikey=`, so a title
   * about "the credential is chosen by code" that only inspected HEADERS was
   * true of the wrong object. It also put a caller-supplied secret-shaped string
   * into the transcript, because the tool echoes the URL it issued.
   */
  for (const key of ['api_key', 'apikey', 'API_KEY', 'token', 'X-Emby-Token']) {
    const plan = planRead('jellyfin', '/System/Info', { [key]: 'not-mine' }, config, 'owner');
    assert.equal(plan.allowed, false, `query.${key} was accepted`);
    assert.match(plan.allowed === false ? plan.reason : '', /names a credential/);
  }
});

test('a path with a querystring in it is refused, and says to use `query`', () => {
  const plan = planRead('jellyfin', '/Search/Hints?searchTerm=x', {}, config, 'owner');
  assert.equal(plan.allowed, false);
  assert.match(plan.allowed === false ? plan.reason : '', /query/i);
});

test('an unknown service is refused and names the ones that exist', () => {
  const plan = planRead('qbittorrent', '/api/v2/transfer/info', {}, config, 'owner');
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
    'owner',
  );
  assert.ok(plan.allowed);
  assert.match(plan.url, /searchTerm=Crystal\+Palace/);
  assert.match(plan.url, /fields=Overview%2CChannelInfo/);
  assert.match(plan.url, /limit=20/);
  assert.match(plan.url, /recursive=true/);
});

test('a nested object in `query` is refused rather than sent as [object Object]', () => {
  const plan = planRead('sonarr', '/series', { filter: { nested: true } }, config, 'owner');
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
    const plan = planRead(service, path, {}, config, 'owner');
    assert.equal(plan.allowed, false, `${service} ${path} was ALLOWED`);
    assert.match(plan.allowed === false ? plan.reason : '', why, 'refused for the wrong reason');
  });
}

test('🔴 the denylist is case-insensitive and covers sub-paths', () => {
  for (const p of ['/livetv/channels', '/LIVETV/CHANNELS', '/LiveTv/Channels/abc123']) {
    const plan = planRead('jellyfin', p, {}, config, 'owner');
    assert.equal(plan.allowed, false, `${p} was allowed`);
    // The REASON, so "refused for some other reason" cannot read as
    // "case-insensitive matching works".
    assert.match(plan.allowed === false ? plan.reason : '', /wedged Jellyfin site-wide/, p);
  }
});

test('🔴 CONTROL: the reads the denylist must NOT block are allowed', () => {
  // If these ever start refusing, the denylist has swallowed the capability the
  // whole tool exists for — measured against Jellyfin's own log, none of them
  // produces a single tuner, HDHomerun, guide or stream line.
  for (const p of ['/LiveTv/Programs', '/LiveTv/GuideInfo', '/Search/Hints', '/LiveTv/Recordings']) {
    assert.equal(planRead('jellyfin', p, {}, config, 'owner').allowed, true, `${p} was refused`);
  }
  assert.equal(planRead('sonarr', '/episode', {}, config, 'owner').allowed, true);
  assert.equal(planRead('sonarr', '/wanted/missing', {}, config, 'owner').allowed, true);
  // 🔴 The reason matching is by SEGMENT and not by raw prefix. `/releaseprofile`
  // is a harmless config read that a raw `/release` prefix would silently eat.
  assert.equal(planRead('sonarr', '/releaseprofile', {}, config, 'owner').allowed, true);
  assert.equal(planRead('prowlarr', '/api/v1/indexerstatus', {}, config, 'owner').allowed, true);
  assert.equal(planRead('radarr', '/movie/lookup/tmdb', {}, config, 'owner').allowed, true);
});

test("🔴 the denylist is per-service: Sonarr's /release ban does not silence Jellyfin", () => {
  assert.equal(planRead('jellyfin', '/release', {}, config, 'owner').allowed, true);
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
  // 🔴 AND THE HEADER MUST AGREE WITH THE BODY. It said "showing 1 of 5" over a
  // paragraph that shows none — a count we did not deliver, which is the same
  // species of claim as a silent truncation.
  assert.match(raw, /showing 0 of 5 record\(s\)/);
  assert.doesNotMatch(raw, /showing 1 of 5/);

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

test('🔴 every result states the time it was read — the model has no other clock', async () => {
  /**
   * On the first live turn the model spent FOUR tool calls hunting for the
   * current time (`date` is refused by the command gate, an outbound time API is
   * unreachable), then hedged its answer and called an already-aired broadcast
   * "live". Two of the four traps in the description say "compare StartDate
   * against now yourself", so an instruction it cannot execute is a trap we
   * built.
   */
  const { impl } = recordingFetch(() => json({ SearchHints: [{ Name: 'x' }], TotalRecordCount: 1 }));
  const before = Date.now();
  const res = await makeHomelabRead(impl).run({ service: 'jellyfin', path: '/Search/Hints' }, ctx());
  const stamped = /read at (\S+) —/.exec(res.content)?.[1];
  assert.ok(stamped, `no read-time in: ${res.content.slice(0, 200)}`);
  const t = Date.parse(stamped);
  assert.ok(t >= before - 1000 && t <= Date.now() + 1000, `read-time ${stamped} is not now`);
  // And the description must point at it, or the model will still go hunting.
  assert.match(makeHomelabRead().description, /states the time it was read/);
});

test('🔴 records with a StartDate and no Overview say the replay question is unanswered', async () => {
  const { impl } = recordingFetch(() =>
    json({
      SearchHints: [
        { Name: 'PL: Everton v Crystal Palace', ChannelId: 'abc', StartDate: '2026-08-25T22:00:00Z' },
      ],
      TotalRecordCount: 1,
    }),
  );
  const res = await makeHomelabRead(impl).run({ service: 'jellyfin', path: '/Search/Hints' }, ctx());
  assert.equal(res.ok, true);
  assert.match(res.content, /NO Overview, so you cannot yet tell a live fixture from a replay/);
  assert.match(res.content, /fields=Overview,ChannelInfo/);
});

test('CONTROL: once Overview IS present the note is gone, so it is not printed unconditionally', async () => {
  const { impl } = recordingFetch(() =>
    json({
      Items: [
        {
          Name: 'PL: Everton v Crystal Palace',
          StartDate: '2026-08-25T22:00:00Z',
          Overview: 'Coverage from Match Week 1 of the Premier League.',
        },
      ],
      TotalRecordCount: 1,
    }),
  );
  const res = await makeHomelabRead(impl).run({ service: 'jellyfin', path: '/LiveTv/Programs' }, ctx());
  assert.doesNotMatch(res.content, /cannot yet tell a live fixture/);
});

test('CONTROL: records with no StartDate at all are not live TV and get no note', async () => {
  const { impl } = recordingFetch(() => json([{ title: 'Fringe', id: 1 }]));
  const res = await makeHomelabRead(impl).run({ service: 'sonarr', path: '/series' }, ctx());
  assert.doesNotMatch(res.content, /cannot yet tell a live fixture/);
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

test('🔴 homelab_read reaches GUESTS; channel_health stays owner-only', () => {
  /**
   * ⚠️ This test asserted the OPPOSITE until 2026-08-25. Jeff overruled the
   * owner-only reading: "All users should have read access to everything in the
   * library, etc, but not other users information or server secrets." The gate
   * moved from WHO IS ASKING to WHAT THE DATA IS ABOUT — see the tier tests.
   *
   * `channel_health` is unchanged: it runs ssh commands on hp, which is not a
   * capability the data-class rule covers.
   */
  const tools = buildTools(testConfig({ readOnly: false }), { safe: true, reason: 't', evidence: [] });
  const guest = toolsForRole(tools, 'guest').map((t) => t.name);
  const owner = toolsForRole(tools, 'owner').map((t) => t.name);
  assert.ok(guest.includes('homelab_read'));
  assert.ok(owner.includes('homelab_read'));
  assert.ok(owner.includes('channel_health'));
  assert.ok(!guest.includes('channel_health'), 'channel_health shells into hp; that is not a guest capability');
});

test('🔴 ONLY homelab_status retired — nothing else went with it', () => {
  const names = new Set(ALL_TOOLS.map((t) => t.name));
  assert.ok(
    !names.has('homelab_status'),
    'homelab_status was retired deliberately once a guest could ask whether the server is up',
  );
  // 🔴 Everything else. A retirement is a decision; a retirement nobody noticed
  // is a regression, and `assertNamedProducersExist` only catches the ones some
  // other tool happens to NAME.
  for (const n of [
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
  assert.equal(tool.minRole, 'guest');
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

// ─────────────────────────────────────────────────────────────────────────────
// THREE TIERS: CONTENT everyone · PERSON owner · SECRET nobody
//
// Jeff, 2026-08-25: "All users should have read access to everything in the
// library, etc, but not other users information or server secrets" and "Owner
// can ask about all information, but not secrets or keys since we don't want
// them in message logs."
// ─────────────────────────────────────────────────────────────────────────────

/** Every SECRET path, with the measurement that put it on the list. */
const SECRET_PATHS: [string, string, string][] = [
  ['sonarr', '/config/host', 'MEASURED: password 44ch + apiKey 32ch on a plain GET'],
  ['radarr', '/config/host', 'MEASURED: same shape as Sonarr'],
  ['sonarr', '/config', 'the whole config subtree'],
  ['sonarr', '/downloadclient', 'MEASURED: password inside fields[]'],
  ['sonarr', '/indexer', 'MEASURED: 4 populated apiKey values in fields[]'],
  ['radarr', '/indexer', 'MEASURED: 3 populated apiKey values in fields[]'],
  ['prowlarr', '/api/v1/indexer', 'clean TODAY only because every indexer is a public tracker'],
  ['prowlarr', '/api/v1/applications', "MEASURED: 2 apiKeys — Sonarr's and Radarr's own"],
  ['prowlarr', '/api/v1/config/host', 'Prowlarr has no path prefix, so its secrets sit under /api/v1'],
  ['sonarr', '/notification', 'webhook URLs and tokens'],
  ['sonarr', '/importlist', 'credentials for the services it pulls from'],
  ['sonarr', '/system/backup', 'a backup is the whole config database'],
  ['jellyfin', '/Auth/Keys', '🔴 MEASURED: four live 32-character AccessTokens, plaintext'],
  ['jellyfin', '/System/Configuration', 'the server config surface'],
  ['jellyfin', '/Plugins', 'plugin config holds the IPTV provider login'],
  ['jellyfin', '/System/Logs', 'logs quote request URLs, which carry tokens'],
  ['jellyfin', '/LiveTv/ListingProviders', 'stores the IPTV username and password'],
  ['jellyfin', '/QuickConnect/Initiate', 'an authentication flow'],
];

for (const [service, path, why] of SECRET_PATHS) {
  test(`🔴 SECRET denied to BOTH roles: ${service} ${path} — ${why}`, () => {
    for (const role of ['guest', 'owner'] as const) {
      const plan = planRead(service, path, {}, config, role);
      assert.equal(plan.allowed, false, `${service} ${path} was ALLOWED to ${role}`);
      assert.match(plan.allowed === false ? plan.reason : '', /REFUSED — SECRET/, `${service} ${path} as ${role}`);
    }
  });
}

test('🔴 secretVerdict TAKES NO ROLE — the guarantee is the signature, not a check inside it', () => {
  /**
   * A role-gated denial can be defeated by a role bug, a spoofed handle, or a
   * refactor of who counts as owner. This one cannot: there is no role in scope
   * to make an exception for. If someone adds a third parameter, this fails and
   * that is the intended answer.
   */
  assert.equal(
    secretVerdict.length,
    2,
    'secretVerdict must take exactly (service, routed). A role parameter here is the bug.',
  );
  assert.ok(secretVerdict('sonarr', '/config/host'));
  assert.equal(secretVerdict('sonarr', '/series'), null);
});

test('🔴 the SECRET refusal says it applies to the owner too, so nobody goes looking for a way round', () => {
  const plan = planRead('sonarr', '/config/host', {}, config, 'owner');
  assert.equal(plan.allowed, false);
  const reason = plan.allowed === false ? plan.reason : '';
  assert.match(reason, /denied to EVERYONE, including the owner/);
  assert.match(reason, /message thread, the conversation history and the log file/);
  assert.match(reason, /no role that can read it and no flag that turns this off/);
});

/** PERSON — the owner may, a guest may not. Both halves asserted, always. */
const PERSON_PATHS: [string, string][] = [
  ['jellyfin', '/Sessions'],
  ['jellyfin', '/Users'],
  ['jellyfin', '/Users/abc123/Items'],
  ['jellyfin', '/Users/Public'],
  ['jellyfin', '/Devices'],
  ['jellyfin', '/System/ActivityLog/Entries'],
  ['jellyfin', '/user_usage_stats/user_activity'],
];

for (const [service, path] of PERSON_PATHS) {
  test(`🔴 PERSON: ${service} ${path} — denied to a guest, ALLOWED to the owner`, () => {
    const asGuest = planRead(service, path, {}, config, 'guest');
    assert.equal(asGuest.allowed, false, `${path} leaked to a guest`);
    assert.match(asGuest.allowed === false ? asGuest.reason : '', /REFUSED — PERSONAL/);

    // 🔴 The other half. Without it, a path denied for an unrelated reason
    // (typo, wrong service) reads as "the person tier works".
    const asOwner = planRead(service, path, {}, config, 'owner');
    assert.equal(asOwner.allowed, true, `${path} was refused to the OWNER, who is allowed it`);
  });
}

test('🔴 CONTENT is open to a GUEST — the tier is about the data, not about who is asking', () => {
  for (const [service, path] of [
    ['jellyfin', '/Items'],
    ['jellyfin', '/Items/Counts'],
    ['jellyfin', '/Search/Hints'],
    ['jellyfin', '/LiveTv/Programs'],
    ['jellyfin', '/LiveTv/GuideInfo'],
    ['jellyfin', '/System/Info/Public'],
    ['jellyfin', '/Persons'], // 🔴 CAST MEMBERS, not users. Must not be caught by /users.
    ['sonarr', '/series'],
    ['sonarr', '/episode'],
    ['sonarr', '/queue'],
    ['sonarr', '/wanted/missing'],
    ['sonarr', '/history'], // decided: no requester field over 30 real rows, so it is content
    ['sonarr', '/calendar'],
    ['prowlarr', '/api/v1/indexerstatus'], // indexer HEALTH survives the /indexer ban
    ['prowlarr', '/api/v1/indexerstats'],
  ] as [string, string][]) {
    const plan = planRead(service, path, {}, config, 'guest');
    assert.equal(plan.allowed, true, `${service} ${path} was refused to a guest: ${plan.allowed === false ? plan.reason : ''}`);
  }
});

test('🔴 the /indexer ban does NOT eat indexer health — that is why matching is by segment', () => {
  assert.equal(planRead('prowlarr', '/api/v1/indexer', {}, config, 'owner').allowed, false);
  assert.equal(planRead('prowlarr', '/api/v1/indexerstatus', {}, config, 'guest').allowed, true);
  assert.equal(planRead('prowlarr', '/api/v1/indexerstats', {}, config, 'guest').allowed, true);
  assert.equal(planRead('sonarr', '/releaseprofile', {}, config, 'guest').allowed, true);
});

test('🔴 a SECRET path is not reachable by dot-segment or percent-escape either', () => {
  for (const p of ['/./config/host', '/config/./host', '/x/../config/host', '/%2e/config/host', '/%63onfig/host']) {
    for (const role of ['guest', 'owner'] as const) {
      assert.equal(planRead('sonarr', p, {}, config, role).allowed, false, `${p} reached a secret as ${role}`);
    }
  }
});

test('the tool is GUEST-level now, and homelab_status is gone', () => {
  const tools = buildTools(testConfig({ readOnly: false }), { safe: true, reason: 't', evidence: [] });
  const guest = toolsForRole(tools, 'guest').map((t) => t.name);
  assert.ok(guest.includes('homelab_read'), 'Jeff overruled owner-only: everyone reads the library');
  assert.ok(!guest.includes('channel_health'), 'channel_health stays owner-only');
  assert.ok(
    !tools.map((t) => t.name).includes('homelab_status'),
    'homelab_status retired once a guest could ask whether the server is up',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// THE SECOND GUARD — the stripper. Independent of the denylist, on purpose.
// ─────────────────────────────────────────────────────────────────────────────

test('🔴 credential-named fields are redacted, recursively, and REPORTED', () => {
  const { value, redacted } = stripCredentials({
    a: { b: [{ apiKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'Sonarr' }] },
    password: 'hunter2',
  });
  const json = JSON.stringify(value);
  assert.doesNotMatch(json, /aaaaaaaa/, 'the apiKey survived');
  assert.doesNotMatch(json, /hunter2/, 'the password survived');
  assert.match(json, /Sonarr/, 'a harmless neighbouring field was destroyed');
  assert.deepEqual(redacted, ['apiKey', 'password']);
});

test('🔴 the {name,value} PAIR — the shape a key-name walker cannot see', () => {
  /**
   * The arrs store connection settings as fields:[{name,value}]. The KEY is
   * `value`; the credential's NAME is data. My own first probe of the live
   * servers reported /downloadclient as clean for exactly this reason — and it
   * is not, it carries a populated password.
   */
  const body = [
    {
      name: 'qBittorrent',
      fields: [
        { name: 'host', value: '172.20.0.1' },
        { name: 'password', value: 'realpassword' },
        { name: 'apiKey', value: 'realkey' },
      ],
    },
  ];
  const { value, redacted } = stripCredentials(body);
  const json = JSON.stringify(value);
  assert.doesNotMatch(json, /realpassword/);
  assert.doesNotMatch(json, /realkey/);
  assert.match(json, /172\.20\.0\.1/, 'the host field must survive — it is diagnostic');
  assert.deepEqual(redacted, ['apiKey', 'password']);
});

test('🔴 a credential in a URL VALUE is scrubbed — no field name would ever flag it', () => {
  // /history looks like pure content, and for a private tracker the downloadUrl
  // it records carries a passkey in its querystring. This is the case that
  // proves a path denylist alone is not enough.
  const { value, redacted } = stripCredentials({
    downloadUrl: 'https://tracker.invalid/rss?uid=12&passkey=SECRETVALUE123&cat=tv',
  });
  const json = JSON.stringify(value);
  assert.doesNotMatch(json, /SECRETVALUE123/);
  assert.match(json, /uid=12/, 'the rest of the URL is diagnostic and must survive');
  assert.match(json, /cat=tv/);
  assert.deepEqual(redacted, ['passkey (in a URL)']);
});

test('🔴 EXACT names only — substring matching redacts the diagnostics', () => {
  /**
   * Measured against the live servers: a `key|pass|token|auth` substring match
   * flagged packageAuthor (a person's name), authenticationMethod ("forms"),
   * proxyBypassLocalAddresses, HasPassword and HasConfiguredPassword. Every one
   * harmless and useful. A stripper that redacts those teaches everyone to
   * ignore [REDACTED].
   */
  const benign = {
    packageAuthor: 'Team Sonarr',
    authenticationMethod: 'forms',
    authenticationRequired: 'enabled',
    proxyBypassLocalAddresses: true,
    HasPassword: true,
    HasConfiguredPassword: true,
    PasswordResetProviderId: 'Jellyfin.Server.Implementations.Users.DefaultPasswordResetProvider',
  };
  const { value, redacted } = stripCredentials(benign);
  assert.deepEqual(redacted, [], `over-redacted: ${redacted.join(', ')}`);
  assert.deepEqual(value, benign);
});

test('🔴 redaction REPLACES rather than deletes — a removed field reads as an empty one', () => {
  const { value } = stripCredentials({ apiKey: 'aaaa' });
  assert.ok('apiKey' in (value as object), 'the key vanished, which reads as "there was nothing there"');
  assert.match(JSON.stringify(value), /REDACTED/);
});

test('an absent or empty credential field is not reported as redacted', () => {
  const { redacted } = stripCredentials({ apiKey: '', password: null, token: undefined, title: 'Fringe' });
  assert.deepEqual(redacted, []);
});

test('the stripper terminates on deeply nested input', () => {
  let deep: unknown = { apiKey: 'aaaa' };
  for (let i = 0; i < 200; i++) deep = { nested: deep };
  assert.doesNotThrow(() => stripCredentials(deep));
});

test('🔴 the stripper runs on EVERY response, including an allowed CONTENT path, for the OWNER', () => {
  // The two guards are independent. This asserts the second one fires where the
  // first does not — which is the entire reason it exists.
  const { impl } = recordingFetch(() =>
    json([{ title: 'Fringe', downloadUrl: 'https://t.invalid/rss?passkey=LEAKED123' }]),
  );
  return makeHomelabRead(impl)
    .run({ service: 'sonarr', path: '/history' }, ctx({ role: 'owner' }))
    .then((res) => {
      assert.equal(res.ok, true, '/history is CONTENT and must stay readable');
      assert.doesNotMatch(res.content, /LEAKED123/, 'a credential reached the transcript');
      assert.match(res.content, /REDACTED before you saw it: passkey \(in a URL\)/);
      assert.match(res.content, /removed for everyone including Jeff/);
    });
});
