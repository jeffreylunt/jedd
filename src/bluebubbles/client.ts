/**
 * The BlueBubbles HTTP surface.
 *
 * Every trap encoded here was measured against the live server, not read from
 * documentation. See `knowledge/bluebubbles-connector.md` in the space.
 */

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * iMessage has no renderer, so markdown ships as literal punctuation: a reply
 * reading `**Dune** is ready` arrives with the asterisks visible.
 *
 * Deliberately conservative. This runs on EVERY outbound message, so an
 * over-eager rule corrupts real text — a title like `*batteries not included`
 * or a path like `some_file_name` must survive. It strips only the markers that
 * wrap content, and leaves anything it is unsure about alone. **Stripping is a
 * cosmetic fix; mangling a title is a correctness bug**, so the asymmetry
 * decides the default.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[a-z]*\n?([\s\S]*?)```/g, '$1')   // fenced blocks
    .replace(/`([^`\n]+)`/g, '$1')                  // inline code
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')           // bold
    .replace(/__([^_\n]+)__/g, '$1')                // bold (underscore)
    .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '$1 ($2)') // links keep the url
    .replace(/^#{1,6}\s+/gm, '')                    // headings
    .replace(/^\s*[-*]\s+/gm, '• ')                 // bullets
    .trim();
}

export interface BlueBubblesOptions {
  baseUrl: string;
  password: string;
  /**
   * 🔴 The Apple account this server MUST be bridging.
   *
   * There are two BlueBubbles servers on the Mac: `:1234` is Jedd
   * (`jeffreylunt@outlook.com`) and `:1235` is Jeff's PERSONAL account, used by
   * the orchestrator to read 2FA codes. **Both use the literal default password
   * and expose the same API**, so a copy-pasted `.env` connects *successfully*
   * to the wrong identity and Jedd texts from the wrong person. Nothing about
   * that failure looks like an error, which is why it is checked at boot.
   */
  expectedIdentity?: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

export interface ServerInfo {
  detectedIMessage: string;
  serverVersion: string;
}

export interface SendResult {
  /** The server took it without an error code. NOT a delivery claim. */
  accepted: boolean;
  guid: string | null;
  /** Three-state. `unknown` is not a "no". */
  delivery: DeliveryVerdict;
  detail: string;
}

export type DeliveryVerdict = 'delivered' | 'failed' | 'unknown';

export interface ReplayResult {
  /** Oldest first, so they can be fed through the normal path in order. */
  messages: Record<string, unknown>[];
  /**
   * True when the walk hit its page budget before reaching the watermark, i.e.
   * the replay is INCOMPLETE. V1 loses these silently; this says so.
   */
  saturated: boolean;
  pages: number;
}

/** How many pages `replaySince` will walk before declaring saturation. */
export const MAX_REPLAY_PAGES = 20;
const PAGE_SIZE = 100;

export class BlueBubblesClient {
  private readonly fetchImpl: FetchImpl;

  private readonly timeoutMs: number;

