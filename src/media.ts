import { isOwner, isAllowed, type AppState, saveState } from './config.js';
import { onMessage } from './session-manager.js';
import type { IncomingMessage } from './types.js';

const SPAM_WINDOW_MS = 60_000; // 1 minute
const SPAM_THRESHOLD = 10; // 10+ messages in 1 minute = spam
const SPAM_PATTERNS = /\b(crypto|bitcoin|forex|earn money|make \$|free iphone|click here|act now|limited time|congratulations you|you've been selected|nigerian prince)\b/i;

function isSpam(sender: string, text: string, state: AppState): boolean {
  if (!state.blockedNumbers) state.blockedNumbers = [];
  if (!state.messageRates) state.messageRates = {};

  if (state.blockedNumbers.includes(sender)) {
    console.log(`[spam] Blocked number ${sender}, ignoring`);
    return true;
  }

  if (SPAM_PATTERNS.test(text)) {
    console.log(`[spam] Spam content detected from ${sender}: "${text.substring(0, 50)}"`);
    blockNumber(sender, state, 'spam content');
    return true;
  }

  const now = Date.now();
  if (!state.messageRates[sender]) state.messageRates[sender] = [];
  state.messageRates[sender].push(now);
  state.messageRates[sender] = state.messageRates[sender].filter(t => now - t < SPAM_WINDOW_MS);

  if (state.messageRates[sender].length >= SPAM_THRESHOLD) {
    console.log(`[spam] Rate limit exceeded for ${sender} (${state.messageRates[sender].length} msgs in 1 min)`);
    blockNumber(sender, state, 'rate limit exceeded');
    return true;
  }

  return false;
}

function blockNumber(sender: string, state: AppState, reason: string): void {
  if (!state.blockedNumbers) state.blockedNumbers = [];
  if (!state.blockedNumbers.includes(sender)) {
    state.blockedNumbers.push(sender);
    saveState(state);
    console.log(`[spam] Blocked ${sender}: ${reason}`);
  }
}

export function handleMessage(msg: IncomingMessage, state: AppState): void {
  const { sender, text } = msg;

  // Spam check (never block the owner).
  if (!isOwner(sender) && isSpam(sender, text, state)) return;

  // If an allow-list is configured, silently ignore senders not on it (owner always allowed).
  if (!isAllowed(sender)) {
    console.log(`[media] Ignoring message from non-allowed sender ${sender}`);
    return;
  }

  console.log(`[media] Processing message from ${sender}: "${text.substring(0, 80)}"`);

  // Route through session manager — it handles buffering, the backend call, and sending
  onMessage(sender, text, state);
}
