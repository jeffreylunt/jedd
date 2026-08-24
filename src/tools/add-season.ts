import { ArrClient, type FetchImpl } from '../media/arr.js';
import { bucket, type ShowSeasons } from '../media/seasons.js';
import { watchIt } from './add-media.js';
import { fail, ok, type Tool } from './types.js';

/**
 * "Get me Seinfeld season 3" — for a show Sonarr ALREADY has.
 *
 * ── 🔴 THE REGRESSION THIS CLOSES ────────────────────────────────────────────
 *
 * Measured live, 2026-08-24, on Jeff's first real test of V2: he asked for
 * Seinfeld season 3 and Jedd answered *"I don't have a tool to flip monitoring
 * on for an existing season… that's a Sonarr-side change you'd have to make
 * yourself."* **That reply was accurate, and that was the problem.** V1 has
 * `add_season`; V2 shipped without it.
 *
 * It is worse than a plain gap. Season *visibility* landed the same afternoon,
 * so Jedd could state exactly which seasons were missing and then act on none of
 * it — **the diagnosis improved while the treatment stayed unbuilt**, and that
 * seam is the first thing a real user walked into.
 *
 * `add_series` cannot serve this: it scopes seasons at CREATE time, and once
 * Sonarr holds the show that path answers 400 "already exists".
 *
 * ── 🔴 A SPECIFIC ASK IS NEVER WIDENED INTO "ALL SEASONS" ────────────────────
 *
 * V1's `add_tv` had exactly that bug — an empty clamp fell through to every
 * season — and it is a recorded defect: a guest asked for *Peppa Pig* "the first
 * 3 seasons" and got seasons 1-9. So when nothing requested is a season the show
 * actually has, this **asks**, naming what the show does have. It never guesses,
 * and it never defaults to everything.
 *
 * ── 🔴 EVERY CLAIM IS READ BACK FROM SONARR ──────────────────────────────────
 *
 * Two separate reads, because they answer two different questions and only one
 * of them is what a user means by "you got it":
 *
 *  1. `monitorSeasons` confirms the season is switched ON, from the PUT
 *     response — never from the request we sent.
 *  2. `seasonSearch` starts the actual hunt. **Monitoring alone downloads
 *     nothing**: Sonarr does not search a season because it was switched on. A
 *     season monitored but not searched sits empty forever while reading, to
 *     anyone glancing at the UI, exactly like "on its way".
 *
 * A tool that collapsed those two would report "downloading" for a show that is
 * doing nothing at all, which is the failure this file is mostly built around.
 */
/** One turn holds open for every search it fires; this bounds that. */
const MAX_SEASONS_PER_CALL = 12;

