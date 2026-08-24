import { jellyfinGet } from '../jellyfin.js';
import { fail, ok, type Tool } from './types.js';

/**
 * 🔴 `request_media` USED TO LIVE HERE AND WAS DELETED ON PURPOSE.
 *
 * It was the POC's stand-in for a homelab that was still read-only: it checked
 * Jellyfin, then appended the request to `data/requests.jsonl` and reported a
 * queue position. Harmless then. Now that `add_movie` and `add_series` really do
 * add, that file would be a SECOND STORE describing what is being fetched,
 * sitting beside the arr queue and answering the same question with different
 * facts.
 *
 * That is the exact V1 defect `check_status` exists to not have — Jedd's own
 * job store reported an empty queue while Sonarr had 26 active downloads. It was
 * never registered in `buildTools`, so it was one import away from being live
 * and looked entirely reasonable sitting here. Deleted rather than left dormant:
 * dead code that solves a problem we no longer have is a trap for whoever finds
 * it next and assumes it was left out by mistake.
 *
 * If a request queue is ever wanted again, it must record REQUESTS THAT WERE NOT
 * ACTED ON, and it must never be a place anyone reads download state from.
 */

/** A status summary any user may ask for. */
export const homelabStatus: Tool = {
  name: 'homelab_status',
  description:
    'A short health summary anyone may ask for: is Jellyfin reachable and what version. Does not reveal ' +
    'who is watching.',
  minRole: 'guest',
  writes: false,
  parameters: { type: 'object', properties: {}, required: [] },
  async run(_args, ctx) {
    const info = await jellyfinGet(ctx.config, '/System/Info');
    if (!info.ok) return fail(`Jellyfin is NOT reachable: ${info.error}`);
    const body = info.body as Record<string, unknown> | undefined;
    return ok(
      `Jellyfin is up (version ${body?.['Version'] ?? 'unknown'}, server "${body?.['ServerName'] ?? '?'}").`,
    );
  },
};
