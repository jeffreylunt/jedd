import {
  hoursBetween,
  humaniseHours,
  IndexerAdminClient,
  INDEXER_SERVICES,
  classifyFailure,
  readsBackoff,
  type BackoffRow,
  type FetchImpl,
  type IndexerRow,
  type IndexerService,
  type TestOutcome,
} from '../media/indexer-admin.js';
import { fail, ok, type Tool } from './types.js';

/**
 * THE WRITE PATH FOR INDEXERS. Owner-only.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * Jeff, 2026-08-26: *"Can you fix the torrent indexers in prowler?"* — and Jedd
 * could not, correctly: *"I have no tool to enable or re-enable indexers in
 * Prowlarr."* `homelab_read` can see `/api/v1/indexerstatus` and nothing on any
 * service could change it, because that tool's method is a GET literal.
 *
 * ── 🔴 WHAT "FIX THE INDEXERS" CAN AND CANNOT DO, STATED IN THE TOOL ─────────
 *
 * There are two completely different faults that both present as "the indexers
 * are broken", and only ONE of them is fixable from here:
 *
 *  - **STALE BACKOFF — fixable, and this is the whole reason the tool exists.**
 *    Sonarr and Radarr each keep their own per-indexer failure state. After a
 *    gluetun wedge (or, recorded 2026-06-21, after nothing at all) they hold
 *    indexers disabled long after the network recovered: Prowlarr reads healthy,
 *    a direct Prowlarr search returns hundreds of results, and every arr
 *    `/release` search still returns 0. A force-test that PASSES resets that
 *    timer. No restart of anything.
 *  - **THE SITE REFUSING US — not fixable, and testing makes it slightly
 *    worse.** A `403 Forbidden` is the tracker turning the request away. No
 *    timer reset changes that, and a failed test re-arms the backoff from now.
 *
 * The tool tells them apart in its own output rather than leaving the model to
 * infer it, because the two produce the same "I tested the indexers" sentence
 * and only one of them means anything was repaired.
 *
 * ── 🔴 THIS TOOL IS ITS OWN PRODUCER ────────────────────────────────────────
 *
 * `test`, `enable` and `disable` need an indexer id, and **nothing else in this
 * repo can hand one over for a HEALTHY indexer.** `homelab_read` reaches
 * Prowlarr's `/api/v1/indexerstatus`, which lists only the ones currently
 * FAILING — `[]` when all is well — and `/api/v1/indexer`, the full list, is
 * denied to it as SECRET because the resource carries tracker credentials in its
 * `fields` array. So a tool that only consumed an id would be reachable exactly
 * when something was already broken, and uncallable the rest of the time: the
 * orphaned-consumer shape that shipped `add_audiobook` and `send_ebook`
 * uncallable. `action: "list"` is the producer, it lives here, and it projects
 * the resource to four scalars so no credential is in the answer.
 */

type Action = 'list' | 'test' | 'test_all' | 'enable' | 'disable';

const ACTIONS: Action[] = ['list', 'test', 'test_all', 'enable', 'disable'];

/** Past this, the standing rule says report once and stop retrying. */
const REPORT_ONCE_HOURS = 72;

