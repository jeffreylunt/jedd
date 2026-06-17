import { config } from './config.js';
import { jlog, truncate } from './logger.js';

// --- jfa-go admin API client (Jellyfin account provisioning) ------------------------------------
//
// jfa-go (https://github.com/hrfee/jfa-go) manages Jellyfin signups via single-use invite links.
// This client speaks its admin API to: log in (Basic → Bearer JWT), generate an invite, read the
// generated code back (the create endpoint returns only {success:true} — NOT the code), and delete
// an invite. Every call is logged at the HTTP layer (method/path/status/ms) with NO credentials:
// the Basic header and Bearer token are built locally and never passed to jlog (jlog also redacts
// `password=`/`token:`/`Bearer …` as a backstop). All paths are relative to config.jfago.url, which
// already includes jfa-go's url_base (e.g. https://host/accounts).

export interface JfagoInvite {
  code: string;
  label?: string;
  profile?: string;
  send_to?: string;
  'remaining-uses'?: number;
  'no-limit'?: boolean;
}

export interface CreateInviteOpts {
  /** Unique admin-visible label — used to read the generated code back out of GET /invites. */
  label: string;
  /** jfa-go profile name to apply to the created account (library-access template). '' = default. */
  profile?: string;
  /** If set, jfa-go emails the invite link to this address (its native "send-to"). */
  email?: string;
  /** Invite validity window in hours (default config.jfago.inviteValidityHours). */
  validityHours?: number;
}

export interface InviteResult {
  code: string;
  link: string;
}

function basicAuthHeader(): string {
  const raw = `${config.jfago.user}:${config.jfago.password}`;
  return 'Basic ' + Buffer.from(raw, 'utf-8').toString('base64');
}

/** Build the public invite signup URL from a code. jfa-go serves it at <url_base>/invite/<code>. */
export function inviteLink(code: string): string {
  return `${config.jfago.url}/invite/${code}`;
}

interface FetchOpts {
  token?: string;
  body?: unknown;
  auth?: 'basic' | 'bearer';
}

async function jfagoFetch<T>(method: 'GET' | 'POST' | 'DELETE', path: string, opts: FetchOpts = {}): Promise<T> {
  if (!config.jfago.url) throw new Error('jfa-go is not configured (JFAGO_URL is empty)');
  const url = `${config.jfago.url}${path}`;
  const headers: Record<string, string> = {};
  if (opts.auth === 'basic') headers['Authorization'] = basicAuthHeader();
  else if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    jlog('jfago.http', { method, path, ok: false, error: String(err), ms: Date.now() - started });
    throw err;
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    jlog('jfago.http', { method, path, status: res.status, ok: false, ms: Date.now() - started, error: truncate(text, 500) });
    throw new Error(`jfa-go ${method} ${path}: ${res.status} ${res.statusText}`.trim());
  }
  jlog('jfago.http', { method, path, status: res.status, ok: true, ms: Date.now() - started });
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return {} as T;
  }
}

/** Log in with the admin Basic creds and return a short-lived Bearer token. */
export async function getToken(): Promise<string> {
  const data = await jfagoFetch<{ token?: string }>('GET', '/token/login', { auth: 'basic' });
  if (!data.token) throw new Error('jfa-go: no token in /token/login response');
  return data.token;
}

/** Generate an invite. NOTE: jfa-go returns only {success:true} — the code is NOT in the response;
 *  read it back with listInvites() by matching the unique label. */
export async function createInvite(token: string, opts: CreateInviteOpts): Promise<void> {
  const hours = opts.validityHours ?? config.jfago.inviteValidityHours ?? 24;
  await jfagoFetch('POST', '/invites', {
    token,
    body: {
      months: 0,
      days: 0,
      hours,
      minutes: 0,
      'user-expiry': false,
      'send-to': opts.email || '',
      'multiple-uses': false,
      'no-limit': false,
      'remaining-uses': 1,
      profile: opts.profile ?? config.jfago.profile ?? '',
      label: opts.label,
    },
  });
}

export async function listInvites(token: string): Promise<JfagoInvite[]> {
  const data = await jfagoFetch<{ invites?: JfagoInvite[] | null }>('GET', '/invites', { token });
  return data.invites || [];
}

export async function deleteInvite(token: string, code: string): Promise<void> {
  await jfagoFetch('DELETE', '/invites', { token, body: { code } });
}

/** Full provisioning round-trip: log in, create a single-use invite with a unique label, then read
 *  the generated code back by matching that label, and return the code + public signup link. If
 *  `email` is given, jfa-go also emails the link via its configured SMTP. Throws if the invite was
 *  created but its code can't be read back (so the caller never reports a success it can't back up). */
export async function createInviteAndGetLink(opts: CreateInviteOpts): Promise<InviteResult> {
  const token = await getToken();
  await createInvite(token, opts);
  // Read the code back by matching the unique label. Retry once — GET /invites can momentarily lag
  // the POST. Throwing on a real miss is correct: the caller then reports an honest failure rather
  // than a success it can't back up (we never claim "sent" without a confirmed link).
  let match: JfagoInvite | undefined;
  for (let attempt = 0; attempt < 2 && !match; attempt++) {
    const invites = await listInvites(token);
    match = invites.find((i) => i.label === opts.label && i.code);
  }
  if (!match) {
    throw new Error('jfa-go: invite created but its code could not be read back by label');
  }
  return { code: match.code, link: inviteLink(match.code) };
}
