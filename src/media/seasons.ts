/**
 * Which seasons of a show are actually THERE.
 *
 * ── 🔴 THE DENOMINATOR IS `totalEpisodeCount`, NEVER `episodeCount` ──────────
 *
 * Sonarr's season statistics carry three counts and only one of them is a
 * stable answer to "how big is this season":
 *
 *   `episodeFileCount`  — files we hold. The numerator.
 *   `totalEpisodeCount` — every episode Sonarr lists for the season.
 *   `episodeCount`      — **monitoring-dependent.** Measured on the live
 *                          instance: 44 of Sesame Street's 57 seasons report
 *                          `episodeCount: 0` beside `totalEpisodeCount: 130`,
 *                          because nothing in them is monitored and none of it
 *                          is held.
 *
 * `episodeCount` is what Sonarr's own `percentOfEpisodes` divides by, which is
 * why it looks like the obvious choice — and it is the trap. **`0/0` satisfies
 * `have >= want`**, so a whole unmonitored library reads as COMPLETE. That is
 * the false-positive direction: telling Jeff he has 56 seasons of Sesame Street
 * when he has one. `total <= 0` is therefore its own state and is never
 * collapsed into "complete" — see `bucket`.
 *
 * ── ⚠️ WHAT THIS NUMBER DOES NOT KNOW ────────────────────────────────────────
 *
 * `totalEpisodeCount` includes episodes that have not aired, so a season fully
 * held up to today can read `28/35`. That understates, and understating is the
 * safe direction here: it never claims something is present that is not. The
 * count is reported as what it is — files over episodes listed — and no branch
 * relabels it as "missing 7".
 */

export interface SeasonState {
  season: number;
  /** Episode files held. */
  have: number;
  /** Episodes Sonarr lists for the season. See the header: NOT `episodeCount`. */
  total: number;
  monitored: boolean;
}

export interface ShowSeasons {
  title: string;
  year?: number;
  /** Ascending by season number, INCLUDING season 0 (specials). */
  seasons: SeasonState[];
}

/** One row of Sonarr's `/series` into a shape that has no opinions in it yet. */
export function parseShowSeasons(row: unknown): ShowSeasons | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const title = typeof r['title'] === 'string' ? r['title'] : '';
  if (!title) return null;
  const raw = Array.isArray(r['seasons']) ? (r['seasons'] as unknown[]) : [];
  const seasons: SeasonState[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const se = s as Record<string, unknown>;
    const n = Number(se['seasonNumber']);
    if (!Number.isFinite(n)) continue;
    const st = (se['statistics'] ?? {}) as Record<string, unknown>;
    const have = Number(st['episodeFileCount'] ?? 0);
    const total = Number(st['totalEpisodeCount'] ?? 0);
    seasons.push({
      season: n,
      have: Number.isFinite(have) ? have : 0,
      total: Number.isFinite(total) ? total : 0,
      monitored: se['monitored'] === true,
    });
  }
  seasons.sort((a, b) => a.season - b.season);
  return {
    title,
    year: typeof r['year'] === 'number' && r['year'] > 0 ? r['year'] : undefined,
    seasons,
  };
}

export type Bucket = 'complete' | 'partial' | 'missing' | 'empty';

/**
 * 🔴 `empty` EXISTS SO `0/0` CANNOT BE `complete`.
 *
 * A season Sonarr lists with no episodes — an unaired one, or one whose
 * episode list has not populated — satisfies `have >= total` arithmetically.
 * Ordering the checks so `total <= 0` is decided FIRST is the whole guard.
 */
export function bucket(s: SeasonState): Bucket {
  if (s.total <= 0) return 'empty';
  if (s.have >= s.total) return 'complete';
  if (s.have > 0) return 'partial';
  return 'missing';
}

interface Segment {
  bucket: Bucket;
  from: number;
  to: number;
  have: number;
  total: number;
}

/** `S4`, or `S4-S9`. */
function label(seg: Segment): string {
  return seg.from === seg.to ? `S${seg.from}` : `S${seg.from}-S${seg.to}`;
}

function ranges(numbers: number[]): string {
  const sorted = [...numbers].sort((a, b) => a - b);
  const out: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i]!;
    let end = start;
    while (i + 1 < sorted.length && sorted[i + 1] === end + 1) {
      end = sorted[++i]!;
    }
    out.push(start === end ? `S${start}` : `S${start}-S${end}`);
    i += 1;
  }
  return out.join(', ');
}

