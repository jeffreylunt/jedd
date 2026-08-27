import { ArrClient, type FetchImpl } from '../media/arr.js';
import { classify, matching, type Assessment, type Release } from '../media/queue.js';
import { fail, ok, type Tool, type ToolContext } from './types.js';

/**
 * "What is downloading?" — asked with a title or without one.
 *
 * 🔴 ONE QUESTION, ONE ANSWER, ONE SOURCE. See `src/media/queue.ts` for the V1
 * defect this shape exists to make unrepresentable: two sources of truth for one
 * fact, which reported an empty queue while Sonarr had 26 active downloads.
 *
 * There is no `status_for_title` beside this tool, and there must not be one.
 * The moment a title gets its own fetch path, the two answers can drift — and
 * the drift is invisible, because each path is individually plausible.
 */

interface Half {
  service: 'sonarr' | 'radarr';
  releases: Release[];
  /** Non-empty when this half could not be read. Never rendered as "nothing here". */
  unknown: string | null;
  saturated: boolean;
}

/**
 * Read both queues.
 *
 * 🔴 AN UNREADABLE HALF IS `unknown`, NEVER ZERO. If Sonarr is unreachable the
 * honest answer is "I could not see the TV queue", and the answer that must
 * never be produced is "nothing is downloading" — which is what an empty array
 * would silently become one line later. This is the same three-state discipline
 * as `LibraryAnswer`, for the same reason: a confident false negative about
 * something Jeff can see with his own eyes is the expensive failure.
 */
async function snapshot(ctx: ToolContext, fetchImpl?: FetchImpl): Promise<Half[]> {
  const clients: Array<[Half['service'], ArrClient]> = [
    ['sonarr', new ArrClient({ ...ctx.config.sonarr, fetchImpl }, 'series')],
    ['radarr', new ArrClient({ ...ctx.config.radarr, fetchImpl }, 'movie')],
  ];
  return Promise.all(
    clients.map(async ([service, client]): Promise<Half> => {
      const res = await client.queue();
      if (res.state === 'unknown') return { service, releases: [], unknown: res.detail, saturated: false };
      return { service, releases: res.releases, unknown: null, saturated: res.saturated };
    }),
  );
}

/**
 * 🔴 THE ANSWER IS GROUPED BEFORE IT IS RENDERED, AND THE LIVE QUEUE IS WHY.
 *
 * The first live run of this tool returned a CORRECT answer that was unusable:
 * fifteen near-identical lines, one per stopped Fringe episode, each repeating
 * the same forty-word explanation of what a stopped torrent is. About 2,700
 * tokens to say one thing — into an ~18 GB model whose entire margin comes from
 * a lean context, and into a person who wanted to know whether Fringe was
 * moving.
 *
 * No fixture was going to catch that. The test queues have one or two rows, and
 * at that size the per-release renderer is perfectly readable; the defect only
 * exists at the shape the real queue has. It is the same lesson the live ebook
 * run taught, in a different costume: **a fixture cannot disagree with the
 * assumption that produced it.**
 *
 * ⚠️ This grouping is for DISPLAY and it is a different axis from the grouping
 * in `parseQueue`. That one turns rows into releases and must happen before
 * anything is counted; this one turns releases into sentences. The release count
 * stays visible in every group precisely so the two never get confused again.
 */
interface Group {
  kind: Assessment['verdict']['kind'];
  subject: string;
  releases: number;
  /** Arr rows, i.e. episodes. Prose only — never a threshold input. */
  rows: number;
  oldestHours: number;
  percents: number[];
  observed: string;
  messages: string[];
  wouldResolve: string;
}

