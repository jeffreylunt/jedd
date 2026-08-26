import type { Config } from '../config.js';
import { stripCredentials } from '../homelab-read.js';

/**
 * INDEXER ADMINISTRATION — the WRITE half of indexer health.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * Jeff, 2026-08-26: *"Can you fix the torrent indexers in prowler?"* Jedd:
 * *"I can't — I have no tool to enable or re-enable indexers in Prowlarr."*
 * That was true: `homelab_read` is GET-only by construction, so there was no
 * write path to any indexer anywhere.
 *
 * ── 🔴 WHY IT IS THREE SERVICES AND NOT JUST PROWLARR ────────────────────────
 *
 * The brief said "a write tool for Prowlarr". Prowlarr alone cannot perform the
 * remedy this repo actually has written down. From
 * `~/.superbot2/knowledge/homelab-arr-api.md`, recorded twice (2026-06-20 and
 * again 2026-06-21 with no tunnel wedge at all):
 *
 *   > Sonarr/Radarr each keep their OWN indexer failure/backoff state, separate
 *   > from Prowlarr's. Prowlarr's `/indexerstatus` reads `[]`, a direct Prowlarr
 *   > search returns hundreds of results, and EVERY Sonarr/Radarr `/release`
 *   > search still returns 0. **The fix is to force-test each indexer ON THE
 *   > ARR**, which resets that arr's backoff timer. No restart needed.
 *
 * So the state that breaks searching is held on Sonarr and Radarr, and a
 * Prowlarr-only tool would force-test the one place that was never stuck. It
 * would return `200 OK` and change nothing that mattered — the shape of defect
 * this repo exists to refuse.
 *
 * ⚠️ MEASURED LIVE 2026-08-26T16:5xZ, and it is the state right now: BOTH arrs
 * report `IndexerLongTermStatusCheck: Indexers unavailable due to failures for
 * more than 6 hours: 1337x (Prowlarr)`. That warning is on the arrs. Nothing on
 * Prowlarr could have cleared it.
 *
 * ── 🔴 THE THREE SERVICES ARE NOT THE SAME API, AND THE DIFFERENCES BITE ─────
 *
 * All three are Servarr and all three answer `POST /indexer/test`. Two things
 * differ, both measured, both capable of producing a confident wrong answer:
 *
 *  1. **Only Prowlarr exposes per-indexer backoff.** `GET /api/v1/indexerstatus`
 *     returns `disabledTill` / `initialFailure` / `mostRecentFailure`. On both
 *     arrs, `/indexerstatus` AND `/indexerStatus` return **404** — measured, both
 *     spellings, both services. So on an arr the backoff reset cannot be READ,
 *     only performed, and the tool has to say that rather than implying it
 *     verified something.
 *  2. **Only Prowlarr has an `enable` field.** A Sonarr/Radarr indexer resource
 *     has `enableRss`, `enableAutomaticSearch` and `enableInteractiveSearch` and
 *     **no `enable` at all** — measured: `enable=undefined` on all 7 arr
 *     indexers. Writing `enable: false` to one is accepted with HTTP 202 and
 *     changes nothing. See `assertTogglable`.
 */

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export type IndexerService = 'prowlarr' | 'sonarr' | 'radarr';

interface ServiceSpec {
  label: string;
  /**
   * The FULL API base, version segment included.
   *
   * ⚠️ The two halves are not symmetric and this is where it is reconciled:
   * `config.sonarr.baseUrl` already carries `/sonarr/api/v3`, while
   * `config.prowlarr.baseUrl` is the bare root and `/api/v1` is appended here.
   * `src/media/prowlarr.ts` records the same fact and the same reason — the
   * prefixed Prowlarr form returns the SPA's HTML with HTTP 200, so getting it
   * wrong fails as "Prowlarr is unreachable" rather than "your URL is wrong".
   */
  apiBase(c: Config): string;
  apiKey(c: Config): string;
  /** Does `/indexerstatus` exist here? Prowlarr yes; both arrs 404 (measured). */
  readsBackoff: boolean;
}