/**
 * 🔴 CONSECUTIVE SEASONS IN THE SAME STATE COLLAPSE INTO ONE RANGE.
 *
 * This is not cosmetics. The live library holds a 57-season show, and the
 * per-season renderer this replaces would have emitted 57 near-identical lines
 * into a 27B model whose entire margin is a lean context — the same defect
 * `check_status` shipped and had to fix after its first live run. **A fixture
 * cannot disagree with the assumption that produced it:** every test season list
 * is short enough that the naive shape looks fine.
 *
 * `partial` never merges: each partial season carries its own counts, and
 * "S8 2/7, S9 3/6" is the entire content of the answer. `MAX_SEGMENTS` bounds
 * the pathological case where a show is partial the whole way down.
 */
function segments(seasons: SeasonState[]): Segment[] {
  const out: Segment[] = [];
  for (const s of seasons) {
    const b = bucket(s);
    const last = out[out.length - 1];
    const mergeable = last && last.bucket === b && b !== 'partial' && s.season === last.to + 1;
    if (mergeable) {
      last.to = s.season;
      last.have += s.have;
      last.total += s.total;
      continue;
    }
    out.push({ bucket: b, from: s.season, to: s.season, have: s.have, total: s.total });
  }
  return out;
}

function render(seg: Segment): string {
  switch (seg.bucket) {
    case 'complete':
      return `${label(seg)} complete`;
    case 'partial':
      return `${label(seg)} ${seg.have}/${seg.total}`;
    case 'missing':
      return `${label(seg)} missing`;
    case 'empty':
      return `${label(seg)} (no episodes listed yet)`;
  }
}

/** Beyond this the answer stops being readable, exactly as in `check_status`. */
export const MAX_SEGMENTS = 10;

/**
 * One show, one line.
 *
 * The shape is: what it has overall, then which seasons are in which state, then
 * — only when something is missing — whether anything is being done about it.
 * **"Monitored" is the difference between a gap that will fill itself and a gap
 * that will sit there forever**, and it is the fact a person actually needs
 * before deciding to ask for a season.
 */
export function summariseShow(show: ShowSeasons): string {
  const specials = show.seasons.find((s) => s.season === 0);
  const real = show.seasons.filter((s) => s.season > 0);
  const year = show.year ? ` (${show.year})` : '';

  if (real.length === 0) {
    return `${show.title}${year} — Sonarr lists no seasons for this show.`;
  }

  const have = real.reduce((n, s) => n + s.have, 0);
  const total = real.reduce((n, s) => n + s.total, 0);
  const segs = segments(real);
  const shown = segs.slice(0, MAX_SEGMENTS);
  const rest = segs.slice(MAX_SEGMENTS);
  const parts = shown.map(render);
  if (rest.length) {
    const restHave = rest.reduce((n, s) => n + s.have, 0);
    const restTotal = rest.reduce((n, s) => n + s.total, 0);
    parts.push(`S${rest[0]!.from}-S${rest[rest.length - 1]!.to} mixed (${restHave}/${restTotal})`);
  }

  // A gap is a season that is not all there. `empty` is not a gap: there is
  // nothing to fetch for a season Sonarr lists no episodes for.
  const gaps = real.filter((s) => bucket(s) === 'missing' || bucket(s) === 'partial');
  let watch = '';
  if (gaps.length) {
    const unmonitored = gaps.filter((s) => !s.monitored).map((s) => s.season);
    if (unmonitored.length === 0) {
      watch = ' The gaps are monitored, so Sonarr is still looking for them.';
    } else if (unmonitored.length === gaps.length) {
      watch = ' ⚠️ None of the gaps is monitored, so NOTHING is being fetched for them.';
    } else {
      watch = ` ⚠️ Not monitored, so nothing is being fetched: ${ranges(unmonitored)}.`;
    }
  }

  const extra = specials && specials.have > 0 ? ` Plus ${specials.have}/${specials.total} specials.` : '';
  return (
    `${show.title}${year} — ${real.length} season${real.length === 1 ? '' : 's'}, ` +
    `${have}/${total} episodes: ${parts.join(', ')}.${extra}${watch}`
  );
}
