import { config } from './config.js';

export async function sendMessage(to: string, text: string): Promise<void> {
  const chatGuid = `iMessage;-;${to}`;
  console.log(`[bluebubbles] Sending to ${to}: ${text.substring(0, 80)}...`);

  const url = `${config.bluebubbles.url}/api/v1/message/text?password=${encodeURIComponent(config.bluebubbles.password)}`;
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
    throw new Error(`BlueBubbles send failed (${response.status}): ${body}`);
  }
}
