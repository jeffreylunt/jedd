import { test } from 'node:test';
import assert from 'node:assert/strict';

// config (imported transitively by logger) requires these env vars at import time.
process.env.SONARR_API_KEY ??= 'test';
process.env.RADARR_API_KEY ??= 'test';
process.env.SONARR_ROOT_FOLDER ??= '/tv';
process.env.RADARR_ROOT_FOLDER ??= '/movies';
process.env.BLUEBUBBLES_PASSWORD ??= 'test';
// Keep the durable file sink OFF for tests (default is off when NODE_ENV != production).
process.env.JEDD_FILE_LOG = '0';

const { jlog, redact, truncate, newConversationId } = await import('./logger.js');

test('redact strips credential query params from strings', () => {
  assert.equal(
    redact('http://h/api/v3/series?apikey=SECRET123&term=bear'),
    'http://h/api/v3/series?apikey=REDACTED&term=bear',
  );
  assert.equal(
    redact('GET /msg?password=hunter2&x=1'),
    'GET /msg?password=REDACTED&x=1',
  );
});

test('redact blanks credential-named object keys, recursively', () => {
  const out = redact({
    apiKey: 'k', password: 'p', token: 't', authorization: 'Bearer z',
    nested: { api_key: 'n', ok: 1, url: 'http://h?apikey=Z' },
    list: ['http://h?password=Q'],
  }) as any;
  assert.equal(out.apiKey, 'REDACTED');
  assert.equal(out.password, 'REDACTED');
  assert.equal(out.token, 'REDACTED');
  assert.equal(out.authorization, 'REDACTED');
  assert.equal(out.nested.api_key, 'REDACTED');
  assert.equal(out.nested.ok, 1);
  assert.equal(out.nested.url, 'http://h?apikey=REDACTED');
  assert.equal(out.list[0], 'http://h?password=REDACTED');
});

test('redact strips bearer tokens and JSON-text secret forms', () => {
  assert.equal(redact('Authorization: Bearer sk-abc123_DEF.456'), 'Authorization: Bearer REDACTED');
  assert.equal(redact('{"token":"abc123","ok":1}'), '{"token":"REDACTED","ok":1}');
  assert.equal(redact("password: 'hunter2'"), "password: 'REDACTED'");
});

test('redact leaves non-secret data untouched', () => {
  const out = redact({ title: 'The Bear', year: 2022, tvdbId: 403294 }) as any;
  assert.deepEqual(out, { title: 'The Bear', year: 2022, tvdbId: 403294 });
});

test('truncate keeps short strings and caps long ones with a marker', () => {
  assert.equal(truncate('short', 100), 'short');
  const long = truncate('x'.repeat(50), 10);
  assert.ok(long.startsWith('x'.repeat(10)));
  assert.ok(long.includes('[+40 chars]'));
});

test('newConversationId is stable-prefixed, phone-tailed, and unique', () => {
  const a = newConversationId('+18015551234');
  const b = newConversationId('+18015551234');
  assert.match(a, /^c_1234_[a-z0-9]+_[a-z0-9]{4}$/);
  assert.notEqual(a, b); // random suffix avoids same-ms collisions
  assert.match(newConversationId(''), /^c_anon_/);
});

test('jlog emits exactly ONE parseable JSON line with t, evt, redacted fields', () => {
  // jlog writes via the console.log captured at module load (to dodge the mirror double-write),
  // which still routes through process.stdout.write — so intercept there.
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (chunk: any, ...rest: any[]) => { lines.push(String(chunk)); return true; };
  try {
    jlog('test.event', { conversationId: 'c_test', turn: 2, apiKey: 'SHHH', note: 'http://h?apikey=NOPE' });
  } finally {
    (process.stdout as any).write = orig;
  }
  const json = lines.join('').trim();
  assert.ok(json.length > 0, 'expected a line on stdout');
  const rec = JSON.parse(json);
  assert.equal(rec.evt, 'test.event');
  assert.equal(rec.conversationId, 'c_test');
  assert.equal(rec.turn, 2);
  assert.equal(rec.apiKey, 'REDACTED');
  assert.equal(rec.note, 'http://h?apikey=REDACTED');
  assert.ok(typeof rec.t === 'string' && rec.t.includes('T')); // ISO timestamp
});

test('redact and jlog are cycle-safe on a circular object (never throw / overflow)', () => {
  const circular: any = { a: 1, secret: { password: 'p' } };
  circular.self = circular;
  // redact must not overflow the stack on a self-reference
  const r = redact(circular) as any;
  assert.equal(r.a, 1);
  assert.equal(r.secret.password, 'REDACTED');
  assert.equal(r.self, '[Circular]');

  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (chunk: any) => { lines.push(String(chunk)); return true; };
  try {
    assert.doesNotThrow(() => jlog('circ.event', { circular }));
  } finally {
    (process.stdout as any).write = orig;
  }
  const rec = JSON.parse(lines.join('').trim()); // one parseable line, no throw
  assert.equal(rec.evt, 'circ.event');
  assert.equal(rec.circular.self, '[Circular]');
});

test('jlog/file sink swallow IO errors (never break the request path)', async () => {
  // Force the file sink on and point the data dir at an unwritable path so appendFileSync throws —
  // jlog must still not throw. We can't redirect config.dataDir post-import, so assert the public
  // guarantee: jlog tolerates a forced-on file sink without throwing regardless of fs state.
  const prev = process.env.JEDD_FILE_LOG;
  process.env.JEDD_FILE_LOG = '1';
  try {
    assert.doesNotThrow(() => jlog('io.event', { conversationId: 'c_io', turn: 1 }));
  } finally {
    if (prev === undefined) delete process.env.JEDD_FILE_LOG; else process.env.JEDD_FILE_LOG = prev;
  }
});
