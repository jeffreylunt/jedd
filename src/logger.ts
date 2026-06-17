// Structured, durable logging for full interaction reconstruction.
//
// WHY: Jedd's failures (false "I've added", fabricated season counts, raw tool-call leaks)
// can only be diagnosed if the logs let us replay an ENTIRE interaction and see exactly where
// it went wrong — no guessing. This module gives:
//   1. jlog(): one JSON line per lifecycle event, tagged with a stable `conversationId` + `turn`
//      so a whole conversation is greppable (`grep <conversationId> jedd-*.log`). Events cover
//      inbound → each model turn's RAW output → every tool call + its FULL response → which
//      guardrail/net fired → the EXACT text delivered.
//   2. A durable FILE sink under <dataDir>/logs/ — the dataDir is the mounted `jedd-data` volume,
//      so logs SURVIVE container recreation. This matters: every deploy recreates the container,
//      which WIPES `docker logs jedd`. The file is the history that outlives the container.
//   3. A console mirror (installConsoleMirror) so EVERY existing console.log/error (the
//      battle-tested [local]/[session]/[scheduler] net + stall + guard lines) ALSO lands in the
//      durable file, timestamped — no edits to those call sites required.
//
// Logging must NEVER throw or break a request: all file IO is wrapped and swallowed.
// Secrets (API keys, the BlueBubbles password) are redacted before anything is written.

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { format } from 'util';
import { config } from './config.js';

const LOG_DIR = join(config.dataDir, 'logs');
const LOG_FILE = join(LOG_DIR, 'jedd.log');

// SIZE-BASED ROTATION with a HARD retention cap so logs can NEVER fill the disk. The active
// jedd.log is rotated to jedd.log.1 (and .1→.2, …) once it reaches LOG_MAX_BYTES; only
// LOG_MAX_FILES files are kept (1 active + archives) and the oldest is auto-deleted. Worst-case
// total footprint = LOG_MAX_BYTES * LOG_MAX_FILES. Both limits are env-configurable.
const LOG_MAX_BYTES = Math.max(1, Number(process.env.JEDD_LOG_MAX_MB) || 50) * 1024 * 1024;
const LOG_MAX_FILES = Math.max(1, Math.floor(Number(process.env.JEDD_LOG_MAX_FILES) || 5));

// The durable file sink is ON in the container (NODE_ENV=production, set in the Dockerfile) and
// can be forced on/off anywhere via JEDD_FILE_LOG=1/0. It stays OFF under tests/dev so the suite
// never litters data/logs or spews to disk. Stdout always gets every line regardless.
const FILE_LOG = /^(1|true|yes|on)$/i.test(process.env.JEDD_FILE_LOG || '')
  || (process.env.NODE_ENV === 'production' && !/^(0|false|no|off)$/i.test(process.env.JEDD_FILE_LOG || ''));

// debug-level events (e.g. nets that did NOT fire) only emit when JEDD_LOG_LEVEL=debug.
export const LOG_LEVEL = (process.env.JEDD_LOG_LEVEL || 'info').toLowerCase();
export const DEBUG = LOG_LEVEL === 'debug';

// Capture the REAL console.log before any mirror patches it, so jlog's own stdout write never
// gets re-captured by the mirror (which would double every JSON line in the file).
const origLog: (...args: unknown[]) => void = console.log.bind(console);

// Running byte count of the active log file, seeded lazily from its on-disk size on first write.
let curBytes = -1;

