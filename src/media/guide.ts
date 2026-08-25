import type { Config } from '../config.js';
import { jellyfinGet } from '../jellyfin.js';
import type { FetchImpl } from './arr.js';
import { normalise, type Fixture } from './espn.js';

/**
 * The guide half of the answer: which channel, if any, is carrying a fixture.
 *
 * ── WHY `/LiveTv/Programs` AND NOT `/Search/Hints` ───────────────────────────
 *
 * `/Search/Hints` is cheaper (7.5 KB) and returns `ChannelId`/`ChannelName`
 * directly, but it has a measured defect that is disqualifying here: **it
 * matches `Name` only, never `Overview`**. `searchTerm=Rayo Vallecano` returns 0
 * results while `Final: Crystal Palace v Rayo Vallecano` sits in the guide under
 * the generic title `UEFA Conference League`. A fixture whose teams live only in
 * the description would be invisible, and invisible renders as "no channel".
 *
 * `/LiveTv/Programs` with `fields=Overview,ChannelInfo` returns the description,
 * so the match can be made client-side over title AND prose.
 *
 * ⚠️ `searchTerm` on `/LiveTv/Programs` is a **silent no-op** — proven with a
 * control: `Crystal Palace`, `Cricket` and `zzzzznonsensezzz` all returned
 * byte-identical bodies of 13,905 records. Never pass it. The filtering that
 * does work is `minStartDate`/`maxStartDate` (controlled here: an 8-hour window
 * returned 101 records, a different 4-hour window 1,071) and `limit` (controlled:
 * `limit=5` returned 5 of the same `TotalRecordCount` 101).
 *
 * ── 🔴 THIS FILE NEVER ENUMERATES CHANNELS ───────────────────────────────────
 *
 * `/LiveTv/Channels` iterates the tuner and wedged Jellyfin site-wide for hours
 * on 2026-07-26. A dead tuner is exactly the state someone is in when they ask
 * what is on. `/LiveTv/Programs` takes no channel id, needs no enumeration, and
 * was measured to add **zero lines** to Jellyfin's HdHomerun/GuideManager log —
 * it is a pure read of the already-imported guide database. The channel name
 * comes back on the programme record itself, so the join is free.
 */

/** How long before kickoff a live broadcast may start. */
const PRE_KICKOFF_MS = 90 * 60 * 1000;

/** How long after kickoff a broadcast may still be starting (late joins). */
const POST_KICKOFF_MS = 15 * 60 * 1000;

/**
 * A hard cap on records read for one window.
 *
 * ~695 B/record measured, so 800 records is ~550 KB worst case, and a
 * kickoff-sized window measured 101. If this cap ever bites, the caller is told
 * — see `truncated`.
 */
const MAX_PROGRAMMES = 800;

/**
 * Words that mark a programme as something other than the live match.
 *
 * ⚠️ `match week` is deliberately NOT here even though every measured replay
 * carried it. Live coverage says "Coverage from Match Week 3" too — the phrase
 * marks a competition round, not a repeat, and using it would suppress the real
 * broadcast.
 *
 * ⚠️ These FLAG, they never FILTER. There is no structured repeat marker that
 * works here — `<previously-shown>` is present on 52% of the feed and on **0 of
 * the 4** measured Crystal Palace replays — so prose is all there is, and prose
 * is not reliable enough to silently drop the one programme someone asked about.
 * The flag is reported and the model decides.
 */
const REPLAY_MARKERS = [
  'highlights',
  ' hls',
  'replay',
  'rerun',
  're run',
  'encore',
  'as it happened',
  'full match',
  'classic',
];

export interface GuideProgramme {
  /** 🔴 Verbatim from the guide record. Never from the fixture source. */
  channelName: string;
  channelId: string | null;
  name: string;
  startDate: string;
  overview: string;
  /** Replay-ish words found in the title or description, if any. */
  replayMarkers: string[];
}

export type GuideAnswer =
  | {
      state: 'searched';
      from: string;
      to: string;
      /** Programmes whose title or description names BOTH teams. */
      matches: GuideProgramme[];
      /** How many programmes were actually read in this window. */
      scanned: number;
      /**
       * What Jellyfin said the window really holds.
       *
       * 🔴 `scanned < total` means the scan was cut short, and a "no match"
       * under those conditions is NOT a zero — it is an unfinished search. The
       * caller must say which of the two it has.
       */
      total: number;
      channels: number;
    }
  | { state: 'unknown'; detail: string };

/**
 * The variants that can actually TELL THE TWO TEAMS APART.
 *
 * 🔴 A NAME BOTH SIDES SHARE PROVES NOTHING, AND IT SHIPPED A FALSE CHANNEL.
 *
 * Found live on 2026-08-25, not reasoned about: `Los Angeles Rams at Los Angeles
 * Chargers` was reported as showing on **EPIX HD**, because the guide entry in
 * that window was *Beverly Hills Cop II* — *"The hard-nosed Detroit cop returns
 * to **Los Angeles** to help solve another case."* Both teams carry the variant
 * `los angeles`, so ONE mention of the city satisfied BOTH halves of a rule that
 * looks like it demands two independent facts. The both-teams rule had silently
 * collapsed into a one-token rule for every same-city fixture — NY Giants at NY
 * Jets, Cubs at White Sox, Clippers at Lakers.
 *
 * So a variant present on more than one team in the same fixture is struck from
 * all of them. What survives is the part that discriminates: `los angeles rams`
 * and `rams`, `los angeles chargers` and `chargers`.
 *
 * ⚠️ A team can be left with NO discriminating variants (two sides ESPN names
 * identically). It then matches nothing, the fixture reports "no channel listed
 * yet", and the kickoff still stands. That is the fail-safe direction: a missed
 * channel is recoverable, an invented one is not.
 */