export function makeAddSeason(fetchImpl?: FetchImpl): Tool {
  return {
    name: 'add_season',
    description:
      'Turn on and start downloading specific SEASONS of a show that is ALREADY in the library. Use ' +
      'this whenever someone asks for a season of a show we already have — add_series only works for ' +
      'a show that is not there at all and will refuse. Pass ONLY the season numbers they actually ' +
      'asked for: "season 3" is [3], "the first two" is [1,2]. If they did not say which season, ASK ' +
      'them — never pass every season to mean "they did not specify". If the show is not in the ' +
      'library at all this will say so; use catalogue_search and add_series for that.',
    minRole: 'guest',
    writes: true,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The show title, as the person said it.' },
        seasons: {
          type: 'array',
          items: { type: 'number' },
          description: 'ONLY the seasons they asked for. Never a guess, never "all" as a default.',
        },
      },
      required: ['title', 'seasons'],
    },
    async run(args, ctx) {
      const title = typeof args['title'] === 'string' ? args['title'].trim() : '';
      const requested = Array.isArray(args['seasons'])
        ? [...new Set(args['seasons'].map(Number).filter((n) => Number.isInteger(n) && n >= 0))].sort((a, b) => a - b)
        : [];
      if (!title) return fail('No title supplied. Ask which show they mean.');
      if (requested.length === 0) {
        // 🔴 The whole Peppa Pig defect in one branch. An empty list means the
        // model did not extract a season, NOT that they want everything.
        return fail(
          'No seasons given. ASK which season they want — do not add every season. An unspecified ' +
            'ask is a question, not a request for the whole show.',
        );
      }
      /**
       * ⚠️ BOUNDED, because each season is a separate search with its own
       * timeout and the turn is held open for all of them. The live library
       * holds a 57-season show; asking for all of it would hold one inbound
       * message for minutes. Refusing and asking for fewer is the honest cap.
       */
      if (requested.length > MAX_SEASONS_PER_CALL) {
        return fail(
          `That is ${requested.length} seasons in one go, and I search them one at a time — ask for ` +
            `at most ${MAX_SEASONS_PER_CALL} at once. Nothing was changed.`,
        );
      }
      if (ctx.config.readOnly) return fail('Writes are disabled, so nothing was changed.');

      const sonarr = new ArrClient({ ...ctx.config.sonarr, fetchImpl }, 'series');

      // Reuses the season data built for library_search rather than a parallel
      // lookup — same endpoint, same parser, same denominator rules.
      const found = await sonarr.seasons(title);
      if (found.state === 'unknown') {
        return fail(
          `UNKNOWN — could not reach Sonarr, so I do not know whether "${title}" is there or what ` +
            `state its seasons are in, and NOTHING was changed. ${found.detail} Say you could not check.`,
        );
      }
      if (found.state === 'untracked') {
        return fail(
          `NOT IN THE LIBRARY — Sonarr was read (${found.searched} shows) and has no "${title}". ` +
            'This tool only turns on seasons of a show we already have; use catalogue_search and ' +
            'then add_series to add it for the first time.',
        );
      }
      if (found.shows.length > 1) {
        const names = found.shows.map((s) => describe(s)).join('; ');
        return fail(
          `AMBIGUOUS — "${title}" matches more than one show we have: ${names}. Ask which one they ` +
            'mean and call this again with the fuller title. Nothing was changed.',
        );
      }

      const show = found.shows[0] as ShowSeasons;
      if (!show.id) {
        return fail(
          `Sonarr listed "${show.title}" but without an internal series id, so I cannot update it. ` +
            'Nothing was changed.',
        );
      }

      const available = show.seasons.map((s) => s.season);
      if (available.length === 0) {
        // ⚠️ Otherwise the branch below renders "It has ." — a sentence with the
        // answer missing, which reads as a bug rather than as a state.
        return fail(
          `Sonarr lists "${show.title}" with no seasons at all, so there is nothing to turn on. ` +
            'Nothing was changed.',
        );
      }
      const unknownSeasons = requested.filter((n) => !available.includes(n));
      const valid = requested.filter((n) => available.includes(n));
      if (valid.length === 0) {
        // 🔴 ASK. Not "all", not the nearest season, not a guess.
        return fail(
          `"${show.title}" has no season ${unknownSeasons.join(', ')}. It has ${listSeasons(available)}. ` +
            'Ask which of those they want. Nothing was changed.',
        );
      }

      // A season already fully on disk is not re-grabbed. Re-searching it would
      // be work nobody asked for against a result already in hand.
      const byNumber = new Map(show.seasons.map((s) => [s.season, s]));
      const complete = valid.filter((n) => bucket(byNumber.get(n)!) === 'complete');
      const toGet = valid.filter((n) => !complete.includes(n));
      if (toGet.length === 0) {
        return ok(
          `NOTHING TO DO — "${show.title}" ${listSeasons(complete)} ${complete.length === 1 ? 'is' : 'are'} ` +
            'already fully downloaded. Nothing was changed and nothing was queued.',
        );
      }

      const monitored = await sonarr.monitorSeasons(show.id, toGet);
      if (monitored.state === 'unknown') {
        return fail(`UNKNOWN — ${monitored.detail} Do not say the season was or was not started.`);
      }
      if (monitored.state === 'failed') {
        return fail(`FAILED — ${monitored.detail} Nothing was started.`);
      }

      // 🔴 `confirmed` is a fresh READ of Sonarr, not our request and not the
      // PUT's echo of it. See `ArrClient.monitorSeasons`.
      const confirmed = monitored.confirmed;
      const refused = toGet.filter((n) => !confirmed.includes(n));

      // Everything that changed beyond the plain ask, collected once so every
      // exit below carries it — a FAILED that omits "S1 was already complete"
      // is a less useful answer than the success would have been.
      const notes: string[] = [];
      if (complete.length) notes.push(`${listSeasons(complete)} already complete, left alone`);
      if (unknownSeasons.length) notes.push(`no season ${unknownSeasons.join(', ')} exists for this show`);
      if (refused.length) notes.push(`${listSeasons(refused)} did NOT switch on`);
      if (monitored.seriesWasUnmonitored && monitored.seriesMonitored) {
        // A change beyond what was asked for — a series toggled off grabs
        // nothing however many seasons are on, so it has to be flipped, and
        // flipping it has to be said out loud.
        notes.push('the show itself was unmonitored and has been switched back on');
      }
      if (monitored.othersChanged.length) {
        notes.push(`⚠️ ${listSeasons(monitored.othersChanged)} also changed state or vanished, which was not asked for`);
      }
      const suffix = notes.length ? ` (${notes.join('; ')})` : '';

      if (confirmed.length === 0) {
        return fail(
          `FAILED — Sonarr accepted the update but ${listSeasons(toGet)} did not come back monitored, ` +
            `so the change did not stick and nothing was queued.${suffix}`,
        );
      }

      /**
       * 🔴 SEASONS UNDER AN UNMONITORED SERIES DOWNLOAD NOTHING.
       *
       * The series flag is read back like everything else. If it did not stick,
       * the seasons are on and inert — which reads, to anyone looking, exactly
       * like "on its way". Searching would be pointless and claiming STARTED
       * would be false, so neither happens.
       */
      if (!monitored.seriesMonitored) {
        return fail(
          `MONITORED BUT INERT — "${show.title}" ${listSeasons(confirmed)} switched on, but the SHOW ` +
            `itself came back unmonitored, so Sonarr will grab nothing for it and NOTHING IS ` +
            `DOWNLOADING. Do not say it is on its way.${suffix}`,
        );
      }

      /**
       * 🔴 The second half, and the one that is easy to skip. Monitoring is not
       * downloading. Each season is searched individually and each result is
       * recorded, so a season we switched on but could not search is reported as
       * exactly that rather than folded into the success.
       */
      const searched: number[] = [];
      const unsearched: { season: number; why: string }[] = [];
      for (const n of confirmed) {
        const r = await sonarr.seasonSearch(show.id, n);
        if (r.ok) searched.push(n);
        else unsearched.push({ season: n, why: r.detail });
      }

      if (searched.length === 0) {
        const why = unsearched.map((u) => `S${u.season}: ${u.why}`).join('; ');
        return fail(
          `MONITORED BUT NOT SEARCHING — "${show.title}" ${listSeasons(confirmed)} ${
            confirmed.length === 1 ? 'is' : 'are'
          } switched on, but the search command failed, so NOTHING IS DOWNLOADING. Do not say it is on ` +
            `its way. ${why}${suffix}`,
        );
      }

      const partial = unsearched.length
        ? ` ${listSeasons(unsearched.map((u) => u.season))} switched on but could NOT be searched, so ` +
          'nothing is downloading for those.'
        : '';
      /**
       * 🔴 NO TVDB ID, NO FOLLOW-UP — and no promise of one.
       *
       * `progress()` matches the subject on `tvdbId`. Scheduling with a `0`, or
       * with Sonarr's internal id, produces a follow-up that runs, finds no row,
       * and tells the user the show *"is not in the library listing at all"* —
       * a show that reads as having vanished. Not scheduling is the honest
       * outcome; `watchIt` already refuses to promise what it did not schedule.
       */
      const note = show.tvdbId
        ? await watchIt(ctx, 'series', show.tvdbId, show.title, searched, `searching ${listSeasons(searched)}`)
        : '';
      return ok(`STARTED — "${show.title}" ${listSeasons(searched)} monitored and searching.${partial}${suffix}${note}`);
    },
  };
}

function describe(s: ShowSeasons): string {
  return `${s.title}${s.year ? ` (${s.year})` : ''}`;
}

/** `S3`, or `S1, S3, S4`. Season 0 is Sonarr's specials and is named as such. */
function listSeasons(ns: number[]): string {
  return ns.map((n) => (n === 0 ? 'specials' : `S${n}`)).join(', ');
}