export function makeIndexerAdmin(fetchImpl?: FetchImpl): Tool {
  return {
    name: 'indexer_admin',
    description:
      'Force-test, enable or disable the torrent indexers on Prowlarr, Sonarr or Radarr, and read ' +
      'back what actually happened. This is the only write path to an indexer; homelab_read can see ' +
      'their health and can never change it.\n' +
      'PICK THE RIGHT SERVICE — this is the part that decides whether anything is fixed:\n' +
      '• "searches find nothing / nothing is downloading / Sonarr says no results" → the stale ' +
      'backoff is on the ARR. Run test_all against "sonarr" AND "radarr". Sonarr and Radarr each ' +
      "keep their OWN indexer failure state, separate from Prowlarr's, and it survives the network " +
      'recovering: Prowlarr can read perfectly healthy and return hundreds of results while every ' +
      'arr search returns 0. A force-test that PASSES resets that timer, and nothing needs ' +
      'restarting.\n' +
      '• "the indexers are down / an indexer is red in Prowlarr" → run test_all against "prowlarr".\n' +
      "• Not sure → do prowlarr first (it is the upstream and it can be READ), then both arrs.\n" +
      'ACTIONS: list — every indexer with its id, whether it is on, and its backoff. Run this FIRST; ' +
      'ids are per-service and do NOT match between Prowlarr, Sonarr and Radarr. test — force-test ' +
      'one id; this is the backoff reset. test_all — force-test every ENABLED indexer on that ' +
      'service in one call (a disabled one is skipped, so a missing id is not a missing result); ' +
      'takes 20-40s. enable / disable — turn one indexer on or off; PROWLARR ONLY, because a Sonarr ' +
      'or Radarr indexer has no such switch (measured) and the arr ones are all Prowlarr proxies ' +
      'anyway, so the real switch is upstream.\n' +
      '🔴 A 403 IS NOT FIXABLE FROM HERE AND YOU MUST NOT IMPLY IT WAS FIXED. If a test fails with ' +
      'Forbidden, the tracker refused us — a backoff reset cannot change that, and the failed test ' +
      'pushes the backoff a further 24h out. Say "tested, still 403 — that is the site refusing us, ' +
      'not something wrong on our side." Never say re-enabled, refreshed or fixed. A 403 lasting ' +
      'over 3 days while the other indexers are green is reported ONCE and then left alone.\n' +
      'WHAT THIS CANNOT DO: it cannot make a dead tracker answer, it cannot add or configure an ' +
      'indexer, and it never restarts a container. If a test fails with a timeout or a network error ' +
      'rather than a 403, the VPN tunnel is the likely cause and that is a separate problem — say so ' +
      'instead of retrying.\n' +
      'Every call ends by re-reading the live state and printing it, so the answer is what IS, not ' +
      'what was requested. Report the per-indexer result; do not summarise it as "done".',
    /**
     * 🔴 OWNER-ONLY. Jeff asked for this **"as the owner"**, and it is a write
     * against shared infrastructure: disabling an indexer degrades searching for
     * everyone in the house, and a force-test spends the tracker rate limits
     * that Sonarr's and Radarr's `/health` already complain about. Neither is
     * recoverable by the guest who triggered it.
     *
     * ⚠️ Unlike `add_movie` and `add_series`, which Jeff opened to guests
     * ("guests can request real media"), nothing here is about a guest getting
     * content — it is about the plumbing that serves everyone.
     */
    minRole: 'owner',
    /**
     * 🔴 TRUE, INCLUDING FOR `action: "list"`.
     *
     * Write-ness is a property of the TOOL, not of the argument it happened to
     * be called with — the read-only kill switch quantifies over `writes` and
     * has no way to see an action enum. Declaring `false` to keep `list`
     * available under `JEDD_ALLOW_WRITES` unset would hand the same tool object
     * its write actions as well.
     *
     * The cost is real and accepted: with writes off, this tool does not exist,
     * so indexer backoff cannot be read either. `homelab_read` still reaches
     * Prowlarr's `/api/v1/indexerstatus` and both arrs' `/health`, which is the
     * diagnosis half; only the repair is gone, which is exactly what that switch
     * is for.
     */
    writes: true,
    parameters: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          enum: INDEXER_SERVICES,
          description:
            'Which service to act on. "sonarr"/"radarr" hold the backoff that stops SEARCHES; ' +
            '"prowlarr" is the upstream that talks to the trackers.',
        },
        action: {
          type: 'string',
          enum: ACTIONS,
          description: 'What to do. Start with "list" — it is where the ids come from.',
        },
        id: {
          type: 'number',
          description:
            'The indexer id, for test / enable / disable. Comes from this tool\'s own "list" action ' +
            'on the SAME service — ids are not shared between services.',
        },
      },
      required: ['service', 'action'],
    },

    async run(args, ctx) {
      const service = args['service'];
      if (typeof service !== 'string' || !(INDEXER_SERVICES as string[]).includes(service)) {
        return fail(
          `"${String(service)}" is not a service I can administer. Choose one of: ` +
            `${INDEXER_SERVICES.join(', ')}. Nothing was done.`,
        );
      }
      const action = args['action'];
      if (typeof action !== 'string' || !(ACTIONS as string[]).includes(action)) {
        return fail(`"${String(action)}" is not an action. Choose one of: ${ACTIONS.join(', ')}. Nothing was done.`);
      }

      const svc = service as IndexerService;
      const client = new IndexerAdminClient({ service: svc, config: ctx.config, fetchImpl });
      if (!client.configured) {
        return fail(`${client.label} has no API key configured, so nothing can be read or changed here.`);
      }

      switch (action as Action) {
        case 'list':
          return runList(client, svc);
        case 'test':
          return runTest(client, svc, args['id']);
        case 'test_all':
          return runTestAll(client, svc);
        case 'enable':
        case 'disable':
          return runToggle(client, svc, args['id'], action === 'enable');
        default:
          return fail(`Unhandled action "${action}". Nothing was done.`);
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIONS
// ─────────────────────────────────────────────────────────────────────────────

async function runList(client: IndexerAdminClient, service: IndexerService) {
  const snap = await snapshot(client, service);
  if ('error' in snap) return fail(snap.error);
  return ok(`${client.label} indexers — nothing was changed.\n\n${renderSnapshot(client, service, snap)}`);
}

async function runTest(client: IndexerAdminClient, service: IndexerService, rawId: unknown) {
  const id = asId(rawId);
  if (id === null) {
    return fail(
      'No indexer `id` supplied, so nothing was tested. Run this tool with action "list" against ' +
        `"${service}" first — that is where the ids come from, and they differ per service.`,
    );
  }

  const before = await snapshot(client, service);
  if ('error' in before) return fail(before.error);
  const name = before.indexers.find((i) => i.id === id)?.name ?? `id ${id}`;

  const result = await client.testOne(id, name);
  if (result.state !== 'ok') return fail(`Force-test of ${client.label} ${name} did not complete.\n${result.detail}`);

  const after = await snapshot(client, service);
  const lines = [
    `Force-tested ${client.label} indexer ${id} (${name}).`,
    '',
    renderOutcome(result.value, before.indexers),
    ...verdictNotes([result.value], before, 'error' in after ? null : after, client, service),
  ];
  if ('error' in after) {
    lines.push('', `⚠️ The test ran, but re-reading the state afterwards failed: ${after.error}`);
    return ok(lines.join('\n'));
  }
  lines.push('', renderSnapshot(client, service, after));
  return ok(lines.join('\n'));
}

async function runTestAll(client: IndexerAdminClient, service: IndexerService) {
  const before = await snapshot(client, service);
  if ('error' in before) return fail(before.error);

  const result = await client.testAll();
  if (result.state !== 'ok') return fail(`Force-test of all ${client.label} indexers did not complete.\n${result.detail}`);

  const outcomes = result.value.map((o) => ({
    ...o,
    name: o.name || before.indexers.find((i) => i.id === o.id)?.name || `id ${o.id}`,
  }));
  const passed = outcomes.filter((o) => o.passed);
  const failed = outcomes.filter((o) => !o.passed);
  const after = await snapshot(client, service);

  const lines = [
    `Force-tested all ${outcomes.length} ENABLED ${client.label} indexer(s): ` +
      `${passed.length} passed, ${failed.length} failed.` +
      (before.indexers.length > outcomes.length
        ? ` (${before.indexers.length - outcomes.length} disabled indexer(s) were not tested — ` +
          'that is not a missing result.)'
        : ''),
    '',
    ...outcomes.map((o) => renderOutcome(o, before.indexers)),
    ...verdictNotes(outcomes, before, 'error' in after ? null : after, client, service),
  ];
  if ('error' in after) {
    lines.push('', `⚠️ The tests ran, but re-reading the state afterwards failed: ${after.error}`);
    return ok(lines.join('\n'));
  }
  lines.push('', renderSnapshot(client, service, after));
  return ok(lines.join('\n'));
}

async function runToggle(
  client: IndexerAdminClient,
  service: IndexerService,
  rawId: unknown,
  enable: boolean,
) {
  const verb = enable ? 'enable' : 'disable';
  const id = asId(rawId);
  if (id === null) {
    return fail(
      `No indexer \`id\` supplied, so nothing was ${verb}d. Run this tool with action "list" ` +
        `against "${service}" first.`,
    );
  }

  const before = await snapshot(client, service);
  if ('error' in before) return fail(before.error);
  const name = before.indexers.find((i) => i.id === id)?.name ?? `id ${id}`;

  const result = await client.setEnable(id, enable);
  if (result.state !== 'ok') return fail(`Could not ${verb} ${client.label} ${name}.\n${result.detail}`);

  const after = await snapshot(client, service);
  const headline = result.value.changed
    ? `${client.label} indexer ${id} (${name}) is now ${enable ? 'ENABLED' : 'DISABLED'}.`
    : `${client.label} indexer ${id} (${name}) was ALREADY ${enable ? 'enabled' : 'disabled'} — ` +
      'nothing was changed. Say that rather than reporting a change.';

  const lines = [headline];
  if (enable) {
    /**
     * ⚠️ ENABLING SAYS NOTHING ABOUT WHETHER IT WORKS. The save is forced past
     * validation on purpose (a broken indexer cannot be saved otherwise), so
     * "enabled" is a statement about configuration and not about health. Point
     * at the test rather than letting "enabled" be heard as "working".
     */
    lines.push(
      '',
      '⚠️ Enabling does NOT mean it works — the save deliberately skips validation, or a broken ' +
        'indexer could never be re-enabled at all. Run action "test" on this id to find out whether ' +
        'the tracker actually answers.',
    );
  }
  if ('error' in after) {
    lines.push('', `⚠️ The change was made, but re-reading the state afterwards failed: ${after.error}`);
    return ok(lines.join('\n'));
  }
  lines.push('', renderSnapshot(client, service, after));
  return ok(lines.join('\n'));
}

// ─────────────────────────────────────────────────────────────────────────────
// STATE — read fresh after every action, so the answer is what IS
// ─────────────────────────────────────────────────────────────────────────────

export interface Snapshot {
  indexers: IndexerRow[];
  /** Prowlarr only. `null` means the service cannot report it — NOT "none". */
  backoff: BackoffRow[] | null;
  backoffNote: string | null;
  health: string[];
  healthNote: string | null;
  readAt: Date;
}

async function snapshot(client: IndexerAdminClient, service: IndexerService): Promise<Snapshot | { error: string }> {
  const list = await client.list();
  if (list.state !== 'ok') return { error: list.detail };

  const backoff = await client.backoff();
  const health = await client.indexerHealth();

  return {
    indexers: [...list.value].sort((a, b) => a.id - b.id),
    backoff: backoff.state === 'ok' ? backoff.value : null,
    backoffNote: backoff.state === 'ok' ? null : backoff.detail,
    health: health.state === 'ok' ? health.value : [],
    healthNote: health.state === 'ok' ? null : `⚠️ ${client.label} /health could not be read: ${health.detail}`,
    readAt: new Date(),
  };
}

function renderSnapshot(client: IndexerAdminClient, service: IndexerService, snap: Snapshot): string {
  const lines = [`STATE NOW — ${client.label}, read at ${snap.readAt.toISOString()}:`];
  for (const row of snap.indexers) {
    lines.push(`  id ${row.id}  ${row.name}  ${describeSwitches(row)}  ${describeBackoff(row.id, snap)}`);
  }
  if (snap.backoffNote) lines.push(`⚠️ ${snap.backoffNote}`);
  if (snap.healthNote) lines.push(snap.healthNote);
  if (snap.health.length) {
    lines.push(`${client.label} health, indexer-related:`);
    for (const m of snap.health) lines.push(`  ${m}`);
    if (!readsBackoff(service)) {
      lines.push(
        '  ⚠️ This warning is SLOW to clear — the runbook records it taking a few hours after a ' +
          'successful reset. Still seeing it right after a passing test does NOT mean the reset ' +
          'failed, and reporting it as a failure would be wrong.',
      );
    }
  } else if (!snap.healthNote) {
    lines.push(`${client.label} reports NO indexer health warnings.`);
  }
  return lines.join('\n');
}

function describeSwitches(row: IndexerRow): string {
  if (row.enable === true) return 'enabled';
  if (row.enable === false) return 'DISABLED';
  // The arrs: three switches and no `enable`. Naming them is the honest render —
  // printing "enabled" over a field that does not exist would be inventing one.
  return row.switches.length ? `on for ${row.switches.join(', ')}` : 'no search modes enabled';
}

function describeBackoff(id: number, snap: Snapshot): string {
  if (snap.backoff === null) return 'backoff UNREADABLE here';
  const row = snap.backoff.find((b) => b.indexerId === id);
  if (!row) return 'ok';
  /**
   * 🔴 THE AGE COMES FROM `initialFailure`, NEVER FROM `mostRecentFailure`.
   *
   * `mostRecentFailure` is rewritten by every retry and by every failing
   * force-test — measured moving three times inside one hour while the outage
   * was already a day old. Anchoring the age there turns a four-day outage into
   * a thirty-minute-old blip, which is the difference between "report once and
   * stop" and "something just broke, go and look".
   */
  const hours = hoursBetween(row.initialFailure, snap.readAt);
  const since =
    row.initialFailure === null
      ? 'failing (start time not reported)'
      : `FAILING since ${row.initialFailure}` + (hours === null ? '' : ` (${humaniseHours(hours)})`);
  const till = row.disabledTill ? ` — backed off until ${row.disabledTill}` : '';
  return `🔴 ${since}${till}`;
}

function renderOutcome(outcome: TestOutcome, before: IndexerRow[]): string {
  const name = outcome.name || before.find((i) => i.id === outcome.id)?.name || `id ${outcome.id}`;
  if (outcome.passed) {
    return `  ✅ id ${outcome.id} ${name} — PASSED. Its backoff timer is reset.`;
  }
  const why = outcome.errors.length ? outcome.errors.join(' / ') : 'no reason reported';
  return `  ❌ id ${outcome.id} ${name} — FAILED: ${why}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE VERDICT — what the result MEANS, decided in code
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 🔴 THE TOOL SAYS WHAT ITS OWN RESULT MEANS, RATHER THAN LEAVING IT TO PROSE.
 *
 * "I force-tested the indexers" is the same sentence whether a real stale
 * backoff was cleared or a dead tracker was poked for the fourth time. The
 * repo's rule is to return the FACT rather than hope a guard reads it back out
 * of English, so the classification happens here, on the structured result, and
 * travels with it.
 */
function verdictNotes(
  outcomes: TestOutcome[],
  before: Snapshot,
  after: Snapshot | null,
  client: IndexerAdminClient,
  service: IndexerService,
): string[] {
  const notes: string[] = [];
  const failed = outcomes.filter((o) => !o.passed);
  const passed = outcomes.filter((o) => o.passed);

  // What the PASSES actually achieved, told apart from a no-op.
  if (passed.length) {
    const cleared = passed.filter((o) => wasBackedOff(before, o.id) && !wasBackedOff(after, o.id));
    if (cleared.length) {
      notes.push(
        '',
        `✅ REAL FIX: ${cleared.length} indexer(s) were in backoff before this and are not now — ` +
          `${cleared.map((o) => `${o.id} (${o.name})`).join(', ')}. That is the stale-backoff fault, ` +
          'and it is now cleared. Searches that were returning 0 should return results again.',
      );
    } else if (before.backoff !== null) {
      notes.push(
        '',
        `⚠️ NOTHING WAS ACTUALLY STUCK on ${client.label}: the indexer(s) that passed were not in ` +
          'backoff before the test either, so the test confirmed health rather than repairing ' +
          'anything. Do not report this as a fix.',
      );
    } else {
      notes.push(
        '',
        `⚠️ The passes reset ${client.label}'s backoff timers, and that is the documented remedy — ` +
          'but this service does not expose backoff over its API, so there is no before/after to ' +
          'show you. The passing test IS the evidence the reset happened. Say it that way: "tested ' +
          'and they pass, which resets the timer", not "I confirmed the backoff cleared".',
      );
    }
  }

  // What the FAILURES mean, and whether retrying is worth anything. Three
  // classes, three different next actions — see `classifyFailure`.
  for (const o of failed) {
    const kind = classifyFailure(o.errors);
    if (kind === 'forbidden') {
      notes.push('', siteRefusalNote(o, before, after, client, service));
    } else if (kind === 'rate-limited') {
      /**
       * 🔴 THE REQUEST NEVER REACHED THE TRACKER, AND THE FAULT IS ONE HOP UP.
       *
       * MEASURED on the first live arr run: Sonarr's test of "1337x (Prowlarr)"
       * failed `[429:TooManyRequests]` against `localhost:9696` — Prowlarr, not
       * the tracker — because Prowlarr's OWN indexer 6 was already backed off
       * with a 403. Retesting the arr cannot fix a fault that lives upstream,
       * and the arr's error names a different failure than the real one.
       */
      notes.push(
        '',
        `⏳ id ${o.id} (${o.name}) was RATE-LIMITED, not refused by the tracker — the request never ` +
          'reached the tracker at all. On an arr this almost always means the UPSTREAM Prowlarr is ' +
          'throttling it because Prowlarr\'s own copy of that indexer is already in backoff. ' +
          'Re-testing here cannot fix that. Run this tool with service "prowlarr", action "list", ' +
          'find the indexer with the same NAME, and read ITS state — the real fault and its real ' +
          'reason are there, and they may not look like this error at all.',
      );
    } else {
      notes.push(
        '',
        `❌ id ${o.id} (${o.name}) failed with neither a 403 nor a rate limit — it got no usable ` +
          'answer at all. That is the shape of a dead VPN tunnel rather than an indexer fault: ' +
          'check whether the container has egress before touching the indexer again. Do not keep ' +
          'retesting; a failed test re-arms the backoff from now.',
      );
    }
  }

  return notes;
}

