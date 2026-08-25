import type { Config } from './config.js';

/**
 * THE GENERIC READ — the gate and the bound, as pure functions.
 *
 * ── 🔴 WHY THIS FILE LOOKS NOTHING LIKE `command-gate.ts` ────────────────────
 *
 * `command-gate.ts` parses a shell string character by character, unpicking
 * flag clusters and quoting, because **the model composes the command text
 * there** and the only defence is to read what it wrote. That fight is
 * unwinnable in principle and merely survivable in practice.
 *
 * Here the model composes NOTHING that reaches a transport. It names a
 * `service` from a closed enum, a `path`, and a `query` object. So:
 *
 *  - **The method is GET by construction.** It is a literal in the fetch call.
 *    There is no argument that can make it anything else, so no write endpoint
 *    is reachable no matter what path is passed — `DELETE /series/{id}` is not
 *    "blocked", it is unrepresentable.
 *  - **The host is allowlisted by construction.** The base URL comes from
 *    `config`, selected by the enum. A path cannot name a host, and the two
 *    forms that could — a scheme (`http://…`) and a protocol-relative `//host` —
 *    are refused below rather than being relied on to fail harmlessly.
 *  - **The credential is chosen by code**, never named by the caller. There is
 *    no way to point Jellyfin's token at somebody else's server.
 *
 * **Do not add a `method` parameter. Do not add a `url` parameter.** Both convert
 * this file from a lookup table into a parser, and the parser is the thing we
 * are deliberately not building.
 */

export type ReadService = 'jellyfin' | 'sonarr' | 'radarr' | 'prowlarr';

/**
 * 🔴 WHY THIS ENUM IS FOUR AND NOT SEVEN. Measured 2026-08-25, not assumed.
 *
 * The survey's rule is *"generic GET is right where the API is uniform and
 * honest"*. Two homelab services are neither, and half-adding them would ship a
 * capability that fails after the model has offered it:
 *
 *  - **qBittorrent is EXCLUDED because its configured base URL is an hp-SIDE
 *    address.** `config.qbittorrent.baseUrl` is `172.20.0.1:8080`, the docker
 *    bridge gateway, and every existing qbit tool reaches it by `curl` running
 *    ON hp. V2 runs on the Mac: measured today, a direct fetch to the bridge
 *    address times out (000) while `192.168.1.7:8080` answers 200 in 261 bytes.
 *    So this needs a SECOND url for a second transport, and inventing one gives
 *    the same host two sources of truth. `diagnose_host_contention` already
 *    reads what matters there. Raise it as a decision; do not guess it here.
 *  - **Dispatcharr is EXCLUDED because its API is closed to us.** Everything
 *    except `/api/core/version/` (37 B, already reported by `livetv_status`)
 *    returns 401, and the one open read, `/output/epg`, is 10.3 MB of XML.
 *    `channel_health` gets that data from its database instead.
 */
interface ServiceSpec {
  label: string;
  baseUrl(config: Config): string;
  /** The credential header, chosen by code. Empty when the service needs none. */
  auth(config: Config): Record<string, string>;
  /** Present when the service cannot be read at all, e.g. no API key configured. */
  unconfigured(config: Config): string | null;
  denied: DeniedPath[];
}

interface DeniedPath {
  /** Lower-cased path prefix. Matched against the lower-cased request path. */
  prefix: string;
  why: string;
}

