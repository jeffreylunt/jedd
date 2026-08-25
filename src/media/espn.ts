import type { FetchImpl } from './arr.js';

/**
 * ESPN's public scoreboard — the answer to WHEN and WHO.
 *
 * ── WHY A SECOND SOURCE EXISTS AT ALL ────────────────────────────────────────
 *
 * The Jellyfin/Dispatcharr guide answers WHERE — which channel is carrying a
 * thing — and it runs out after about four days (measured: 5,614 programmes on
 * 2026-08-26 collapsing to 296 by 2026-08-29). Asked "when do Crystal Palace
 * play next", a guide-only tool searches its ~4 days, finds nothing, and says
 * **"no game"**. That is a false zero: the fixture exists, it is simply further
 * out than the guide reaches.
 *
 * So the two sources answer different halves and neither substitutes for the
 * other:
 *   - ESPN  → the fixture exists, and here is the kickoff.   (weeks ahead)
 *   - guide → and here is the channel carrying it.            (~4 days)
 *
 * ── 🔴 `broadcasts` IS PARSED BY NOTHING HERE, ON PURPOSE ────────────────────
 *
 * ESPN's `competitions[].broadcasts` is populated for its US leagues — MLS came
 * back `[{market:'national', names:['Apple TV']}]`, NFL `['NFL Net']`. It is
 * **empty for the Premier League** (US-centric, no UK rights data), so it cannot
 * be relied on. Worse, where it IS populated it names a US carrier that has
 * nothing to do with what this house's tuner can actually tune.
 *
 * A channel name is only ever true if it came out of the guide record. This file
 * therefore reads the field and discards it, rather than passing it up where
 * something might render it as an answer.
 *
 * ── THREE STATES, AND `unknown` IS NEVER "NO FIXTURE" ────────────────────────
 *
 * The same rule as `TmdbClient`, and here it is the entire point of the tool.
 * ESPN's API is unofficial: it can change shape or vanish without notice. If it
 * does, the caller must SAY SO. Degrading quietly to a guide-only answer would
 * reintroduce the exact false zero this file exists to remove, while still
 * looking like it works — a confident wrong answer, which is worse than an error.
 */

/**
 * Which competitions we ask about.
 *
 * ── WHY THESE FIVE ───────────────────────────────────────────────────────────
 *
 *  - `epl`  — Jeff asked for it by name; Crystal Palace is the worked example.
 *  - `mls`  — there is an `mls-matchday-lineup-sync` job in the homelab, so it
 *             is already a thing this house tracks.
 *  - `nfl`, `nba`, `mlb` — the three US leagues whose games appear in the
 *             channel lineup (`NBA: UTAH JAZZ ᴴᴰ` is a channel here).
 *
 * ── ADDING ONE IS ONE LINE ───────────────────────────────────────────────────
 *
 * ESPN's pattern is `/sports/{sport}/{league}/scoreboard`, so a new competition
 * is a new row here and nothing else — the enum in the tool schema is derived
 * from `Object.keys`, so the model sees it immediately.
 *
 * ⚠️ Verify a candidate slug before adding it. A WRONG slug is HTTP 400 (checked:
 * `soccer/zzz.999` and `zzzball/nfl` both 400), which this client reports as
 * unknown — but a slug that is merely EMPTY this season returns HTTP 200 with
 * `events: []`, which is indistinguishable from "no fixtures". `uefa.champions`
 * is currently in that state (valid slug, ESPN still on the 2025-26 season, zero
 * future events), which is why it is not in this table: it would answer every
 * question with a true-but-useless zero.
 */
export const LEAGUES = {
  epl: { path: 'soccer/eng.1', label: 'Premier League' },
  mls: { path: 'soccer/usa.1', label: 'MLS' },
  nfl: { path: 'football/nfl', label: 'NFL' },
  nba: { path: 'basketball/nba', label: 'NBA' },
  mlb: { path: 'baseball/mlb', label: 'MLB' },
} as const satisfies Record<string, { path: string; label: string }>;

export type LeagueKey = keyof typeof LEAGUES;

export const LEAGUE_KEYS = Object.keys(LEAGUES) as LeagueKey[];

export function leagueLabel(key: LeagueKey): string {
  return LEAGUES[key].label;
}

export interface Team {
  /** ESPN's fullest rendering, e.g. "Manchester City". */
  displayName: string;
  /**
   * Every name ESPN gives this team, normalised, for matching guide prose.
   *
   * 🔴 THE ABBREVIATION IS DELIBERATELY NOT IN HERE. "MNC", "CRY", "NE" are
   * three letters and would substring-match half the guide — "CRY" is inside
   * "crying", "NE" inside almost everything. A false channel claim is the one
   * outcome this tool must never produce, so the short forms are dropped and
   * the cost is a missed match, which reports honestly as "not listed yet".
   */
  variants: string[];
  homeAway: 'home' | 'away' | 'unknown';
}

