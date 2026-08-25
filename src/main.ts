import { appendFileSync, mkdirSync } from 'node:fs';
import { Agent, type TurnRecord } from './agent.js';
import { BlueBubblesClient } from './bluebubbles/client.js';
import { Presence } from './bluebubbles/presence.js';
import { BlueBubblesConnector, BlueBubblesReceiver, parseSendAudience } from './bluebubbles/receiver.js';
import { SeenStore } from './bluebubbles/seen.js';
import { ChoiceStore } from './choices.js';
import { withPresence } from './connector.js';
import { assertShellIdentityIsSafe, loadConfig } from './config.js';
import { FollowupStore } from './followups.js';
import { InviteLedger } from './invite-ledger.js';
import { JfagoClient } from './jfago.js';
import { runDueFollowups } from './followup-runner.js';
import { proveShellIdentityIsSafe } from './identity-probe.js';
import { KindleRegistry } from './kindle.js';
import { realMailSender } from './media/kindle-send.js';
import { createLlmClient } from './llm.js';
import { HistoryStore } from './store.js';
import { buildTools } from './tools/index.js';

/**
 * LIVE MODE — V2 on iMessage, replying as Jedd.
 *
 * ── 🔴 THIS IS THE FILE THAT SENDS. READ THE THREE GATES BEFORE STARTING IT. ─
 *
 * `shadow-main.ts` cannot text anybody: it holds no client, its connector has no
 * send path, and it refuses to start with writes on. **None of that is true
 * here.** This process answers real people on Jeff's household thread, from
 * Jedd's Apple ID, and the messages it sends cannot be recalled.
 *
 *  1. **`JEDD_SEND_TO` is required.** `everyone` is the cutover value; a
 *     comma-separated handle list is the rehearsal value. There is no default —
 *     an unset variable refuses to start rather than picking the permissive
 *     reading for somebody who did not think about it.
 *  2. **The identity assertion runs before anything is served.** Ports 1234 and
 *     1235 share a password and an API shape, so a copy-pasted `.env` connects
 *     *successfully* to Jeff's personal iMessage. It throws; nothing catches it.
 *  3. **The webhook is deregistered on the way out.** A Ctrl-C that leaves a row
 *     pointing at a dead port is the 1.4.11 orphan: BlueBubbles delivers into a
 *     black hole and nothing fails loudly. Shutdown is part of the contract, not
 *     a courtesy.
 *
 * ⚠️ Starting this does NOT stop V1. V1 keeps running with its own webhook until
 * somebody deletes that row deliberately — see the cutover runbook. Registration
 * here will not touch it: a row on a different port belongs to somebody else.
 */

const DATA_DIR = new URL('../data/', import.meta.url).pathname;

function recordTurn(record: TurnRecord): void {
  mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(`${DATA_DIR}audit.jsonl`, `${JSON.stringify(record)}\n`, 'utf8');
}

/** How often to look for follow-ups that have come due. */
const TICK_MS = 60_000;

