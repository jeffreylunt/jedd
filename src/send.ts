import { config } from './config.js';
import { jlog, truncate } from './logger.js';

export async function sendMessage(to: string, text: string): Promise<void> {
  const chatGuid = `iMessage;-;${to}`;
  console.log(`[bluebubbles] Sending to ${to}: ${text.substring(0, 80)}...`);

  const url = `${config.bluebubbles.url}/api/v1/message/text?password=${encodeURIComponent(config.bluebubbles.password)}`;
  const started = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chatGuid,
      message: text,
      tempGuid: `temp-${Date.now()}`,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    // Outbound delivery FAILED — log the status + body (password is in the url, never logged here)
    // so a non-delivery is never silent. This is the wire-level record of what reached the user.
    jlog('imsg.sent', { to, ok: false, status: response.status, ms: Date.now() - started, error: truncate(body, 500), text: truncate(text, 2000) });
    throw new Error(`BlueBubbles send failed (${response.status}): ${body}`);
  }
  // Wire-level confirmation of the EXACT text delivered to the user.
  jlog('imsg.sent', { to, ok: true, status: response.status, ms: Date.now() - started, text: truncate(text, 2000) });
}

/**
 * Check whether an address is reachable over iMessage, via BlueBubbles' handle-availability lookup.
 * Returns true (iMessage-capable), false (definitively not), or null (UNDETERMINED — e.g. the BB
 * Private API helper isn't connected, or the lookup errored). BlueBubbles can only send iMessage
 * (no SMS unless text-forwarding is set up), so a definitive `false` means we must NOT try to text
 * the number. `null` (can't tell) is handled by the caller as "send best-effort but hedge".
 *
 * NOTE: the availability endpoint requires BlueBubbles' Private API helper. When that helper isn't
 * connected the endpoint 500s — we return null so the feature degrades gracefully and starts working
 * automatically if the helper is later connected.
 */
export async function imessageAvailability(address: string): Promise<boolean | null> {
  const url = `${config.bluebubbles.url}/api/v1/handle/availability/imessage?address=${encodeURIComponent(address)}&password=${encodeURIComponent(config.bluebubbles.password)}`;
  const started = Date.now();
  try {
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) {
      jlog('imsg.availability', { address, ok: false, status: response.status, result: 'unknown', ms: Date.now() - started });
      return null;
    }
    const data = (await response.json().catch(() => null)) as { data?: { available?: boolean } } | null;
    const available = data?.data?.available;
    if (typeof available !== 'boolean') {
      jlog('imsg.availability', { address, ok: true, result: 'unknown', ms: Date.now() - started });
      return null;
    }
    jlog('imsg.availability', { address, ok: true, available, ms: Date.now() - started });
    return available;
  } catch (err) {
    jlog('imsg.availability', { address, ok: false, result: 'unknown', error: String(err), ms: Date.now() - started });
    return null;
  }
}
