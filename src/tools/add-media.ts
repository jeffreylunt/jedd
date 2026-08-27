import { ArrClient, type FetchImpl } from '../media/arr.js';
import { fail, ok, type Tool, type ToolContext } from './types.js';

/**
 * Adding things. The write half of the media path.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────
 *
 * **No season-phrase parser.** The model turns *"the first 3 seasons"* or
 * *"everything except season 1"* into `seasons: [...]`; this tool only checks
 * that each number exists. Measured over 90 calls, a hand-rolled parser matched
 * the model on 28 of 30 cells and **inverted negation** — *"everything except
 * season 1"* became `[1]`, the exact opposite of the request.
 *
 * **Nothing inspects what the model said.** Every constraint here is on the
 * ARGUMENTS, which makes a wrong call unrepresentable, rather than on the prose,
 * which only detects a wrong claim after it has been made.
 */

/**
 * Schedule the return visit. A turn ends when the user is told the outcome.
 *
 * 🔴 EXPORTED, AND `id` IS THE **TVDB** ID FOR A SERIES — never Sonarr's internal
 * one. `ArrClient.progress()` looks the subject up with
 * `rows.find(r => r.tvdbId === id)`, so passing the internal id matches nothing
 * and the follow-up reports *"is not in the library listing at all"* — a show
 * that reads as having vanished, from a follow-up that was scheduled correctly.
 * `add_season` holds BOTH ids (it needs the internal one for the PUT), which is
 * exactly the situation where the wrong one is easy to hand over.
 */
export async function watchIt(
  ctx: ToolContext,
  arr: 'series' | 'movie',
  id: number,
  title: string,
  seasons: number[],
  observed: string,
): Promise<string> {
  const followups = ctx.followups;
  // 🔴 A tool must never PROMISE a follow-up it did not manage to schedule.
  if (!followups) return '';
  if (followups.pendingForSubject(ctx.senderHandle, arr, id)) {
    return ' I am already watching this one for you.';
  }
  followups.schedule({
    kind: 'media-add',
    senderHandle: ctx.senderHandle,
    dueAt: new Date(Date.now() + 60 * 60 * 1000),
    reason: `added "${title}"${seasons.length ? ` (season(s) ${seasons.join(', ')})` : ''}`,
    observed,
    subject: { arr, id, title, seasons },
  });
  return ' I will check back and tell you how it went, whether or not it works.';
}

export function makeAddMovie(fetchImpl?: FetchImpl): Tool {
  return {
    name: 'add_movie',
    // Useless without this service; absent rather than always-failing.
    needsServices: ['radarr'],
    description:
      'Add a film to the library and start searching for it. Use the tmdbId from catalogue_search — ' +
      'do not invent one. If catalogue_search said AMBIGUOUS, ask which they meant first; do not pick.',
    minRole: 'guest',
    writes: true,
    parameters: {
      type: 'object',
      properties: {
        tmdb_id: { type: 'number', description: 'tmdbId from catalogue_search.' },
        title: { type: 'string', description: 'Title, for the confirmation message.' },
      },
      required: ['tmdb_id', 'title'],
    },
    async run(args, ctx) {
      const id = Number(args['tmdb_id']);
      const title = String(args['title'] ?? '').trim();
      if (!Number.isFinite(id) || id <= 0) return fail('A valid tmdbId is required. Search first.');
      if (ctx.config.readOnly) return fail('Writes are disabled, so nothing was added.');

      const client = new ArrClient({ ...ctx.config.radarr, fetchImpl }, 'movie');
      const outcome = await client.addMovie({
        tmdbId: id,
        title,
        rootFolder: ctx.config.radarr.rootFolder,
        qualityProfileId: ctx.config.radarr.qualityProfileId,
      });
      switch (outcome.state) {
        case 'started': {
          const note = await watchIt(ctx, 'movie', id, title, [], outcome.detail);
          return ok(`STARTED — ${outcome.detail}${note}`);
        }
        case 'already-have':
          // 🔴 SUCCESS, not failure. Never tell them to retry.
          return ok(`ALREADY_HAVE — ${outcome.detail}`);
        case 'unknown':
          return fail(`UNKNOWN — ${outcome.detail}`);
        case 'failed':
          return fail(`FAILED — ${outcome.detail}`);
      }
    },
  };
}

export function makeAddSeries(fetchImpl?: FetchImpl): Tool {
  return {
    name: 'add_series',
    // Useless without this service; absent rather than always-failing.
    needsServices: ['sonarr'],
    description:
      'Add a TV show and start searching. Use the tvdbId from catalogue_search — do not invent one. ' +
      'Pass `seasons` as the list of season numbers the person actually asked for: work out which ' +
      'those are from what they said and from `available_seasons`. Only the seasons you list are ' +
      'monitored, so listing extra ones downloads things nobody asked for. If they did not say, ask.',
    minRole: 'guest',
    writes: true,
    parameters: {
      type: 'object',
      properties: {
        tvdb_id: { type: 'number', description: 'tvdbId from catalogue_search.' },
        title: { type: 'string' },
        seasons: {
          type: 'array',
          items: { type: 'number' },
          description: 'ONLY the seasons requested. "The first 3 seasons" is [1,2,3].',
        },
        available_seasons: {
          type: 'array',
          items: { type: 'number' },
          description: 'Every season the show actually has.',
        },
      },
      required: ['tvdb_id', 'title', 'seasons', 'available_seasons'],
    },
    async run(args, ctx) {
      const id = Number(args['tvdb_id']);
      const title = String(args['title'] ?? '').trim();
      const seasons = Array.isArray(args['seasons']) ? args['seasons'].map(Number).filter(Number.isFinite) : [];
      const available = Array.isArray(args['available_seasons'])
        ? args['available_seasons'].map(Number).filter(Number.isFinite)
        : [];
      if (!Number.isFinite(id) || id <= 0) return fail('A valid tvdbId is required. Search first.');
      if (seasons.length === 0) {
        return fail('No seasons given. Ask which seasons they want rather than guessing at all of them.');
      }
      if (ctx.config.readOnly) return fail('Writes are disabled, so nothing was added.');

      const client = new ArrClient({ ...ctx.config.sonarr, fetchImpl }, 'series');
      const outcome = await client.addSeries({
        tvdbId: id,
        title,
        seasons,
        availableSeasons: available.length ? available : seasons,
        rootFolder: ctx.config.sonarr.rootFolder,
        qualityProfileId: ctx.config.sonarr.qualityProfileId,
      });
      switch (outcome.state) {
        case 'started': {
          const note = await watchIt(ctx, 'series', id, title, outcome.confirmed, outcome.detail);
          // Name only what was actually requested and accepted — never "all of it".
          return ok(`STARTED — ${outcome.detail}${note}`);
        }
        case 'already-have':
          return ok(`ALREADY_HAVE — ${outcome.detail}`);
        case 'unknown':
          return fail(`UNKNOWN — ${outcome.detail}`);
        case 'failed':
          return fail(`FAILED — ${outcome.detail}`);
      }
    },
  };
}