export interface Fixture {
  id: string;
  /** ESPN's own title, e.g. "Manchester City at Crystal Palace". */
  name: string;
  /** ISO 8601 kickoff, exactly as ESPN gave it. */
  kickoff: string;
  kickoffMs: number;
  teams: Team[];
  venue: string | null;
  /**
   * ESPN's own lifecycle state: `pre` (scheduled), `in` (playing now), `post`
   * (finished). Read rather than derived from the clock, because "started 40
   * minutes ago" and "finished two hours ago" are the same arithmetic and very
   * different answers.
   */
  state: 'pre' | 'in' | 'post' | 'unknown';
}

export type FixtureAnswer =
  | {
      state: 'results';
      league: LeagueKey;
      /** Fixtures still to come or in progress, soonest first. */
      fixtures: Fixture[];
      /**
       * How many events ESPN returned before any filtering.
       *
       * 🔴 THE CALLER NEEDS BOTH NUMBERS TO TELL TWO ZEROS APART. `fixtures: []`
       * out of `considered: 0` means ESPN has no events in this window at all;
       * out of `considered: 40` it means every one of them was already finished,
       * or none matched the team asked about. Those are different sentences.
       */
      considered: number;
      /** Keys of the first raw event, so a field rename is diagnosable. */
      sampleKeys: string[];
      windowFrom: string;
      windowTo: string;
    }
  | { state: 'unknown'; detail: string };

const BASE_URL = 'https://site.api.espn.com/apis/site/v2/sports';

/**
 * A ceiling on what we will read from an unofficial API.
 *
 * A 35-day Premier League window measured 403,719 B and a 100-event MLB window
 * is larger. This is not a paging cap — nothing here is fed to the model raw —
 * it is a guard against an endpoint that changes shape and starts returning a
 * season dump.
 */
const MAX_BODY_BYTES = 8_000_000;

/** Lowercase, de-accent, and reduce every run of non-alphanumerics to one space. */
export function normalise(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The names a team might appear under in guide prose.
 *
 * ⚠️ Anything shorter than four characters after normalising is dropped. Guide
 * matching is substring-based against a whole description, so a two- or
 * three-character needle matches by accident, and an accidental match becomes a
 * claimed channel.
 */
export function teamVariants(raw: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const key of ['displayName', 'shortDisplayName', 'name', 'location', 'nickname']) {
    const v = raw[key];
    if (typeof v !== 'string') continue;
    const n = normalise(v);
    if (n.length >= 4) out.add(n);
    // "Seattle Sounders FC" in the fixture source vs "Seattle Sounders" in the
    // guide. Suffix-stripping adds a variant; it never replaces one, so a club
    // whose name really ends in one of these is not damaged.
    const stripped = n.replace(/\b(fc|sc|afc|cf|united fc)\b/g, '').replace(/\s+/g, ' ').trim();
    if (stripped.length >= 4 && stripped !== n) out.add(stripped);
  }
  return [...out];
}

function parseTeam(competitor: Record<string, unknown>): Team | null {
  const team = competitor['team'];
  if (!team || typeof team !== 'object') return null;
  const raw = team as Record<string, unknown>;
  const displayName = typeof raw['displayName'] === 'string' ? raw['displayName'] : '';
  if (!displayName) return null;
  const ha = competitor['homeAway'];
  return {
    displayName,
    variants: teamVariants(raw),
    homeAway: ha === 'home' || ha === 'away' ? ha : 'unknown',
  };
}

function parseState(event: Record<string, unknown>): Fixture['state'] {
  const status = event['status'];
  if (!status || typeof status !== 'object') return 'unknown';
  const type = (status as Record<string, unknown>)['type'];
  if (!type || typeof type !== 'object') return 'unknown';
  const s = (type as Record<string, unknown>)['state'];
  return s === 'pre' || s === 'in' || s === 'post' ? s : 'unknown';
}

function parseFixture(event: Record<string, unknown>): Fixture | null {
  const id = typeof event['id'] === 'string' ? event['id'] : '';
  const kickoff = typeof event['date'] === 'string' ? event['date'] : '';
  const name = typeof event['name'] === 'string' ? event['name'] : '';
  if (!id || !kickoff || !name) return null;
  const kickoffMs = Date.parse(kickoff);
  if (!Number.isFinite(kickoffMs)) return null;

  const comps = event['competitions'];
  const comp = (Array.isArray(comps) ? comps[0] : undefined) as Record<string, unknown> | undefined;
  const competitors = comp?.['competitors'];
  const teams: Team[] = [];
  if (Array.isArray(competitors)) {
    for (const c of competitors) {
      if (!c || typeof c !== 'object') continue;
      const t = parseTeam(c as Record<string, unknown>);
      if (t) teams.push(t);
    }
  }

  const venueRaw = comp?.['venue'];
  let venue: string | null = null;
  if (venueRaw && typeof venueRaw === 'object') {
    const full = (venueRaw as Record<string, unknown>)['fullName'];
    if (typeof full === 'string' && full) venue = full;
  }

  return { id, name, kickoff, kickoffMs, teams, venue, state: parseState(event) };
}

