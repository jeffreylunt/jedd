import { ArrClient, type EpisodeRow, type FetchImpl, type ReleaseOption } from '../media/arr.js';
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
const MAX_RELEASES_SHOWN = 6;

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
      'Find out what releases actually EXIST for one missing episode, including the ones the quality ' +
      'profile refuses and the reason it refused them. Use this to fill a gap: it is how you offer a ' +
      '1080p when the profile only wants 720p, WITHOUT changing any settings. Present the numbered ' +
      'options with their quality, then call grab_release with the number they pick. ' +
      'Do NOT offer or grab 4K / 2160p releases — they are far too large for this library.',
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
       * 🔴 THREE EXCLUSIONS, EACH COUNTED, NONE SILENT.
       *
       * These are the rejections that are the system WORKING, so bypassing them
       * is a regression rather than the feature. Everything else — including
       * "not wanted in profile", which is the entire point of this tool — stays.
       */
      const dead = all.filter((r) => r.seeders <= 0);
      const cam = all.filter((r) => r.seeders > 0 && isCam(r));
      const foreign = all.filter((r) => r.seeders > 0 && !isCam(r) && isForeign(r));
      const usable = all.filter((r) => r.seeders > 0 && !isCam(r) && !isForeign(r));

      const excluded: string[] = [];
      if (dead.length) excluded.push(`${dead.length} with no seeders (they would never finish)`);
      if (cam.length) excluded.push(`${cam.length} CAM/theater rip(s)`);
      if (foreign.length) excluded.push(`${foreign.length} non-English`);

      // A filter that removed everything is not a finding that nothing exists.
      if (usable.length === 0) {
        return ok(
          `FILTERED OUT — ${all.length} release(s) exist for ${code(target)} "${target.title}", but ` +
            `every one was excluded: ${excluded.join(', ')}. Say so; do not say none were found.`,
        );
      }

      const ranked = [...usable].sort(
        (a, b) => Number(b.approved) - Number(a.approved) || b.resolution - a.resolution || b.seeders - a.seeders,
      );
      const shown = ranked.slice(0, MAX_RELEASES_SHOWN);
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
        options: shown.map((r, i) => ({
          n: i + 1,
          label: describe(r),
          value: { guid: r.guid, indexerId: r.indexerId, title: r.title, quality: r.quality },
        })),
      });

      const notes: string[] = [];
      if (shown.length < ranked.length) notes.push(`showing the top ${shown.length} of ${ranked.length}`);
      if (excluded.length) notes.push(`excluded ${excluded.join(', ')}`);
      const suffix = notes.length ? ` (${notes.join('; ')})` : '';

      const lines = shown.map((r, i) => `  ${i + 1}. ${describe(r)}`).join('\n');
      return ok(
        `${shown.length} release(s) for ${code(target)} "${target.title}"${suffix}:\n${lines}\n` +
          '(present these with their quality and ask which one; then call grab_release with their ' +
          'number. A line saying "not wanted in profile" just means it is outside the usual quality ' +
          'setting — it can still be grabbed, and nothing about the settings changes. ' +
          'Nothing is downloading yet.)',
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
      'Download the specific release they picked from search_episode. Pass the number they chose. ' +
      'This does not change any quality settings — it grabs that one file, once. ' +
      'Never grab a 4K / 2160p release.',
    minRole: 'guest',
    writes: true,
    consumesChoiceKind: 'sonarr-release',
    parameters: {
      type: 'object',
      properties: { choice: { type: 'number', description: 'The option number they picked.' } },
      required: ['choice'],
    },
    async run(args, ctx: ToolContext) {
      const n = Number(args['choice']);
      if (!Number.isFinite(n)) return fail('A choice number is required.');
      if (ctx.config.readOnly) return fail('Writes are disabled, so nothing was grabbed.');
      if (!ctx.choices) return fail('No option store is available, so nothing can be resolved.');

      const picked = ctx.choices.resolve(ctx.senderHandle, n);
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
  return `${r.title.slice(0, 70)} — ${r.quality}, ${size}, ${r.seeders} seeder(s), ${r.indexer} [${why}]`;
}

/** Queue rows carry the release name; compare on the distinctive head of it. */
function sameRelease(queueTitle: string, grabbed: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 40);
  return norm(queueTitle) === norm(grabbed) || norm(queueTitle).startsWith(norm(grabbed).slice(0, 25));
}