  constructor(private readonly opts: BlueBubblesOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  private url(path: string): string {
    const sep = path.includes('?') ? '&' : '?';
    return `${this.opts.baseUrl}/api/v1${path}${sep}password=${encodeURIComponent(this.opts.password)}`;
  }

  /**
   * Every request is bounded. V1's `postText` has NO timeout at all, so a hung
   * BlueBubbles blocks it forever — and the attachment endpoint is the proven
   * case, hanging >90s with no response for an unreachable recipient while the
   * text endpoint fails fast in ~1s. Do not assume one endpoint's timing
   * generalises to another.
   */
  private async call(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
    const res = await this.fetchImpl(this.url(path), {
      ...init,
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }

  private static data(body: unknown): unknown {
    return (body as { data?: unknown } | null)?.data;
  }

  async serverInfo(): Promise<ServerInfo> {
    const { status, body } = await this.call('/server/info');
    const d = BlueBubblesClient.data(body) as Record<string, unknown> | undefined;
    const detected = typeof d?.['detected_imessage'] === 'string' ? d['detected_imessage'] : '';
    if (status >= 400 || !detected) {
      throw new Error(
        `Could not read BlueBubbles server identity (http ${status}). This is UNKNOWN, not "probably ` +
          'the right server" — refusing to start rather than risk texting from the wrong Apple account.',
      );
    }
    return {
      detectedIMessage: detected,
      serverVersion: String(d?.['server_version'] ?? 'unknown'),
    };
  }

  /** Refuse to run against the wrong Apple account. Throws; the caller must not catch it. */
  async assertIdentity(): Promise<ServerInfo> {
    const info = await this.serverInfo();
    const want = this.opts.expectedIdentity;
    if (want && info.detectedIMessage.toLowerCase() !== want.toLowerCase()) {
      throw new Error(
        `WRONG BLUEBUBBLES SERVER: ${this.opts.baseUrl} is bridging "${info.detectedIMessage}", ` +
          `but this deployment expects "${want}". Both servers on this host accept the same ` +
          'password and expose the same API, so this connects successfully to the wrong identity. ' +
          'Refusing to start.',
      );
    }
    return info;
  }

  async listWebhooks(): Promise<{ id: number; url: string; events: string[] }[]> {
    const { body } = await this.call('/webhook');
    const rows = BlueBubblesClient.data(body);
    if (!Array.isArray(rows)) return [];
    return rows.map((r) => {
      const row = r as Record<string, unknown>;
      const ev = row['events'];
      return {
        id: Number(row['id']),
        url: String(row['url'] ?? ''),
        events: Array.isArray(ev) ? ev.map(String) : typeof ev === 'string' ? [ev] : [],
      };
    });
  }

  /**
   * Register our webhook, removing any stale row that points at us-but-elsewhere.
   *
   * 🔴 V1 dedups by exact URL string and only ever ADDS. When the registered URL
   * changed (loopback → LAN IP) it left an ORPHAN pointing at an unreachable
   * address, and **nothing failed loudly** — BlueBubbles delivered into a black
   * hole for an entire version. Registration has to converge on one row.
   */
  async ensureWebhook(url: string, events: string[]): Promise<void> {
    const existing = await this.listWebhooks();
    if (existing.some((w) => w.url === url)) return;

    // Remove rows that are ours by shape (same path) but stale by address.
    let path = '';
    try {
      path = new URL(url).pathname;
    } catch {
      path = url;
    }
    for (const w of existing) {
      let wPath = '';
      try {
        wPath = new URL(w.url).pathname;
      } catch {
        wPath = w.url;
      }
      if (wPath === path && w.url !== url) {
        await this.call(`/webhook/${w.id}`, { method: 'DELETE' });
      }
    }
    await this.call('/webhook', { method: 'POST', body: JSON.stringify({ url, events }) });
  }

  /**
   * Everything after `sinceRowid`, oldest first, paging until the watermark is
   * reached or the page budget runs out.
   *
   * 🔴 V1 queries `limit:50` with NO pagination and filters client-side, so an
   * outage longer than 50 messages loses the older ones permanently — and says
   * nothing. Saturation here is reported, not hidden.
   */
  async replaySince(sinceRowid: number): Promise<ReplayResult> {
    const collected: Record<string, unknown>[] = [];
    let pages = 0;
    let saturated = true;

    for (; pages < MAX_REPLAY_PAGES; pages++) {
      const { body } = await this.call('/message/query', {
        method: 'POST',
        body: JSON.stringify({
          limit: PAGE_SIZE,
          offset: pages * PAGE_SIZE,
          sort: 'DESC',
          with: ['handle', 'chat'],
        }),
      });
      const rows = BlueBubblesClient.data(body);
      if (!Array.isArray(rows) || rows.length === 0) {
        saturated = false; // ran out of history: the walk is complete
        break;
      }
      let reachedWatermark = false;
      for (const r of rows as Record<string, unknown>[]) {
        const rowid = Number(r['originalROWID']);
        if (Number.isFinite(rowid) && rowid <= sinceRowid) {
          reachedWatermark = true;
          break;
        }
        collected.push(r);
      }
      if (reachedWatermark) {
        saturated = false;
        break;
      }
      if (rows.length < PAGE_SIZE) {
        saturated = false;
        break;
      }
    }

    collected.sort((a, b) => Number(a['originalROWID']) - Number(b['originalROWID']));
    return { messages: collected, saturated, pages };
  }

  /**
   * Send text.
   *
   * 🔴 A 200 means "no error code at send time". It is NOT delivery. A real
   * verdict needs `deliveryVerdict(guid)`, and BlueBubbles reports a genuine
   * red-bubble failure as **HTTP 500 "Message sent with an error"** with a
   * written-but-undelivered row carrying `error: 22`.
   */
  async sendText(to: string, text: string): Promise<SendResult> {
    const { status, body } = await this.call('/message/text', {
      method: 'POST',
      body: JSON.stringify({
        chatGuid: `iMessage;-;${to}`,
        message: stripMarkdown(text),
        tempGuid: `jedd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      }),
    });
    if (status >= 400) {
      return {
        accepted: false,
        guid: null,
        delivery: 'failed',
        detail: `BlueBubbles refused the send (http ${status}). This is a delivery failure that has ALREADY happened, not a pending state.`,
      };
    }
    const d = BlueBubblesClient.data(body) as Record<string, unknown> | undefined;
    const guid = typeof d?.['guid'] === 'string' ? d['guid'] : null;
    return {
      accepted: true,
      guid,
      delivery: 'unknown',
      detail: 'accepted with no error code at send time — this is NOT a delivery confirmation',
    };
  }

  /** Three-state delivery verdict for a sent message. `unknown` is not a "no". */
  async deliveryVerdict(guid: string): Promise<DeliveryVerdict> {
    const { status, body } = await this.call(`/message/${encodeURIComponent(guid)}`);
    if (status >= 400) return 'unknown';
    const d = BlueBubblesClient.data(body) as Record<string, unknown> | undefined;
    if (!d) return 'unknown';
    const error = Number(d['error'] ?? 0);
    if (Number.isFinite(error) && error !== 0) return 'failed';
    if (d['isDelivered'] === true) return 'delivered';
    const delivered = Number(d['dateDelivered'] ?? 0);
    if (Number.isFinite(delivered) && delivered > 0) return 'delivered';
    return 'unknown';
  }
}