/**
 * 🔴 A DENYLIST, NOT AN ALLOWLIST, AND THE CHOICE IS THE WHOLE POINT.
 *
 * A path allowlist rebuilds exactly the failure this tool exists to remove:
 * *"nobody wrote that verb"*. It answered the questions we thought of in
 * advance, and the Seinfeld defect was a question we had not
 * (`/episode?seriesId=80&seasonNumber=2` — a plain GET nobody had authored).
 *
 * So: **allow by default.** The denylist is small on purpose and it has a RULE,
 * which is what makes it extensible by someone who was not here:
 *
 *   ⚠️ **DENY ANYTHING THAT MAKES JELLYFIN TALK TO THE TUNER, OR AN ARR TALK TO
 *   AN INDEXER.**
 *
 * Both classes are *cheap-looking GETs with side effects*, and that is why no
 * amount of response-size bounding catches them:
 *
 *  - `/LiveTv/Channels` iterates the tuner. Against a HEALTHY tuner it answers
 *    from cache in 0.42 s and logs nothing — measured twice. Against a DEAD one
 *    it wedged Jellyfin site-wide for hours on 2026-07-26. **It is fast right up
 *    until it is catastrophic, and a dead tuner is precisely the state someone
 *    is in when they ask about live TV.** So the rule is "never call it", not
 *    "call it when the tuner is up".
 *  - An arr's `/release` and Prowlarr's `/api/v1/search` run a LIVE indexer
 *    search on GET: 20.9 s measured warm, 35-45 s cold, and they consume the
 *    indexer rate limits that Sonarr's and Radarr's `/health` are already
 *    complaining about. A read that costs half a minute and can disable an
 *    indexer is not a read.
 *
 * ⚠️ Prefix-matched and lower-cased, so `/LiveTv/Channels/{id}` and
 * `/livetv/channels` are both refused. `/LiveTv/Programs`, `/LiveTv/GuideInfo`
 * and `/Search/Hints` are NOT denied and must not be: measured against
 * Jellyfin's own log, they produce **zero** tuner, HDHomerun, guide or stream
 * lines, and `/Search/Hints` returns `ChannelId` itself so the channel join
 * needs no enumeration at all.
 */
const TUNER_WHY =
  'it enumerates Jellyfin channels/tuners. That call wedged Jellyfin site-wide for hours on ' +
  '2026-07-26 against a dead tuner — and a dead tuner is exactly the state someone is in when they ' +
  'ask about live TV. Use /Search/Hints?searchTerm=…&includeItemTypes=LiveTvProgram instead: it ' +
  'returns ChannelId and ChannelName itself, so you never need the channel list. For per-channel ' +
  'health use channel_health, which reads a results file and never touches a stream.';

const INDEXER_WHY =
  'a GET here runs a LIVE indexer search — 20.9 s measured, 35-45 s cold — and burns the indexer ' +
  'rate limits that Sonarr and Radarr are already reporting as unhealthy. It looks like a cheap read ' +
  'and is not. Use search_episode, which is the curated verb for finding a release.';

const SERVICES: Record<ReadService, ServiceSpec> = {
  jellyfin: {
    label: 'Jellyfin',
    baseUrl: (c) => c.jellyfin.baseUrl,
    auth: (c) => ({ 'X-Emby-Token': c.jellyfin.apiKey }),
    unconfigured: (c) => (c.jellyfin.apiKey ? null : 'JELLYFIN_API_KEY is not configured'),
    denied: [
      { prefix: '/livetv/channels', why: TUNER_WHY },
      { prefix: '/livetv/tuners', why: TUNER_WHY },
      { prefix: '/livetv/tunerhosts', why: TUNER_WHY },
      /**
       * ⚠️ BOTH spellings, listed in full, because matching is by PATH SEGMENT
       * and not by raw string prefix — `/livetv/channelmapping` does not match
       * `/livetv/channelmappings`.
       *
       * Segment matching is the right rule and this is the price of it. A raw
       * prefix would also deny Sonarr's `/releaseprofile`, a harmless config
       * read, off the back of the `/release` ban — silently removing a
       * capability that has nothing to do with indexers. Over-denying is not
       * free just because it is the cautious direction: it rebuilds "nobody
       * wrote that verb" one endpoint at a time.
       */
      { prefix: '/livetv/channelmappings', why: TUNER_WHY },
      { prefix: '/livetv/channelmappingoptions', why: TUNER_WHY },
    ],
  },
  sonarr: {
    label: 'Sonarr',
    baseUrl: (c) => c.sonarr.baseUrl,
    auth: (c) => ({ 'X-Api-Key': c.sonarr.apiKey }),
    unconfigured: (c) => (c.sonarr.apiKey ? null : 'SONARR_API_KEY is not configured'),
    denied: [{ prefix: '/release', why: INDEXER_WHY }],
  },
  radarr: {
    label: 'Radarr',
    baseUrl: (c) => c.radarr.baseUrl,
    auth: (c) => ({ 'X-Api-Key': c.radarr.apiKey }),
    unconfigured: (c) => (c.radarr.apiKey ? null : 'RADARR_API_KEY is not configured'),
    denied: [{ prefix: '/release', why: INDEXER_WHY }],
  },
  prowlarr: {
    label: 'Prowlarr',
    baseUrl: (c) => c.prowlarr.baseUrl,
    auth: (c) => ({ 'X-Api-Key': c.prowlarr.apiKey }),
    unconfigured: (c) => (c.prowlarr.apiKey ? null : 'PROWLARR_API_KEY is not configured'),
    denied: [{ prefix: '/api/v1/search', why: INDEXER_WHY }],
  },
};