function group(assessments: Assessment[]): Group[] {
  const byKey = new Map<string, Group>();
  for (const a of assessments) {
    const key = `${a.verdict.kind}::${a.release.subject}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.releases += 1;
      existing.rows += a.release.rows;
      existing.oldestHours = Math.max(existing.oldestHours, a.ageHours);
      if (a.verdict.kind === 'progressing') existing.percents.push(a.verdict.percent);
      for (const m of a.release.messages) if (!existing.messages.includes(m)) existing.messages.push(m);
      continue;
    }
    byKey.set(key, {
      kind: a.verdict.kind,
      subject: a.release.subject,
      releases: 1,
      rows: a.release.rows,
      oldestHours: a.ageHours,
      percents: a.verdict.kind === 'progressing' ? [a.verdict.percent] : [],
      observed: `client says "${a.release.status}", arr says ${a.release.trackedStatus}/${a.release.trackedState}`,
      messages: [...a.release.messages],
      wouldResolve: a.response.wouldResolve,
    });
  }
  return [...byKey.values()];
}

function age(hours: number): string {
  return hours < 1 ? `${Math.round(hours * 60)}m` : `${Math.round(hours)}h`;
}

function scale(g: Group): string {
  // "15 releases (15 episodes)" is noise; "1 release (9 episodes)" is the whole
  // point, because that is the season pack V1 counted as nine stuck downloads.
  const rows = g.rows !== g.releases ? ` covering ${g.rows} episodes` : '';
  return g.releases === 1 ? `1 release${rows}` : `${g.releases} releases${rows}`;
}

/** How one GROUP reads in the answer. The remedy appears once per group, not once per release. */
function line(g: Group): string {
  const head = `${g.subject}: ${scale(g)}`;
  const msgs = g.messages.length ? `\n    arr messages: ${g.messages.slice(0, 3).join('; ')}` : '';
  const fix = `\n    → ${g.wouldResolve}`;

  switch (g.kind) {
    case 'progressing': {
      const lo = Math.min(...g.percents);
      const hi = Math.max(...g.percents);
      const pct = lo === hi ? `${lo}%` : `${lo}–${hi}%`;
      return `DOWNLOADING ${pct} — ${head}, started ${age(g.oldestHours)} ago`;
    }
    case 'importing':
      return `IMPORTING (downloaded, being moved into the library) — ${head}`;
    case 'import-blocked':
      return `IMPORT BLOCKED — ${head}. The download FINISHED ${age(g.oldestHours)} ago; the import did not.${msgs}${fix}`;
    case 'stopped':
      /**
       * 🔴 THE AGE IS SINCE IT WAS QUEUED. IT IS NOT HOW LONG IT HAS BEEN STOPPED.
       *
       * This read "0% after 49h" and a human read it — correctly, from the
       * words — as "stopped for 49 hours". It had in fact been stopped **27
       * minutes** earlier, deliberately, by someone reclaiming download slots.
       * 49h was the age of the QUEUE ITEM.
       *
       * The stop carries **no timestamp anywhere**. qBittorrent's `last_activity`
       * equals `added_on` for a torrent that never transferred a byte, so even
       * that field reads as "last did something on the 22nd" when it means "was
       * added on the 22nd and has done nothing since". There is no field to ask.
       *
       * So the sentence says what the number IS, and says the unknown out loud.
       * An age silently relabelled as a duration is how a reader reconstructs a
       * two-day-old outage out of a decision somebody made this afternoon.
       */
      return `STOPPED in the download client — ${head}. 0% in the ${age(g.oldestHours)} since it was queued; I cannot tell you WHEN it was stopped, because nothing records that (${g.observed})${fix}`;
    case 'starting':
      return `JUST STARTED — ${head}, ${age(g.oldestHours)} ago, nothing downloaded yet (normal at this age)`;
    case 'no-peers':
      return `NO PEERS — ${head}, ${age(g.oldestHours)} old and not even the torrent metadata has arrived${fix}`;
    case 'stalled':
      return `STALLED — ${head}, ${age(g.oldestHours)} old and not one byte has arrived (${g.observed})${fix}`;
  }
}

/** Beyond this many groups the answer stops being readable; the worst are kept. */
const MAX_GROUPS = 12;

export function makeCheckStatus(fetchImpl?: FetchImpl, now: () => Date = () => new Date()): Tool {
  return {
    name: 'check_status',
    // Spans several services and degrades partially — but needs at least ONE.
    needsAnyService: ['sonarr', 'radarr'],
    description:
      'What is downloading right now, and how it is going. Answers both "what is downloading?" and ' +
      '"is <title> downloading?" — pass the title only to narrow the same answer. This reads the ' +
      'Sonarr/Radarr queue live; it is the only place that knows, so use it instead of guessing from ' +
      'earlier messages.',
    minRole: 'guest',
    writes: false,
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Optional. Narrow the answer to one show or film. Omit for everything.',
        },
      },
      required: [],
    },
    async run(args, ctx) {
      const title = typeof args['title'] === 'string' ? args['title'].trim() : '';
      const halves = await snapshot(ctx, fetchImpl);

      const unreadable = halves.filter((h) => h.unknown);
      // 🔴 BOTH halves unreadable is a FAILURE, not an empty queue.
      if (unreadable.length === halves.length) {
        return fail(
          'I could NOT read the download queue, so I do not know what is downloading. This is not ' +
            `"nothing is downloading" — I could not look. ${unreadable.map((h) => `${h.service}: ${h.unknown}`).join(' | ')}`,
        );
      }

      const all = halves.flatMap((h) => h.releases);
      // The named title FILTERS the general answer. It does not fetch its own.
      const selected = title ? matching(all, title) : all;
      const at = now();
      const assessments = selected.map((r) => classify(r, at));

      const caveats: string[] = [];
      for (const h of unreadable) {
        caveats.push(
          `⚠️ Could not read the ${h.service} queue (${h.unknown}), so ${h.service === 'sonarr' ? 'TV' : 'film'} ` +
            'downloads are MISSING from this answer — not absent.',
        );
      }
      for (const h of halves.filter((x) => x.saturated)) {
        caveats.push(`⚠️ The ${h.service} queue is longer than one page; this list is truncated.`);
      }

      if (assessments.length === 0) {
        const scope = title ? `Nothing matching "${title}" is in the download queue.` : 'Nothing is downloading.';
        const readable = halves.filter((h) => !h.unknown).map((h) => h.service).join(' and ');
        return ok([`${scope} (Read live from the ${readable} queue just now.)`, ...caveats].join('\n'));
      }

      // Problems first: the reason someone asks is usually that something is wrong.
      const rank: Record<Assessment['verdict']['kind'], number> = {
        'import-blocked': 0,
        stalled: 1,
        'no-peers': 2,
        stopped: 3,
        progressing: 4,
        importing: 5,
        starting: 6,
      };
      assessments.sort((a, b) => rank[a.verdict.kind] - rank[b.verdict.kind]);

      const groups = group(assessments);
      const shown = groups.slice(0, MAX_GROUPS);
      const hidden = groups.length - shown.length;
      const header = title
        ? `${assessments.length} release(s) matching "${title}" in the queue:`
        : `${assessments.length} release(s) in the download queue:`;
      const more = hidden > 0 ? [`  ...and ${hidden} more group(s) not shown.`] : [];
      return ok([header, ...shown.map((g) => `  - ${line(g)}`), ...more, ...caveats].join('\n'));
    },
  };
}