const SERVICES: Record<IndexerService, ServiceSpec> = {
  prowlarr: {
    label: 'Prowlarr',
    apiBase: (c) => `${c.prowlarr.baseUrl.replace(/\/$/, '')}/api/v1`,
    apiKey: (c) => c.prowlarr.apiKey,
    readsBackoff: true,
  },
  sonarr: {
    label: 'Sonarr',
    apiBase: (c) => c.sonarr.baseUrl.replace(/\/$/, ''),
    apiKey: (c) => c.sonarr.apiKey,
    readsBackoff: false,
  },
  radarr: {
    label: 'Radarr',
    apiBase: (c) => c.radarr.baseUrl.replace(/\/$/, ''),
    apiKey: (c) => c.radarr.apiKey,
    readsBackoff: false,
  },
};

export const INDEXER_SERVICES = Object.keys(SERVICES) as IndexerService[];

export function serviceLabel(service: IndexerService): string {
  return SERVICES[service].label;
}

export function readsBackoff(service: IndexerService): boolean {
  return SERVICES[service].readsBackoff;
}

// ─────────────────────────────────────────────────────────────────────────────
// SHAPES
// ─────────────────────────────────────────────────────────────────────────────

export interface IndexerRow {
  id: number;
  name: string;
  /**
   * Prowlarr's single on/off switch. **`null` on Sonarr and Radarr**, which do
   * not have the field — and `null` here is the fact `assertTogglable` reads.
   */
  enable: boolean | null;
  /** The arrs' own switches, named, for the ones that are on. Empty on Prowlarr. */
  switches: string[];
}

export interface BackoffRow {
  indexerId: number;
  /** When Prowlarr will try it again. */
  disabledTill: string | null;
  /**
   * 🔴 THE ONE TO MEASURE AGE FROM. It is pinned to the FIRST failure and does
   * not move — measured: it stayed `2026-08-25T13:13:54Z` across three separate
   * failing tests on 2026-08-26.
   */
  initialFailure: string | null;
  /**
   * 🔴 NEVER COMPUTE AN AGE FROM THIS. It is rewritten on every backoff retry
   * and on every failing force-test — measured moving `14:07:59Z` →
   * `16:36:30Z` → `16:37:29Z` within one hour while the outage was already a
   * day old. A four-day outage reads as thirty minutes old from this field.
   */
  mostRecentFailure: string | null;
}

export interface TestOutcome {
  id: number;
  /** Empty when the id was not in the list — `testAll` reports ids, not names. */
  name: string;
  passed: boolean;
  /** The service's own error prose, credential-scrubbed. Empty when it passed. */
  errors: string[];
}

export type Fetched<T> = { state: 'ok'; value: T } | { state: 'unknown'; detail: string };

// ─────────────────────────────────────────────────────────────────────────────
// PURE HELPERS — no I/O, so a test can assert on them directly
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 🔴 THREE KINDS OF FAILURE, AND THEY LEAD TO THREE DIFFERENT ACTIONS.
 *
 * The whole point of a force-test is that it clears a backoff timer. That only
 * helps when the indexer WOULD work and the service has stopped asking. Every
 * other failure means the test achieved nothing — and a failed test is not
 * neutral, it **re-arms the backoff from now**. So these are told apart in the
 * OUTPUT, or Jedd reports "tested it" in a tone that implies a repair.
 *
 *  - `forbidden` — the TRACKER turned us away (403). Nothing here changes that.
 *  - `rate-limited` — **the request never reached the tracker.** MEASURED live
 *    on the first real arr run: Sonarr's test of "1337x (Prowlarr)" failed with
 *    `[429:TooManyRequests] [GET] at [http://localhost:9696/6/api…]` — that host
 *    is PROWLARR, not the tracker. Prowlarr was throttling the arr's request
 *    because ITS indexer 6 was already in backoff. So the arr's symptom is a
 *    429 while the actual fault is a 403 one hop upstream, and the fix is to
 *    look at the SAME indexer on Prowlarr rather than to keep poking the arr.
 *  - `other` — a timeout or a connection error, i.e. no answer at all, which is
 *    the shape of a dead VPN tunnel.
 *
 * ⚠️ `rate-limited` used to fall into `other`, and `other` says "check the
 * tunnel". That was a confidently wrong diagnosis on the very first live arr
 * test: the tunnel was fine, Prowlarr answered promptly, and it answered 429.
 */
