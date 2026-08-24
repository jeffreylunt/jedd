import { Agent, type TurnRecord } from './agent.js';
import { BlueBubblesClient } from './bluebubbles/client.js';
import { BlueBubblesReceiver, ShadowConnector } from './bluebubbles/receiver.js';
import { SeenStore } from './bluebubbles/seen.js';
import { ShadowRecorder, assertShadowSafe } from './bluebubbles/shadow.js';
import { assertShellIdentityIsSafe, loadConfig } from './config.js';
import { proveShellIdentityIsSafe } from './identity-probe.js';
import { FollowupStore } from './followups.js';
import { createLlmClient } from './llm.js';
import { HistoryStore } from './store.js';
import { buildTools } from './tools/index.js';

/**
 * SHADOW MODE — receive real traffic, answer nobody.
 *
 * ── 🔴 WHY THIS IS ITS OWN ENTRY POINT ───────────────────────────────────────
 *
 * Send-absence is structural in three independent places, and this file is the
 * outermost:
 *
 *  1. **This entry point never calls `send`.** It runs the loop and writes the
 *     reply to a file. There is no code path from a turn to the transport.
 *  2. **`ShadowConnector` holds no BlueBubbles client**, so even if something
 *     called `send` there is nothing to send with.
 *  3. **`assertShadowSafe` refuses to start** if homelab writes are enabled.
 *
 * A single flag would have been one edit away from sending as Jedd to Jeff's
 * household. Three structural barriers is not paranoia — it is the difference
 * between "we decided not to" and "it cannot".
 *
 * ⚠️ The shadow does not use `sendText` at all. Pointing anything at the live
 * server for a real send is a separate, deliberate, announced step.
 */

const DATA_DIR = new URL('../data/', import.meta.url).pathname;

async function main(): Promise<void> {
  const config = loadConfig();

  // Refuse the contradiction rather than coercing it. See shadow.ts.
  assertShadowSafe(config);

  const client = new BlueBubblesClient({
    baseUrl: config.bluebubbles.baseUrl,
    password: config.bluebubbles.password,
    expectedIdentity: config.bluebubbles.expectedIdentity,
  });

  // 🔴 Refuses to start against the wrong Apple account. :1234 and :1235 share a
  // password and an API shape, so a .env typo connects SUCCESSFULLY to Jeff's
  // personal identity. This throws; nothing catches it.
  const info = await client.assertIdentity();
  console.error(`[shadow] BlueBubbles ${info.serverVersion} bridging ${info.detectedIMessage}`);

  const llm = createLlmClient(config);
  const preflight = assertShellIdentityIsSafe(config);
  const shellIdentity = preflight.safe
    ? await proveShellIdentityIsSafe(config)
    : { safe: false, reason: preflight.reason, evidence: ['pre-flight refused; probe not attempted'] };

  const tools = buildTools(config, shellIdentity);
  const history = new HistoryStore(`${DATA_DIR}shadow-history.jsonl`);
  const followups = new FollowupStore(`${DATA_DIR}shadow-followups.jsonl`);
  const recorder = new ShadowRecorder(`${DATA_DIR}shadow.jsonl`);
  const seen = new SeenStore(`${DATA_DIR}shadow-seen.jsonl`);

  const agent = new Agent(
    config,
    llm,
    (record: TurnRecord) => recorder.recordTurn(record),
    tools,
    history,
    followups,
  );

  const receiver = new BlueBubblesReceiver({
    client,
    seen,
    host: config.bluebubbles.host,
    port: config.bluebubbles.port,
    path: config.bluebubbles.path,
    // V1's own replies arrive here as outbound echoes. The loop never sees them;
    // the recorder keeps them, which is what pairs each message with what V1 said.
    onSkipped: (v) => recorder.recordSkipped(v),
  });

  const connector = new ShadowConnector(receiver);
  console.error(
    `[shadow] model=${llm.label} owner=${config.ownerHandle} ` +
      `writes=${config.readOnly ? 'DISABLED' : 'ENABLED'} connector=${connector.name}`,
  );
  console.error(`[shadow] tools=${tools.map((t) => t.name).join(', ')}`);

  await client.ensureWebhook(config.bluebubbles.publicUrl, ['new-message']);
  console.error(`[shadow] registered ${config.bluebubbles.publicUrl}`);

  let turns = 0;
  await connector.listen(async (message) => {
    turns += 1;
    const started = Date.now();
    try {
      const record = await agent.handle(message.senderHandle, message.text);
      // 🔴 The reply is WRITTEN, never sent. This is the whole point of the mode.
      console.error(
        `[shadow] turn ${turns} from ${message.senderHandle}: ` +
          `${record.toolCalls.map((c) => c.name).join(',') || 'no tools'} ` +
          `${Date.now() - started}ms — would have replied ${record.replyText.length} chars`,
      );
    } catch (e) {
      // A failing turn must not stop the next message arriving.
      console.error(`[shadow] turn ${turns} THREW: ${(e as Error).message}`);
    }
  });
}

main().catch((e) => {
  console.error(`[shadow] fatal: ${(e as Error).message}`);
  process.exit(1);
});
