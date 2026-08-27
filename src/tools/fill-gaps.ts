import { ArrClient, type EpisodeRow, type FetchImpl, type ReleaseOption } from '../media/arr.js';
import { resolveOfKind } from '../choices.js';
import { byScore, describeSwarm, swarmRank } from '../media/pick-release.js';
import { fail, ok, type Tool, type ToolContext } from './types.js';

/**
 * Filling gaps in a series — the episodes that are monitored and missing.
 *
 * ── 🔴 THE GOAL IS BINDING; THE MECHANISM JEFF GUESSED IS NOT ───────────────
 *
 * Jeff: *"search for missing series easily and change the quality profile in
 * order to get more options (**or whatever the best way is to fill in gaps**)."*
 * That trailing clause is the brief. Changing the quality profile is the wrong
 * default and not as a matter of taste:
 *
 * **A PROFILE CHANGE PERSISTS.** Widen a series to fill one gap and it keeps
 * that profile forever, grabbing unattended and indefinitely:
 *  - **Theater rips.** `The.Mandalorian.and.Grogu.2026.1080p.HDTS` was
 *    auto-grabbed exactly this way, on an upcoming title with nothing legitimate
 *    available.
 *  - **Foreign-language releases.** The `Not English` custom format scores
 *    **-1000**, and it is the only thing keeping Malayalam *Patriot* and
 *    Japanese *Spirited Away* out. **Those rejections are the system working; a
 *    widening that bypasses them is a regression wearing a feature's clothes.**
 *
 * So nothing here mutates a profile. `search_episode` asks the indexers what
 * exists and shows Sonarr's own reason for refusing each one; `grab_release`
 * takes the one the person picked. The gap gets filled, the profile is never
 * touched, and the quality call is a human decision instead of a config change
 * that outlives the decision.
 *
 * Measured live on Seinfeld S03E01: 12 releases in 2.0 s — two approved at 720p,
 * and 1080p WEB-DLs sitting right there rejected as *"not wanted in profile"*.
 * That is exactly the case Jeff was trying to solve, and it needed no widening.
 */

/** A list this long is already more than a text message can carry usefully. */
const MAX_GAPS_SHOWN = 15;

/**
 * How many ranked releases are KEPT, not how many are shown — nothing but the
 * chosen one is shown any more. The rest stay in the choice store so a later
 * *"get a different one"* has something to resolve against.
 */
const MAX_RELEASES_KEPT = 6;

/**
 * ⚠️ 4K IS EXCLUDED IN CODE NOW, BECAUSE NOBODY IS PICKING ANY MORE.
 *
 * *"Do NOT offer or grab 4K / 2160p releases — they are far too large for this
 * library"* used to live in this tool's DESCRIPTION, and it worked because a
 * model read the list and chose from it. The moment a comparator chooses, a
 * description is not a control: a 2160p remux with a big swarm would win on
 * every key. So the policy moves into the filter beside CAM and non-English,
 * counted like they are.
 */
const MAX_RESOLUTION = 1080;

/** Resolve a title to one owned series, or say why not. */
async function oneSeries(
  sonarr: ArrClient,
  title: string,
): Promise<{ ok: true; id: number; title: string } | { ok: false; result: ReturnType<typeof fail> }> {
  const found = await sonarr.seasons(title);
  if (found.state === 'unknown') {
    return {
      ok: false,
      result: fail(
        `UNKNOWN — could not reach Sonarr, so I do not know what "${title}" is missing. ${found.detail} ` +
          'Say you could not check.',
      ),
    };
  }
  if (found.state === 'untracked') {
    return {
      ok: false,
      result: fail(
        `NOT IN THE LIBRARY — Sonarr was read (${found.searched} shows) and has no "${title}". Use ` +
          'catalogue_search and add_series to add it first.',
      ),
    };
  }
  if (found.shows.length > 1) {
    const names = found.shows.map((s) => `${s.title}${s.year ? ` (${s.year})` : ''}`).join('; ');
    return { ok: false, result: fail(`AMBIGUOUS — "${title}" matches: ${names}. Ask which one they mean.`) };
  }
  const show = found.shows[0]!;
  if (!show.id) return { ok: false, result: fail(`Sonarr listed "${show.title}" without an id, so I cannot look it up.`) };
  return { ok: true, id: show.id, title: show.title };
}

/**
 * ⚠️ SCOPED TO ONE SERIES, ALWAYS. There is deliberately no all-series entry
 * point: ~1600 episodes are wanted instance-wide and most are unsourceable
 * archive shows (Mister Rogers ~750, Suits ~108). A sweep hammers indexers for
 * about zero yield, so this tool cannot be asked to do one.
 */