/**
 * The paragraph that has to be in the OUTPUT rather than in a briefing
 * somewhere, because it is the difference between an honest report and an
 * implied repair.
 */
function siteRefusalNote(
  outcome: TestOutcome,
  before: Snapshot,
  after: Snapshot | null,
  client: IndexerAdminClient,
  service: IndexerService,
): string {
  const lines = [
    `🔴 id ${outcome.id} (${outcome.name}) — THIS IS THE SITE REFUSING US, NOT A BACKOFF, AND THE ` +
      'TEST DID NOT FIX IT.',
    '  A 403/Forbidden means the tracker itself turned the request away. Force-testing resets a ' +
      "backoff TIMER; it cannot change the tracker's mind. Tell them: \"tested, still 403 — that is " +
      'the site refusing us, not something wrong on our side." Do NOT say fixed, re-enabled or ' +
      'refreshed.',
  ];

  const age = failureAgeHours(before, outcome.id) ?? failureAgeHours(after, outcome.id);
  if (age !== null) {
    lines.push(`  It has been failing for ${humaniseHours(age)} (measured from the FIRST failure, not the last retry).`);
    if (age >= REPORT_ONCE_HOURS) {
      lines.push(
        `  That is past 3 days. The standing rule for this house: a 403 lasting more than 3 days ` +
          'while the other indexers are green is REPORTED ONCE and then left alone — not escalated, ' +
          'not retried on a schedule.',
      );
    }
  }

  const green = greenCount(after ?? before);
  if (green) {
    lines.push(
      `  Every other enabled ${client.label} indexer is green right now (${green.ok} of ${green.total}), ` +
        'so this is a single-indexer outage and searching still works.',
    );
  }

  const moved = backoffMoved(before, after, outcome.id);
  if (moved) {
    lines.push(
      `  ⚠️ AND THE TEST COST SOMETHING: its backoff moved ${moved.from} → ${moved.to}. A FAILED ` +
        'test re-arms the timer from now, so each retry pushes the next automatic attempt further ' +
        'out. Retrying gains nothing and loses that.',
    );
  } else if (!readsBackoff(service)) {
    lines.push(
      `  ⚠️ A failed test re-arms ${client.label}'s backoff from now, and ${client.label} does not ` +
        'expose backoff over its API, so that cost is real but not visible here. Retrying is still ' +
        'the wrong move.',
    );
  }

  return lines.join('\n');
}

