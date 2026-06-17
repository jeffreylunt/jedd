import { type AppState, type DownloadJob, saveState } from './config.js';
import { runLocalSession } from './local-backend.js';
import { sendMessage } from './send.js';
import { jlog, newConversationId, truncate } from './logger.js';

const QUIET_PERIOD_MS = 5000; // Wait 5s for stragglers before sending response

interface UserSession {
  isRunning: boolean;
  messageBuffer: string[];
  lastActivity: number; // timestamp ms
  quietTimer: NodeJS.Timeout | null;
}

const sessions: Map<string, UserSession> = new Map();

function getOrCreateSession(phone: string): UserSession {
  let session = sessions.get(phone);
  if (!session) {
    session = {
      isRunning: false,
      messageBuffer: [],
      lastActivity: Date.now(),
      quietTimer: null,
    };
    sessions.set(phone, session);
    console.log(`[session] Created session for ${phone}`);
  }
  return session;
}

/** Called when a new message arrives from a user */
export function onMessage(phone: string, text: string, state: AppState): void {
  const session = getOrCreateSession(phone);
  session.lastActivity = Date.now();
  session.messageBuffer.push(text);

  console.log(`[session] Message from ${phone}: "${text.substring(0, 80)}" (buffer: ${session.messageBuffer.length}, running: ${session.isRunning})`);

  // If a quiet timer is pending (waiting to send a response), cancel it — user is still typing.
  if (session.quietTimer) {
    clearTimeout(session.quietTimer);
    session.quietTimer = null;
    console.log(`[session] Cancelled quiet timer for ${phone} — new message arrived`);
  }

  // If the backend is already running for this user, just buffer — processSession picks it up.
  if (session.isRunning) {
    console.log(`[session] Backend running for ${phone}, message buffered`);
    return;
  }

  processSession(phone, state).catch(err => {
    console.error(`[session] Error processing session for ${phone}:`, err);
  });
}

/** Run the Ollama backend once. The local backend is stateless — we replay recent
 *  conversation history so multi-turn (e.g. "which seasons?" -> "all") keeps context. */
async function runBackend(phone: string, message: string, state: AppState, conversationId: string): Promise<string> {
  const history = state.conversationHistory?.[phone]?.slice(-20);
  const result = await runLocalSession(phone, message, state.activeJobs, history, conversationId);
  return result.response;
}

/** Process buffered messages for a user, looping until the buffer drains and the quiet period passes */
async function processSession(phone: string, state: AppState): Promise<void> {
  const session = sessions.get(phone);
  if (!session || session.messageBuffer.length === 0) return;

  session.isRunning = true;

  try {
    while (session.messageBuffer.length > 0) {
      // Drain the buffer into a single combined message
      const messages = session.messageBuffer.splice(0);
      const combined = messages.join('\n\n');

      // One conversationId per drained-buffer backend invocation — the correlation key that ties the
      // inbound text → every model turn / tool call / net → the delivered reply in the logs.
      const conversationId = newConversationId(phone);
      console.log(`[session] Calling backend for ${phone} (${messages.length} message(s))`);
      jlog('inbound', { conversationId, phone, messageCount: messages.length, text: combined });

      let response = await runBackend(phone, combined, state, conversationId);
      session.lastActivity = Date.now();

      // Parse job tracking tag(s) if present. A multi-movie/franchise add emits MORE THAN ONE JOB
      // tag (e.g. "get all the despicable me movies"), so register EVERY tag, not just the first.
      const jobMatches = [...response.matchAll(/<!--JOB:(movie|tv):(\d+):(.+?)-->/g)];
      if (jobMatches.length > 0) {
        response = response.replace(/\n?<!--JOB:.+?-->/g, '').trim();
        for (const [, type, arrId, title] of jobMatches) {
          const job: DownloadJob = {
            id: `${type}-${arrId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            type: type as 'movie' | 'tv',
            title,
            arrId: parseInt(arrId),
            requestedBy: phone,
            requestedAt: new Date().toISOString(),
            qualityProfileId: type === 'movie' ? 6 : 3,
            status: 'downloading',
            nextCheckAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
            checkCount: 0,
          };
          state.activeJobs.push(job);
          console.log(`[session] Registered job: ${type} "${title}" (arrId: ${arrId}) for ${phone}`);
          jlog('job.registered', { conversationId, phone, jobId: job.id, type, arrId: parseInt(arrId), title });
        }
        saveState(state);
      }

      // Store conversation history
      if (!state.conversationHistory) state.conversationHistory = {};
      if (!state.conversationHistory[phone]) state.conversationHistory[phone] = [];
      for (const msg of messages) {
        state.conversationHistory[phone].push({ role: 'user', text: msg, timestamp: new Date().toISOString() });
      }
      state.conversationHistory[phone].push({ role: 'assistant', text: response, timestamp: new Date().toISOString() });
      if (state.conversationHistory[phone].length > 20) {
        state.conversationHistory[phone] = state.conversationHistory[phone].slice(-20);
      }
      saveState(state);

      // More messages arrived while the backend was running — loop without waiting.
      if (session.messageBuffer.length > 0) {
        console.log(`[session] ${session.messageBuffer.length} message(s) buffered during processing, continuing loop`);
        continue;
      }

      // No buffered messages — wait the quiet period for stragglers.
      console.log(`[session] Waiting ${QUIET_PERIOD_MS / 1000}s quiet period for ${phone}`);
      const gotMore = await waitForQuietPeriod(session);
      if (gotMore) {
        console.log(`[session] New message arrived during quiet period for ${phone}, continuing loop`);
        continue;
      }

      console.log(`[session] Sending response to ${phone}: "${response.substring(0, 80)}"`);
      jlog('delivery.sent', { conversationId, phone, text: truncate(response, 2000), length: response.length });
      await sendMessage(phone, response);
      break;
    }
  } catch (error) {
    console.error(`[session] Error for ${phone}:`, error);
    jlog('error', { where: 'processSession', phone, error: error instanceof Error ? error.stack || error.message : String(error) });
    await sendMessage(phone, "Something went wrong on my end, sorry about that. Try again in a sec?");
  } finally {
    session.isRunning = false;
  }
}

/** Wait for the quiet period. Returns true if new messages arrived. */
function waitForQuietPeriod(session: UserSession): Promise<boolean> {
  return new Promise(resolve => {
    session.quietTimer = setTimeout(() => {
      session.quietTimer = null;
      resolve(session.messageBuffer.length > 0);
    }, QUIET_PERIOD_MS);
  });
}

/** Clean up all quiet timers on shutdown */
export function cleanupSessions(): void {
  for (const session of sessions.values()) {
    if (session.quietTimer) {
      clearTimeout(session.quietTimer);
      session.quietTimer = null;
    }
  }
  sessions.clear();
}
