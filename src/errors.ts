/**
 * Turning a thrown thing into a line a human can act on.
 *
 * ── 🔴 WHY THIS FILE EXISTS: "fetch failed" COST HOURS ───────────────────────
 *
 * On 2026-08-26 Jedd told Jeff his homelab reads were failing with
 * `fetch failed`, and called the failure "transient" for an evening. It was
 * neither transient nor mysterious: every call was returning **EHOSTUNREACH**,
 * a permission denial that names itself. The code threw that away:
 *
 *     error: `request failed: ${(e as Error).message}`   // → "fetch failed"
 *
 * 🔴 **Node puts the diagnosis in `e.cause`, and NOTHING in this codebase read
 * it.** `.message` on a failed `fetch()` is the constant string "fetch failed"
 * — it carries no information at all. One field away sat
 * `EHOSTUNREACH 192.168.1.7:8096`, which would have named the cause in seconds.
 *
 * A model handed a contentless error does what a person does: it guesses. The
 * fix for "the bot described the failure wrongly" is therefore NOT a sentence
 * telling it how to describe failures — it is to stop destroying the evidence.
 */

/**
 * ⚠️ `message` AND `stack` ARE NON-ENUMERABLE ON `Error`.
 *
 * Measured, in this Node:
 *
 *     JSON.stringify(new Error('fetch failed'))  →  {}
 *
 * So anything that rebuilds an error from `Object.entries`, a spread, or
 * `JSON.stringify` **silently drops the message** and keeps only incidental
 * fields. That is why this reads the properties BY NAME instead of enumerating.
 * A serialiser that looks like it works is the trap here: `cause.code` survives
 * (it is enumerable) while `cause.message` vanishes, so the output looks
 * populated and is missing the sentence.
 */
function fieldsOf(e: unknown): { name: string; message: string; code?: string; detail?: string } {
  if (typeof e !== 'object' || e === null) return { name: 'thrown', message: String(e) };
  const o = e as Record<string, unknown>;
  const pick = (k: string): string | undefined => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
  const num = (k: string): string | undefined => (typeof o[k] === 'number' ? String(o[k]) : undefined);
  // `syscall`/`address`/`port` make a network error actionable — but only when
  // the message has not already said them. Node's connect errors embed the
  // address, so appending it again is noise in a line meant to be read fast.
  const address = pick('address');
  const message = pick('message') ?? '';
  const where =
    address && !message.includes(address)
      ? [pick('syscall'), address, num('port')].filter(Boolean).join(' ')
      : undefined;
  return {
    name: pick('name') ?? 'Error',
    message,
    code: pick('code') ?? pick('errno'),
    detail: where,
  };
}

/** How deep to walk `cause`. Bounded: a cycle or a deep chain must not hang. */
const MAX_CAUSE_DEPTH = 4;
/** Diagnostics, not an audit log — one line, never a paragraph. */
export const MAX_ERROR_CHARS = 300;

/**
 * A compact, legible description of a thrown value, walking the `cause` chain.
 *
 * `fetch failed` becomes `fetch failed — EHOSTUNREACH (connect EHOSTUNREACH
 * 192.168.1.7:8096)`, which names the cause instead of implying a mystery.
 *
 * ⚠️ Redaction is the CALLER's job where the string is persisted or shown — see
 * `describeErrorSafe`. This function does not scrub, because the raw form is
 * what a local debugger wants.
 */
export function describeError(e: unknown, redact?: (s: string) => string): string {
  const parts: string[] = [];
  let current: unknown = e;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current != null; depth += 1) {
    const f = fieldsOf(current);
    const head = f.code && !f.message.includes(f.code) ? `${f.code}: ${f.message}` : f.message || f.name;
    const piece = f.detail && !head.includes(f.detail) ? `${head} (${f.detail})` : head;
    // Skip a cause that adds nothing over its parent — a repeated line is noise.
    if (piece && !parts.includes(piece)) parts.push(piece);
    const next = (current as { cause?: unknown }).cause;
    if (next === current) break;
    current = next;
  }
  const joined = parts.join(' — ') || 'unknown error';
  const scrubbed = redact ? redact(joined) : joined;
  return scrubbed.length > MAX_ERROR_CHARS ? `${scrubbed.slice(0, MAX_ERROR_CHARS - 1)}…` : scrubbed;
}

/**
 * Remove credentials from a string before it is persisted or shown.
 *
 * 🔴 ERROR CAUSES CARRY URLS, AND URLS HERE CARRY API KEYS. An arr request is
 * `…/api/v3/queue?apikey=…`, and a connection error quotes the URL it failed on.
 * Writing diagnostics without this trades one gap for a worse one: a credential
 * in `audit.jsonl` is a credential on disk, forever, in a file nobody re-reads.
 *
 * ⚠️ Deliberately a denylist of KEY NAMES plus a bare-token sweep, because the
 * value shapes vary. It is a last line, not the only one — do not put a secret
 * into an error message on purpose and rely on this to remove it.
 */
export function redactUrlSecrets(text: string): string {
  return text
    .replace(/([?&](?:apikey|api_key|token|access_token|password|passkey|key|auth)=)[^&\s"']+/gi, '$1REDACTED')
    .replace(/(X-Emby-Token|Authorization|X-Api-Key)(["'\s:=]+)[^\s"',)]+/gi, '$1$2REDACTED');
}
