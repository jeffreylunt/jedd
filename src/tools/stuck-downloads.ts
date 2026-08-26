import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { ArrClient, type FetchImpl } from '../media/arr.js';
import {
  byHash,
  fetchTorrents,
  qbitVerdict,
  setTopPriority,
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

type Action = 'list' | 'unstick' | 'promote';

/**
 * 🔴 THIS LINE WAS THE LAST EDIT, AND DELIBERATELY SO.
 *
 * `jedd-v2` transpiles from DISK with `autorestart: true`, so any crash — not
 * any deploy, any crash — loads whatever is on disk and registers this
 * write-capable tool in whatever state it happens to be in. Nobody chooses that
 * window and nobody is told about it. `runUnstick` and `runPromote` were written
 * and committed while unreachable, because an unreferenced function cannot be
 * invoked no matter what loads it. Adding them here is what makes them live.
 */
const ACTIONS: Action[] = ['list', 'unstick', 'promote'];

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
      'a torrent is really dead. Then remove the dead ones and blocklist them, or push a healthy ' +
      'one that is waiting to the front of the queue. Use this for "what is stuck", "downloads are ' +
      'not moving", "clear the queue", "nothing is downloading", "get the downloads unstuck".',
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
        action: {
          type: 'string',
          enum: ACTIONS,
          description:
            'list — what is stuck and why. unstick — remove a stalled release and blocklist it. ' +
            'promote — move a healthy waiting torrent to the top of the queue.',
        },
        hash: {
          type: 'string',
          description:
            'The 40-character infohash, for unstick and promote. Comes from "list", which prints ' +
            'one per item. Only items "list" calls STALLED can be unstuck.',
        },
      },
      required: ['action'],
    },

    async run(args, ctx) {
      const action = args['action'];
      if (typeof action !== 'string' || !(ACTIONS as string[]).includes(action)) {
        return fail(`"${String(action)}" is not an action. Choose one of: ${ACTIONS.join(', ')}.`);
      }
      switch (action as Action) {
        case 'list':
          return runList(ctx, fetchImpl);
        case 'unstick':
          return runUnstick(ctx, args['hash'], fetchImpl);
        case 'promote':
          return runPromote(ctx, args['hash'], fetchImpl);
        default:
          return fail(`Unhandled action "${action}". Nothing was done.`);
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE DESTRUCTIVE HALF — gated on the VERDICT, never on what was asked for
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find one item by infohash and say whether the verdict permits `need`.
 *
 * 🔴 THIS IS THE WHOLE SAFETY MODEL. The caller names a hash; the CODE decides
 * whether that hash may be acted on, from the verdict it computed out of
 * qBittorrent's own state. A held torrent, a finished one, an unstarted one or
 * an unmanaged one is refused **whatever the model asks for**, so targeting one
 * is unrepresentable rather than discouraged.
 *
 * It is deliberately not a confirmation prompt. Tool selection on this model was
 * measured at 39%, and a confirm step asks an unreliable selector the same
 * question twice, then treats the second correlated answer as corroboration.
 */
function gate(
  items: Item[],
  hash: string,
  need: QbitVerdict['kind'],
  action: string,
): { item: Item } | { refusal: string } {
  const wanted = hash.trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(wanted)) {
    return {
      refusal:
        `"${hash}" is not a 40-character infohash, so nothing was done. Run action "list" — every ` +
        'item there prints its hash, and that is the only handle these actions take.',
    };
  }
  const item = items.find((i) => (i.torrent?.hash ?? i.release?.releaseId ?? '').toLowerCase() === wanted);
  if (!item) {
    return { refusal: `Nothing in the queue has infohash ${wanted}. Run action "list" for the current set — and note the queue changes between reads, so a hash from an old listing may simply be gone.` };
  }
  if (item.verdict.kind === need) return { item };
  /**
   * 🔴 THE REFUSAL MUST ANSWER THE QUESTION THAT WAS ASKED.
   *
   * Caught on a live run: asking to PROMOTE a torrent came back *"has not had
   * long enough to be called stalled"* — a true sentence about the item, and an
   * answer to a question nobody asked. A model reading that learns the wrong
   * thing about why its request failed and retries the wrong way. So the
   * mismatch is named explicitly alongside the state.
   */
  return {
    refusal:
      `${refusalFor(item)}\n"${action}" needs an item whose state is ${describeNeed(need)}; this ` +
      `one is ${describeNeed(item.verdict.kind)}. Nothing was done.`,
  };
}

/** The verdict in words, for a refusal that has to name both sides of a mismatch. */
function describeNeed(kind: string): string {
  return (
    {
      stalled: 'STALLED (active for a day or more with nothing moving)',
      'not-started': 'WAITING in the queue and never started',
      held: 'STOPPED by someone',
      finished: 'FINISHED and seeding',
      progressing: 'DOWNLOADING',
      starting: 'recently started',
      unmanaged: 'not arr-managed',
      unseen: 'absent from qBittorrent',
    }[kind] ?? kind
  );
}

/** Why this item is not actionable, in the words that matter to the person. */
function refusalFor(item: Item): string {
  const name = item.release?.releaseTitle || item.torrent?.name || 'that torrent';
  switch (item.verdict.kind) {
    case 'held':
      return (
        `REFUSED — ${name} is STOPPED, not stalled. Somebody stopped it deliberately, almost ` +
        'certainly a person at the qBittorrent UI, and it still has ' +
        `${item.torrent?.numComplete ?? 0} seed(s) in its swarm. Acting on it would route around ` +
        'their decision. Report it and ask; there is no verb here that resumes it.'
      );
    case 'finished':
      return (
        `REFUSED — ${name} is FINISHED and seeding. Blocklisting it would destroy a completed ` +
        'download AND poison the release so the arrs will not re-grab it. An upload-side state is ' +
        'never a download fault.'
      );
    case 'not-started':
      return (
        `REFUSED — ${name} has NEVER STARTED. qBittorrent's own queue is holding it, so its 0 ` +
        'seeds and 0 speed are the absence of any observation, not a dead swarm. Wait for it to ' +
        'start, or use "promote" if something healthy is stuck behind dead torrents.'
      );
    case 'unmanaged':
      return `REFUSED — ${name} is in state "${item.verdict.state}" and is not arr-managed. Outside what this tool may touch.`;
    case 'progressing':
      return `REFUSED — ${name} is DOWNLOADING right now. Nothing is wrong with it.`;
    case 'starting':
      return `REFUSED — ${name} started recently and has not had long enough to be called stalled.`;
    case 'unseen':
      return `REFUSED — ${name} is in the arr queue but qBittorrent has no record of it, so there is no torrent here to remove. That is a different fault.`;
    default:
      return `REFUSED — ${name} is not in an actionable state.`;
  }
}

/**
 * Remove a stalled release and blocklist it — CAPTURING IT FIRST.
 *
 * ── 🔴 CAPTURE BEFORE DELETE, AND A FAILED CAPTURE ABORTS ───────────────────
 *
 * The capture is not paperwork; it is the file the post-grab diff reads. The
 * arrs' blocklist keys on RELEASE and INDEXER identity, **not on infohash**, so
 * the identical torrent offered by another indexer walks straight back through
 * it — measured 2026-08-23, a replacement grab re-added the exact infohash
 * blocklisted minutes earlier because an indexer advertised 1562 seeders for a
 * swarm that had been at 0 for 23 hours. **Indexer seeder counts are not swarm
 * truth; only qBit's `num_complete` is.**
 *
 * ── 🔴 EVERY ROW, NOT THE FIRST ────────────────────────────────────────────
 *
 * A season pack is ONE torrent and N arr rows. Deleting one row removes the
 * torrent and strands the other N-1 pointing at a download that no longer
 * exists. All of `rowIds` or none.
 */
async function runUnstick(ctx: ToolContext, rawHash: unknown, fetchImpl?: FetchImpl) {
  const hash = typeof rawHash === 'string' ? rawHash : '';
  const state = await collect(ctx, fetchImpl);
  if ('error' in state) return fail(state.error);

  const found = gate(state.items, hash, 'stalled', 'unstick');
  if ('refusal' in found) return fail(found.refusal);
  const { item } = found;
  if (!item.release) {
    return fail(
      'That torrent is in qBittorrent but no arr queue row claims it, so there is nothing to ' +
        'blocklist — removing it here would leave the arr unaware. Not something this tool does.',
    );
  }
  if (!item.release.rowIds.length) {
    return fail('The arr queue rows for that release carry no usable id, so a removal cannot be addressed. Nothing was done.');
  }

  let savedTo: string;
  try {
    savedTo = captureRemoval(ctx.config.downloadBackupDir, item);
  } catch (e) {
    return fail(
      `NOTHING WAS REMOVED. The record of what I was about to delete could not be written ` +
        `(${(e as Error).message}), and that file is what makes this reversible AND what the ` +
        'post-grab diff reads. This is a refusal, not a failed removal.',
    );
  }

  const client = arrClientFor(ctx, item.release.service, fetchImpl);
  const results: string[] = [];
  let anyFailed = false;
  for (const rowId of item.release.rowIds) {
    const r = await client.removeFromQueue(rowId);
    results.push(r.detail);
    if (!r.ok) anyFailed = true;
  }

  /**
   * 🔴 CONFIRM THE HASH IS ACTUALLY GONE. The spec's rule, and it is a rule
   * because a 200 has lied here before: *"Confirm the hash is actually gone from
   * qBit after a blocklist-delete rather than trusting the 200."*
   */
  const after = await fetchTorrents(ctx.config.qbittorrent.lanUrl, fetchImpl);
  const stillThere = after.state === 'ok' && after.value.some((t) => t.hash === item.torrent?.hash);

  const name = item.release.releaseTitle;
  const lines = [
    stillThere
      ? `⚠️ ${name} — the arr accepted the removal but the torrent is STILL IN qBittorrent.`
      : after.state === 'ok'
        ? `Removed ${name} and blocklisted the release. Confirmed GONE from qBittorrent.`
        : `Removed ${name} and blocklisted the release — but I could NOT re-read qBittorrent to confirm the torrent is gone, so that half is UNKNOWN.`,
    '',
    `arr rows (${item.release.rowIds.length}): ${results.join('; ')}`,
  ];
  if (anyFailed) {
    lines.push(
      '⚠️ At least one row did not remove cleanly. A season pack is one torrent across several rows, ' +
        'so a partial removal leaves rows pointing at a download that no longer exists — run "list" ' +
        'and look before doing anything else.',
    );
  }
  lines.push(
    '',
    `🔴 DELETED INFOHASH: ${item.torrent?.hash ?? '(unknown)'}`,
    'If you now grab a replacement, CHECK ITS INFOHASH AGAINST THAT ONE. The blocklist keys on ' +
      'release and indexer identity, NOT on infohash, so the same dead torrent offered by a ' +
      'different indexer passes straight back through it — and indexer seeder counts are not swarm ' +
      'truth. Measured: a replacement grab re-added the exact hash blocklisted minutes earlier.',
    `Recorded at ${savedTo}.`,
    '',
    'This did NOT search for a replacement. Use find_gaps and search_episode for that — and read ' +
      'hasFile first, because a stalled torrent for an episode already on disk is pure redundancy.',
  );
  return ok(lines.join('\n'));
}

/**
 * Push one torrent to the top of qBit's queue.
 *
 * ⚠️ Gated on `not-started` WITH A LIVE SWARM. Promoting a dead torrent moves it
 * up a queue it will fail at anyway, and promoting one nothing is waiting behind
 * achieves nothing. The case this exists for is real and documented:
 * dead torrents holding active slots while qBit promotes by ADD ORDER rather
 * than by health — which is how the client moved zero bytes for 24 h while
 * looking fully busy.
 *
 * ⚠️ NARROWER THAN IT WAS. `dont_count_slow_torrents` is now `true` (measured
 * 2026-08-26; the runbook still records the old `false`), with a 2 KB/s
 * threshold over 60 s, so qBit now sheds dead weight from the active set on its
 * own — `queuedDL` 8 → 0 while `metaDL` 3 → 8 inside one 15-minute window.
 * This verb is for the remaining case: something healthy waiting behind a full
 * active set.
 */
async function runPromote(ctx: ToolContext, rawHash: unknown, fetchImpl?: FetchImpl) {
  const hash = typeof rawHash === 'string' ? rawHash : '';
  const state = await collect(ctx, fetchImpl);
  if ('error' in state) return fail(state.error);

  const found = gate(state.items, hash, 'not-started', 'promote');
  if ('refusal' in found) return fail(found.refusal);
  const torrent = found.item.torrent!;
  if (torrent.numComplete <= 0) {
    return fail(
      `REFUSED — ${torrent.name} is waiting in the queue but its swarm has 0 seeds, so moving it up ` +
        'the queue only gives it a slot to fail in. Promotion helps a HEALTHY torrent stuck behind ' +
        'dead ones; this is not that.',
    );
  }

  const before = torrent.priority;
  const sent = await setTopPriority(ctx.config.qbittorrent.lanUrl, torrent.hash, fetchImpl);
  if (sent.state !== 'ok') return fail(`Could not promote ${torrent.name}.\n${sent.detail}`);

  const after = await fetchTorrents(ctx.config.qbittorrent.lanUrl, fetchImpl);
  if (after.state !== 'ok') {
    return fail(
      `qBittorrent accepted the request (HTTP ${sent.value.status}) but I could NOT re-read the ` +
        `priority, so whether ${torrent.name} actually moved is UNKNOWN. ` +
        'The status code is not the outcome here — a topPrio call returns 200 even for a torrent ' +
        'that does not exist.',
    );
  }
  const now = after.value.find((t) => t.hash === torrent.hash)?.priority;

  /**
   * 🔴 THE COMPARISON IS THE RESULT. Measured: a batched `topPrio` returns 200
   * with every priority unchanged, and a `topPrio` for a hash that does not
   * exist also returns 200. There is no success signal in the response.
   */
  if (now === undefined) {
    return fail(`${torrent.name} is no longer in qBittorrent at all, so its priority is UNKNOWN.`);
  }
  if (now === before) {
    return fail(
      `⚠️ ${torrent.name} did NOT move. qBittorrent returned HTTP ${sent.value.status} and the ` +
        `priority is still ${now}. That combination is documented: the status code is not the ` +
        'outcome. Do not report this as done.',
    );
  }
  return ok(
    `${torrent.name} moved to priority ${now} (was ${before}) — verified by re-reading, not by the ` +
      `HTTP ${sent.value.status}.\nIt still has to find peers; ${torrent.numComplete} seed(s) in the ` +
      'swarm say it can.',
  );
}

/**
 * Write down what is about to be deleted. 0600 in a 0700 directory, created
 * with `wx` so an existing path is an error rather than something to widen.
 *
 * ⚠️ Throws rather than returning an error, so the delete below cannot be
 * reached by ignoring a return value.
 */
function captureRemoval(dir: string, item: Item): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const hash = item.torrent?.hash ?? item.release?.releaseId ?? 'unknown';
  const path = join(dir, `removed-${hash.slice(0, 12)}-${stamp}.json`);
  const body = JSON.stringify(
    {
      removedAt: new Date().toISOString(),
      infohash: item.torrent?.hash ?? null,
      releaseTitle: item.release?.releaseTitle ?? item.torrent?.name ?? null,
      subject: item.release?.subject ?? null,
      service: item.release?.service ?? null,
      arrRowIds: item.release?.rowIds ?? [],
      qbitState: item.torrent?.state ?? null,
      hoursActive: item.torrent ? Math.floor(item.torrent.timeActiveSeconds / 3600) : null,
      swarmSeeds: item.torrent?.numComplete ?? null,
      arrMessages: item.release?.messages ?? [],
    },
    null,
    1,
  );
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, body, null, 'utf8');
  } finally {
    closeSync(fd);
  }
  return path;
}

