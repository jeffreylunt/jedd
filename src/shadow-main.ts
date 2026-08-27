import { Agent, type TurnRecord } from './agent.js';
import { BlueBubblesClient } from './bluebubbles/client.js';
import { BlueBubblesReceiver, ShadowConnector } from './bluebubbles/receiver.js';
import { SeenStore } from './bluebubbles/seen.js';
import { ShadowRecorder, assertShadowSafe } from './bluebubbles/shadow.js';
import { assertShellIdentityIsSafe, loadConfig } from './config.js';
import { proveShellIdentityIsSafe } from './identity-probe.js';
import { FollowupStore } from './followups.js';
import { createLlmClient } from './llm.js';
import { ChoiceStore } from './choices.js';
import { KindleRegistry } from './kindle.js';
import { HistoryStore } from './store.js';
import { buildTools } from './tools/index.js';
import type { IncomingMessage } from './connector.js';
import { BURST_SETTLE_MS, sleep, TurnQueue } from './turn-queue.js';

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
    new ChoiceStore(`${DATA_DIR}shadow-choices.jsonl`),
    new KindleRegistry(`${DATA_DIR}shadow-kindle.jsonl`),
  );

  const receiver = new BlueBubblesReceiver({
    client,
    seen,
    // From the server, not from config: the loop guard must compare against the
    // account BlueBubbles is actually signed in as.
    selfIdentity: info.detectedIMessage,
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

  /**
   * 🔴 THE SAME QUEUE THE LIVE PATH USES, FOR THE REASON SHADOW MODE EXISTS.
   *
   * A shadow whose dispatch differs from production is not measuring production.
   * If this answered a burst as two concurrent turns while `main.ts` answered it
   * as one, the parity corpus would record V2 behaving in a way V2 no longer
   * does, and every conclusion drawn from it would be about a build nobody runs.
   */
  const queue = new TurnQueue<IncomingMessage>({
    keyOf: (m) => m.senderHandle,
    settle: () => sleep(BURST_SETTLE_MS),
    run: async (batch) => {
      const turn = ++turns;
      const started = Date.now();
      const senderHandle = batch[batch.length - 1]!.senderHandle;
      try {
        const record = await agent.handle(senderHandle, batch.map((m) => m.text).join('\n'));
        // 🔴 The reply is WRITTEN, never sent. This is the whole point of the mode.
        console.error(
          `[shadow] turn ${turn} from ${senderHandle}: ` +
            `${batch.length > 1 ? `burst=${batch.length} ` : ''}` +
            `${record.toolCalls.map((c) => c.name).join(',') || 'no tools'} ` +
            `${Date.now() - started}ms — would have replied ${record.replyText.length} chars`,
        );
      } catch (e) {
        // A failing turn must not stop the next message arriving.
        console.error(`[shadow] turn ${turn} THREW: ${(e as Error).message}`);
      }
    },
  });
  console.error(`[shadow] one turn per burst: serialised per sender, ${BURST_SETTLE_MS}ms settle.`);

  await connector.listen((message) => queue.submit(message));
}

main().catch((e) => {
  console.error(`[shadow] fatal: ${(e as Error).message}`);
  process.exit(1);
});
