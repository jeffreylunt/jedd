import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { jellyfinGet } from '../jellyfin.js';
import { fail, ok, type Tool } from './types.js';

const DATA_DIR = new URL('../../data/', import.meta.url).pathname;
const QUEUE_PATH = `${DATA_DIR}requests.jsonl`;

/**
 * The guest capability.
 *
 * In the POC this does NOT add to Radarr/Sonarr — the homelab stays read-only.
 * It checks the library for real, and records the request to a durable queue.
 * The tool result reports the queue position, so "did you do it" is answered by
 * a file that either has the line or does not.
 */
export const requestMedia: Tool = {
  name: 'request_media',
  description:
    'Record a request for a movie or TV show. Checks the Jellyfin library first — if it is already ' +
    'there, nothing is queued and you should just tell the person it is available. Returns the queue ' +
    'position when a request is actually recorded.',
  minRole: 'guest',
  writes: false,
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Title of the movie or show.' },
      media_type: { type: 'string', enum: ['movie', 'tv'], description: 'movie or tv' },
    },
    required: ['title', 'media_type'],
  },
  async run(args, ctx) {
    const title = typeof args['title'] === 'string' ? args['title'].trim() : '';
    const mediaType = args['media_type'] === 'tv' ? 'tv' : 'movie';
    if (!title) return fail('No title supplied.');

    const search = await jellyfinGet(
      ctx.config,
      `/Items?searchTerm=${encodeURIComponent(title)}` +
        `&IncludeItemTypes=${mediaType === 'tv' ? 'Series' : 'Movie'}&Recursive=true&Limit=5`,
    );
    if (!search.ok) {
      return fail(
        `Could not check the library (${search.error}), so nothing was queued. Library state is UNKNOWN.`,
      );
    }
    const body = search.body as { Items?: unknown[] } | undefined;
    const items = Array.isArray(body?.Items) ? body.Items : [];
    if (items.length > 0) {
      const first = items[0] as Record<string, unknown>;
      return ok(
        `ALREADY IN LIBRARY — "${first['Name'] ?? title}" is on Jellyfin already. Nothing queued.`,
      );
    }

    const entry = {
      requestedBy: ctx.senderHandle,
      title,
      mediaType,
      requestedAt: new Date().toISOString(),
    };
    try {
      await mkdir(DATA_DIR, { recursive: true });
      await appendFile(QUEUE_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (e) {
      return fail(`Failed to record the request: ${(e as Error).message}. Nothing was queued.`);
    }
    let position = 1;
    try {
      const contents = await readFile(QUEUE_PATH, 'utf8');
      position = contents.split('\n').filter((l) => l.trim()).length;
    } catch {
      /* position stays 1; the append above already succeeded */
    }
    return ok(`QUEUED: "${title}" (${mediaType}) recorded as request #${position}.`);
  },
};

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
