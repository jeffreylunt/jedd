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

/**
 * The chat guid for a 1:1 conversation with `handle`.
 *
 * ⚠️ ONE OWNER FOR THIS STRING. Sending, typing and read receipts all address
 * the same conversation, and three inlined copies of `iMessage;-;${x}` are three
 * places for the form to drift — with the drift invisible, because each one
 * looks right on its own and only the *pairing* is wrong. A typing indicator
 * that lands on a different guid from the reply is a stuck indicator on one
 * thread and a silent one on another.
 *
 * 🔴 THIS IS 1:1 ONLY, exactly like `sendText`. V1 had no group support and V2
 * has not added any: a message from a group thread is answered as a stray DM to
 * the sender, and these presence signals inherit that same limitation rather
 * than quietly inventing a second addressing scheme. See the "Group chats"
 * section of `knowledge/bluebubbles-connector.md`.
 */
export function chatGuidFor(handle: string): string {
  return `iMessage;-;${handle}`;
}

/**
 * What a Private API call did.
 *
 * 🔴 `helperAbsent` IS A FIRST-CLASS OUTCOME, NOT AN ERROR.
 *
 * Typing indicators and read receipts are the only BlueBubbles operations that
 * require the Private API helper bundle, and the helper only loads with SIP
 * disabled. Measured on this server 2026-08-25 with `helper_connected: false`:
 *
 *     POST   /api/v1/chat/{guid}/typing  → 500 in ~7ms
 *     DELETE /api/v1/chat/{guid}/typing  → 500 in ~3ms
 *     POST   /api/v1/chat/{guid}/read    → 500 in ~3ms
 *     {"status":500,
 *      "message":"Please make sure you have completed the setup for the Private
 *                 API, and your helper is connected!",
 *      "error":{"type":"iMessage Error",
 *               "message":"iMessage Private API Helper is not connected!"}}
 *
 * It **fails fast and never hangs** — BlueBubbles' `restrictedPrivateApi`
 * middleware runs the check *before* the controller touches the helper socket,
 * so nothing waits on a connection that is not there. That is why this is a
 * cheap thing to attempt on every turn.
 *
 * Distinguishing it matters because it will be the outcome of EVERY call until
 * SIP is disabled, and a caller that cannot tell it apart from a real fault will
 * either log an error twelve times a day about a known, expected, harmless
 * condition — or learn to ignore the log, which is worse.
 */
