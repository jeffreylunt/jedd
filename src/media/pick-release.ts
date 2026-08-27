/**
 * WHICH release to take — and the answer leads on the SWARM, not the name.
 *
 * ── 🔴 THE INCIDENT THIS FILE IS THE ANSWER TO ──────────────────────────────
 *
 * 2026-08-26, Fringe S02, measured on hp: Sonarr had grabbed a pool of 2009
 * 720p-HDTV releases. Every one of them read as respectable by name — right
 * show, right season, a format the quality profile approved. In qBittorrent they
 * sat at `time_active` 50–60 h with `num_complete` **0** and **zero bytes moved,
 * ever**. Blocklisting them and taking a 1080p AMZN WEB-DL instead completed in
 * minutes.
 *
 * So the rule this file encodes is not "prefer a good release". It is:
 *
 *   **A WELL-NAMED RELEASE WITH AN EMPTY SWARM IS THE WORST OPTION, NOT THE
 *   BEST.** Swarm health is the FIRST key of every release comparator in this
 *   repo. Quality, format and size only ever break ties BETWEEN releases that
 *   can actually finish.
 *
 * Ranking by label quality first — which is what `search_episode` did, sorting
 * `approved DESC, resolution DESC, seeders DESC` — puts a dead 720p that the
 * profile likes above a live 1080p that it does not. That ordering reproduces
 * the incident on demand.
 *
 * ── ⚠️ WHICH FIELD, AND WHY THAT ONE ────────────────────────────────────────
 *
 * On a torrent we already hold, the swarm-truth field is qBittorrent's
 * `num_complete` and NOT `num_seeds` — see the note on `QbitTorrent.numComplete`
 * in `qbit-torrents.ts`. `num_seeds` counts seeds we are CONNECTED to, so an
 * unstarted torrent reads 0 no matter how healthy its swarm is, and reading it
 * as death nearly destroyed four healthy downloads.
 *
 * Here we are ranking releases we have NOT grabbed yet, so no connected-peer
 * count exists at all and the ambiguity cannot arise. Both payloads we rank
 * carry exactly one seeder-like field, and in both it is the tracker/indexer's
 * own count of complete seeds — the pre-grab analogue of `num_complete`:
 *
 *  - `ReleaseOption.seeders` (`arr.ts`) — Sonarr's `/api/v3/release`, which
 *    passes through what the indexer reported.
 *  - `Release.seeders` (`prowlarr.ts`) — Prowlarr's `/api/v1/search`, same.
 *
 * **It is NOT a count of peers we have connected to.** If either payload ever
 * grows a connected-peer field, this comment is the place that says not to key
 * on it.
 */

/**
 * Where "alive" stops being a coin flip.
 *
 * A release with one or two seeders is technically alive and is still a bet on
 * two strangers staying online; the Fringe pool is what that bet looks like when
 * it loses. Above a handful of seeds the marginal seed buys very little, which
 * is the other half of why this is a BAND and not a raw sort: keying on raw
 * seeders first would rank a 900-seed CAM above a 40-seed WEB-DL for no gain in
 * completion time, and hand the quality decision to popularity.
 *
 * Three bands, then: healthy, thin, dead. Quality decides within a band.
 */
export const HEALTHY_SWARM_SEEDERS = 5;

export type SwarmHealth = 'healthy' | 'thin' | 'dead';

export function swarmHealth(seeders: number): SwarmHealth {
  if (!Number.isFinite(seeders) || seeders <= 0) return 'dead';
  return seeders >= HEALTHY_SWARM_SEEDERS ? 'healthy' : 'thin';
}

/**
 * The band as a sortable number, higher is better.
 *
 * 🔴 THIS IS THE FIRST ELEMENT OF EVERY RELEASE SCORE VECTOR. Moving it, or
 * putting a quality key ahead of it, is the Fringe incident.
 */
export function swarmRank(seeders: number): number {
  const h = swarmHealth(seeders);
  return h === 'healthy' ? 2 : h === 'thin' ? 1 : 0;
}

/** Human wording for a swarm count, so a report never states a bare number. */
export function describeSwarm(seeders: number): string {
  switch (swarmHealth(seeders)) {
    case 'healthy':
      return `${seeders} seeder(s)`;
    case 'thin':
      return `only ${seeders} seeder(s)`;
    case 'dead':
      return 'NO seeders';
  }
}

/**
 * Compare two score vectors, higher-is-better, first difference wins.
 *
 * Shared so that every ranker in the repo is the same comparator with a
 * different vector, and a new one cannot quietly invent its own tie-breaking.
 */
export function byScore<T>(score: (v: T) => number[]): (a: T, b: T) => number {
  return (a, b) => {
    const x = score(a);
    const y = score(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (y[i] ?? 0) - (x[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  };
}