export function makeFindGaps(fetchImpl?: FetchImpl): Tool {
  return {
    name: 'find_gaps',
    // Useless without this service; absent rather than always-failing.
    needsServices: ['sonarr'],
    description:
      'List the episodes of ONE show that are monitored but missing — the gaps. Use it for "what is ' +
      'missing from X", "why is X incomplete", or before trying to fill anything in. It only ever ' +
      'reports on the one show named; it cannot sweep the library, and you should not ask for that. ' +
      'To then fill a gap, use search_episode on a specific season and episode.',
    minRole: 'guest',
    writes: false,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The show, as they said it.' },
        season: { type: 'number', description: 'Optional: only this season.' },
      },
      required: ['title'],
    },
    async run(args, ctx) {
      const title = typeof args['title'] === 'string' ? args['title'].trim() : '';
      if (!title) return fail('No title supplied. Ask which show they mean.');
      const seasonArg = Number(args['season']);
      const season = Number.isFinite(seasonArg) ? seasonArg : null;

      const sonarr = new ArrClient({ ...ctx.config.sonarr, fetchImpl }, 'series');
      const resolved = await oneSeries(sonarr, title);
      if (!resolved.ok) return resolved.result;

      const eps = await sonarr.episodes(resolved.id);
      if (eps.state === 'unknown') {
        return fail(`UNKNOWN — could not read the episode list for "${resolved.title}": ${eps.detail}`);
      }
      const inScope = season === null ? eps.rows : eps.rows.filter((e) => e.season === season);
      if (season !== null && inScope.length === 0) {
        return ok(`"${resolved.title}" has no season ${season}. Ask which season they meant.`);
      }
      const gaps = inScope.filter((e) => e.monitored && !e.hasFile);

      // Two different zeros, and only one of them is "you have it all".
      if (gaps.length === 0) {
        const unmonitored = inScope.filter((e) => !e.monitored && !e.hasFile).length;
        const scope = season === null ? '' : ` season ${season}`;
        return ok(
          `NO GAPS — every monitored episode of "${resolved.title}"${scope} is on disk ` +
            `(${inScope.length} episode(s) checked).` +
            (unmonitored
              ? ` ⚠️ ${unmonitored} more are missing but NOT monitored, so nothing is looking for them — ` +
                'use add_season if they want those too.'
              : ''),
        );
      }

      const shown = gaps.slice(0, MAX_GAPS_SHOWN);
      const lines = shown.map((e) => `  ${code(e)} ${e.title}${aired(e)}`).join('\n');
      const more = gaps.length > shown.length ? ` (showing ${shown.length} of ${gaps.length})` : '';
      return ok(
        `${gaps.length} MISSING from "${resolved.title}"${season === null ? '' : ` season ${season}`}${more}:\n` +
          `${lines}\n(to try to fill one, call search_episode with the season and episode number.)`,
      );
    },
  };
}