export const READ_SERVICES = Object.keys(SERVICES) as ReadService[];

export type ReadPlan =
  | { allowed: true; service: ReadService; label: string; url: string; headers: Record<string, string> }
  | { allowed: false; reason: string };

/**
 * Characters a path may contain. Deliberately narrow — every real endpoint on
 * these four services is ASCII words, slashes, dots, hyphens and the occasional
 * hex GUID. Anything else is refused with the character named, rather than being
 * silently encoded into something that means a different thing.
 *
 * 🔴 `%` IS NOT IN THIS SET, AND ITS ABSENCE IS LOAD-BEARING.
 *
 * `/LiveTv/%43hannels` is `/LiveTv/Channels` to Jellyfin and to the arrs — they
 * percent-decode the path before matching a route — but it is NOT `/livetv/channels`
 * to any string comparison, and `new URL` deliberately leaves `%43` alone, so
 * normalising first does not catch it either. `%2e%2e` is worse: it is a
 * dot-segment to the URL parser, so `/%2e%2e/%2e%2e/%2e%2e/release` climbs out
 * from under `/sonarr/api/v3` while still carrying the API key.
 *
 * Percent-escapes are never NEEDED here: search terms and dates go in `query`,
 * which encodes them properly, and the only path-embedded identifiers on these
 * services are hex GUIDs and integers. So the whole class is refused rather than
 * decoded — and the refusal names the character.
 */
const PATH_CHARS = /^[A-Za-z0-9/._~()@:,+-]+$/;

/**
 * Turn a (service, path, query) triple into the exact GET this tool will issue,
 * or explain the refusal.
 *
 * Pure: it performs no I/O and returns a value. The tool does the fetch, so a
 * test can assert on the URL a refused call would have produced — and, more
 * importantly, that a refused call produced no URL at all.
 */