export function discriminatingVariants(fixture: Fixture): string[][] {
  const counts = new Map<string, number>();
  for (const t of fixture.teams) for (const v of new Set(t.variants)) counts.set(v, (counts.get(v) ?? 0) + 1);
  return fixture.teams.map((t) => t.variants.filter((v) => (counts.get(v) ?? 0) === 1));
}

/**
 * Does this variant appear as WHOLE WORDS in the haystack?
 *
 * ⚠️ Plain `includes` matches inside words, and the short club names that
 * survive the length floor are exactly the ones that hide there: `rams` is
 * inside "programs", `jets` inside "jetset", `heat` inside "heated". Both
 * strings are already normalised to space-separated tokens, so padding each end
 * turns a substring test into a token-sequence test at no cost.
 */
function namesTeam(paddedHay: string, variants: string[]): boolean {
  return variants.some((v) => paddedHay.includes(` ${v} `));
}

/** Is a programme's title+description naming every one of these teams? */
export function programmeNamesAllTeams(haystack: string, fixture: Fixture): boolean {
  const hay = ` ${normalise(haystack)} `;
  if (!fixture.teams.length) return false;
  const perTeam = discriminatingVariants(fixture);
  // A team with nothing left to discriminate on cannot be confirmed, and an
  // unconfirmed team must not be waved through as "matched".
  return perTeam.every((variants) => variants.length > 0 && namesTeam(hay, variants));
}

function findReplayMarkers(haystack: string): string[] {
  const hay = ` ${normalise(haystack)} `;
  return REPLAY_MARKERS.filter((m) => hay.includes(m)).map((m) => m.trim());
}

/** The guide window this fixture's live coverage would have to start in. */
export function kickoffWindow(fixture: Fixture): { fromMs: number; toMs: number } {
  return { fromMs: fixture.kickoffMs - PRE_KICKOFF_MS, toMs: fixture.kickoffMs + POST_KICKOFF_MS };
}

/** Jellyfin wants milliseconds-precision ISO with a trailing Z. */
function jellyfinInstant(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Search the guide for the channel carrying one fixture.
 *
 * ⚠️ `minStartDate`/`maxStartDate` filter on a programme's START, so coverage
 * that began more than 90 minutes before kickoff and is still running is not
 * found. That is a miss, and a miss reports as "not listed", never as "no game".
 */
export async function findFixtureInGuide(
  config: Config,
  fixture: Fixture,
  fetchImpl?: FetchImpl,
): Promise<GuideAnswer> {
  const { fromMs, toMs } = kickoffWindow(fixture);
  const from = jellyfinInstant(fromMs);
  const to = jellyfinInstant(toMs);
  const path =
    `/LiveTv/Programs?minStartDate=${encodeURIComponent(from)}&maxStartDate=${encodeURIComponent(to)}` +
    // 🔴 ChannelName is `null` without ChannelInfo — measured. Dropping it here
    // would leave every found programme with no channel to report, which reads
    // as "found nothing".
    `&limit=${MAX_PROGRAMMES}&fields=Overview,ChannelInfo`;

  const res = await jellyfinGet(config, path, 20_000, fetchImpl);
  if (!res.ok) return { state: 'unknown', detail: res.error ?? `HTTP ${res.status}` };

  const body = res.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { state: 'unknown', detail: 'the guide response was not a JSON object' };
  }
  const items = (body as { Items?: unknown }).Items;
  if (!Array.isArray(items)) {
    // Same rule as ESPN's missing `events`: an unrecognised 200 is a gap, not an
    // empty guide. `Items?.length ?? 0` here would render as "no channel".
    return {
      state: 'unknown',
      detail: `the guide returned no Items array (keys: ${Object.keys(body as object).join(', ')})`,
    };
  }

  const rawTotal = (body as { TotalRecordCount?: unknown }).TotalRecordCount;
  const total = typeof rawTotal === 'number' && Number.isFinite(rawTotal) ? rawTotal : items.length;

  const matches: GuideProgramme[] = [];
  const channelNames = new Set<string>();
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    const name = typeof p['Name'] === 'string' ? p['Name'] : '';
    const overview = typeof p['Overview'] === 'string' ? p['Overview'] : '';
    const episode = typeof p['EpisodeTitle'] === 'string' ? p['EpisodeTitle'] : '';
    const channelName = typeof p['ChannelName'] === 'string' ? p['ChannelName'] : '';
    if (channelName) channelNames.add(channelName);

    const haystack = `${name} ${episode} ${overview}`;
    if (!programmeNamesAllTeams(haystack, fixture)) continue;
    matches.push({
      // A programme we matched but whose channel Jellyfin did not name is
      // reported with the gap visible. Inventing a channel is the one thing
      // this tool must never do, and "" would render as a blank claim.
      channelName: channelName || '(the guide did not name a channel for this programme)',
      channelId: typeof p['ChannelId'] === 'string' ? p['ChannelId'] : null,
      name,
      startDate: typeof p['StartDate'] === 'string' ? p['StartDate'] : '',
      overview,
      replayMarkers: findReplayMarkers(haystack),
    });
  }

  return { state: 'searched', from, to, matches, scanned: items.length, total, channels: channelNames.size };
}