export function makeSearchEpisode(fetchImpl?: FetchImpl): Tool {
  return {
    name: 'search_episode',
    // Useless without this service; absent rather than always-failing.
    needsServices: ['sonarr'],
    description:
      'Find the best release for one missing episode and CHOOSE IT. Use this to fill a gap: it looks ' +
      'past the quality profile, so it is how a 1080p gets in when the profile only wants 720p, ' +
      'WITHOUT changing any settings. It picks the release itself, leading on how alive the swarm is ' +
      '— do NOT list the releases and do NOT ask which torrent they want, that choice is not theirs ' +
      'to make and a good-looking name with a dead swarm never finishes. Then call grab_release to ' +
      'take the one it chose.',
    minRole: 'guest',
    writes: false,
    presentsChoiceKinds: ['sonarr-release'],
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The show, as they said it.' },
        season: { type: 'number' },
        episode: { type: 'number' },
      },
      required: ['title', 'season', 'episode'],
    },
    async run(args, ctx) {
      const title = typeof args['title'] === 'string' ? args['title'].trim() : '';
      const season = Number(args['season']);
      const episode = Number(args['episode']);
      if (!title) return fail('No title supplied.');
      if (!Number.isFinite(season) || !Number.isFinite(episode)) {
        return fail('A season and an episode number are both required. Use find_gaps to see which are missing.');
      }
      // Same rule as search_audiobook: the only route onward is a pick, so a list
      // nothing can resolve would offer a flow that cannot complete.
      if (!ctx.choices) return fail('There is nowhere to record a numbered list, so a pick could not be resolved.');

      /**
       * 🔴 THE OLD LIST DIES THE MOMENT A NEW SEARCH STARTS, NOT WHEN ONE
       * SUCCEEDS.
       *
       * `present` replaces the pending list, so while the consumer took an
       * explicit number a person had just been shown, a search that returned
       * EARLY — UNKNOWN, NONE, FILTERED OUT, "no such episode", "already have
       * it" — simply left the previous list in place and nothing could go wrong.
       *
       * It goes wrong now. The consumer defaults to option 1 with no argument,
       * so the sequence *search S02E01 (stored) → search S02E02 (Sonarr 500,
       * UNKNOWN) → grab* grabs **E01**, reports ACCEPTED, and names the wrong
       * episode. `resolve` never consumes and nothing else in `src/` calls
       * `clear`, so the stale list survives its full hour.
       *
       * ⚠️ Clearing FIRST rather than in each early-return branch is the point:
       * a per-branch clear is a thing to forget, and the branch someone forgets
       * is the one that ships. The cost of clearing too eagerly is a re-search;
       * the cost of not clearing is a download nobody asked for.
       */
      ctx.choices.clear(ctx.senderHandle);

      const sonarr = new ArrClient({ ...ctx.config.sonarr, fetchImpl }, 'series');
      const resolved = await oneSeries(sonarr, title);
      if (!resolved.ok) return resolved.result;

      const eps = await sonarr.episodes(resolved.id);
      if (eps.state === 'unknown') return fail(`UNKNOWN — could not read the episode list: ${eps.detail}`);
      const target = eps.rows.find((e) => e.season === season && e.episode === episode);
      if (!target) {
        return fail(`"${resolved.title}" has no S${pad(season)}E${pad(episode)}. Use find_gaps to see what exists.`);
      }
      if (target.hasFile) {
        return ok(`ALREADY HAVE IT — ${code(target)} "${target.title}" is already on disk. Nothing to fill.`);
      }

      const found = await sonarr.releasesFor(target.id);
      if (found.state === 'unknown') {
        return fail(
          `UNKNOWN — the release search failed, so this is a failure to LOOK rather than a finding ` +
            `that nothing exists: ${found.detail}`,
        );
      }
      const all = found.rows;
      if (all.length === 0) {
        return ok(`NONE — the indexers were searched and have nothing for ${code(target)} "${target.title}".`);
      }

      /**
       * 🔴 FOUR EXCLUSIONS, EACH COUNTED, NONE SILENT.
       *
       * These are the rejections that are the system WORKING, so bypassing them
       * is a regression rather than the feature. Everything else — including
       * "not wanted in profile", which is the entire point of this tool — stays
       * and is ranked.
       *
       * ⚠️ The order of the tests matters only so each release is counted in
       * exactly one bucket; it is not a priority.
       */
      const dead = all.filter((r) => r.seeders <= 0);
      const rest = all.filter((r) => r.seeders > 0);
      const cam = rest.filter((r) => isCam(r));
      const foreign = rest.filter((r) => !isCam(r) && isForeign(r));
      const tooBig = rest.filter((r) => !isCam(r) && !isForeign(r) && r.resolution > MAX_RESOLUTION);
      const usable = rest.filter((r) => !isCam(r) && !isForeign(r) && r.resolution <= MAX_RESOLUTION);

      const excluded: string[] = [];
      if (dead.length) excluded.push(`${dead.length} with no seeders (they would never finish)`);
      if (cam.length) excluded.push(`${cam.length} CAM/theater rip(s)`);
      if (foreign.length) excluded.push(`${foreign.length} non-English`);
      if (tooBig.length) excluded.push(`${tooBig.length} above ${MAX_RESOLUTION}p (4K is too large for this library)`);

      // A filter that removed everything is not a finding that nothing exists.
      if (usable.length === 0) {
        return ok(
          `FILTERED OUT — ${all.length} release(s) exist for ${code(target)} "${target.title}", but ` +
            `every one was excluded: ${excluded.join(', ')}. Say so; do not say none were found.`,
        );
      }

      /**
       * 🔴 SWARM HEALTH IS THE FIRST KEY. THIS ORDER IS THE WHOLE FEATURE.
       *
       * This comparator used to read `approved DESC, resolution DESC, seeders
       * DESC` — label quality first — and that ordering *reproduces the Fringe
       * incident on demand*: a 720p HDTV the profile approves, with a swarm
       * nobody is in, outranks a 1080p WEB-DL with 400 seeders. It looked right
       * and moved zero bytes for 60 hours.
       *
       * So the band comes first and the quality keys break ties INSIDE a band.
       * See `pick-release.ts`.
       */
      const ranked = [...usable].sort(
        byScore((r) => [
          swarmRank(r.seeders),
          Number(r.approved),
          r.resolution,
          r.seeders,
        ]),
      );
      const kept = ranked.slice(0, MAX_RELEASES_KEPT);
      ctx.choices.present({
        senderHandle: ctx.senderHandle,
        subject: `${resolved.title} ${code(target)}`,
        /**
         * 🔴 A DISTINCT KIND FROM `release`.
         *
         * `add_audiobook` and `send_ebook` consume `release` options and read an
         * `infoHash` off them. A Sonarr release carries a guid and an indexerId
         * instead, so sharing the kind would let a pick from here be handed to
         * the audiobook grabber, which would read `infoHash: undefined` and fail
         * in a way that looks like a lost list. Different payload, different kind.
         */
        kind: 'sonarr-release',
        options: kept.map((r, i) => ({
          n: i + 1,
          label: describe(r),
          value: { guid: r.guid, indexerId: r.indexerId, title: r.title, quality: r.quality },
        })),
      });

      /**
       * 🔴 ONLY THE CHOSEN RELEASE IS RETURNED. THE REST NEVER REACH THE MODEL.
       *
       * Jeff, verbatim: *"When downloading media, don't give users a choice of
       * which torrent to choose, just choose the best one."* Telling the model
       * not to present a list would be a request; handing it one release is a
       * fact. **A model cannot offer a numbered pick it was never given.**
       *
       * The alternatives are still PERSISTED above, so *"get a different one"*
       * has something to resolve against — they are withheld from the prose, not
       * discarded.
       *
       * ⚠️ This is release choice only. Deciding WHICH WORK someone meant — the
       * 2026 film or the 2003 show — is a different question with a different
       * wrong answer, and `catalogue_search` still asks it.
       */
      const best = ranked[0]!;
      const notes: string[] = [];
      if (ranked.length > 1) notes.push(`${ranked.length - 1} other usable release(s) not chosen`);
      if (excluded.length) notes.push(`excluded ${excluded.join(', ')}`);
      const suffix = notes.length ? ` (${notes.join('; ')})` : '';

      return ok(
        `CHOSE — for ${code(target)} "${target.title}" I picked the best release myself, leading on ` +
          `swarm health: ${describe(best)}${suffix}.\n` +
          'Do NOT list releases and do NOT ask which torrent they want — that choice is already made. ' +
          'A line saying "not wanted in profile" just means it is outside the usual quality setting; ' +
          'it can still be grabbed and nothing about the settings changes. ' +
          'Call grab_release now to take this one. Nothing is downloading yet.',
      );
    },
  };
}

