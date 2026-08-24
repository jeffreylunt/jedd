/**
 * jfa-go — minting Jellyfin invites.
 *
 * ── 🔴 WHAT AN INVITE ACTUALLY IS ────────────────────────────────────────────
 *
 * `remaining-uses: 1`, `multiple-uses: false`, validity 24 h, and — the flag
 * that sets the stakes — **`user-expiry: false`**.
 *
 * **So possession of the code grants ONE PERMANENT Jellyfin account, redeemable
 * once, within 24 hours.** The invite expires; the account it creates does not.
 *
 * That is the same asymmetry as a Kindle send one level up: **revocable until
 * redeemed, irreversible after.** Undoing a redeemed invite means deleting a
 * real person's account, which is a different act entirely.
 *
 * ── ⚠️ THE CODE IS NOT IN THE CREATE RESPONSE ────────────────────────────────
 *
 * `POST /invites` answers `{success:true}` and nothing else, so the code is read
 * back from `GET /invites` by matching a unique label. **That means there is a
 * window in which a live invite exists whose code we do not know** — and an
 * invite we cannot name is an invite we cannot revoke. The read-back therefore
 * retries, and a final miss is reported LOUDLY WITH THE LABEL so a human can
 * find and delete it by hand.
 */

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface JfagoOptions {
  baseUrl: string;
  username: string;
  password: string;
  /**
   * 🔴 jfa-go's OWN public base, INCLUDING its `url_base` — the signup page is
   * served at `<base>/invite/<code>`.
   *
   * **This is NOT the Jellyfin URL, and the two are one path segment apart on
   * the same host:** `https://jeffreylunt.com/accounts` (jfa-go, correct) versus
   * `https://jeffreylunt.com/jellyfin` (Jellyfin, wrong). A link built from the
   * second is a 404 — and it is a 404 handed to a guest inside a message that
   * says "set up your account here", after a real invite has been minted and
   * charged against their quota. Nothing in this process could detect it: the
   * mint succeeded, the send succeeded, and the only thing that failed happened
   * in somebody else's browser.
   *
   * The field used to be called `publicUrl` and documented as the Jellyfin URL.
   * Renamed rather than re-commented, because the name is what a caller reads
   * when deciding which of two adjacent values to pass.
   */
  inviteBaseUrl: string;
  profile: string;
  validityHours: number;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  /**
   * How long to wait between read-back attempts. Injectable so the retry is a
   * real wait in production and free in tests.
   *
   * ⚠️ Zero here makes the retry loop decorative: three back-to-back requests
   * against a service that lags by even 50 ms all miss, and the outcome is an
   * `orphaned` — a live credential nobody can name — reported for a race that
   * would have resolved itself.
   */
  readBackDelayMs?: number;
}

export interface Invite {
  code: string;
  link: string;
  label: string;
}

export type MintOutcome =
  | { state: 'minted'; invite: Invite }
  /**
   * 🔴 Created but unreadable. A LIVE credential exists and we cannot name it,
   * so we cannot revoke it. This is the one outcome a human must see.
   */
  | { state: 'orphaned'; label: string; detail: string }
  | { state: 'failed'; detail: string };

export class JfagoClient {
  private readonly fetchImpl: FetchImpl;

  private readonly timeoutMs: number;

  constructor(private readonly opts: JfagoOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  private async call(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    init: { token?: string; basic?: boolean; body?: unknown } = {},
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const headers: Record<string, string> = {};
    if (init.basic) {
      headers['Authorization'] =
        'Basic ' + Buffer.from(`${this.opts.username}:${this.opts.password}`).toString('base64');
    } else if (init.token) {
      headers['Authorization'] = `Bearer ${init.token}`;
    }
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
        method,
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      return { ok: false, status: 0, body: { error: (e as Error).message } };
    }
    const text = await res.text().catch(() => '');
    let body: unknown = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text.slice(0, 200) };
    }
    return { ok: res.ok, status: res.status, body };
  }

  private async token(): Promise<string | null> {
    const r = await this.call('GET', '/token/login', { basic: true });
    const t = (r.body as { token?: string } | undefined)?.token;
    return r.ok && typeof t === 'string' && t ? t : null;
  }

  private link(code: string): string {
    return `${this.opts.inviteBaseUrl.replace(/\/$/, '')}/invite/${code}`;
  }

  /** Mint a single-use invite and read its code back. */
  async mint(label: string): Promise<MintOutcome> {
    const token = await this.token();
    if (!token) return { state: 'failed', detail: 'could not authenticate with jfa-go.' };

    const created = await this.call('POST', '/invites', {
      token,
      body: {
        months: 0,
        days: 0,
        hours: this.opts.validityHours,
        minutes: 0,
        'user-expiry': false,
        'send-to': '',
        'multiple-uses': false,
        'no-limit': false,
        'remaining-uses': 1,
        profile: this.opts.profile,
        label,
      },
    });
    if (!created.ok) {
      return { state: 'failed', detail: `jfa-go refused to create the invite (http ${created.status}).` };
    }

    // The code is not in the create response. Read it back by label; GET can lag
    // the POST, so this retries rather than concluding on the first miss.
    const delay = this.opts.readBackDelayMs ?? 300;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0 && delay > 0) await new Promise((r) => setTimeout(r, delay));
      const listed = await this.call('GET', '/invites', { token });
      const invites = (listed.body as { invites?: { code?: string; label?: string }[] } | undefined)?.invites;
      const match = Array.isArray(invites)
        ? invites.find((i) => i.label === label && typeof i.code === 'string' && i.code)
        : undefined;
      if (match?.code) {
        return { state: 'minted', invite: { code: match.code, link: this.link(match.code), label } };
      }
    }
    return {
      state: 'orphaned',
      label,
      detail:
        `🔴 An invite was CREATED in jfa-go but its code could not be read back, so it cannot be ` +
        `revoked automatically. A live single-use invite exists under the label "${label}" and will ` +
        `remain valid for ${this.opts.validityHours}h. Delete it by hand in jfa-go.`,
    };
  }

  /**
   * Revoke an invite by code.
   *
   * 🔴 The failure path OWNS this. Because the link IS the message, the credential
   * must exist before the risky operation — so when that operation fails, the
   * failure branch destroys it rather than trying to contain it. **A withheld
   * link is still a link; a deleted one is not.**
   */
  async revoke(code: string): Promise<{ revoked: boolean; detail: string }> {
    const token = await this.token();
    if (!token) {
      return {
        revoked: false,
        detail: `could not authenticate with jfa-go to revoke invite ${code}. IT IS STILL LIVE.`,
      };
    }
    const r = await this.call('DELETE', '/invites', { token, body: { code } });
    return r.ok
      ? { revoked: true, detail: `invite ${code} revoked.` }
      : {
          revoked: false,
          detail: `🔴 FAILED to revoke invite ${code} (http ${r.status}). IT IS STILL LIVE — delete it by hand in jfa-go.`,
        };
  }
}