/** `YYYYMMDD` in UTC, which is the form ESPN's `dates` parameter takes. */
export function espnDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

export interface EspnOptions {
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

export class EspnClient {
  private readonly fetchImpl: FetchImpl;

  private readonly timeoutMs: number;

  constructor(opts: EspnOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /**
   * Fixtures for one league between two instants.
   *
   * The requested window is padded by a day on each side before it is sent,
   * because ESPN's `dates` parameter is day-granular in its own timezone and a
   * fixture at the boundary would otherwise fall outside it. The precise cut is
   * made here, client-side, against the real ISO kickoff.
   */
  async fixtures(league: LeagueKey, fromMs: number, toMs: number): Promise<FixtureAnswer> {
    const entry = LEAGUES[league];
    if (!entry) return { state: 'unknown', detail: `no such league "${league}"` };

    const day = 86_400_000;
    const from = espnDate(fromMs - day);
    const to = espnDate(toMs + day);
    const url = `${BASE_URL}/${entry.path}/scoreboard?dates=${from}-${to}`;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      return { state: 'unknown', detail: `could not reach ${url}: ${(e as Error).message}` };
    }

    // ⚠️ Two separate failures, reported separately: a connection dropped
    // mid-body yields an empty string, and folding it into the JSON branch would
    // blame ESPN's response shape for a transport fault.
    let raw: string;
    try {
      raw = await res.text();
    } catch (e) {
      return { state: 'unknown', detail: `the response from ${url} could not be read: ${(e as Error).message}` };
    }
    if (raw.length > MAX_BODY_BYTES) {
      return {
        state: 'unknown',
        detail: `${url} returned ${raw.length.toLocaleString()} bytes, over the ${MAX_BODY_BYTES.toLocaleString()}-byte ceiling; it was not parsed`,
      };
    }

    let body: unknown = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }

    if (!res.ok) {
      // 400 is what a wrong sport or league slug produces — verified against
      // `soccer/zzz.999` and `zzzball/nfl`. Named, because "ESPN is down" and
      // "our slug is wrong" lead to completely different actions.
      const why = res.status === 400 ? ` (ESPN rejected the "${entry.path}" slug)` : '';
      return { state: 'unknown', detail: `http ${res.status} from ${url}${why}` };
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return {
        state: 'unknown',
        detail: `${url} returned ${res.status} but the body is not a JSON object (starts "${raw.slice(0, 60)}")`,
      };
    }

    const events = (body as { events?: unknown }).events;
    if (!Array.isArray(events)) {
      // 🔴 NOT an empty schedule. A 200 whose shape we do not recognise is a gap
      // in what we know, and `[]` here would render as "there is no fixture" —
      // the precise false zero this whole tool exists to remove.
      return {
        state: 'unknown',
        detail: `${url} returned ${res.status} with no events array (keys: ${Object.keys(body as object).join(', ')})`,
      };
    }

    const rows = events as Record<string, unknown>[];
    const fixtures: Fixture[] = [];
    for (const r of rows) {
      const f = parseFixture(r);
      if (!f) continue;
      // A finished match is not an answer to "when do they play next", and
      // excluding it here is also what makes a REPLAY unreachable: the guide is
      // only ever searched around a kickoff that has not been completed.
      if (f.state === 'post') continue;
      // 🔴 A match ALREADY UNDER WAY has a kickoff in the past, so the lower
      // bound would drop it — and "when do they play next" would answer with
      // next week's fixture while the current one is on screen. ESPN's own
      // `state` is what keeps it, rather than a grace period guessed from the
      // clock: `in` and `post` are the same arithmetic and different answers.
      if (f.kickoffMs < fromMs && f.state !== 'in') continue;
      if (f.kickoffMs > toMs) continue;
      fixtures.push(f);
    }
    fixtures.sort((a, b) => a.kickoffMs - b.kickoffMs);

    return {
      state: 'results',
      league,
      fixtures,
      considered: rows.length,
      sampleKeys: rows.length ? Object.keys(rows[0] ?? {}) : [],
      windowFrom: new Date(fromMs).toISOString(),
      windowTo: new Date(toMs).toISOString(),
    };
  }
}

/**
 * Does this fixture involve a team the person named?
 *
 * Matched against the normalised variants, in both directions, so "palace"
 * finds "Crystal Palace" and "Crystal Palace" finds "palace".
 */
export function fixtureInvolves(f: Fixture, query: string): boolean {
  const q = normalise(query);
  if (q.length < 3) return false;
  return f.teams.some((t) => t.variants.some((v) => v.includes(q) || q.includes(v)));
}