export function planRead(
  service: unknown,
  path: unknown,
  query: unknown,
  config: Config,
): ReadPlan {
  if (typeof service !== 'string' || !(service in SERVICES)) {
    return {
      allowed: false,
      reason:
        `"${String(service)}" is not a service I can read. Choose one of: ${READ_SERVICES.join(', ')}. ` +
        'qBittorrent and Dispatcharr are deliberately not on this list — see homelab-read.ts.',
    };
  }
  const spec = SERVICES[service as ReadService];

  const missing = spec.unconfigured(config);
  if (missing) {
    return { allowed: false, reason: `${spec.label} cannot be read: ${missing}. Nothing was requested.` };
  }

  if (typeof path !== 'string' || !path.trim()) {
    return { allowed: false, reason: 'No path supplied. A path looks like "/Search/Hints" or "/wanted/missing".' };
  }
  const trimmed = path.trim();

  if (!trimmed.startsWith('/')) {
    return { allowed: false, reason: `Path must start with "/" — got "${trimmed}".` };
  }
  /**
   * 🔴 The two forms that could name a different host. Both are refused rather
   * than left to fail harmlessly by string concatenation: relying on "it would
   * only produce a 404" makes this file's safety depend on how the URL happens
   * to be built two functions away.
   */
  if (trimmed.includes('://') || trimmed.startsWith('//')) {
    return {
      allowed: false,
      reason:
        `Path may not name a host — got "${trimmed}". The host comes from \`service\`; the path is ` +
        'only the endpoint under it.',
    };
  }
  if (trimmed.includes('?') || trimmed.includes('#')) {
    return {
      allowed: false,
      reason:
        `Path may not contain "?" or "#" — got "${trimmed}". Put querystring parameters in the ` +
        '`query` object instead, e.g. {"searchTerm": "Crystal Palace", "limit": 20}.',
    };
  }
  if (!PATH_CHARS.test(trimmed)) {
    const bad = [...trimmed].find((ch) => !PATH_CHARS.test(ch)) ?? '';
    return {
      allowed: false,
      reason:
        `Path contains a character I will not send: ${JSON.stringify(bad)} in "${trimmed}". ` +
        'Search terms, dates and ids with punctuation belong in `query`, which encodes them for you.',
    };
  }

  const base = spec.baseUrl(config).replace(/\/$/, '');
  let baseUrl: URL;
  let target: URL;
  try {
    baseUrl = new URL(base);
    target = new URL(`${base}${trimmed}`);
  } catch {
    return { allowed: false, reason: `Could not form a URL from ${spec.label}'s base and "${trimmed}".` };
  }

  /**
   * 🔴 MATCH WHAT THE SERVER WILL ROUTE ON, NOT WHAT THE CALLER TYPED.
   *
   * Found by review and reproduced against the live gate: matching the raw
   * string let **every** denylist member through by inserting a dot-segment.
   *
   *   `/./LiveTv/Channels`  → fetch sends `/jellyfin/LiveTv/Channels`
   *   `/LiveTv/./Channels`  → the same
   *   `/api/v1/./search`    → the 20.9 s indexer search, on all three arrs
   *
   * `fetch` hands the URL to the WHATWG parser, which removes single-dot
   * segments and resolves double-dot ones before a byte goes out. So the string
   * the denylist inspected and the string the server received were never
   * required to be the same string, and a guard over the first is a guard over
   * nothing.
   *
   * Normalising FIRST also retires the old `..` guard entirely: a `..` that
   * climbs out of the base path now fails the containment check below, which is
   * a property of the resulting URL rather than a pattern someone remembered to
   * look for.
   */
  if (target.origin !== baseUrl.origin) {
    return {
      allowed: false,
      reason: `Path may not name a host — "${trimmed}" resolves to ${target.origin}, not ${baseUrl.origin}.`,
    };
  }
  const basePath = baseUrl.pathname.replace(/\/$/, '');
  if (basePath && target.pathname !== basePath && !target.pathname.startsWith(`${basePath}/`)) {
    return {
      allowed: false,
      reason:
        `Path escapes ${spec.label}'s API prefix — "${trimmed}" resolves to "${target.pathname}", ` +
        `which is outside "${basePath}".`,
    };
  }

  // The path RELATIVE to the API prefix, normalised — the form the denylist is
  // written in, and the form the service's own router sees.
  const routed = target.pathname.slice(basePath.length).toLowerCase();
  for (const rule of spec.denied) {
    if (routed === rule.prefix || routed.startsWith(`${rule.prefix}/`)) {
      return {
        allowed: false,
        reason: `REFUSED: ${spec.label} ${target.pathname} is not readable through this tool, because ${rule.why}`,
      };
    }
  }

  const qs = buildQuery(query);
  if ('error' in qs) return { allowed: false, reason: qs.error };

  return {
    allowed: true,
    service: service as ReadService,
    label: spec.label,
    url: `${target.origin}${target.pathname}${qs.value ? `?${qs.value}` : ''}`,
    headers: { Accept: 'application/json', ...spec.auth(config) },
  };
}

/**
 * The query object → a querystring.
 *
 * Arrays are joined with commas because that is what these servers actually
 * want (`fields=Overview,ChannelInfo`, `includeItemTypes=Movie,Series`), and a
 * model that writes `["Overview","ChannelInfo"]` means the same thing. Nested
 * objects are refused: there is no encoding of them that any of these four
 * services reads, so accepting one would send something meaningless and get a
 * plausible-looking wrong answer back.
 */
/**
 * 🔴 A CREDENTIAL IS NEVER THE CALLER'S TO NAME — INCLUDING THROUGH `query`.
 *
 * Jellyfin accepts `?api_key=` and the arrs accept `?apikey=`, both equivalent to
 * the header this file chooses. Leaving that door open meant "the credential is
 * chosen by code" was true of the HEADERS and false of the request, and it also
 * put a caller-supplied secret-shaped string into the transcript, since the tool
 * echoes the URL it issued.
 */
const CREDENTIAL_KEYS = new Set(['api_key', 'apikey', 'token', 'apitoken', 'x-emby-token', 'x-api-key']);