async function main(): Promise<void> {
  const config = loadConfig();
  // 🔴 First, before a socket is opened or a webhook registered. A refusal here
  // must cost nothing and leave nothing behind.
  const audience = parseSendAudience(process.env['JEDD_SEND_TO']);

  const client = new BlueBubblesClient({
    baseUrl: config.bluebubbles.baseUrl,
    password: config.bluebubbles.password,
    expectedIdentity: config.bluebubbles.expectedIdentity,
  });
  const info = await client.assertIdentity();
  console.error(`[jedd] BlueBubbles ${info.serverVersion} bridging ${info.detectedIMessage}`);
  /**
   * 🔴 THE ONE LINE THAT SAYS WHETHER DISABLING SIP WORKED.
   *
   * Typing indicators and read receipts need the helper bundle, and the failure
   * is otherwise completely silent by design — `Presence` swallows it so it can
   * never touch a reply. Silence is the right behaviour and the wrong diagnostic,
   * so the state is stated once at boot where somebody looking for it will find
   * it.
   *
   * ⚠️ BOTH FLAGS, NOT ONE. `private_api` is the setting; `helper_connected` is
   * whether the dylib actually loaded. On 2026-08-25 they read `true` and
   * `false` — the setting alone would have said the feature was on.
   */
  console.error(
    info.helperConnected
      ? '[jedd] presence: typing indicators and read receipts are LIVE (private api on, helper connected).'
      : `[jedd] presence: typing indicators and read receipts are OFF — private_api=${info.privateApiEnabled}, ` +
        'helper_connected=false. Needs SIP disabled and the BlueBubbles helper bundle installed. ' +
        'Nothing else is affected; the calls fail in ~3ms and are swallowed.',
  );
  console.error(
    audience === 'everyone'
      ? '[jedd] 🔴 SEND AUDIENCE: everyone — this is a real cutover, not a rehearsal.'
      : `[jedd] SEND AUDIENCE: ${audience.join(', ')} — everyone else gets SILENCE.`,
  );

  const llm = createLlmClient(config);
  const preflight = assertShellIdentityIsSafe(config);
  const shellIdentity = preflight.safe
    ? await proveShellIdentityIsSafe(config)
    : { safe: false, reason: preflight.reason, evidence: ['pre-flight refused; probe not attempted'] };

  const history = new HistoryStore(`${DATA_DIR}history.jsonl`);
  const followups = new FollowupStore(`${DATA_DIR}followups.jsonl`);
  const choices = new ChoiceStore(`${DATA_DIR}choices.jsonl`);
  const kindle = new KindleRegistry(`${DATA_DIR}kindle.jsonl`);
  const seen = new SeenStore(`${DATA_DIR}seen.jsonl`);
  const invites = new InviteLedger(`${DATA_DIR}invites.jsonl`);

  const receiver = new BlueBubblesReceiver({
    client,
    seen,
    host: config.bluebubbles.host,
    port: config.bluebubbles.port,
    path: config.bluebubbles.path,
    onSkipped: (v) => {
      if (v.action === 'skip') console.error(`[jedd] skipped rowid ${v.rowid}: ${v.reason}`);
    },
  });

  /**
   * Typing indicators and read receipts.
   *
   * ⚠️ REQUIRES THE BLUEBUBBLES PRIVATE API HELPER, WHICH NEEDS SIP DISABLED.
   * As of 2026-08-25 `server/info` reports `private_api: true` but
   * `helper_connected: false`, so every one of these calls returns HTTP 500 in
   * ~3ms and nothing appears on anybody's phone. That is the expected state, it
   * is handled, and it is invisible: `Presence` swallows it and says so once.
   * Nothing else about this process changes when it starts working.
   */
  const presence = new Presence({ client });

  const connector = new BlueBubblesConnector(
    receiver,
    client,
    audience,
    (to, text) => console.error(`[jedd] SUPPRESSED ${text.length} chars to ${to} — not in the send audience.`),
    presence,
  );

  /**
   * 🔴 THE INVITE SENDS THROUGH THE SAME GATED CONNECTOR AS EVERY OTHER MESSAGE.
   *
   * Two things follow, and both are load-bearing:
   *
   *  1. A rehearsal cannot leak a real invite link to somebody outside
   *     `JEDD_SEND_TO`. The audience gate is not re-implemented here; there is
   *     one send path.
   *  2. **A SUPPRESSED SEND MUST READ AS A FAILED SEND**, so the invite is
   *     revoked. `sendReporting` reports what happened; anything that is not a
   *     confirmed non-failure destroys the credential. Silently swallowing a
   *     suppression would leave a live single-use invite behind for a message
   *     nobody ever received — the exact V1 defect this tool was built to not
   *     have, reintroduced by the test harness rather than by the tool.
   */
  const invite = {
    jfago: new JfagoClient({
      baseUrl: config.jfago.baseUrl,
      inviteBaseUrl: config.jfago.inviteBaseUrl,
      username: config.jfago.username,
      password: config.jfago.password,
      profile: config.jfago.profile,
      validityHours: config.jfago.validityHours,
    }),
    ledger: invites,
    send: (to: string, text: string) => connector.sendReporting(to, text),
  };
  /**
   * ⚠️ `send_ebook` IS RESTRICTED TO THE OWNER IN THIS BUILD.
   *
   * It is `minRole: 'guest'` by declaration and the address it mails is
   * provenance-verified per sender, so widening it is one line — delete
   * `onlySendTo`. It is narrow here because the path has had exactly ONE live
   * send ever, and this is its first exposure to real household traffic. A guest
   * who asks gets a visible refusal naming the restriction, which is the safe
   * direction: annoying beats an unrecallable email.
   */
  const ebook = { send: await realMailSender(config), onlySendTo: config.ownerHandle };
  const tools = buildTools(config, shellIdentity, { invite, ebook });
  const agent = new Agent(config, llm, recordTurn, tools, history, followups, choices, kindle);

  console.error(
    `[jedd] model=${llm.label} owner=${config.ownerHandle} ` +
      `writes=${config.readOnly ? 'DISABLED' : 'ENABLED'} hp_shell=${shellIdentity.safe ? 'on' : 'OFF'}`,
  );
  console.error(`[jedd] tools=${tools.map((t) => t.name).join(', ')}`);

  const reg = await client.ensureWebhook(config.bluebubbles.publicUrl, ['new-message']);
  console.error(`[jedd] webhook ${reg.outcome}: ${config.bluebubbles.publicUrl}`);
  // ⚠️ Printed even when empty. A removal nobody logged is how the orphan
  // happened in the first place, with the sign reversed.
  console.error(
    reg.removed.length
      ? `[jedd] 🔴 REMOVED ${reg.removed.length} stale row(s) on our own port: ${reg.removed.map((r) => `#${r.id} ${r.url}`).join(', ')}`
      : '[jedd] removed 0 existing registrations (nobody else\'s row was touched).',
  );

  // 🔴 Deregister on the way out, and say whether it worked. A shutdown that
  // leaves the row behind means BlueBubbles keeps delivering to a closed port.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`\n[jedd] ${signal} — deregistering ${config.bluebubbles.publicUrl}`);
    // 🔴 FIRST, and bounded. A pm2 restart lands mid-turn sooner or later, and
    // exiting with a "…" still showing leaves a real person watching a reply
    // that is never coming — for however long Apple keeps it up, which is not a
    // number this codebase knows. `stopAll` cannot hang shutdown.
    await presence.stopAll().catch(() => {});
    try {
      const rows = await client.listWebhooks();
      const ours = rows.filter((w) => w.url === config.bluebubbles.publicUrl);
      for (const w of ours) {
        const res = await client.deleteWebhook(w.id);
        console.error(`[jedd] deleted webhook #${w.id}: ${res.ok ? 'ok' : `FAILED http ${res.status}`}`);
      }
      if (ours.length === 0) console.error('[jedd] our row was already gone.');
    } catch (e) {
      // 🔴 Loud. An orphan left behind is the failure that hides for a version.
      console.error(
        `[jedd] 🔴 COULD NOT DEREGISTER: ${(e as Error).message}\n` +
          `[jedd] 🔴 DELETE ${config.bluebubbles.publicUrl} BY HAND before starting anything else.`,
      );
    }
    await receiver.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  const timer = setInterval(() => {
    // 🔴 The follow-up runner sends through the SAME gated connector, so a
    // rehearsal cannot leak a "here is how that download went" message to
    // somebody outside the send audience an hour after the window closed.
    void runDueFollowups(followups, {
      config,
      send: (to, text) => connector.send(to, text),
    });
  }, TICK_MS);
  timer.unref();

  let turns = 0;
  await connector.listen(async (message) => {
    turns += 1;
    const started = Date.now();
    try {
      /**
       * 🔴 THE READ RECEIPT AND THE TYPING INDICATOR ARE ONE CALL — see
       * `withPresence`. The typing region covers the model turn AND the send, so
       * the "…" runs for exactly as long as Jedd owes this person a reply, and
       * it is transparent: it rethrows whatever `agent.handle` or `send` throws
       * into the catch below, stopping the indicator on the way past either way.
       */
      const record = await withPresence(connector, message, async () => {
        const r = await agent.handle(message.senderHandle, message.text);
        await connector.send(message.senderHandle, r.replyText);
        return r;
      });
      console.error(
        `[jedd] turn ${turns} from ${message.senderHandle}: ` +
          `${record.toolCalls.map((c) => c.name).join(',') || 'no tools'} ${Date.now() - started}ms`,
      );
    } catch (e) {
      // A failing turn must not stop the next message arriving.
      console.error(`[jedd] turn ${turns} THREW: ${(e as Error).message}`);
    }
  });
}

main().catch((e) => {
  console.error(`[jedd] FATAL: ${(e as Error).message}`);
  process.exit(1);
});