// --- secret redaction -------------------------------------------------------------------------
// Strip credentials from any string and blank out credential-named object keys. API keys and the
// BlueBubbles password must NEVER hit the logs. Three string forms are covered so the redactor is a
// reliable defense-in-depth backstop, not just for query params:
//   1. query-param form    apikey=SECRET            → apikey=REDACTED
//   2. JSON / object-text   "token":"SECRET"         → "token":"REDACTED"
//   3. bearer header        Authorization: Bearer X  → Authorization: Bearer REDACTED
const SECRET_QS_RE = /\b(apikey|api_key|x-api-key|password|passwd|pwd|token)=([^&\s"']+)/gi;
const SECRET_JSON_RE = /(["']?(?:apikey|api_key|x-api-key|password|passwd|pwd|token|authorization)["']?\s*[:=]\s*["'])([^"']*)(["'])/gi;
const SECRET_BEARER_RE = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_KEY_RE = /^(apikey|api_?key|x-api-key|password|passwd|pwd|token|authorization)$/i;

function redactString(s: string): string {
  return s
    .replace(SECRET_JSON_RE, '$1REDACTED$3')
    .replace(SECRET_QS_RE, '$1=REDACTED')
    .replace(SECRET_BEARER_RE, '$1 REDACTED');
}

export function redact<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (typeof value === 'string') return redactString(value) as unknown as T;
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]' as unknown as T;
    seen.add(value);
    return value.map((v) => redact(v, seen)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    // Guard against circular references — a logged object could self-reference and would otherwise
    // overflow the stack (redact runs before JSON.stringify, so this must be cycle-safe itself).
    if (seen.has(value as object)) return '[Circular]' as unknown as T;
    seen.add(value as object);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? 'REDACTED' : redact(v, seen);
    }
    return out as unknown as T;
  }
  return value;
}

// Keep huge payloads from bloating the log while preserving the decision-relevant head. Accepts
// unknown so a non-string (e.g. undefined field) passes through untouched rather than throwing.
export function truncate(s: unknown, max = 4000): any {
  if (typeof s !== 'string') return s;
  return s.length > max ? `${s.slice(0, max)}…[+${s.length - max} chars]` : s;
}

// Rotate the active log: drop the oldest archive (jedd.log.<MAX-1>), shift each archive up one
// index, then move the active file to jedd.log.1. Keeps at most LOG_MAX_FILES files total; the
// oldest is auto-deleted. Best-effort — any fs error is swallowed so logging never breaks a request.
function rotate(): void {
  try { unlinkSync(`${LOG_FILE}.${LOG_MAX_FILES - 1}`); } catch { /* may not exist */ }
  for (let i = LOG_MAX_FILES - 2; i >= 1; i--) {
    try { renameSync(`${LOG_FILE}.${i}`, `${LOG_FILE}.${i + 1}`); } catch { /* may not exist */ }
  }
  try { renameSync(LOG_FILE, `${LOG_FILE}.1`); } catch { /* may not exist */ }
}

function writeFile(line: string): void {
  if (!FILE_LOG) return;
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    const buf = line + '\n';
    const lineBytes = Buffer.byteLength(buf);
    // Seed the byte counter from the existing file once per process (survives restarts mid-file).
    if (curBytes < 0) { try { curBytes = statSync(LOG_FILE).size; } catch { curBytes = 0; } }
    // Rotate BEFORE writing if this line would push the active file past the cap (and it already has
    // content — never spin rotating an empty file when a single line exceeds the cap).
    if (curBytes > 0 && curBytes + lineBytes > LOG_MAX_BYTES) {
      rotate();
      curBytes = 0;
    }
    appendFileSync(LOG_FILE, buf);
    curBytes += lineBytes;
  } catch { /* never let logging break a request */ }
}

// --- structured event log ---------------------------------------------------------------------
// One JSON line: {t, evt, ...fields}. Goes to stdout (captured by `docker logs jedd`) AND the
// durable file. Fields are redacted. Use a stable `conversationId` + `turn` in fields so an entire
// interaction is greppable.
export function jlog(evt: string, fields: Record<string, unknown> = {}): void {
  const t = new Date().toISOString();
  let line: string;
  try {
    line = JSON.stringify({ t, evt, ...redact(fields) });
  } catch {
    // Last-resort: redaction or serialization failed (should not happen — redact is cycle-safe and
    // JSON.stringify is guarded — but logging must NEVER throw into the request path).
    line = JSON.stringify({ t, evt, _err: 'unserializable log fields' });
  }
  origLog(line);
  writeFile(line);
}

// debug-level structured event (suppressed unless JEDD_LOG_LEVEL=debug).
export function dlog(evt: string, fields: Record<string, unknown> = {}): void {
  if (DEBUG) jlog(evt, fields);
}

// --- console mirror ---------------------------------------------------------------------------
// Patch console.log / console.error / console.warn so every legacy human-readable line (the
// existing [local]/[session]/[media]/[bb-webhook]/[scheduler] net, stall and guard logs) is ALSO
// appended to the durable file, timestamped. This makes the whole existing log surface survive
// container recreation with no edits to the call sites. jlog uses the captured origLog, so its
// JSON lines are NOT re-captured here (no double-write). Call once at process startup.
export function installConsoleMirror(): void {
  const mirror = (level: string, args: unknown[]) => {
    // Redact BEFORE and AFTER format: redact each arg first (so a secret-keyed OBJECT like
    // {token:'x'} is blanked before util.format flattens it to text), then redact the formatted
    // string (catches query-param / bearer forms embedded in string args). Defense-in-depth so no
    // human log line can leak a credential into the durable file.
    try {
      const redArgs = args.map((a) => redact(a));
      writeFile(redact(`${new Date().toISOString()} [${level}] ${format(...(redArgs as [unknown]))}`));
    } catch { /* ignore */ }
  };
  const wrap = (level: string, real: (...a: unknown[]) => void) =>
    (...args: unknown[]) => { real(...args); mirror(level, args); };
  console.log = wrap('log', origLog);
  console.error = wrap('error', console.error.bind(console));
  console.warn = wrap('warn', console.warn.bind(console));
  jlog('logger.ready', {
    fileLog: FILE_LOG,
    logFile: FILE_LOG ? LOG_FILE : null,
    level: LOG_LEVEL,
    rotateAtMB: Math.round(LOG_MAX_BYTES / (1024 * 1024)),
    maxFiles: LOG_MAX_FILES,
    maxTotalMB: Math.round((LOG_MAX_BYTES * LOG_MAX_FILES) / (1024 * 1024)),
  });
}

// Make a short, stable conversation id from a phone + the current time. Collisions across
// concurrent requests for the SAME phone are avoided with a small random suffix.
export function newConversationId(phone: string): string {
  const tail = phone.replace(/[^\d]/g, '').slice(-4) || 'anon';
  const rand = Math.random().toString(36).slice(2, 6);
  return `c_${tail}_${Date.now().toString(36)}_${rand}`;
}