function buildQuery(query: unknown): { value: string } | { error: string } {
  if (query === undefined || query === null) return { value: '' };
  if (typeof query !== 'object' || Array.isArray(query)) {
    return { error: '`query` must be an object of parameters, e.g. {"limit": 20}.' };
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (CREDENTIAL_KEYS.has(key.toLowerCase())) {
      return {
        error:
          `query.${key} names a credential. The credential is chosen by code from \`service\` and is ` +
          'never yours to supply — remove it and the request will be authenticated correctly.',
      };
    }
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (!value.every(isScalar)) return { error: `query.${key} is an array containing non-scalar values.` };
      params.append(key, value.map(String).join(','));
      continue;
    }
    if (!isScalar(value)) {
      return {
        error:
          `query.${key} is a ${typeof value}. Query parameters must be strings, numbers, booleans, or ` +
          'arrays of those.',
      };
    }
    params.append(key, String(value));
  }
  return { value: params.toString() };
}

function isScalar(v: unknown): boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

// ─────────────────────────────────────────────────────────────────────────────
// THE BOUND
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 🔴 BOUNDED BY RECORDS AND FIELDS, NEVER BY BYTES.
 *
 * A byte clip of JSON is INVALID JSON. It is also the wrong axis: Jellyfin's
 * `/Sessions` is 496 KB for five sessions, and 527 KB of that is one stale
 * session's `NowPlayingQueueFullItems`. A byte cap on that response returns
 * device blobs and **nothing about who is watching** — the exact question it was
 * called to answer. Dropping the field answers it in a few hundred bytes.
 *
 * 🔴 AND IT ALWAYS SAYS WHAT IT DROPPED. `showing 25 of 1744` is a different
 * fact from `showing 25 of 25`, and a silent truncation is indistinguishable
 * from *"that's all there is"* — which is a false zero with a helpful tone.
 * The header is emitted even when nothing was dropped, so its ABSENCE can never
 * be read as "nothing was dropped".
 */
export interface BoundOptions {
  /** How many records to show. */
  limit: number;
  /** Show only these top-level keys of each record. */
  fields?: string[];
  /** Output ceiling. Exceeding it drops RECORDS, never bytes. */
  maxChars: number;
}

/** Envelope keys these four services use for "the list is in here". */
const LIST_KEYS = ['Items', 'SearchHints', 'records', 'results', 'data'];
/** Envelope keys these four services use for "and there were this many". */
const TOTAL_KEYS = ['TotalRecordCount', 'totalRecords', 'totalCount', 'total'];

export function renderRead(body: unknown, opts: BoundOptions): string {
  const list = findList(body);
  if (!list) return renderSingle(body, opts);

  const total = list.total;
  const projected = opts.fields?.length
    ? list.records.map((r) => project(r, opts.fields as string[]))
    : list.records;

  let shown = Math.min(opts.limit, projected.length);
  let rendered = JSON.stringify(projected.slice(0, shown), null, 1);
  /**
   * Drop RECORDS until it fits. Never slice the string: half a record is not a
   * smaller answer, it is a syntactically broken one.
   *
   * Scaled by how far over the ceiling we are rather than halved — halving goes
   * 25 → 12 → 6 → 3 → 1 and throws away most of what would have fitted. `0.9`
   * leaves headroom for the records being uneven; the loop is the real guarantee.
   */
  while (rendered.length > opts.maxChars && shown > 1) {
    const next = Math.floor((shown * opts.maxChars) / rendered.length * 0.9);
    shown = Math.max(1, Math.min(next, shown - 1));
    rendered = JSON.stringify(projected.slice(0, shown), null, 1);
  }

  /**
   * 🔴 THE HEADER STATES WHAT WAS ACTUALLY RENDERED.
   *
   * When even one record is over the ceiling, `shown` is the count the shrink
   * loop STOPPED at, not the count that gets printed — and the oversized branch
   * below prints none. Reporting "showing 1 of 5" above a paragraph that shows
   * zero is a count we did not deliver, which is the same species of claim as a
   * silent truncation. So the header is built after that question is settled.
   */
  const oversized = rendered.length > opts.maxChars;
  if (oversized) shown = 0;

  const header = [`showing ${shown} of ${total} record(s)`];
  if (shown < total) header.push(`${total - shown} NOT SHOWN — narrow the query or raise \`limit\``);
  if (opts.fields?.length) header.push(`fields projected to: ${opts.fields.join(', ')}`);
  if (list.envelope.length) header.push(`envelope keys: ${list.envelope.join(', ')}`);

  if (oversized) return `${header.join(' · ')}\n${describeOversized(projected[0], opts)}`;

  /**
   * 🔴 A PROJECTION THAT MATCHED NOTHING IS A FALSE ZERO, NOT AN EMPTY RESULT.
   *
   * `fields: ["Name"]` against Sonarr rows (whose key is `title`) renders `[{},
   * {}, {}]`, which reads as "these records are empty". They are not — the
   * projection missed. Say so, and name the keys that are actually there.
   */
  if (opts.fields?.length && shown > 0 && projected.slice(0, shown).every((r) => Object.keys(r).length === 0)) {
    const available = [...new Set(list.records.slice(0, 5).flatMap((r) => Object.keys(r ?? {})))];
    return (
      `${header.join(' · ')}\n` +
      `⚠️ NONE of the requested fields exist on these records, so the projection is empty — this is ` +
      `NOT an empty result. Keys actually present: ${available.join(', ') || '(none)'}\n` +
      rendered
    );
  }

  return `${header.join(' · ')}\n${rendered}`;
}

