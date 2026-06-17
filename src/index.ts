import { loadState, saveState } from './config.js';
import { BlueBubblesListener } from './bb-webhook.js';
import { handleMessage } from './media.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import { cleanupSessions } from './session-manager.js';
import { installConsoleMirror, jlog } from './logger.js';
import type { IncomingMessage } from './types.js';
import { readFileSync } from 'fs';

// Released version — read from the package.json baked into the image (Dockerfile copies it to /app),
// so the running container reports the EXACT version it was built/released at (running == released).
function readVersion(): string {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
}
const VERSION = readVersion();

// Install the durable console mirror FIRST so every subsequent log line (incl. startup) is
// captured to the persistent file on the jedd-data volume — it outlives container recreation.
installConsoleMirror();
console.log(`[media-bot] Starting up... (jedd v${VERSION})`);

// Load persisted state
const state = loadState();
console.log(`[media-bot] Loaded state: ${state.activeJobs.filter((j) => j.status === 'downloading').length} active jobs`);

async function main(): Promise<void> {
  console.log('[media-bot] Inbound source: BlueBubbles webhook');
  const listener = new BlueBubblesListener(state.processedMessageIds, state.lastRowid);
  if (state.lastRowid !== undefined) {
    console.log(`[media-bot] Will replay messages after rowid ${state.lastRowid}`);
  }
  await listener.start();

  listener.on('message', (msg: IncomingMessage) => {
    try {
      state.processedMessageIds = listener.getProcessedIds();
      if (typeof msg.rowid === 'number' && (state.lastRowid === undefined || msg.rowid > state.lastRowid)) {
        state.lastRowid = msg.rowid;
      }
      saveState(state);
      handleMessage(msg, state);
    } catch (err) {
      console.error('[media-bot] Error in message listener:', err);
    }
  });

  listener.on('error', (err: Error) => {
    console.error('[media-bot] Inbound listener error:', err);
  });

  // Start follow-up scheduler
  startScheduler(state);

  // Graceful shutdown
  function shutdown(signal: string): void {
    console.log(`[media-bot] Received ${signal}, shutting down...`);
    listener.stop();
    stopScheduler();
    cleanupSessions();
    state.processedMessageIds = listener.getProcessedIds();
    saveState(state);
    console.log('[media-bot] State saved. Goodbye!');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  console.log(`[media-bot] Ready and listening for messages. (jedd v${VERSION})`);
  jlog('ready', { version: VERSION });
}

main().catch((err) => {
  console.error('[media-bot] Fatal startup error:', err);
  process.exit(1);
});
