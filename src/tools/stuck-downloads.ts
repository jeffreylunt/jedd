import { ArrClient, type FetchImpl } from '../media/arr.js';
import {
  byHash,
  fetchTorrents,
  qbitVerdict,
  type QbitTorrent,
  type QbitVerdict,
} from '../media/qbit-torrents.js';
import type { Release } from '../media/queue.js';
import { fail, ok, type Tool, type ToolContext } from './types.js';

/**
 * FINDING AND UNSTICKING STUCK DOWNLOADS.
 *
 * Jeff, 2026-08-26: *"go give jedd the tools needed to get stuff unstuck
 * better"*, after Jedd told him *"I can't clear them — I have no tool to delete
 * or remove releases from qBittorrent or the arrs"*. **Unlike the Prowlarr
 * claim the same morning, that one was TRUE.**
 *
 * ── 🔴 THE VERDICT IS COMPUTED HERE, AND THE MODEL DOES NOT GET TO ARGUE ────
 *
 * Every destructive action this tool will grow is gated on the verdict `list`
 * computed — not on what the caller asks for. A `stoppedDL` a human paused, a
 * finished torrent seeding, a `queuedDL` that never started, an unmanaged
 * `missingFiles` row: each is refused **by construction**, so targeting one is
 * unrepresentable rather than merely discouraged.
 *
 * That is deliberately NOT a confirmation prompt. Selection on this model was
 * measured at 39% today, and a confirm step asks an unreliable selector the same
 * question twice — it collects a second correlated opinion and calls it
 * corroboration. Moving the decision into code removes the question instead.
 *
 * ── WHY THE GROUND TRUTH IS qBITTORRENT AND NOT THE ARR ─────────────────────
 *
 * See `src/media/qbit-torrents.ts`: 10 of 18 real stalls carried no warning in
 * Sonarr at all. The join is by infohash, and both halves are reported so an
 * unreadable half is never rendered as an empty one.
 */

type Action = 'list';

const ACTIONS: Action[] = ['list'];

export function makeStuckDownloads(fetchImpl?: FetchImpl): Tool {
  return {
    name: 'stuck_downloads',
    /**
     * 🔴 SHORT, AND IT LEADS WITH WHAT IT DOES.
     *
     * The measurement that produced this shape: `indexer_admin`'s 4,110-byte
     * description — the largest of 33 tools, and one that opens with what it
     * must refuse — was selected 2/8 times, against 4/7 for a 330-byte rewrite.
     * p = 0.31, so that is not proof and I am not claiming it. But the caveats
     * cost nothing in the tool's OUTPUT and might cost selection in its
     * DESCRIPTION, so they live in the output. Every guard below is enforced in
     * code; none of it needs to be read to be obeyed.
     */
    description:
      'Find downloads that are actually stuck and say what would fix each one. Reads the Sonarr and ' +
      'Radarr queues and joins them against qBittorrent, which is the only thing that knows whether ' +
      'a torrent is really dead. Use this for "what is stuck", "downloads are not moving", "clear ' +
      'the queue", "nothing is downloading".',
    minRole: 'owner',
    /**
     * TRUE even though only `list` exists today. Write-ness is a property of the
     * TOOL — the kill switch cannot see an action enum, and the destructive
     * actions land here rather than in a second tool. Declaring `false` now
     * would hand them the permissive answer the moment they arrive.
     */
    writes: true,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS, description: 'Only "list" so far.' },
      },
      required: ['action'],
    },

    async run(args, ctx) {
      const action = args['action'];
      if (typeof action !== 'string' || !(ACTIONS as string[]).includes(action)) {
        return fail(`"${String(action)}" is not an action. Choose one of: ${ACTIONS.join(', ')}.`);
      }
      return runList(ctx, fetchImpl);
    },
  };
}

interface Item {
  release: Release | null;
  torrent: QbitTorrent | null;
  verdict: QbitVerdict | { kind: 'unseen' };
}