/** Not a list — a single object (`/System/Info`, `/Items/Counts`, `/queue/status`). */
function renderSingle(body: unknown, opts: BoundOptions): string {
  const value =
    opts.fields?.length && body && typeof body === 'object' && !Array.isArray(body)
      ? project(body as Record<string, unknown>, opts.fields)
      : body;
  const rendered = JSON.stringify(value, null, 1);
  const projection = opts.fields?.length ? ` · fields projected to: ${opts.fields.join(', ')}` : '';
  // Same rule as the list branch: the count reports what was RENDERED. A body
  // too large to print is "showing 0", not "showing 1".
  if (rendered !== undefined && rendered.length <= opts.maxChars) {
    return `showing 1 record (not a list)${projection}\n${rendered}`;
  }
  return `showing 0 of 1 record (not a list, and too large to print)${projection}\n${describeOversized(value, opts)}`;
}

/**
 * The last resort, and it still refuses to lie: instead of a truncated record,
 * emit the record's SHAPE with each field's size, so the caller can pick a
 * projection that fits. `/Sessions` lands here, and the map immediately shows
 * that one key holds 500 KB.
 */
function describeOversized(record: unknown, opts: BoundOptions): string {
  // ⚠️ Absence is not a measurement. Saying "the value is larger than N" about a
  // value that is not there states a size fact about nothing.
  if (record === undefined || record === null) {
    return '⚠️ There is no record here to show. This is UNKNOWN, not an empty result.';
  }
  if (typeof record !== 'object') {
    return `⚠️ The single value is larger than ${opts.maxChars} characters and cannot be shown.`;
  }
  const sizes = Object.entries(record as Record<string, unknown>)
    .map(([k, v]) => ({ k, n: JSON.stringify(v)?.length ?? 0 }))
    .sort((a, b) => b.n - a.n)
    .map(({ k, n }) => `${k} (${n} chars)`);
  return (
    `⚠️ ONE record is larger than ${opts.maxChars} characters, so NOTHING is shown rather than half ` +
    `a record. Re-run with \`fields\` set to the ones you need. Fields present, largest first:\n  ` +
    sizes.join('\n  ')
  );
}

interface FoundList {
  records: Record<string, unknown>[];
  total: number;
  /** The other keys of the envelope object, so the caller knows they were there. */
  envelope: string[];
}

function findList(body: unknown): FoundList | null {
  if (Array.isArray(body)) {
    return { records: body.map(asRecord), total: body.length, envelope: [] };
  }
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  for (const key of LIST_KEYS) {
    const value = obj[key];
    if (!Array.isArray(value)) continue;
    /**
     * 🔴 THE SERVER'S OWN TOTAL WINS, WHEN IT HAS ONE.
     *
     * Sonarr's `/queue` defaults to `pageSize=10` against `totalRecords=15`, and
     * `/wanted/missing?pageSize=20` returns 20 rows of 1,744. Counting the array
     * would report "20 of 20" — a truncation the SERVER performed, reported by
     * us as completeness. The envelope is the only place that fact exists.
     */
    const total = TOTAL_KEYS.map((t) => obj[t]).find((v) => typeof v === 'number') as number | undefined;
    return {
      records: value.map(asRecord),
      total: total ?? value.length,
      envelope: Object.keys(obj).filter((k) => k !== key),
    };
  }
  return null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
}

function project(record: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (f in record) out[f] = record[f];
  return out;
}
