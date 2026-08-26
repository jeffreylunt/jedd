import {
  hoursBetween,
  humaniseHours,
  IndexerAdminClient,
  INDEXER_SERVICES,
  classifyFailure,
  type BackoffRow,
  type FetchImpl,
  type IndexerRow,
  type IndexerService,
  type TestOutcome,
} from '../media/indexer-admin.js';
import { stripCredentials } from '../homelab-read.js';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import type { Config } from '../config.js';
import { join } from 'node:path';
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

type Action =
  | 'list'
  | 'search_available'
  | 'test'
  | 'test_all'
  | 'enable'
  | 'disable'
  | 'add'
  | 'remove';

const ACTIONS: Action[] = [
  'list',
  'search_available',
  'test',
  'test_all',
  'enable',
  'disable',
  'add',
  'remove',
];

/** Catalogue matches shown at once. 625 definitions exist; a list is not an answer. */
const SEARCH_LIMIT = 12;

/** Past this, the standing rule says report once and stop retrying. */
const REPORT_ONCE_HOURS = 72;

export function makeIndexerAdmin(fetchImpl?: FetchImpl): Tool {
  return {
    name: 'indexer_admin',
    description:
      'Manage the torrent indexers on Prowlarr, Sonarr and Radarr — force-test, enable, disable, ' +
      'add and remove — and read back what actually happened. This is the only write path to an ' +
      'indexer; homelab_read can see their health and can never change it.\n' +
      'PICK THE RIGHT SERVICE — this is the part that decides whether anything is fixed:\n' +
      '• "searches find nothing / nothing is downloading / Sonarr says no results" → the stale ' +
      'backoff is on the ARR. Run test_all against "sonarr" AND "radarr". Sonarr and Radarr each ' +
      "keep their OWN indexer failure state, separate from Prowlarr's, and it survives the network " +
      'recovering: Prowlarr can read perfectly healthy and return hundreds of results while every ' +
      'arr search returns 0. A force-test that PASSES resets that timer, and nothing needs ' +
      'restarting. This is the highest-value thing this tool does.\n' +
      '• "the indexers are down / an indexer is red in Prowlarr" → test_all against "prowlarr".\n' +
      '• Adding or removing a tracker → "prowlarr" only. Every arr indexer is a Prowlarr proxy, so ' +
      'Prowlarr decides which trackers exist and pushes them out.\n' +
      'ACTIONS. list — every indexer with its id and whether it is on, plus its backoff on Prowlarr ' +
      '(the arrs do not expose backoff at all, so do not promise a figure for those). Run this ' +
      'FIRST; ids are per-service and do NOT match between Prowlarr, Sonarr and Radarr. ' +
      'search_available — search the 625 definitions Prowlarr ships, by `query`. This is where ' +
      '`add` gets its definition name, AND it is the only way to answer "is there an indexer for ' +
      'X?" — never assert from memory that a tracker is or is not supported, ask this. ' +
      'test — force-test one id; this is the backoff reset. test_all — force-test every ENABLED ' +
      'indexer on that service in one call (a disabled one is skipped, so a missing id is not a ' +
      'missing result); takes 20-40s. enable / disable — turn one indexer on or off. ' +
      'add — install a definition by name; takes ~25s because Prowlarr live-tests it before saving. ' +
      'remove — delete an indexer.\n' +
      '🔴 REMOVE IS RECOVERABLE AND YOU SHOULD SAY SO. The full configuration is saved to a file ' +
      'before anything is deleted, and the result gives you the path — report it, because it is how ' +
      'the change gets undone. If that file cannot be written, nothing is deleted. The saved file ' +
      'may hold tracker credentials: say the file contains them and where it is, and NEVER read ' +
      'them out or offer to.\n' +
      '🔴 ONLY "public" DEFINITIONS CAN BE ADDED. Of the 625, 475 are private and 63 semiPrivate — ' +
      'those need an account or API key this house does not have, and REGISTERING for a tracker is ' +
      "the owner's decision, never something you do because it would solve the problem. add refuses " +
      'them and says so.\n' +
      '🔴 A 403 IS NOT FIXABLE FROM HERE AND YOU MUST NOT IMPLY IT WAS FIXED. If a test fails with ' +
      'Forbidden, the tracker refused us — a backoff reset cannot change that, and the failed test ' +
      'pushes the backoff a further 24h out. Say "tested, still 403 — that is the site refusing us, ' +
      'not something wrong on our side." Never say re-enabled, refreshed or fixed. A 403 lasting ' +
      'over 3 days while the other indexers are green is reported ONCE and then left alone.\n' +
      'WHAT THIS CANNOT DO: it cannot make a dead tracker answer, it cannot register an account, ' +
      'and it never restarts a container. If a test fails with a timeout or a network error rather ' +
      'than a 403, the VPN tunnel is the likely cause and that is a separate problem — say so ' +
      'instead of retrying.\n' +
      'Every call tries to re-read the live state afterwards and print it. When that re-read ' +
      'SUCCEEDS the printed state is what IS; when it fails the tool says so, and then nothing ' +
      'about the current state is verified — repeat that caveat rather than dropping it. Report ' +
      'the per-indexer result; do not summarise it as "done".',
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
            'The indexer id, for test / enable / disable / remove. Comes from this tool\'s own ' +
            '"list" action on the SAME service — ids are not shared between services.',
        },
        query: {
          type: 'string',
          description:
            'For search_available: what to look for in the catalogue of 625 definitions, matched ' +
            'against the name and the description. Omit to see the first few, which is rarely useful.',
        },
        definition: {
          type: 'string',
          description:
            'For add: the definition NAME from search_available, e.g. "BTdirectory". A definition ' +
            'has no numeric id — the name IS the identifier.',
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
          return runList(client);
        case 'search_available':
          return runSearchAvailable(client, args['query']);
        case 'add':
          return runAdd(client, args['definition']);
        case 'remove':
          return runRemove(client, args['id'], ctx.config);
        case 'test':
          return runTest(client, args['id']);
        case 'test_all':
          return runTestAll(client);
        case 'enable':
        case 'disable':
          return runToggle(client, args['id'], action === 'enable');
        default:
          return fail(`Unhandled action "${action}". Nothing was done.`);
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIONS
// ─────────────────────────────────────────────────────────────────────────────

async function runList(client: IndexerAdminClient) {
  const snap = await snapshot(client);
  if ('error' in snap) return fail(snap.error);
  return ok(`${client.label} indexers — nothing was changed.\n\n${renderSnapshot(client, snap)}`);
}

/**
 * 🔴 ADD, REMOVE AND THE TOGGLES ARE PROWLARR-ONLY, AND FOR THE SAME REASON.
 *
 * Every Sonarr and Radarr indexer here is a Prowlarr proxy — their names end
 * "(Prowlarr)" and their URLs point at `localhost:9696/{prowlarrId}/api`.
 * Prowlarr PUSHES them; an indexer added directly to an arr is not managed by
 * anything and one removed there comes back on the next sync. So the arrs get
 * the operation that is genuinely theirs — force-testing, which resets THEIR
 * backoff — and coverage changes happen upstream where they mean something.
 */
function prowlarrOnly(client: IndexerAdminClient, operation: string): string | null {
  if (client.service === 'prowlarr') return null;
  return (
    `${operation} is a PROWLARR operation and this call named "${client.service}". Every ` +
    `${client.label} indexer here is a Prowlarr proxy (their names end "(Prowlarr)"), so Prowlarr ` +
    'is what decides which trackers exist — a coverage change made on ' +
    `${client.label} directly is either unmanaged or undone by the next sync. Re-run with service ` +
    `"prowlarr". Force-testing ${client.label} still works and is the operation that resets ITS ` +
    'backoff.'
  );
}

/**
 * THE PRODUCER FOR `add`.
 *
 * ── 🔴 IT IS ALSO THE ONLY HONEST ANSWER TO "IS THERE AN INDEXER FOR X?" ────
 *
 * Recorded in the knowledge file as a META-LESSON, because it has gone wrong
 * twice: an Audiobook Bay definition was asserted from memory, relayed to the
 * owner as fact, and was FALSE — having already been disproven ten days
 * earlier. The catalogue is 5.75 MB and lives on the server; the only way to
 * know is to ask it.
 */
async function runSearchAvailable(client: IndexerAdminClient, rawQuery: unknown) {
  const refusal = prowlarrOnly(client, 'Searching the definition catalogue');
  if (refusal) return fail(refusal);

  const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  const result = await client.searchSchema(query, SEARCH_LIMIT);
  if (result.state !== 'ok') return fail(`Could not read the definition catalogue.\n${result.detail}`);

  const matches = result.value;
  const total = matches[0]?.totalMatched ?? matches.length;
  if (!matches.length) {
    return ok(
      `Prowlarr's catalogue has NO definition matching ${JSON.stringify(query)}.\n` +
        '🔴 That is a real answer from the live instance, not a gap in what I know — say plainly ' +
        'that Prowlarr does not ship one, rather than guessing at a name. Prowlarr will not index a ' +
        'site it has no definition for; building a custom one is a separate project and a decision ' +
        'for the owner.',
    );
  }

  // Already-installed definitions are marked, so `add` is not offered for
  // something that is already there.
  const installed = await client.list();
  const have = new Set(
    installed.state === 'ok' ? installed.value.map((i) => i.name.toLowerCase()) : [],
  );

  const lines = [
    `Prowlarr catalogue: ${total} definition(s) match ${JSON.stringify(query)}` +
      (total > matches.length ? `, showing the first ${matches.length}` : '') +
      '. NOTHING was added.',
    '',
  ];
  for (const m of matches) {
    const already = have.has(m.name.toLowerCase()) ? '  ⚠️ ALREADY INSTALLED' : '';
    lines.push(`  ${m.name}  [definition: ${m.definitionName}]  ${m.privacy}/${m.protocol}${already}`);
    if (m.description) lines.push(`      ${m.description}`);
  }
  lines.push(
    '',
    '🔴 ONLY A "public" DEFINITION CAN BE ADDED HERE. A private or semiPrivate tracker needs an ' +
      'account, an invite or an API key that this house does not have, so adding one fails at the ' +
      'validation step — and REGISTERING for a tracker is the owner\'s decision, never something to ' +
      'do unprompted. Of the 625 definitions Prowlarr ships, 475 are private and 63 semiPrivate; ' +
      'only 87 are public.',
    'To install one: action "add" with `definition` set to the bracketed definition name above.',
  );
  return ok(lines.join('\n'));
}

/**
 * Install a definition from the catalogue.
 *
 * ⚠️ SLOW ON PURPOSE: the create endpoint live-tests before saving (measured
 * 25.3 s for a working public tracker), so this genuinely reaches the site.
 */
async function runAdd(client: IndexerAdminClient, rawDefinition: unknown) {
  const refusal = prowlarrOnly(client, 'Adding an indexer');
  if (refusal) return fail(refusal);

  const wanted = typeof rawDefinition === 'string' ? rawDefinition.trim() : '';
  if (!wanted) {
    return fail(
      'No `definition` supplied, so nothing was added. Run action "search_available" with a `query` ' +
        'first — that is where definition names come from, and a definition has no numeric id.',
    );
  }

  const found = await client.findDefinition(wanted);
  if (found.state !== 'ok') return fail(`Could not read the definition catalogue.\n${found.detail}`);
  if (!found.value) {
    return fail(
      `Prowlarr has NO definition called ${JSON.stringify(wanted)}, so nothing was added.\n` +
        '🔴 This is the live instance answering, so do not guess at a near-miss name or assert that ' +
        'the tracker is supported. Run action "search_available" with a shorter query to see what ' +
        'actually exists.',
    );
  }
  const def = found.value;
  const defName = String(def['name'] ?? wanted);

  /**
   * 🔴 PRIVACY IS CHECKED BEFORE ANYTHING IS SENT.
   *
   * A private tracker's definition needs credentials we do not hold, so the
   * create would fail its validation 25 seconds later with a confusing message
   * about a missing field. Worse, the fix for that message is "go and register
   * an account", which the knowledge file explicitly says not to do unprompted.
   * Refuse first, and say which of the two it is.
   */
  const privacy = String(def['privacy'] ?? '?');
  if (privacy !== 'public') {
    return fail(
      `${defName} is a ${privacy} tracker, so it was NOT added and nothing was sent.\n` +
        'It needs an account, invite or API key that this house does not have — the create would ' +
        'fail its validation, and the only way to make it succeed is to REGISTER for the tracker, ' +
        'which is the owner\'s decision and is never done unprompted. Say that plainly and offer a ' +
        'public alternative from action "search_available" instead.',
    );
  }

  const before = await snapshot(client);
  if ('error' in before) return fail(before.error);
  const existing = before.indexers.find((i) => i.name.toLowerCase() === defName.toLowerCase());
  if (existing) {
    return ok(
      `Prowlarr ALREADY has ${defName} as id ${existing.id} — nothing was added and there is now no ` +
        'duplicate. Say it was already there rather than reporting a new install.\n\n' +
        renderSnapshot(client, before),
    );
  }

  /**
   * 🔴 THE `appProfileId` TRAP. The obvious implementation fails 100% of the
   * time: the catalogue hands back `appProfileId: 0` and the create endpoint
   * requires a real one — MEASURED, `HTTP 400 "'App Profile Id' must be greater
   * than '0'"`. Read the profile list rather than hardcoding the 1 this box
   * happens to use.
   */
  const profile = await client.defaultAppProfileId();
  if (profile.state !== 'ok') return fail(`Nothing was added.\n${profile.detail}`);

  const created = await client.addFromSchema(def, profile.value);
  if (created.state !== 'ok') {
    return fail(
      `${defName} was NOT added.\n${created.detail}\n` +
        '⚠️ Prowlarr live-tests a new indexer before saving it, so a refusal here usually means the ' +
        'site did not answer — not that the request was wrong. That is the same "the site is ' +
        'refusing us" case as a 403 on an existing indexer, and it is not something we can fix.',
    );
  }

  const after = await snapshot(client);
  return ok(
    finish(
      [
        `Added ${created.value.name} to Prowlarr as id ${created.value.id}, enabled.`,
        '',
        'Prowlarr live-tested it before saving, so it answered — but that is one probe, not a ' +
          'guarantee. Run action "test" on this id if you want the current verdict.',
        '⚠️ Prowlarr pushes its indexer list to Sonarr and Radarr on its own sync cycle, so this ' +
          'will appear there shortly rather than immediately. Do not report it as missing on the ' +
          'arrs until a sync has had time to run.',
      ],
      client,
      after,
      'The indexer was added',
    ),
  );
}

/**
 * Remove an indexer — CAPTURING ITS FULL CONFIGURATION FIRST.
 *
 * ── 🔴 RECOVERABILITY IS THE DESIGN, NOT AN APPROVAL PROMPT ─────────────────
 *
 * Delete is the only destructive verb here: it discards the URL, the categories,
 * the priority, any hand-tuned settings and any credentials, and **Prowlarr will
 * not tell you afterwards what was there**. The obvious answer is to gate it
 * behind a confirmation, and that is the wrong answer — a manufactured approval
 * step is friction that teaches people to click through it, and the owner has
 * been explicit about not wanting them.
 *
 * So the destructive action is made REVERSIBLE instead: the exact definition is
 * written to a file before anything is deleted, and the reply says where it is.
 *
 * ── 🔴 THE FILE IS WRITTEN FIRST, AND A FAILED WRITE ABORTS THE DELETE ──────
 *
 * That ordering IS the guarantee. Deleting first and capturing afterwards is
 * capturing nothing, and capturing "best effort" alongside a delete that
 * proceeds regardless is a promise of recoverability that is void exactly when
 * it is needed.
 *
 * ── 🔴 AND THE FILE IS NOT THE REPLY ────────────────────────────────────────
 *
 * The captured definition may carry a tracker's API key or password. The
 * standing rule outranks recoverability and does not bend for convenience: a
 * credential quoted into a reply is copied into the message thread, the replayed
 * history and the log file. So the REPLY gets a redacted summary and a path; the
 * FILE gets the secret, at 0600.
 */
async function runRemove(client: IndexerAdminClient, rawId: unknown, config: Config) {
  const refusal = prowlarrOnly(client, 'Removing an indexer');
  if (refusal) return fail(refusal);

  const id = asId(rawId, client);
  if (typeof id === 'string') return fail(`Nothing was removed. ${id}`);

  const before = await snapshot(client);
  if ('error' in before) return fail(before.error);
  const row = before.indexers.find((i) => i.id === id);
  if (!row) {
    return fail(
      `Prowlarr has no indexer with id ${id}, so nothing was removed. Run action "list" to see the ` +
        'ids it actually has.',
    );
  }

  // 1. CAPTURE — the full resource, unredacted, straight to disk.
  const raw = await client.fetchRaw(id);
  if (raw.state !== 'ok') {
    return fail(
      `NOTHING WAS REMOVED. I could not read ${row.name}'s configuration first, and removing it ` +
        `without a copy would be irreversible.\n${raw.detail}`,
    );
  }

  let savedTo: string;
  try {
    savedTo = captureDefinition(config.indexerBackupDir, id, row.name, raw.value);
  } catch (e) {
    return fail(
      `NOTHING WAS REMOVED. The configuration backup could not be written (${(e as Error).message}), ` +
        'and a delete is only safe because that file exists. Fix the path or the permissions and ' +
        'try again — this is a refusal, not a failure of the removal itself.',
    );
  }

  // 2. DELETE — only now.
  const removed = await client.remove(id);
  if (removed.state !== 'ok') {
    return fail(
      `${row.name} was NOT removed.\n${removed.detail}\n` +
        `Its configuration was saved to ${savedTo} anyway, which is harmless — nothing was lost.`,
    );
  }

  const after = await snapshot(client);
  return ok(
    finish(
      [
        `Removed ${row.name} (was id ${id}) from Prowlarr.`,
        '',
        `🔴 THIS IS RECOVERABLE. Its complete configuration was saved to:\n  ${savedTo}`,
        'To put it back, re-add it from that file — or, for a stock definition, action "add" with ' +
          `\`definition\` set to its catalogue name.`,
        summariseCaptured(raw.value),
        '⚠️ Re-adding does NOT restore the id. A new indexer gets a NEW id — measured: the same ' +
          'definition added, removed and added again came back as id 10, then id 11, never its ' +
          'original. Sonarr and Radarr reference Prowlarr indexers BY id, so Prowlarr re-syncs them ' +
          'rather than the old link resuming. Say that if anyone asks why the arrs look different ' +
          'afterwards.',
      ],
      client,
      after,
      'The indexer was removed',
    ),
  );
}

/**
 * Write the captured definition, 0600, and return the path.
 *
 * ⚠️ Throws rather than returning an error value, so a caller CANNOT proceed to
 * the delete by ignoring a return value. This repo has already shipped a defect
 * where a discarded return value gated a success flag.
 */
function captureDefinition(dir: string, id: number, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'indexer';
  const path = join(dir, `prowlarr-${slug}-id${id}-${stamp}.json`);
  writeFileSync(path, body, { encoding: 'utf8', mode: 0o600 });
  // Explicit, because `mode` on writeFileSync is masked by the process umask and
  // is a no-op when the file already exists. This file may hold a tracker
  // credential; 0600 is not decoration.
  chmodSync(path, 0o600);
  return path;
}

/**
 * What the reply is allowed to say about the captured definition.
 *
 * 🔴 NAMES THE CREDENTIAL FIELDS, QUOTES NONE OF THEM. Saying "3 credential
 * fields were saved and withheld" is the useful, safe half — it tells the reader
 * the file matters and why, without putting the secret anywhere it will be
 * copied.
 */
function summariseCaptured(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return `The saved copy is ${body.length} characters. Its contents are not shown here.`;
  }
  const stripped = stripCredentials(parsed);
  const secrets = stripped.redacted;
  const summary = `The saved copy is the complete definition (${body.length} characters).`;
  if (!secrets.length) return `${summary} It contains no credential fields.`;
  return (
    `${summary}\n🔴 It contains ${secrets.length} CREDENTIAL field(s) — ${secrets.join(', ')} — which ` +
    'are in the file and are deliberately NOT repeated here. A secret quoted into a reply is copied ' +
    'into the message thread, the history and the log file. Tell the user the file holds them and ' +
    'where it is; do not read them out, and do not offer to.'
  );
}

async function runTest(client: IndexerAdminClient, rawId: unknown) {
  const id = asId(rawId, client);
  if (typeof id === 'string') return fail(id);

  const before = await snapshot(client);
  if ('error' in before) return fail(before.error);
  const name = before.indexers.find((i) => i.id === id)?.name ?? `id ${id}`;

  const result = await client.testOne(id, name);
  if (result.state !== 'ok') return fail(`Force-test of ${client.label} ${name} did not complete.\n${result.detail}`);

  const after = await snapshot(client);
  const settled = 'error' in after ? null : after;
  return ok(
    finish(
      [
        `Force-tested ${client.label} indexer ${id} (${name}).`,
        '',
        renderOutcome(result.value),
        ...verdictNotes([result.value], before, settled, client),
      ],
      client,
      after,
      'The test ran',
    ),
  );
}

async function runTestAll(client: IndexerAdminClient) {
  const before = await snapshot(client);
  if ('error' in before) return fail(before.error);

  const result = await client.testAll();
  if (result.state !== 'ok') return fail(`Force-test of all ${client.label} indexers did not complete.\n${result.detail}`);

  // Name resolution happens ONCE, here. `renderOutcome` used to repeat the same
  // fallback chain, so there were two rules for one fact.
  const outcomes = result.value.map((o) => ({
    ...o,
    name: o.name || before.indexers.find((i) => i.id === o.id)?.name || `id ${o.id}`,
  }));
  const passed = outcomes.filter((o) => o.passed === true);
  const failed = outcomes.filter((o) => o.passed === false);
  const unclear = outcomes.filter((o) => o.passed === null);
  const after = await snapshot(client);
  const settled = 'error' in after ? null : after;

  return ok(
    finish(
      [
        `Force-tested all ${outcomes.length} ENABLED ${client.label} indexer(s): ` +
          `${passed.length} passed, ${failed.length} failed` +
          // 🔴 An unrecognised row is counted APART. Folding it into "failed"
          // would report a verdict the service never gave.
          (unclear.length ? `, ${unclear.length} with NO verdict reported` : '') +
          '.' +
          (before.indexers.length > outcomes.length
            ? ` (${before.indexers.length - outcomes.length} disabled indexer(s) were not tested — ` +
              'that is not a missing result.)'
            : ''),
        '',
        ...outcomes.map((o) => renderOutcome(o)),
        ...verdictNotes(outcomes, before, settled, client),
      ],
      client,
      after,
      'The tests ran',
    ),
  );
}

async function runToggle(client: IndexerAdminClient, rawId: unknown, enable: boolean) {
  const verb = enable ? 'enable' : 'disable';
  const id = asId(rawId, client);
  if (typeof id === 'string') return fail(`Nothing was ${verb}d. ${id}`);

  const before = await snapshot(client);
  if ('error' in before) return fail(before.error);
  const name = before.indexers.find((i) => i.id === id)?.name ?? `id ${id}`;

  const result = await client.setEnable(id, enable);
  if (result.state !== 'ok') return fail(`Could not ${verb} ${client.label} ${name}.\n${result.detail}`);

  const after = await snapshot(client);
  const headline = result.value.changed
    ? `${client.label} indexer ${id} (${name}) is now ${enable ? 'ENABLED' : 'DISABLED'}.`
    : `${client.label} indexer ${id} (${name}) was ALREADY ${enable ? 'enabled' : 'disabled'} — ` +
      'nothing was changed. Say that rather than reporting a change.';

  const lines = [headline];
  /**
   * 🔴 DISABLING A FAILING INDEXER MUTES THE ALARM THAT WOULD SHOW RECOVERY.
   *
   * This is a RECORDED DECISION, not a preference. Escalation
   * `esc-homelab-stream-cloudflare-check-1337x-indexer-403-for-4-days-replace`,
   * resolved 2026-08-10, weighed exactly this and chose LEAVE IT ENABLED —
   * verbatim: *"disabling quietly removes the signal that would tell us if 1337x
   * comes back. That is the alarm-muting failure this whole system keeps
   * re-learning: a warning removed because it is currently noise takes the
   * recovery signal with it."* It also recorded that **adding or disabling an
   * indexer is a coverage decision for Jeff**, not something to do unprompted.
   *
   * And disabling is precisely how a model would "make the warning go away" when
   * asked to fix the indexers. So the tool says this at the moment it happens.
   */
  if (!enable && result.value.changed && wasBackedOff(before, id)) {
    lines.push(
      '',
      `⚠️ ${name} was FAILING when you disabled it, and that removes the signal that would tell us ` +
        "if it comes back. Prowlarr's own backoff already handles the retry, so leaving a broken " +
        'indexer enabled costs nothing and keeps the recovery visible. The standing decision here ' +
        '(2026-08-10, after 1337x had been 403 for four days with the others green) was to LEAVE IT ' +
        'ENABLED and report once. Adding or removing indexer coverage is the OWNER\'S decision, so ' +
        'unless they explicitly asked for this, say what you did and offer to put it back.',
    );
  }
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
  return ok(finish(lines, client, after, 'The change was made'));
}

/**
 * The common tail: print the live state, or say plainly that it could not be
 * read. Three call sites had a byte-identical copy of this.
 *
 * 🔴 THE "COULD NOT RE-READ" LINE IS NOT DECORATION. Everything a caller reads
 * about the CURRENT state comes from that snapshot, so when it is missing the
 * answer above it is the last thing we know, not the latest thing that is true.
 */
function finish(
  lines: string[],
  client: IndexerAdminClient,
  after: Snapshot | { error: string },
  what: string,
): string {
  if ('error' in after) {
    return [
      ...lines,
      '',
      `⚠️ ${what}, but re-reading ${client.label} afterwards FAILED: ${after.error}`,
      'So nothing below this line is verified, and the state above is what was true BEFORE, not now.',
    ].join('\n');
  }
  return [...lines, '', renderSnapshot(client, after)].join('\n');
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

async function snapshot(client: IndexerAdminClient): Promise<Snapshot | { error: string }> {
  // Three independent reads. Sequentially they were six round trips per action.
  const [list, backoff, health] = await Promise.all([
    client.list(),
    client.backoff(),
    client.indexerHealth(),
  ]);
  if (list.state !== 'ok') return { error: list.detail };

  return {
    indexers: [...list.value].sort((a, b) => a.id - b.id),
    backoff: backoff.state === 'ok' ? backoff.value : null,
    backoffNote: backoff.state === 'ok' ? null : backoff.detail,
    health: health.state === 'ok' ? health.value : [],
    healthNote: health.state === 'ok' ? null : `⚠️ ${client.label} /health could not be read: ${health.detail}`,
    readAt: new Date(),
  };
}

function renderSnapshot(client: IndexerAdminClient, snap: Snapshot): string {
  const lines = [`STATE NOW — ${client.label}, read at ${snap.readAt.toISOString()}:`];
  for (const row of snap.indexers) {
    lines.push(`  id ${row.id}  ${row.name}  ${describeSwitches(row)}  ${describeBackoff(row.id, snap)}`);
  }
  if (snap.backoffNote) lines.push(`⚠️ ${snap.backoffNote}`);
  if (snap.healthNote) lines.push(snap.healthNote);
  if (snap.health.length) {
    lines.push(`${client.label} health, indexer-related:`);
    for (const m of snap.health) lines.push(`  ${m}`);
    if (!client.readsBackoff) {
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

function renderOutcome(outcome: TestOutcome): string {
  const name = outcome.name || `id ${outcome.id}`;
  if (outcome.passed === true) {
    return `  ✅ id ${outcome.id} ${name} — PASSED. Its backoff timer is reset.`;
  }
  if (outcome.passed === null) {
    // 🔴 The service returned a row and no verdict in it. Printing FAILED here
    // would be us supplying the verdict.
    return (
      `  ⚠️ id ${outcome.id} ${name} — NO VERDICT. The service returned a row for this indexer ` +
      'with no pass/fail in it, so whether it works is UNKNOWN. That is not a failure.'
    );
  }
  const why = outcome.errors.length ? outcome.errors.join(' / ') : 'and gave NO reason';
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
): string[] {
  const notes: string[] = [];
  const failed = outcomes.filter((o) => o.passed === false);
  const passed = outcomes.filter((o) => o.passed === true);

  // What the PASSES actually achieved, told apart from a no-op and from an
  // unverified one.
  if (passed.length) notes.push('', passVerdict(passed, before, after, client));

  // What the FAILURES mean, and whether retrying is worth anything. Four
  // classes, four different next actions — see `classifyFailure`.
  for (const o of failed) {
    const kind = classifyFailure(o.errors);
    if (kind === 'forbidden') {
      notes.push('', siteRefusalNote(o, before, after, client));
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
          "throttling it because Prowlarr's own copy of that indexer is already in backoff. " +
          'Re-testing here cannot fix that. Run this tool with service "prowlarr", action "list", ' +
          'find the indexer with the same NAME, and read ITS state — the real fault and its real ' +
          'reason are there, and they may not look like this error at all.',
      );
    } else if (kind === 'unreported') {
      /**
       * 🔴 A FAILURE WITH NO REASON IS NOT EVIDENCE FOR ANY CAUSE.
       *
       * This used to fall into the branch below, which names the VPN tunnel — a
       * confident causal claim built on the service having said nothing at all.
       */
      notes.push(
        '',
        `❓ id ${o.id} (${o.name}) FAILED and the service gave NO reason for it. The cause is ` +
          `UNKNOWN — do not guess at one. ${client.label}'s own log around this moment is the only ` +
          'place the reason exists; say that rather than offering a likely-sounding explanation.',
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
 * 🔴 A PASS IS ONLY A FIX IF SOMETHING WAS STUCK **AND** WE COULD SEE THAT IT
 * STOPPED BEING STUCK.
 *
 * Found in review: `wasBackedOff(null, id)` is `false`, and `after` is `null`
 * exactly when the re-read FAILED. So "was in backoff before" AND "is not in
 * backoff now" was satisfied by **never having looked**, and an UNKNOWN rendered
 * as this tool's single strongest positive claim — "✅ REAL FIX … searches
 * should return results again" — directly above a line admitting the state could
 * not be read. The confident half is the half that becomes a text message.
 *
 * Four cases, and only one of them is a fix.
 */
function passVerdict(
  passed: TestOutcome[],
  before: Snapshot,
  after: Snapshot | null,
  client: IndexerAdminClient,
): string {
  if (before.backoff === null) {
    return (
      `⚠️ The passes reset ${client.label}'s backoff timers, and that is the documented remedy — ` +
      'but this service does not expose backoff over its API, so there is no before/after to ' +
      'show you. The passing test IS the evidence the reset happened. Say it that way: "tested ' +
      'and they pass, which resets the timer", not "I confirmed the backoff cleared".'
    );
  }
  if (after === null || after.backoff === null) {
    return (
      `⚠️ The passes reset ${client.label}'s backoff timers — that is the documented remedy and it ` +
      'was applied. But re-reading the backoff afterwards did NOT succeed, so whether it actually ' +
      'cleared is UNKNOWN. Say "tested and they pass, which resets the timer"; do NOT claim you ' +
      'confirmed anything cleared.'
    );
  }
  const cleared = passed.filter((o) => wasBackedOff(before, o.id) && !wasBackedOff(after, o.id));
  if (cleared.length) {
    return (
      `✅ REAL FIX: ${cleared.length} indexer(s) were in backoff before this and are not now — ` +
      `${cleared.map((o) => `${o.id} (${o.name})`).join(', ')}. That is the stale-backoff fault, ` +
      'and it is now cleared. Searches that were returning 0 should return results again.'
    );
  }
  return (
    `⚠️ NOTHING WAS ACTUALLY STUCK on ${client.label}: the indexer(s) that passed were not in ` +
    'backoff before the test either, so the test confirmed health rather than repairing ' +
    'anything. Do not report this as a fix.'
  );
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
  // ⚠️ A negative age means the clocks disagree, not that it fails in the
  // future. "It has been failing for in the future" is not a sentence.
  if (age !== null && age >= 0) {
    lines.push(`  It has been failing for ${humaniseHours(age)} (measured from the FIRST failure, not the last retry).`);
    if (age >= REPORT_ONCE_HOURS) {
      // The threshold is stated once, in REPORT_ONCE_HOURS, and the sentence is
      // derived from it. Two copies of a number drift silently.
      const days = REPORT_ONCE_HOURS / 24;
      lines.push(
        `  That is past ${days} days. The standing rule for this house: a 403 lasting more than ` +
          `${days} days while the other indexers are green is REPORTED ONCE and then left alone — ` +
          'not escalated, not retried on a schedule.',
      );
    }
  }

  /**
   * 🔴 "SEARCHING STILL WORKS" IS A CLAIM, AND IT WAS BEING MADE UNCONDITIONALLY.
   *
   * Found in review: `if (green)` is true for ANY object, `{ok: 0, total: 1}`
   * included. With two of three indexers down it said "(1 of 3) … so this is a
   * single-indexer outage and searching still works" — twice, once per failure —
   * and with one enabled indexer that was the failing one it said "(0 of 1) …
   * searching still works" while search was entirely dead. False reassurance, on
   * the exact question that was asked.
   *
   * So the reassuring sentence is emitted ONLY when this really is the only one
   * down. Otherwise the same numbers get the opposite headline.
   */
  const green = greenCount(after ?? before);
  if (green) {
    const down = green.total - green.ok;
    if (down <= 1) {
      lines.push(
        `  Every other enabled ${client.label} indexer is green right now (${green.ok} of ` +
          `${green.total}), so this is a single-indexer outage and searching still works.`,
      );
    } else {
      lines.push(
        `  🔴 AND IT IS NOT ALONE: ${down} of ${green.total} enabled ${client.label} indexers are ` +
          'down right now. More than one is failing, so searching IS degraded, and the "report ' +
          'once and leave it" rule does not apply — that rule is for a lone indexer while the rest ' +
          `are green. Say plainly that ${down} are down, and look for what they have in common; a ` +
          'dead VPN tunnel is the usual answer when several fail together.',
      );
    }
  }

  const moved = backoffMoved(before, after, outcome.id);
  if (moved) {
    lines.push(
      `  ⚠️ AND THE TEST COST SOMETHING: its backoff moved ${moved.from} → ${moved.to}. A FAILED ` +
        'test re-arms the timer from now, so each retry pushes the next automatic attempt further ' +
        'out. Retrying gains nothing and loses that.',
    );
  } else if (!client.readsBackoff) {
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

/**
 * An id must be a real integer. Returns the id, or the REFUSAL TEXT to show.
 *
 * ⚠️ "No id supplied" and "that is not an id" are different problems with
 * different fixes, and models emit numeric arguments as strings often enough
 * that the second is common. Telling a model to go and run `list` when it
 * already has the right number and merely quoted it sends it round a loop it
 * cannot escape.
 */
function asId(v: unknown, client: IndexerAdminClient): number | string {
  if (v === undefined || v === null) {
    return (
      'No indexer `id` supplied. Run this tool with action "list" against ' +
      `"${client.service}" first — that is where the ids come from, and they differ per service.`
    );
  }
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  return (
    `\`id\` must be a whole number, and it was ${JSON.stringify(v)}. ` +
    (typeof v === 'string' && /^\d+$/.test(v)
      ? `Send it as the number ${v}, not as text — you already have the right id.`
      : `Run action "list" against "${client.service}" to see the ids it actually has.`)
  );
}