async function runList(ctx: ToolContext, fetchImpl?: FetchImpl) {
  const torrents = await fetchTorrents(ctx.config.qbittorrent.lanUrl, fetchImpl);

  /**
   * 🔴 NO qBIT, NO VERDICT — AND THAT IS A REFUSAL, NOT A DEGRADED ANSWER.
   *
   * The arr queue alone cannot tell a stall from a healthy download; that is the
   * whole reason this tool exists. Rendering the arr's own opinion here would
   * reproduce the exact 10-of-18 blind spot, wearing the authority of a tool
   * whose name says it finds stuck downloads.
   */
  if (torrents.state !== 'ok') {
    return fail(
      `I could NOT read qBittorrent, so I cannot tell you what is stuck.\n${torrents.detail}\n` +
        'This is UNKNOWN, not "nothing is stuck". The arr queue on its own cannot distinguish a ' +
        'dead torrent from a healthy one — measured, it misses more than half of real stalls — so ' +
        'I am not going to answer from it.',
    );
  }

  const index = byHash(torrents.value);
  const arr = await readArrQueues(ctx, fetchImpl);

  // Join: every arr release matched to its torrent, then every torrent that no
  // arr row claims (those are qBit-only, e.g. the unmanaged audiobook).
  const items: Item[] = [];
  const claimed = new Set<string>();
  for (const release of arr.releases) {
    const hash = release.releaseId.toLowerCase();
    const torrent = index.get(hash) ?? null;
    if (torrent) claimed.add(hash);
    items.push({ release, torrent, verdict: torrent ? qbitVerdict(torrent) : { kind: 'unseen' } });
  }
  for (const t of torrents.value) {
    if (claimed.has(t.hash)) continue;
    items.push({ release: null, torrent: t, verdict: qbitVerdict(t) });
  }

  const of = (kind: string) => items.filter((i) => i.verdict.kind === kind);
  const stalled = of('stalled');
  const lines: string[] = [
    `STUCK DOWNLOADS — read at ${new Date().toISOString()}. Nothing was changed.`,
    `${torrents.value.length} torrents in qBittorrent; ${arr.releases.length} releases in the arr queues.`,
  ];
  if (arr.unreadable.length) {
    lines.push(
      `⚠️ ${arr.unreadable.join('; ')}. Those queues are UNKNOWN, not empty — anything of theirs is ` +
        'missing from the list below, so do not read this as a complete picture.',
    );
  }

  lines.push('', `🔴 STALLED — ${stalled.length}. ${stalled.length ? 'These are the only ones anything here may act on.' : 'Nothing is stuck.'}`);
  for (const i of stalled) lines.push(renderItem(i));

  for (const [kind, headline] of [
    ['held', 'Somebody STOPPED these deliberately. Report them and leave them — there is no verb here that resumes one, on purpose.'],
    ['unseen', 'In the arr queue but NOT in qBittorrent at all. The arr thinks it is downloading and the client has never heard of it.'],
    ['unmanaged', 'Not in a download state and not arr-managed. Outside this tool\'s remit.'],
    ['not-started', "qBittorrent's own queue is holding these; they have never started, so their 0 seeds is the ABSENCE OF AN OBSERVATION and NOT a dead swarm."],
  ] as const) {
    const group = of(kind);
    if (!group.length) continue;
    lines.push('', `${labelFor(kind)} — ${group.length}. ${headline}`);
    for (const i of group) lines.push(renderItem(i));
  }

  const progressing = of('progressing').length;
  const starting = of('starting').length;
  const finished = of('finished').length;
  lines.push(
    '',
    `✅ Moving: ${progressing} downloading, ${starting} recently started (too young to judge). ` +
      `📦 ${finished} finished and seeding — a completed torrent is never a download fault, and ` +
      'blocklisting one destroys the file and poisons the release.',
  );
  return ok(lines.join('\n'));
}

function labelFor(kind: string): string {
  return (
    { held: '⏸ HELD', unseen: '❓ NOT IN qBITTORRENT', unmanaged: '⚠️ NOT ARR-MANAGED', 'not-started': '⏳ NOT STARTED' }[
      kind
    ] ?? kind
  );
}

function renderItem(i: Item): string {
  const name = i.release?.releaseTitle || i.torrent?.name || '?';
  const subject = i.release?.subject ? ` (${i.release.subject})` : '';
  const t = i.torrent;
  const facts = t
    ? `${t.state}, active ${(t.timeActiveSeconds / 3600).toFixed(0)}h, swarm ${t.numComplete} seed(s), ` +
      `${(t.progress * 100).toFixed(0)}%`
    : 'no qBittorrent record';
  /**
   * The infohash is the handle a destructive action will take, and it is also
   * the thing the post-grab diff needs: Sonarr's blocklist keys on release and
   * indexer identity, NOT on infohash, so the same dead torrent offered by a
   * different indexer walks straight back in.
   */
  const hash = t?.hash ?? i.release?.releaseId ?? '';
  return `  ${name}${subject}\n      ${facts}\n      hash ${hash || '(none)'}`;
}

/** Both queues. An unreadable half is NAMED, never silently dropped. */
async function readArrQueues(
  ctx: ToolContext,
  fetchImpl?: FetchImpl,
): Promise<{ releases: Release[]; unreadable: string[] }> {
  const releases: Release[] = [];
  const unreadable: string[] = [];
  for (const [label, client] of [
    ['Sonarr', new ArrClient({ ...ctx.config.sonarr, fetchImpl }, 'series')],
    ['Radarr', new ArrClient({ ...ctx.config.radarr, fetchImpl }, 'movie')],
  ] as const) {
    const res = await client.queue();
    if (res.state === 'queue') {
      releases.push(...res.releases);
      if (res.saturated) {
        unreadable.push(`${label}'s queue was TRUNCATED by its page size, so some rows are missing`);
      }
      continue;
    }
    unreadable.push(`${label}'s queue could not be read`);
  }
  return { releases, unreadable };
}