export type FailureKind = 'forbidden' | 'rate-limited' | 'other';

export function classifyFailure(errors: string[]): FailureKind {
  if (errors.some((e) => /\bforbidden\b|\b403\b/i.test(e))) return 'forbidden';
  if (errors.some((e) => /\btoo\s*many\s*requests\b|\b429\b|\brate.?limit/i.test(e))) return 'rate-limited';
  return 'other';
}

/** Whole hours between two ISO instants, or null if either is missing/unparsable. */
export function hoursBetween(from: string | null, to: Date): number | null {
  if (!from) return null;
  const t = Date.parse(from);
  if (!Number.isFinite(t)) return null;
  return Math.floor((to.getTime() - t) / 3_600_000);
}

/** "27h" / "3d 4h", from a whole-hour count. */
export function humaniseHours(hours: number): string {
  if (hours < 0) return 'in the future';
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * 🔴 REFUSE TO WRITE A FIELD THE RESOURCE DOES NOT HAVE.
 *
 * A Sonarr indexer has no `enable`. `PUT`ting one back with `enable: false`
 * added is accepted — **HTTP 202, the full resource echoed** — and the indexer
 * carries on exactly as before. That is a write that reports success and does
 * nothing, which is indistinguishable from a working one at every layer except
 * the one nobody checks.
 *
 * So the toggle is gated on the field being PRESENT AND BOOLEAN in the body we
 * just read, rather than on a hardcoded list of which services support it. The
 * hardcoded list would be a second copy of the same fact, and it would go stale
 * silently the first time a Servarr release moved the field.
 */
export function assertTogglable(service: IndexerService, body: unknown): string | null {
  const enable = (body as Record<string, unknown> | null)?.['enable'];
  if (typeof enable === 'boolean') return null;
  return (
    `${SERVICES[service].label} indexers have no single \`enable\` field, so there is nothing here ` +
    `to switch on or off — MEASURED: every Sonarr and Radarr indexer returns \`enable: undefined\`, ` +
    'and they use enableRss / enableAutomaticSearch / enableInteractiveSearch instead. Writing ' +
    '`enable` anyway is accepted with HTTP 202 and changes NOTHING, so this refuses rather than ' +
    'reporting a success that did not happen.\n' +
    (service === 'prowlarr'
      ? ''
      : `Every ${SERVICES[service].label} indexer here is a Prowlarr proxy (their names end ` +
        '"(Prowlarr)"), so turning a tracker off belongs upstream: use service "prowlarr". ' +
        `Force-testing ${SERVICES[service].label} — which is what resets ITS backoff — still works.`)
  );
}

/**
 * Scrub a service's own error prose before it is quoted anywhere.
 *
 * Servarr error messages embed the request URL, and for a private tracker that
 * URL carries the passkey in its querystring. `stripCredentials` already
 * rewrites exactly that shape, so its key list is reused rather than re-derived.
 *
 * ── 🔴 WHY IT CANNOT JUST CALL `stripCredentials(message)` ───────────────────
 *
 * Found by the test, not by reading: `stripCredentials`'s URL scrubber is
 * guarded by `/^https?:\/\//`, so it only fires on a string that **IS** a URL.
 * An error message is PROSE CONTAINING one — `"Unable to connect to
 * https://tracker/rss?passkey=…"` — which fails that test at character one and
 * sails through untouched. The redactor was real, the key list was right, and
 * the credential still came out, because the shape it was written for is not the
 * shape it was handed.
 *
 * So the URLs are extracted from the prose first and scrubbed individually.
 *
 * ⚠️ `stripCredentials` itself is deliberately NOT widened to scan prose: it
 * runs over every string field of every `homelab_read` response, and a
 * prose-scanning version would start rewriting descriptions and log lines for
 * every caller. The wider blast radius belongs to that file's owner, not to a
 * fix for error messages.
 *
 * ⚠️ Today every indexer on this box is a public tracker, so this fires on
 * nothing. That is a fact about the current tracker list, not a property of the
 * endpoint, and it stops being true the moment one private tracker is added.
 */
const URL_IN_PROSE = /https?:\/\/[^\s"'<>]+/gi;

export function scrubMessage(message: string): string {
  return message.replace(URL_IN_PROSE, (url) => {
    const stripped = stripCredentials(url);
    return typeof stripped.value === 'string' ? stripped.value : url;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// THE CLIENT
// ─────────────────────────────────────────────────────────────────────────────

export interface IndexerAdminOptions {
  service: IndexerService;
  config: Config;
  fetchImpl?: FetchImpl;
}

/** A single force-test is a live tracker hit; `testAll` is one per enabled indexer. */
const READ_TIMEOUT_MS = 20_000;
const TEST_ONE_TIMEOUT_MS = 90_000;
/** Measured: Prowlarr's testall took 22.8 s for 5 indexers. Leave real headroom. */
const TEST_ALL_TIMEOUT_MS = 180_000;

export class IndexerAdminClient {
  private readonly spec: ServiceSpec;

  private readonly fetchImpl: FetchImpl;

  constructor(private readonly opts: IndexerAdminOptions) {
    this.spec = SERVICES[opts.service];
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  }

  get label(): string {
    return this.spec.label;
  }

  get configured(): boolean {
    return !!this.spec.apiKey(this.opts.config);
  }

  private url(path: string): string {
    return `${this.spec.apiBase(this.opts.config)}${path}`;
  }

  private headers(withBody: boolean): Record<string, string> {
    return {
      Accept: 'application/json',
      'X-Api-Key': this.spec.apiKey(this.opts.config),
      ...(withBody ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  /**
   * One request. Returns the STATUS and the TEXT together and judges neither.
   *
   * 🔴 `res.ok` IS NOT THE ANSWER FOR THESE ENDPOINTS. Measured: Prowlarr's
   * `POST /indexer/testall` returns **HTTP 400 with a complete per-indexer body**
   * when any single indexer fails — 4 of 5 passing came back as a 400. A caller
   * that gates on `res.ok` reports "test-all failed" over a result saying four
   * indexers are healthy. So the status is handed back for the caller to
   * interpret against what that endpoint means, not converted into a verdict
   * here.
   */
  private async call(
    path: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<{ status: number; text: string } | { error: string }> {
    const url = this.url(path);
    try {
      const res = await this.fetchImpl(url, {
        ...init,
        headers: this.headers(!!init.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: res.status, text: await res.text() };
    } catch (e) {
      return {
        error:
          `Could not reach ${this.spec.label} at ${url}: ${(e as Error).message}. That is a failure ` +
          'to ACT, not a finding that anything is broken or fixed — the state is UNKNOWN.',
      };
    }
  }

  private async getJson(path: string): Promise<Fetched<unknown> & { status?: number }> {
    const r = await this.call(path, { method: 'GET' }, READ_TIMEOUT_MS);
    if ('error' in r) return { state: 'unknown', detail: r.error };
    if (r.status >= 400) {
      return { state: 'unknown', detail: `${this.spec.label} ${path} → HTTP ${r.status}.`, status: r.status };
    }
    try {
      return { state: 'ok', value: JSON.parse(r.text), status: r.status };
    } catch {
      return {
        state: 'unknown',
        // Same signature `homelab_read` documents: a 200 that is not JSON is the
        // SPA, i.e. a wrong base URL — not an unreachable service.
        detail:
          `${this.spec.label} ${path} returned HTTP ${r.status} but the body is not JSON (starts ` +
          `"${r.text.slice(0, 60).replace(/\s+/g, ' ')}"). That is a wrong base URL, not a broken service.`,
        status: r.status,
      };
    }
  }

  /**
   * Every indexer this service knows, projected to scalars.
   *
   * 🔴 THE RAW RESOURCE NEVER LEAVES THIS METHOD. A Prowlarr indexer body is
   * ~19 KB and its `fields` array is the `{name, value}` shape that hides
   * credentials from a key-name walker — `/indexer` is denied outright to
   * `homelab_read` for exactly that reason. Here the projection is a WHITELIST
   * of four scalars, so a credential is never IN the value a caller holds,
   * rather than being removed from it by a redactor that has to recognise one.
   *
   * ⚠️ It is one of TWO layers and neither is the whole defence — the mutation
   * sweep proved that by ablating this one. Spreading the raw resource into the
   * row left every test green, because the renderer reads four named fields and
   * simply never printed the extras. So: this projection keeps the credential
   * out of the VALUE, and the renderer keeps it out of the OUTPUT. Both are
   * asserted separately, because relying on the renderer alone puts the whole
   * guarantee one `JSON.stringify(row)` away from a leak.
   */
  async list(): Promise<Fetched<IndexerRow[]>> {
    const r = await this.getJson('/indexer');
    if (r.state !== 'ok') return r;
    if (!Array.isArray(r.value)) {
      return { state: 'unknown', detail: `${this.spec.label} /indexer returned something that is not a list.` };
    }
    const rows: IndexerRow[] = [];
    for (const raw of r.value as Record<string, unknown>[]) {
      const on = raw['enable'];
      const switches: string[] = [];
      for (const [key, label] of [
        ['enableRss', 'rss'],
        ['enableAutomaticSearch', 'auto-search'],
        ['enableInteractiveSearch', 'interactive-search'],
      ] as const) {
        if (raw[key] === true) switches.push(label);
      }
      rows.push({
        id: Number(raw['id']),
        name: String(raw['name'] ?? '?'),
        enable: typeof on === 'boolean' ? on : null,
        switches,
      });
    }
    return { state: 'ok', value: rows };
  }

  /**
   * Per-indexer backoff. **Prowlarr only** — both arrs 404 this path, measured
   * on both spellings.
   *
   * 🔴 `unsupported` IS NOT `unknown` AND IS NOT "NOTHING IS BACKED OFF".
   * `[]` from Prowlarr means every indexer is healthy. A 404 from Sonarr means
   * we cannot see. Collapsing those would let the tool print "no indexer is in
   * backoff" about a service whose backoff it never read — a false zero, on the
   * exact question the tool was called to answer.
   */
  async backoff(): Promise<Fetched<BackoffRow[]> | { state: 'unsupported'; detail: string }> {
    if (!this.spec.readsBackoff) {
      return {
        state: 'unsupported',
        detail:
          `${this.spec.label} does not expose per-indexer backoff over its API — MEASURED: both ` +
          '/indexerstatus and /indexerStatus return HTTP 404 on Sonarr v4 and Radarr v6. Its backoff ' +
          'is real and is what stops searches; it just cannot be read. The only visible signal is ' +
          "the /health warning \"Indexers unavailable due to failures for more than 6 hours\", and " +
          'that warning is SLOW — the knowledge file records it clearing over a few hours after a ' +
          'successful reset, so it still being there a minute later means nothing at all.',
      };
    }
    const r = await this.getJson('/indexerstatus');
    if (r.state !== 'ok') return r;
    if (!Array.isArray(r.value)) {
      return { state: 'unknown', detail: `${this.spec.label} /indexerstatus returned something that is not a list.` };
    }
    return {
      state: 'ok',
      value: (r.value as Record<string, unknown>[]).map((raw) => ({
        indexerId: Number(raw['indexerId']),
        disabledTill: asIso(raw['disabledTill']),
        initialFailure: asIso(raw['initialFailure']),
        mostRecentFailure: asIso(raw['mostRecentFailure']),
      })),
    };
  }

  /** The service's own health messages that are ABOUT indexers, scrubbed. */
  async indexerHealth(): Promise<Fetched<string[]>> {
    const r = await this.getJson('/health');
    if (r.state !== 'ok') return r;
    if (!Array.isArray(r.value)) return { state: 'ok', value: [] };
    const messages: string[] = [];
    for (const raw of r.value as Record<string, unknown>[]) {
      const source = String(raw['source'] ?? '');
      const message = String(raw['message'] ?? '');
      if (!/indexer/i.test(source) && !/indexer/i.test(message)) continue;
      messages.push(scrubMessage(`${raw['type'] ?? '?'}: ${message}`));
    }
    return { state: 'ok', value: messages };
  }

  /**
   * Force-test ONE indexer. This is the operation that resets its backoff.
   *
   * The body is the indexer's own resource, read back and posted verbatim —
   * Servarr's test endpoint takes the resource, not an id. That body carries
   * credentials for a private tracker, which is why it is read and posted
   * without ever being returned, logged, or rendered.
   */
  async testOne(id: number, name: string): Promise<Fetched<TestOutcome>> {
    const current = await this.call(`/indexer/${id}`, { method: 'GET' }, READ_TIMEOUT_MS);
    if ('error' in current) return { state: 'unknown', detail: current.error };
    if (current.status === 404) {
      return {
        state: 'unknown',
        detail:
          `${this.spec.label} has no indexer with id ${id}. Nothing was tested. Run the \`list\` ` +
          'action against this service to see the ids it actually has — ids are per-service and do ' +
          'NOT line up between Prowlarr, Sonarr and Radarr.',
      };
    }
    if (current.status >= 400) {
      return { state: 'unknown', detail: `${this.spec.label} /indexer/${id} → HTTP ${current.status}. Nothing was tested.` };
    }

    const r = await this.call(
      '/indexer/test',
      { method: 'POST', body: current.text },
      TEST_ONE_TIMEOUT_MS,
    );
    if ('error' in r) return { state: 'unknown', detail: r.error };

    // 200 = pass. 400 = a real, reported test failure with the reasons in the
    // body. Anything else is us not knowing what happened.
    if (r.status === 200) return { state: 'ok', value: { id, name, passed: true, errors: [] } };
    if (r.status === 400) {
      return { state: 'ok', value: { id, name, passed: false, errors: parseValidationFailures(r.text) } };
    }
    return {
      state: 'unknown',
      detail:
        `${this.spec.label} POST /indexer/test returned HTTP ${r.status}, which is neither a pass ` +
        `(200) nor a reported failure (400). Body: ${scrubMessage(r.text.slice(0, 300))}`,
    };
  }

  /**
   * Force-test every ENABLED indexer in one call.
   *
   * ⚠️ Disabled indexers are not included — measured: Prowlarr's testall
   * returned ids 1, 2, 3, 4 and 6, omitting the disabled id 8. So "all" means
   * "all enabled", and the output has to say so or a missing id reads as a
   * missing result.
   */
  async testAll(): Promise<Fetched<TestOutcome[]>> {
    const r = await this.call('/indexer/testall', { method: 'POST' }, TEST_ALL_TIMEOUT_MS);
    if ('error' in r) return { state: 'unknown', detail: r.error };
    /**
     * 🔴 400 IS THE NORMAL ANSWER HERE WHEN ANYTHING FAILED, AND THE BODY IS
     * COMPLETE. Measured: 4 passes and 1 failure came back as HTTP 400 carrying
     * all five results. So the body is parsed FIRST and the status is only
     * consulted if there is no body to read.
     */
    let rows: unknown;
    try {
      rows = JSON.parse(r.text);
    } catch {
      return {
        state: 'unknown',
        detail: `${this.spec.label} POST /indexer/testall → HTTP ${r.status} with a body that is not JSON.`,
      };
    }
    if (!Array.isArray(rows)) {
      return {
        state: 'unknown',
        detail: `${this.spec.label} POST /indexer/testall → HTTP ${r.status} with an unexpected shape.`,
      };
    }
    return {
      state: 'ok',
      value: (rows as Record<string, unknown>[]).map((raw) => ({
        id: Number(raw['id']),
        name: '',
        passed: raw['isValid'] === true,
        errors: collectFailures(raw['validationFailures']),
      })),
    };
  }

  /**
   * Turn one indexer on or off.
   *
   * ── 🔴 `forceSave=true`, AND IT IS NOT A SHORTCUT ────────────────────────────
   *
   * MEASURED: a plain `PUT /api/v1/indexer/6` with the body UNCHANGED returns
   * **HTTP 400 "Unable to connect to indexer … Forbidden"**. Prowlarr live-tests
   * an indexer before saving it, so **a broken indexer cannot be disabled** by
   * the obvious call — the single most likely thing anyone would want to do with
   * a broken indexer is the one thing that fails. Worse, that rejected PUT ran a
   * live test on the way, so it pushed `disabledTill` a further 24 h out while
   * saving nothing.
   *
   * `?forceSave=true` skips the validation: measured HTTP 202 in 222 ms with no
   * outbound tracker hit at all. The health of the indexer is then reported
   * separately by an explicit test, which is a fact we state rather than a side
   * effect of whether a save was allowed.
   */
  async setEnable(id: number, enable: boolean): Promise<Fetched<{ changed: boolean }>> {
    const current = await this.call(`/indexer/${id}`, { method: 'GET' }, READ_TIMEOUT_MS);
    if ('error' in current) return { state: 'unknown', detail: current.error };
    if (current.status === 404) {
      return { state: 'unknown', detail: `${this.spec.label} has no indexer with id ${id}. Nothing was changed.` };
    }
    if (current.status >= 400) {
      return { state: 'unknown', detail: `${this.spec.label} /indexer/${id} → HTTP ${current.status}. Nothing was changed.` };
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(current.text) as Record<string, unknown>;
    } catch {
      return { state: 'unknown', detail: `${this.spec.label} /indexer/${id} did not return JSON. Nothing was changed.` };
    }

    const refusal = assertTogglable(this.opts.service, body);
    if (refusal) return { state: 'unknown', detail: `REFUSED — nothing was changed.\n${refusal}` };

    if (body['enable'] === enable) {
      return { state: 'ok', value: { changed: false } };
    }

    const r = await this.call(
      `/indexer/${id}?forceSave=true`,
      { method: 'PUT', body: JSON.stringify({ ...body, enable }) },
      READ_TIMEOUT_MS,
    );
    if ('error' in r) return { state: 'unknown', detail: r.error };
    if (r.status >= 400) {
      return {
        state: 'unknown',
        detail:
          `${this.spec.label} PUT /indexer/${id}?forceSave=true → HTTP ${r.status}. The change may or ` +
          `may not have been saved. Body: ${scrubMessage(r.text.slice(0, 300))}`,
      };
    }
    return { state: 'ok', value: { changed: true } };
  }
}

function asIso(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

/** `[{errorMessage, severity}]` — the shape a single `/indexer/test` returns. */
function parseValidationFailures(text: string): string[] {
  try {
    return collectFailures(JSON.parse(text));
  } catch {
    return [scrubMessage(text.slice(0, 300))];
  }
}

function collectFailures(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value as Record<string, unknown>[]) {
    const message = typeof raw?.['errorMessage'] === 'string' ? raw['errorMessage'] : '';
    if (message) out.push(scrubMessage(message));
  }
  return out;
}