function wasBackedOff(snap: Snapshot | null, id: number): boolean {
  return !!snap?.backoff?.some((b) => b.indexerId === id);
}

function failureAgeHours(snap: Snapshot | null, id: number): number | null {
  const row = snap?.backoff?.find((b) => b.indexerId === id);
  if (!row || !snap) return null;
  return hoursBetween(row.initialFailure, snap.readAt);
}

/** How many ENABLED indexers are not in backoff. `null` when backoff is unreadable. */
function greenCount(snap: Snapshot): { ok: number; total: number } | null {
  if (snap.backoff === null) return null;
  const enabled = snap.indexers.filter((i) => i.enable !== false);
  const bad = new Set(snap.backoff.map((b) => b.indexerId));
  return { ok: enabled.filter((i) => !bad.has(i.id)).length, total: enabled.length };
}

function backoffMoved(
  before: Snapshot,
  after: Snapshot | null,
  id: number,
): { from: string; to: string } | null {
  const from = before.backoff?.find((b) => b.indexerId === id)?.disabledTill;
  const to = after?.backoff?.find((b) => b.indexerId === id)?.disabledTill;
  if (!from || !to || from === to) return null;
  return { from, to };
}

/** An id must be a real integer. `"6"`, `6.5` and `NaN` are not ids. */
function asId(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}