export interface PrivateApiResult {
  ok: boolean;
  status: number;
  /** The helper bundle is not loaded. Expected until SIP is disabled. */
  helperAbsent: boolean;
  detail: string;
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
  /**
   * 🔴 THESE TWO ARE NOT THE SAME QUESTION, AND EITHER ONE ALONE LIES.
   *
   * `privateApiEnabled` is a SETTING in BlueBubbles' own config.
   * `helperConnected` is whether the helper dylib is actually loaded into
   * Messages.app, which only happens with SIP disabled.
   *
   * Measured on this server 2026-08-25: `true` and `false` respectively. Reading
   * only the first would say the Private API is on — and every typing indicator
   * and read receipt would still fail. The pair is the state.
   */
  privateApiEnabled: boolean;
  helperConnected: boolean;
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
  private async call(
    path: string,
    init?: RequestInit,
    timeoutMs?: number,
  ): Promise<{ status: number; body: unknown }> {
    const res = await this.fetchImpl(this.url(path), {
      ...init,
      signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
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
      // Strict `=== true`: an absent or unparseable field is NOT a capability.
      privateApiEnabled: d?.['private_api'] === true,
      helperConnected: d?.['helper_connected'] === true,
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
   *
   * ── 🔴 "OURS" IS PORT + PATH. IT WAS PATH ALONE, AND THAT WAS A LANDMINE. ───
   *
   * The staleness rule used to match on PATHNAME only, so any row ending
   * `/webhook` was fair game to delete. Live registrations on this server right
   * now:
   *
   *     id 5  http://192.168.1.7:18790/webhook    ← V1. Production. Serving a household.
   *     id 9  http://127.0.0.1:18795/webhook      ← a V2 listener
   *
   * Both are `/webhook`, because `/webhook` is what everybody calls it. Under
   * the old rule, **V2 starting up would have silently deleted V1's
   * registration** and taken the live Jedd off the air — with no log line saying
   * so, because from the code's point of view it was tidying up after itself.
   *
   * That is the right thing to do at CUTOVER and a catastrophe at every other
   * moment, and the difference is not something the registration path can see.
   * So it no longer guesses: a row on a **different port is somebody else's**,
   * and we do not delete other people's registrations. The original incident is
   * still covered, because a host change (`127.0.0.1:18790` → `192.168.1.7:18790`)
   * keeps the port.
   *
   * Taking V1 down is a DELIBERATE, SEPARATE step — `deleteWebhook(5)` in the
   * runbook, recorded before it is done so it can be undone.
   *
   * ⚠️ Returns what it did. A removal that nobody logs is the orphan bug wearing
   * the opposite sign.
   */
  async ensureWebhook(
    url: string,
    events: string[],
  ): Promise<{ outcome: 'already-registered' | 'created'; removed: { id: number; url: string }[] }> {
    const existing = await this.listWebhooks();
    if (existing.some((w) => w.url === url)) return { outcome: 'already-registered', removed: [] };

    const mine = BlueBubblesClient.endpointKey(url);
    const removed: { id: number; url: string }[] = [];
    for (const w of existing) {
      if (w.url !== url && BlueBubblesClient.endpointKey(w.url) === mine) {
        await this.call(`/webhook/${w.id}`, { method: 'DELETE' });
        removed.push({ id: w.id, url: w.url });
      }
    }
    await this.call('/webhook', { method: 'POST', body: JSON.stringify({ url, events }) });
    return { outcome: 'created', removed };
  }

  /**
   * `port:path` — what makes a registration OURS across a host change.
   *
   * A malformed URL falls back to the whole string, which can only ever match
   * itself. That is the fail-closed direction: an unparseable row is never
   * mistaken for one of ours and deleted.
   */
  private static endpointKey(url: string): string {
    try {
      const u = new URL(url);
      return `${u.port}:${u.pathname}`;
    } catch {
      return url;
    }
  }

  /**
   * Remove one registration by id. The DOWN step of a cutover, and the thing
   * that undoes an UP step.
   *
   * 🔴 Deliberately takes an ID, not a URL. Deleting a webhook is how the live
   * Jedd is taken off the air, and that is not an action anything should perform
   * as a side effect of matching a pattern — the caller has to have looked at the
   * list and named the row.
   */
  async deleteWebhook(id: number): Promise<{ ok: boolean; status: number }> {
    const { status } = await this.call(`/webhook/${id}`, { method: 'DELETE' });
    return { ok: status >= 200 && status < 300, status };
  }

  /**
   * The newest `originalROWID` the server knows about, for seeding a watermark.
   *
   * 🔴 EXISTS SO A FIRST BOOT DOES NOT REPLY TO HISTORY. See
   * `BlueBubblesReceiver.replayMissed()` — a virgin `SeenStore` has watermark 0,
   * and replaying from 0 would walk back up to 20 pages and hand every one of
   * those messages to the agent as if it had just arrived.
   *
   * `null` when the server cannot be read or has no messages. The caller must
   * treat that as "do not know", never as 0 — 0 is the value that causes the
   * flood.
   */
  async newestRowid(): Promise<number | null> {
    const { body } = await this.call('/message/query', {
      method: 'POST',
      body: JSON.stringify({ limit: 1, sort: 'DESC', with: ['handle'] }),
    });
    const rows = BlueBubblesClient.data(body);
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const raw = (rows[0] as Record<string, unknown>)['originalROWID'];
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
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
        chatGuid: chatGuidFor(to),
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

  /**
   * ── PRIVATE API SURFACE: typing indicators and read receipts ───────────────
   *
   * 🔴 THESE DELIBERATELY DO NOT SWALLOW THEIR OWN FAILURES.
   *
   * They are the only calls in this file whose whole point is that they must
   * never break a reply — so the temptation is to make them un-throwable right
   * here. That would be a mistake, because the swallow belongs in exactly one
   * place (`Presence`) and a subject that cannot throw cannot be used to prove
   * that its caller survives a throw. A test that stubs `fetch` to reject and
   * asserts the turn still completes only means something while these can
   * genuinely propagate. So an HTTP error comes back as a RESULT and a transport
   * failure comes back as a THROW, the same as every other method here.
   *
   * ⚠️ The timeout is short and separate from `this.timeoutMs`. A presence
   * signal that is 5 seconds late is worthless even if it succeeds, and holding
   * a request open for 15s to deliver one is 15s of an open socket bought for
   * nothing.
   */
  private static readonly PRESENCE_TIMEOUT_MS = 5_000;

  private async presenceCall(path: string, method: 'POST' | 'DELETE'): Promise<PrivateApiResult> {
    const { status, body } = await this.call(path, { method }, BlueBubblesClient.PRESENCE_TIMEOUT_MS);
    const b = body as { message?: unknown; error?: { message?: unknown } } | null;
    const inner = typeof b?.error?.message === 'string' ? b.error.message : '';
    const outer = typeof b?.message === 'string' ? b.message : '';
    // Match on the helper's own wording. `restrictedPrivateApi` throws with the
    // outer sentence and carries the inner one from `checkPrivateApiStatus()`;
    // both are checked because only one of them names the *helper* specifically
    // and the other also fires when the setting itself is off.
    const helperAbsent =
      status >= 400 && /helper is not connected|your helper is connected/i.test(`${inner} ${outer}`);
    return {
      ok: status >= 200 && status < 300,
      status,
      helperAbsent,
      detail: helperAbsent
        ? `Private API helper is not connected (http ${status}). Expected until SIP is disabled and the ` +
          'BlueBubbles helper bundle is installed — this is not a fault and nothing was lost but a nicety.'
        : status >= 400
          ? `http ${status}: ${outer || inner || 'no message'}`
          : `http ${status}`,
    };
  }

  /**
   * Show "…" in the recipient's thread.
   *
   * 🔴 IT DOES NOT STOP BY ITSELF ON OUR SIDE. The helper calls Apple's
   * `-[IMChat setLocalUserIsTyping:]` (confirmed in the shipped
   * `BlueBubblesHelper.dylib`), and neither BlueBubbles nor the helper holds any
   * expiry timer — BlueBubbles only tracks a `typingCache` array so it can stop
   * on send. Whatever hides the indicator afterwards is Apple's, on the
   * RECIPIENT'S device, and is not a number this codebase can see. So the stop
   * is ours to guarantee: see `Presence`.
   */
  async startTyping(chatGuid: string): Promise<PrivateApiResult> {
    return this.presenceCall(`/chat/${encodeURIComponent(chatGuid)}/typing`, 'POST');
  }

  /** Hide the "…". Must always run — see `Presence.withTyping`. */
  async stopTyping(chatGuid: string): Promise<PrivateApiResult> {
    return this.presenceCall(`/chat/${encodeURIComponent(chatGuid)}/typing`, 'DELETE');
  }

  /**
   * Mark the conversation read, so the sender sees "Read" rather than
   * "Delivered".
   *
   * ⚠️ It marks the **CHAT**, not the one message — BlueBubbles' controller
   * forwards `mark-chat-read` with a chat guid and nothing finer. On a 1:1
   * thread that is the same thing in practice, but it means a backlog recovered
   * by replay is marked read wholesale by the first message we act on.
   */
  async markChatRead(chatGuid: string): Promise<PrivateApiResult> {
    return this.presenceCall(`/chat/${encodeURIComponent(chatGuid)}/read`, 'POST');
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