export function makeGrabRelease(fetchImpl?: FetchImpl): Tool {
  return {
    name: 'grab_release',
    // Useless without this service; absent rather than always-failing.
    needsServices: ['sonarr'],
    description:
      'Download the release that search_episode chose. Call it with NO arguments — search_episode ' +
      'already picked the best one and you do not need to ask anybody which. This does not change ' +
      'any quality settings; it grabs that one file, once.',
    minRole: 'guest',
    writes: true,
    consumesChoiceKind: 'sonarr-release',
    /**
     * 🔴 `choice` IS OPTIONAL, AND ITS ABSENCE IS THE NORMAL PATH.
     *
     * `search_episode` ranks and picks; option 1 IS that pick. Leaving the
     * parameter in place means a person who says *"actually, the other one"* can
     * still be served — the alternatives are in the store even though they were
     * never printed — but nothing has to be asked to reach the common case.
     *
     * ⚠️ It is no longer in `required`, so `requiresChoice` in `index.ts` will not
     * flag this tool. `consumesChoiceKind` is what keeps the producer invariant
     * alive here, and it is still declared.
     */
    parameters: {
      type: 'object',
      properties: {
        choice: {
          type: 'number',
          description:
            'Omit this. Only pass a number if the person explicitly asked for a DIFFERENT release ' +
            'than the one that was chosen for them.',
        },
      },
      required: [],
    },
    async run(args, ctx: ToolContext) {
      // 🔴 THE DEFAULT IS THE PICK. Option 1 is the top of the ranked list that
      // `search_episode` stored, so "no argument" means "the one we chose".
      const n = args['choice'] === undefined ? 1 : Number(args['choice']);
      if (!Number.isFinite(n)) return fail('That is not an option number.');
      if (ctx.config.readOnly) return fail('Writes are disabled, so nothing was grabbed.');
      if (!ctx.choices) return fail('No option store is available, so nothing can be resolved.');

      const picked = resolveOfKind(ctx.choices, ctx.senderHandle, n, 'sonarr-release');
      if (!picked.ok) return fail(`${picked.reason.toUpperCase()} — ${picked.detail}`);

      const guid = String(picked.option.value['guid'] ?? '');
      const indexerId = Number(picked.option.value['indexerId']);
      const title = String(picked.option.value['title'] ?? picked.option.label);
      if (!guid || !Number.isFinite(indexerId)) {
        // The pick resolved but is not a Sonarr release — a list of some other
        // kind. Refusing beats POSTing a malformed grab.
        return fail(
          `That pick is not a Sonarr release (it carries no guid), so there is nothing to grab. ` +
            'Run search_episode first.',
        );
      }

      const sonarr = new ArrClient({ ...ctx.config.sonarr, fetchImpl }, 'series');
      const out = await sonarr.grabRelease(guid, indexerId);
      if (out.state === 'unknown') return fail(`UNKNOWN — ${out.detail}`);
      if (out.state === 'failed') return fail(`FAILED — ${out.detail} Nothing was grabbed.`);

      /**
       * 🔴 SONARR'S 201 IS AN ACKNOWLEDGEMENT, NOT A DOWNLOAD.
       *
       * It echoes the release back, which says the command was accepted — the
       * same shape as the PUT echo in `monitorSeasons`. So the queue is re-read,
       * and the answer distinguishes "it is in the download queue" from "Sonarr
       * took it and I cannot see it yet".
       */
      const queue = await sonarr.queue();
      if (queue.state === 'unknown') {
        return ok(
          `ACCEPTED — Sonarr took "${title}" and handed it to the download client, but I could not ` +
            `re-read the queue to confirm it is actually downloading (${queue.detail}). Say it was ` +
            'accepted, not that it is downloading.',
        );
      }
      const inQueue = queue.releases.some((r) => sameRelease(r.releaseTitle, title));
      return ok(
        inQueue
          ? `GRABBED — "${title}" is in the download queue now. Nothing about the quality settings changed.`
          : `ACCEPTED — Sonarr took "${title}", but it is not in the download queue yet. That is normal ` +
              'for a few seconds; it can also mean the client rejected it. Do not promise it has started.',
      );
    },
  };
}