interface Item {
  release: Release | null;
  torrent: QbitTorrent | null;
  verdict: QbitVerdict | { kind: 'unseen' };
}

/**
 * 🔴 ONE GATHER, ONE JOIN, ONE VERDICT — used by the listing AND by every action.
 *
 * If the actions recomputed their own view, the thing the caller was shown and
 * the thing the gate decides on could disagree, and the gap between them is
 * exactly where a wrong target gets through. Same snapshot, same rules.
 */
async function collect(
  ctx: ToolContext,
  fetchImpl?: FetchImpl,
): Promise<{ items: Item[]; torrentCount: number; unreadable: string[] } | { error: string }> {
  const torrents = await fetchTorrents(ctx.config.qbittorrent.lanUrl, fetchImpl);

  /**
   * 🔴 NO qBIT, NO VERDICT — AND THAT IS A REFUSAL, NOT A DEGRADED ANSWER.
   *
   * The arr queue alone cannot tell a stall from a healthy download; that is the
   * whole reason this tool exists. Answering from it would reproduce the
   * measured 10-of-18 blind spot wearing the authority of a tool whose name says
   * it finds stuck downloads.
   */
  if (torrents.state !== 'ok') {
    return {
      error:
        `I could NOT read qBittorrent, so I cannot tell you what is stuck.\n${torrents.detail}\n` +
        'This is UNKNOWN, not "nothing is stuck". The arr queue on its own cannot distinguish a ' +
        'dead torrent from a healthy one — measured, it misses more than half of real stalls — so ' +
        'I am not going to answer from it.',
    };
  }

  const index = byHash(torrents.value);
  const arr = await readArrQueues(ctx, fetchImpl);

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
  return { items, torrentCount: torrents.value.length, unreadable: arr.unreadable };
}

function arrClientFor(ctx: ToolContext, service: 'sonarr' | 'radarr', fetchImpl?: FetchImpl): ArrClient {
  return service === 'sonarr'
    ? new ArrClient({ ...ctx.config.sonarr, fetchImpl }, 'series')
    : new ArrClient({ ...ctx.config.radarr, fetchImpl }, 'movie');
}

async function runList(ctx: ToolContext, fetchImpl?: FetchImpl) {
  const state = await collect(ctx, fetchImpl);
  if ('error' in state) return fail(state.error);
  const { items, torrentCount, unreadable } = state;
  const arrCount = items.filter((i) => i.release).length;

  const lines: string[] = [
    `STUCK DOWNLOADS — read at ${new Date().toISOString()}. Nothing was changed.`,
    `${torrentCount} torrents in qBittorrent; ${arrCount} releases in the arr queues.`,
  ];
  if (unreadable.length) {
    lines.push(
      `⚠️ ${unreadable.join('; ')}. Those queues are UNKNOWN, not empty — anything of theirs is ` +
        'missing from the list below, so do not read this as a complete picture.',
    );
  }

  const of = (kind: string) => items.filter((i) => i.verdict.kind === kind);
  const stalled = of('stalled');

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
