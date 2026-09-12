import { describeError, redactUrlSecrets } from './errors.js';

/**
 * Audiobookshelf admin API — create / verify / delete user accounts.
 *
 * Measured 2026-09-04 (feasibility) and re-checked 2026-09-12 on ABS 2.36.0:
 *  - jfa-go cannot create ABS accounts (Route A is impossible).
 *  - `POST /api/users` works; **`isActive` defaults to false** — omit it and the
 *    account cannot log in.
 *  - Verify with `GET /api/users/:id` only. **Never** `GET /api/users` (enumerates
 *    other users' tokens when called as root).
 *  - Jeff 2026-09-05: new users get **accessAllLibraries: true** (Books + Podcasts).
 */

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface AbsOptions {
  baseUrl: string;
  apiKey: string;
  /** URL put in the invite text (often same as baseUrl on LAN). */
  publicUrl: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

export interface AbsUser {
  id: string;
  username: string;
  isActive: boolean;
  type: string;
}

export type CreateUserOutcome =
  | { state: 'created'; user: AbsUser }
  | { state: 'failed'; detail: string };

export type DeleteUserOutcome =
  | { state: 'deleted'; detail: string }
  | { state: 'failed'; detail: string };

export class AbsClient {
  private readonly fetchImpl: FetchImpl;
  private readonly timeoutMs: number;
  private readonly base: string;

  constructor(private readonly opts: AbsOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.base = opts.baseUrl.replace(/\/$/, '');
  }

  get publicUrl(): string {
    return this.opts.publicUrl.replace(/\/$/, '');
  }

  private async call(
    method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
    path: string,
    body?: unknown,
  ): Promise<{ ok: boolean; status: number; body: unknown; detail: string }> {
    const url = `${this.base}${path.startsWith('/') ? path : `/${path}`}`;
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await res.text();
      let parsed: unknown = null;
      if (text.trim()) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text.slice(0, 200);
        }
      }
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          body: parsed,
          detail: `HTTP ${res.status} from ${redactUrlSecrets(url)}: ${text.slice(0, 160)}`,
        };
      }
      return { ok: true, status: res.status, body: parsed, detail: 'ok' };
    } catch (e) {
      return {
        ok: false,
        status: 0,
        body: null,
        detail: `could not reach ${redactUrlSecrets(url)}: ${describeError(e)}`,
      };
    }
  }

  /**
   * Create a login-capable user. Always sends `isActive: true` and
   * `accessAllLibraries: true` (Books + Podcasts) — Jeff's 2026-09-05 choice.
   */
  async createUser(username: string, password: string): Promise<CreateUserOutcome> {
    const res = await this.call('POST', '/api/users', {
      username,
      password,
      type: 'user',
      isActive: true,
      permissions: {
        download: true,
        update: false,
        delete: false,
        upload: false,
        createEreader: false,
        accessAllLibraries: true,
        accessAllTags: true,
        accessExplicitContent: false,
        librariesAccessible: [],
        itemTagsSelected: [],
      },
    });
    if (!res.ok) return { state: 'failed', detail: res.detail };
    const user = parseUser(res.body);
    if (!user) {
      return {
        state: 'failed',
        detail:
          'Audiobookshelf accepted the create but the response had no usable user id — ' +
          'UNKNOWN whether the account exists. Do not invent credentials.',
      };
    }
    if (!user.isActive) {
      return {
        state: 'failed',
        detail:
          `Audiobookshelf created "${user.username}" but isActive is false — a disabled account. ` +
          'Nothing usable was provisioned.',
      };
    }
    return { state: 'created', user };
  }

  /** Single-user verify — never enumerate `/api/users`. */
  async getUser(id: string): Promise<CreateUserOutcome> {
    const res = await this.call('GET', `/api/users/${encodeURIComponent(id)}`);
    if (!res.ok) return { state: 'failed', detail: res.detail };
    const user = parseUser(res.body);
    if (!user) return { state: 'failed', detail: 'verify response had no usable user object' };
    return { state: 'created', user };
  }

  async deleteUser(id: string): Promise<DeleteUserOutcome> {
    const res = await this.call('DELETE', `/api/users/${encodeURIComponent(id)}`);
    if (!res.ok) return { state: 'failed', detail: res.detail };
    return { state: 'deleted', detail: `deleted user ${id}` };
  }
}

function parseUser(body: unknown): AbsUser | null {
  if (!body || typeof body !== 'object') return null;
  const root = body as Record<string, unknown>;
  const raw = (typeof root.user === 'object' && root.user !== null ? root.user : root) as Record<
    string,
    unknown
  >;
  const id = typeof raw.id === 'string' ? raw.id : '';
  const username = typeof raw.username === 'string' ? raw.username : '';
  if (!id || !username) return null;
  return {
    id,
    username,
    isActive: Boolean(raw.isActive),
    type: typeof raw.type === 'string' ? raw.type : 'user',
  };
}