/** `S03E01`. */
function code(e: EpisodeRow): string {
  return `S${pad(e.season)}E${pad(e.episode)}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function aired(e: EpisodeRow): string {
  if (!e.airDate) return '';
  const year = e.airDate.slice(0, 4);
  return /^\d{4}$/.test(year) ? ` (${year})` : '';
}

/**
 * ⚠️ Theater rips. The documented guard: `…2026.1080p.HDTS` was auto-grabbed on
 * an upcoming title with nothing legitimate available. Matched on the release
 * NAME because Sonarr's parsed quality does not distinguish a CAM from a real
 * source — this is the one place a name match is the only instrument available,
 * and it is stated rather than hidden.
 */
function isCam(r: ReleaseOption): boolean {
  return /\b(cam|camrip|ts|telesync|telecine|hdts|hdcam|dvdscr|screener)\b/i.test(r.title);
}

/**
 * ⚠️ The `Not English` custom format scores -1000 and is the only thing keeping
 * Malayalam and Japanese releases out of an English library. Sonarr already made
 * this judgement; this reads its verdict rather than re-deriving it.
 */
function isForeign(r: ReleaseOption): boolean {
  if (r.rejections.some((x) => /language|not english/i.test(x))) return true;
  if (r.customFormatScore <= -100) return true;
  return r.languages.length > 0 && !r.languages.some((l) => /english/i.test(l));
}

function describe(r: ReleaseOption): string {
  const size = r.sizeBytes > 0 ? `${(r.sizeBytes / 1024 ** 3).toFixed(1)} GB` : 'size unknown';
  const why = r.approved ? 'matches the usual quality' : r.rejections.join('; ') || 'outside the usual quality';
  // The swarm is worded rather than left as a bare integer — "only 2 seeder(s)"
  // and "40 seeder(s)" are different facts and should not read the same.
  return `${r.title.slice(0, 70)} — ${r.quality}, ${size}, ${describeSwarm(r.seeders)}, ${r.indexer} [${why}]`;
}

/** Queue rows carry the release name; compare on the distinctive head of it. */
function sameRelease(queueTitle: string, grabbed: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 40);
  return norm(queueTitle) === norm(grabbed) || norm(queueTitle).startsWith(norm(grabbed).slice(0, 25));
}
