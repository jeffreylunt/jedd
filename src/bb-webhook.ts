import http from 'http';
import { EventEmitter } from 'events';
import { config } from './config.js';
import type { IncomingMessage } from './types.js';

const WEBHOOK_PATH = '/webhook';

interface BBHandle {
  address?: string;
  service?: string;
}

interface BBMessageData {
  originalROWID?: number;
  guid?: string;
  text?: string;
  dateCreated?: number;
  isFromMe?: boolean;
  handle?: BBHandle | null;
  chats?: Array<{ chatIdentifier?: string; originalROWID?: number }>;
}

interface BBWebhookPayload {
  type?: string;
  data?: BBMessageData;
}

export class BlueBubblesListener extends EventEmitter {
  private server: http.Server | null = null;
  private processedIds: Set<number>;
  private sinceRowid?: number;
  private port: number;

  constructor(initialProcessedIds: number[] = [], sinceRowid?: number, port?: number) {
    super();
    this.processedIds = new Set(initialProcessedIds);
    this.sinceRowid = sinceRowid;
    this.port = port ?? config.bluebubbles.webhookPort;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.handleRequest(req, res));

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.server!.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        this.server!.removeListener('error', onError);
        resolve();
      };
      this.server!.once('error', onError);
      this.server!.once('listening', onListening);
      this.server!.listen(this.port, config.bluebubbles.webhookHost);
    });

    console.log(`[bb-webhook] Listening on http://${config.bluebubbles.webhookHost}:${this.port}${WEBHOOK_PATH}`);

    try {
      await this.registerWebhook();
    } catch (err) {
      console.error('[bb-webhook] Webhook registration failed:', err);
      throw err;
    }

    if (this.sinceRowid !== undefined) {
      try {
        await this.replayMissed(this.sinceRowid);
      } catch (err) {
        console.error('[bb-webhook] Replay failed (non-fatal):', err);
      }
    }
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  getProcessedIds(): number[] {
    return [...this.processedIds];
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Liveness probe for container healthchecks.
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    if (req.method !== 'POST' || req.url !== WEBHOOK_PATH) {
      res.writeHead(404);
      res.end();
      return;
    }

    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 2 * 1024 * 1024) {
        req.destroy();
      }
    });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');

      let payload: BBWebhookPayload;
      try {
        payload = JSON.parse(body);
      } catch {
        console.error('[bb-webhook] Invalid JSON payload, ignoring');
        return;
      }

      try {
        this.handlePayload(payload);
      } catch (err) {
        console.error('[bb-webhook] Error handling payload:', err);
      }
    });
    req.on('error', (err) => {
      console.error('[bb-webhook] Request error:', err);
    });
  }

  private handlePayload(payload: BBWebhookPayload): void {
    if (payload.type !== 'new-message') return;
    const data = payload.data;
    if (!data) return;
    this.ingest(data, 'webhook');
  }

  private ingest(data: BBMessageData, source: 'webhook' | 'replay'): void {
    const rowid = data.originalROWID;
    const guid = data.guid;
    const text = (data.text || '').trim();
    const isFromMe = data.isFromMe === true;
    const senderRaw = data.handle?.address || '';

    if (isFromMe) {
      console.log(`[bb-webhook] ${source}: skipped outbound echo rowid=${rowid} (isFromMe=true)`);
      return;
    }
    if (!text) return;
    if (!senderRaw) return;
    if (rowid === undefined) return;

    if (this.processedIds.has(rowid)) {
      return;
    }
    this.processedIds.add(rowid);
    if (this.processedIds.size > 2000) {
      const ids = [...this.processedIds];
      this.processedIds = new Set(ids.slice(-1000));
    }

    const normalized = normalizePhone(senderRaw);
    const timestamp = data.dateCreated ? new Date(data.dateCreated).toISOString() : new Date().toISOString();
    const chatId = data.chats?.[0]?.originalROWID;

    const message: IncomingMessage = {
      rowid,
      sender: normalized,
      text,
      timestamp,
      isFromMe: false,
      chatId,
    };

    console.log(`[bb-webhook] ${source}: message ${rowid} (guid=${guid?.slice(0, 8)}) from ${normalized}: ${text.substring(0, 80)}`);
    this.emit('message', message);
  }

  private async registerWebhook(): Promise<void> {
    const url = config.bluebubbles.webhookUrl;
    const existing = await bbFetch<Array<{ id: number; url: string; events: string[] }>>('GET', '/api/v1/webhook');

    const match = existing?.find((w) => w.url === url);
    if (match) {
      console.log(`[bb-webhook] Reusing existing webhook id=${match.id} url=${match.url}`);
      return;
    }

    const created = await bbFetch<{ id: number; url: string; events: string[] }>('POST', '/api/v1/webhook', {
      url,
      events: ['new-message'],
    });
    console.log(`[bb-webhook] Registered webhook id=${created?.id} url=${url} events=[new-message]`);
  }

  private async replayMissed(sinceRowid: number): Promise<void> {
    const limit = 50;
    const result = await bbFetch<Array<BBMessageData>>('POST', '/api/v1/message/query', {
      limit,
      sort: 'DESC',
      with: ['handle', 'chat'],
    });

    if (!Array.isArray(result)) return;

    const toReplay = result
      .filter((m) => typeof m.originalROWID === 'number' && m.originalROWID > sinceRowid)
      .sort((a, b) => (a.originalROWID! - b.originalROWID!));

    if (toReplay.length === 0) {
      console.log(`[bb-webhook] Replay: no messages after rowid ${sinceRowid}`);
      return;
    }
    console.log(`[bb-webhook] Replay: ${toReplay.length} missed messages after rowid ${sinceRowid}`);
    for (const m of toReplay) {
      this.ingest(m, 'replay');
    }
  }
}

function normalizePhone(phone: string): string {
  const cleaned = phone.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('1') && cleaned.length === 11) return '+' + cleaned;
  if (cleaned.length === 10) return '+1' + cleaned;
  return '+' + cleaned;
}

async function bbFetch<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T | undefined> {
  const base = config.bluebubbles.url.replace(/\/$/, '');
  const sep = path.includes('?') ? '&' : '?';
  const url = `${base}${path}${sep}password=${encodeURIComponent(config.bluebubbles.password)}`;

  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);
  const raw = await res.text();
  let parsed: { status?: number; message?: string; data?: T } = {};
  try { parsed = JSON.parse(raw); } catch { /* ignore */ }

  if (!res.ok || (parsed.status && parsed.status >= 400)) {
    throw new Error(`BB ${method} ${path} failed (${res.status}): ${parsed.message || raw.slice(0, 200)}`);
  }
  return parsed.data;
}
