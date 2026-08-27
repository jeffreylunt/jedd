import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  channelHealth,
  describeAge,
  describeRow,
  parseRoster,
  parseStreamCheck,
} from '../src/tools/channel-health.js';
import type { ExecImpl } from '../src/hp.js';
import type { ToolContext } from '../src/tools/types.js';
import { testConfig } from './helpers.js';
import { commandFor, QUERIES, QUERY_NAMES, type QueryName } from '../src/media/dispatcharr-queries.js';

/** Real rows, copied from the live file and the live database on 2026-08-25. */
const RESULTS = [
  '1|COOKING CHANNEL HD|OK|h264|1920x1080|60000/1001',
  '2|BRAVO WEST HD|OK|h264|1280x720|30000/1001',
  '3|DISCOVERY SCIENCE HD|OK|h264|1920x1080|25/1',
  // 🔴 A REAL FAIL ROW, copied verbatim from the live file. Column 4 is the
  // REASON on a fail, not a codec — a fixture that used `FAIL|||` could never
  // have shown that, and the earlier version of this file did exactly that.
  '77|ESPN DEPORTES ᴴᴰ ⁶⁰ᶠᵖˢ|FAIL|http://znq234.live/live/x/y/1537742.ts: Server returned 4XX Client Error, but not one of 40{0,1,3,4}|?|?',
].join('\n');

const ROSTER = [
  '1|COOKING CHANNEL HD|t|f',
  '2|BRAVO WEST HD|t|f',
  '3|DISCOVERY SCIENCE HD|t|f',
  '77|ESPN DEPORTES ᴴᴰ ⁶⁰ᶠᵖˢ|t|f',
  // In Dispatcharr, absent from the results file: the coverage gap.
  '90|NEWLY ADDED CHANNEL|f|f',
].join('\n');

const MTIME = 1_787_498_113; // 2026-08-23 3:15 PM:13Z, the live file's real mtime
const HOUR = 3600;

/**
 * An exec stub that answers by matching the command, and RECORDS every command
 * string it was handed. The recording is the point: the safety properties here
 * are about what was sent, and a return value cannot show you that.
 */
function execStub(now: number, opts: { results?: string; resultsExit?: number; rosterExit?: number } = {}) {
  const commands: { host: string; command: string }[] = [];
  const impl: ExecImpl = (_file, args, _options, callback) => {
    const host = args[args.length - 2] ?? '';
    const command = args[args.length - 1] ?? '';
    commands.push({ host, command });
    if (command.includes('check-streams-results.txt')) {
      if (opts.resultsExit) return callback({ code: opts.resultsExit }, '', 'cat: No such file or directory');
      /**
       * 🔴 THE STUB ANSWERS WHAT WAS ASKED, NOT WHAT THE TOOL HOPED FOR.
       *
       * It used to prepend `mtime\nnow\n` regardless of the command, so deleting
       * `stat -c %Y` and `date +%s` from RESULTS_CMD left every test green while
       * production lost the age entirely AND ate the first two channel rows.
       * The 🔴 age test was asserting this fixture, not the tool.
       */
      const head = command.includes('stat -c %Y') ? `${MTIME}\n` : '';
      const clock = command.includes('date +%s') ? `${now}\n` : '';
      return callback(null, `${head}${clock}${opts.results ?? RESULTS}\n`, '');
    }
    if (command.includes('psql')) {
      if (opts.rosterExit) return callback({ code: opts.rosterExit }, '', 'Error: No such container: dispatcharr');
      return callback(null, `${ROSTER}\n`, '');
    }
    return callback({ code: 127 }, '', 'unexpected command');
  };
  return { commands, impl };
}

function ctx(exec: ExecImpl, role: 'owner' | 'guest' = 'owner'): ToolContext {
  return { role, senderHandle: '+18015550123', config: testConfig(), exec };
}

// ─────────────────────────────────────────────────────────────────────────────
// IT NEVER PROBES — the safety property, asserted structurally
// ─────────────────────────────────────────────────────────────────────────────

test('🔴 NOTHING it runs can open a stream — no ffprobe, no ffmpeg, no curl at a channel', async () => {
  const { commands, impl } = execStub(MTIME + 2 * HOUR);
  await channelHealth.run({}, ctx(impl));
  assert.ok(commands.length > 0, 'the control: it really did run something');
  for (const { command } of commands) {
    assert.doesNotMatch(command, /ffprobe|ffmpeg/, `probing command sent: ${command}`);
    assert.doesNotMatch(command, /curl|wget/, `network fetch sent: ${command}`);
  }
});

test('🔴 the `channel` filter NEVER reaches a shell — the commands are byte-identical', async () => {
  const plain = execStub(MTIME + HOUR);
  await channelHealth.run({}, ctx(plain.impl));
  const hostile = execStub(MTIME + HOUR);
  await channelHealth.run({ channel: '"; docker rm -f jellyfin #' }, ctx(hostile.impl));

  assert.deepEqual(
    hostile.commands.map((c) => c.command),
    plain.commands.map((c) => c.command),
    'a model-supplied string changed the command text — it must be filtered in TypeScript instead',
  );
  for (const { command } of hostile.commands) assert.doesNotMatch(command, /docker rm/);
});

test('🔴 the file read uses the UNPRIVILEGED identity; only the docker call is privileged', async () => {
  const { commands, impl } = execStub(MTIME + HOUR);
  const config = testConfig();
  await channelHealth.run({}, ctx(impl));
  const results = commands.find((c) => c.command.includes('check-streams-results.txt'));
  const roster = commands.find((c) => c.command.includes('psql'));
  assert.equal(results?.host, config.shellSshHost, 'a plain world-readable file needs no docker rights');
  assert.equal(roster?.host, config.adminSshHost, 'docker exec genuinely needs the privileged account');
});

// ─────────────────────────────────────────────────────────────────────────────
// THE AGE IS THE HEADLINE
// ─────────────────────────────────────────────────────────────────────────────

test('🔴 the age is stated first, always', async () => {
  const { impl } = execStub(MTIME + 3 * HOUR);
  const res = await channelHealth.run({}, ctx(impl));
  assert.equal(res.ok, true);
  assert.match(res.content.split('\n')[0] ?? '', /Stream check last ran 2026-08-23 3:15 PM UTC — 3h ago/);
});

test('🔴 a snapshot older than a day is called STALE, not presented as current', async () => {
  const fresh = await channelHealth.run({}, ctx(execStub(MTIME + 2 * HOUR).impl));
  assert.doesNotMatch(fresh.content, /STALE/);
  // CONTROL above: the same rendering path without the staleness condition does
  // NOT say STALE, so the assertion below is about the age and not the wording.
  const old = await channelHealth.run({}, ctx(execStub(MTIME + 50 * HOUR).impl));
  assert.match(old.content, /⚠️ STALE/);
  assert.match(old.content, /2d 2h ago/);
});

test('🔴 an UNKNOWN age takes the CAUTIOUS branch, never the fresh one', async () => {
  /**
   * The first version tested `isFinite(age) && age > threshold`, so a clock it
   * could not read fell through to "This is a snapshot, not a live probe" — the
   * sentence written for a FRESH result. The whole contract is that the age gates
   * whether these numbers may be quoted as current.
   */
  const noClock: ExecImpl = (_f, args, _o, cb) => {
    const command = args[args.length - 1] ?? '';
    if (command.includes('check-streams-results.txt')) return cb(null, `${MTIME}\n\n${RESULTS}\n`, '');
    return cb(null, `${ROSTER}\n`, '');
  };
  const res = await channelHealth.run({}, ctx(noClock));
  assert.equal(res.ok, true);
  assert.match(res.content, /could NOT work out how old this is, so treat it as stale/);
  assert.doesNotMatch(res.content, /This is a snapshot, not a live probe/);
});

test('🔴 an empty mtime line is UNKNOWN, not 1970 — Number("") is 0', async () => {
  const noMtime: ExecImpl = (_f, args, _o, cb) => {
    const command = args[args.length - 1] ?? '';
    if (command.includes('check-streams-results.txt')) return cb(null, `\n${MTIME + HOUR}\n${RESULTS}\n`, '');
    return cb(null, `${ROSTER}\n`, '');
  };
  const res = await channelHealth.run({}, ctx(noMtime));
  assert.match(res.content, /last ran unknown —/);
  assert.doesNotMatch(res.content, /1970/);
  assert.match(res.content, /treat it as stale/);
});

test('🔴 unparsed lines are reported on the FILTERED path too, not just the summary', async () => {
  /**
   * When this warning lived only in the whole-picture branch, a checker writing
   * garbage answered "is ESPN working?" with a confident "no such channel" —
   * exactly the false negative `parseStreamCheck` counts unparsed lines to stop.
   */
  const garbage = `${Array.from({ length: 30 }, (_, i) => `junk line ${i}`).join('\n')}\n1|COOKING CHANNEL HD|OK|h264|1920x1080|25/1`;
  const { impl } = execStub(MTIME + HOUR, { results: garbage });
  const res = await channelHealth.run({ channel: 'ESPN' }, ctx(impl));
  assert.match(res.content, /30 line\(s\) in the results file did not parse/);
  assert.match(res.content, /this list may be incomplete/);
});

test('describeAge renders days, hours and minutes', () => {
  assert.equal(describeAge(0), '0m ago');
  assert.equal(describeAge(90 * 60), '1h 30m ago');
  assert.equal(describeAge(2 * 86400 + 3 * 3600), '2d 3h ago');
  assert.equal(describeAge(NaN), 'an UNKNOWN time ago');
});

// ─────────────────────────────────────────────────────────────────────────────
// FALSE ZEROES
// ─────────────────────────────────────────────────────────────────────────────

test('🔴 an unreadable results file is UNKNOWN, never "no channels are working"', async () => {
  const { impl } = execStub(MTIME, { resultsExit: 1 });
  const res = await channelHealth.run({}, ctx(impl));
  assert.equal(res.ok, false);
  assert.match(res.content, /UNKNOWN/);
  assert.match(res.content, /NOT\s+"no channels are working"/);
});

test('🔴 an unreadable roster does not read as "every channel was covered"', async () => {
  const { impl } = execStub(MTIME + HOUR, { rosterExit: 1 });
  const res = await channelHealth.run({}, ctx(impl));
  assert.equal(res.ok, true, 'the file half still answered, so this is a partial answer not a failure');
  assert.match(res.content, /4 channels checked: 3 OK, 1 FAIL/);
  assert.match(res.content, /roster could NOT be read/);
  assert.match(res.content, /Coverage is UNKNOWN/);
  assert.doesNotMatch(res.content, /Every channel in the Dispatcharr roster/);
});

test('🔴 a channel in Dispatcharr but absent from the check is UNKNOWN, not working', async () => {
  const { impl } = execStub(MTIME + HOUR);
  const res = await channelHealth.run({}, ctx(impl));
  assert.match(res.content, /NOT COVERED by the last check/);
  assert.match(res.content, /90 NEWLY ADDED CHANNEL/);
  assert.match(res.content, /UNKNOWN rather than working/);
});

test('unparseable lines are counted and reported, never silently dropped', () => {
  const { rows, unparsed } = parseStreamCheck(`${RESULTS}\ngarbage line with no pipes\n5|X|MAYBE|||`);
  assert.equal(rows.length, 4);
  assert.equal(unparsed, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ANSWERS
// ─────────────────────────────────────────────────────────────────────────────

test('the failing channel is named, WITH the reason the checker recorded', async () => {
  const { impl } = execStub(MTIME + HOUR);
  const res = await channelHealth.run({}, ctx(impl));
  assert.match(res.content, /4 channels checked: 3 OK, 1 FAIL/);
  assert.match(res.content, /FAILING at that time:\n {2}FAIL 77 ESPN DEPORTES/);
  assert.match(res.content, /reason: http:\/\/znq234\.live.*Server returned 4XX/);
});

test('🔴 a FAIL row‘s column 4 is a REASON, never rendered as a codec', () => {
  const { rows } = parseStreamCheck(RESULTS);
  const failed = rows.find((r) => !r.ok);
  assert.ok(failed);
  const line = describeRow(failed);
  assert.match(line, /^FAIL 77 ESPN DEPORTES .* — reason: http:\/\/znq234\.live/);
  // CONTROL: an OK row still renders its codec, so the branch really did switch
  // on the verdict rather than on the field happening to look like a URL.
  const okRow = rows.find((r) => r.ok);
  assert.ok(okRow);
  assert.match(describeRow(okRow), /^OK {3}1 COOKING CHANNEL HD — h264 1920x1080 60000\/1001$/);
});

test('a FAIL row with no reason recorded says so rather than printing nothing', () => {
  const { rows } = parseStreamCheck('9|SOME CHANNEL|FAIL|||');
  assert.match(describeRow(rows[0] as never), /no reason recorded/);
});

test('a filter by name returns that channel with its codec and resolution', async () => {
  const { impl } = execStub(MTIME + HOUR);
  const res = await channelHealth.run({ channel: 'cooking' }, ctx(impl));
  assert.equal(res.ok, true);
  assert.match(res.content, /OK {3}1 COOKING CHANNEL HD — h264 1920x1080 60000\/1001/);
  assert.doesNotMatch(res.content, /BRAVO/);
});

test('a filter by number is exact, not a substring of the number', async () => {
  const { impl } = execStub(MTIME + HOUR);
  const res = await channelHealth.run({ channel: '7' }, ctx(impl));
  // "7" must not match channel 77 by number. It matches nothing here at all.
  assert.match(res.content, /No channel matching "7"/);
});

test('a channel that exists in Dispatcharr but was never checked says so under a filter', async () => {
  const { impl } = execStub(MTIME + HOUR);
  const res = await channelHealth.run({ channel: 'NEWLY ADDED' }, ctx(impl));
  assert.match(res.content, /exist in Dispatcharr but were NOT in the last check/);
  assert.match(res.content, /UNKNOWN/);
  assert.match(res.content, /NO EPG mapping/);
});

test('an unknown channel is reported against BOTH sources, not just the file', async () => {
  const { impl } = execStub(MTIME + HOUR);
  const res = await channelHealth.run({ channel: 'bbc four' }, ctx(impl));
  assert.match(res.content, /No channel matching "bbc four" in the 4 checked or in Dispatcharr's 5-channel roster/);
});

test('the roster summary counts EPG gaps, because the guide is empty for those', async () => {
  const { impl } = execStub(MTIME + HOUR);
  const res = await channelHealth.run({}, ctx(impl));
  assert.match(res.content, /Dispatcharr roster: 5 channels \(0 hidden from output, 1 with no EPG mapping/);
});

test('parseRoster reads the psql tuple format', () => {
  const rows = parseRoster(ROSTER);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[4], { number: '90', name: 'NEWLY ADDED CHANNEL', hasEpg: false, hidden: false });
});

test('the tool declares itself a read, and CONTENT means guests get it', () => {
  assert.equal(channelHealth.writes, false);
  // ⚠️ Was 'owner'. Which channel works is not about a person and is not a
  // secret, so by Jeff's rule it is everyone's. The PRIVILEGED half is gated
  // inside run(), not by the tool's minRole.
  assert.equal(channelHealth.minRole, 'guest');
});

test('🔴 a GUEST never causes the privileged docker exec — the call is not made at all', async () => {
  const { commands, impl } = execStub(MTIME + HOUR);
  const res = await channelHealth.run({}, ctx(impl, 'guest'));

  assert.equal(res.ok, true, 'a guest is entitled to the content answer');
  assert.match(res.content, /243 channels checked|4 channels checked/, 'the guest got the real data');
  assert.deepEqual(
    commands.filter((c) => c.command.includes('psql')),
    [],
    'a guest triggered docker exec on the PRIVILEGED identity',
  );
  assert.deepEqual(
    commands.map((c) => c.host),
    [testConfig().shellSshHost],
    'a guest reached an identity other than the unprivileged one',
  );

  // 🔴 CONTROL: the owner DOES cause it, so the assertion above is about the
  // role and not about a stub that never answers psql.
  const asOwner = execStub(MTIME + HOUR);
  await channelHealth.run({}, ctx(asOwner.impl, 'owner'));
  assert.equal(
    asOwner.commands.filter((c) => c.command.includes('psql')).length,
    1,
    'the owner path did not run the roster query, so the guest check proves nothing',
  );
});

test('🔴 "I did not look" is not rendered as "I looked and it failed"', async () => {
  const { impl } = execStub(MTIME + HOUR);
  const guest = await channelHealth.run({}, ctx(impl, 'guest'));
  assert.match(guest.content, /I did not look up the full Dispatcharr channel list/);
  assert.match(guest.content, /NOT a report that anything is wrong/);
  assert.doesNotMatch(guest.content, /could NOT be read/, 'a guest was told a read failed that never ran');

  // CONTROL: when the owner's roster read really does fail, it says so.
  const broken = execStub(MTIME + HOUR, { rosterExit: 1 });
  const owner = await channelHealth.run({}, ctx(broken.impl, 'owner'));
  assert.match(owner.content, /could NOT be read/);
  assert.match(owner.content, /Coverage is UNKNOWN/);
});

test('a guest asking about one channel gets it, without the roster commentary', async () => {
  const { impl } = execStub(MTIME + HOUR);
  const res = await channelHealth.run({ channel: 'cooking' }, ctx(impl, 'guest'));
  assert.match(res.content, /OK {3}1 COOKING CHANNEL HD/);
  assert.match(res.content, /Stream check last ran/);
});

test('🔴 a guest never sees the privileged command‘s stderr', async () => {
  // On failure the owner path quotes docker's stderr, which names containers and
  // paths. A guest must not reach that text by any route.
  const { impl } = execStub(MTIME + HOUR, { rosterExit: 1 });
  const res = await channelHealth.run({}, ctx(impl, 'guest'));
  assert.doesNotMatch(res.content, /No such container/, "docker's stderr reached a guest");
  assert.doesNotMatch(res.content, /exit=|stderr=/, 'raw command diagnostics reached a guest');

  // 🔴 CONTROL: the owner DOES see that stderr, so the assertions above are
  // about the role rather than about a stub that never produced any.
  const asOwner = execStub(MTIME + HOUR, { rosterExit: 1 });
  const owner = await channelHealth.run({}, ctx(asOwner.impl, 'owner'));
  assert.match(owner.content, /No such container/);
  assert.match(owner.content, /stderr=/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 NAMED DISPATCHARR QUERIES — the SQL is a literal, the model picks a name
// ─────────────────────────────────────────────────────────────────────────────

/** Records every command, and answers a named query with fixture rows. */
function queryStub(rows: string, exitCode = 0) {
  const commands: { host: string; command: string }[] = [];
  const impl: ExecImpl = (_file, args, _options, callback) => {
    commands.push({ host: args[args.length - 2] ?? '', command: args[args.length - 1] ?? '' });
    if (exitCode) return callback({ code: exitCode }, '', 'ERROR:  relation "epg_programdata" does not exist');
    return callback(null, `${rows}\n`, '');
  };
  return { commands, impl };
}

test('🔴 MUTATION TARGET: no query selects a CREDENTIAL COLUMN — quantified over all of them', () => {
  /**
   * 🔴 THE COLUMN WHITELIST IS THE ENTIRE DEFENCE HERE, and `stripCredentials`
   * cannot help. Measured on the live database 2026-08-26:
   *
   *  - `m3u_m3uaccount` has POPULATED `username` and `password` (10 chars each
   *    on all three live accounts) — the IPTV provider login.
   *  - `dispatcharr_channels_stream.url` is Xtream format,
   *    `http://znq234.live/live/<credential>/...`, so the secret is a PATH
   *    SEGMENT. The URL scrubber rewrites querystring keys and matches nothing
   *    here.
   *
   * Quantified over every query rather than checked one by one, so a query
   * nobody has written yet is covered the moment it exists.
   */
  for (const name of QUERY_NAMES) {
    const sql = QUERIES[name].sql(1).toLowerCase();
    assert.ok(!/select\s+\*/.test(sql), `${name} must not SELECT *`);
    for (const column of ['url', 'username', 'password']) {
      assert.ok(
        !new RegExp(`\\b(s|a)\\.${column}\\b`).test(sql),
        `${name} must not select the credential-bearing column ${column}`,
      );
    }
  }
});

test('🔴 MUTATION TARGET: epg_coverage names the table and column that EXIST', () => {
  /**
   * Verified against `information_schema` on the live database, because the job
   * specs disagree with themselves: there is no `dispatcharr_epg_programdata`
   * and no `stop_time`. A query naming either fails HARD — which is the good
   * failure, but only if the failure is reported as UNKNOWN rather than as an
   * empty result.
   */
  const sql = QUERIES.epg_coverage.sql(0);
  assert.match(sql, /\bepg_programdata\b/);
  assert.match(sql, /\bend_time\b/);
  assert.ok(!/dispatcharr_epg_programdata/.test(sql), 'that table does not exist');
  assert.ok(!/stop_time/.test(sql), 'that column does not exist');
});

test('🔴 m3u_staleness keeps its load-bearing guard and its control', () => {
  // Account 1 is the local 'custom' account with no server and no streams;
  // without this it trips a NULL alarm permanently. Scoped by the REASON, not
  // by `id <> 1`, which would silently stop working if ids moved.
  assert.match(QUERIES.m3u_staleness.sql(0), /a\.server_url is not null/i);
  assert.equal(QUERIES.m3u_staleness.control?.minRows, 3);
  // And it keys on STREAM freshness, never the account row's own frozen fields.
  assert.match(QUERIES.m3u_staleness.sql(0), /max\(s\.updated_at\)/i);
});

test('`order` is quoted — it is a reserved word in Postgres', () => {
  assert.match(QUERIES.channel_streams.sql(7), /cs\."order"/);
  assert.match(QUERIES.channel_streams.sql(7), /channel_number = 7/);
});

test('🔴 MUTATION TARGET: a GUEST is refused and the privileged command is NEVER SENT', async () => {
  const { commands, impl } = queryStub('2|acct|2026-01-01|1.0|10');
  const res = await channelHealth.run({ query: 'm3u_staleness' }, ctx(impl, 'guest'));

  assert.equal(res.ok, false);
  assert.match(res.content, /owner-only/);
  assert.match(res.content, /capability rather than a kind of data/);
  assert.deepEqual(commands, [], '🔴 a guest must not cause the privileged docker exec at all');
  // ⚠️ And it must not invite them to claim otherwise — the role came from the
  // number they texted from, before the model read a word.
  assert.match(res.content, /Do not offer to take their word/);
});

test('🔴 MUTATION TARGET: a non-integer channel is refused BEFORE anything is sent', async () => {
  // The only value that ever reaches SQL, on the privileged identity. The spec
  // records a Python repr leaking into `WHERE name IN (...)` and crashing the
  // job on 2026-08-14. A type constraint is a proof; escaping is a promise.
  for (const bad of ['ESPN', '1; drop table x', 7.5, null, undefined]) {
    const { commands, impl } = queryStub('');
    const res = await channelHealth.run(
      { query: 'channel_streams', channel_number: bad },
      ctx(impl, 'owner'),
    );
    assert.equal(res.ok, false, JSON.stringify(bad));
    assert.match(res.content, /whole number/);
    assert.deepEqual(commands, [], `nothing may be sent for ${JSON.stringify(bad)}`);
  }
});

test('🔴 MUTATION TARGET: a SHORT result trips the control and is UNKNOWN, not a clean answer', async () => {
  // Two rows where three are required. The rows themselves look perfectly
  // healthy — which is exactly why the control runs BEFORE they are read.
  const { impl } = queryStub(['2|a|2026-08-26 16:00:00+00|3.1|100', '3|b|2026-08-26 16:00:00+00|3.1|100'].join('\n'));
  const res = await channelHealth.run({ query: 'm3u_staleness' }, ctx(impl, 'owner'));

  assert.equal(res.ok, false);
  assert.match(res.content, /returned 2 row\(s\) and needs at least 3/);
  assert.match(res.content, /would report a healthy system from a query that did not see it/);
  assert.ok(!/refreshed within 30 hours/.test(res.content), 'the verdict must not be rendered');
});

test('🔴 a query that could not RUN is UNKNOWN, never "nothing found"', async () => {
  const { impl } = queryStub('', 1);
  const res = await channelHealth.run({ query: 'epg_coverage' }, ctx(impl, 'owner'));
  assert.equal(res.ok, false);
  assert.match(res.content, /UNKNOWN — NOT "nothing found"/);
});

test('CONTROL: a full result IS rendered, with its verdict', async () => {
  // Without this, every assertion above is equally consistent with the query
  // path never returning anything at all.
  const { commands, impl } = queryStub(
    ['2|a|2026-08-26 16:00:00+00|3.1|100', '3|b|2026-08-26 16:00:00+00|3.1|100', '4|c|2026-08-26 16:00:00+00|3.1|100'].join('\n'),
  );
  const res = await channelHealth.run({ query: 'm3u_staleness' }, ctx(impl, 'owner'));
  assert.equal(res.ok, true);
  assert.match(res.content, /All accounts refreshed within 30 hours/);
  assert.match(res.content, /Nothing was changed/);
  assert.equal(commands[0]?.host, testConfig().adminSshHost, 'psql needs the privileged account');
  assert.match(commands[0]?.command ?? '', /docker exec dispatcharr psql/);
});

test('a stale account and a never-refreshed one are DIFFERENT and reported apart', async () => {
  const { impl } = queryStub(
    ['2|a|2026-08-20 00:00:00+00|99.0|100', '3|b|2026-08-26 16:00:00+00|3.1|100', '4|c|||0'].join('\n'),
  );
  const res = await channelHealth.run({ query: 'm3u_staleness' }, ctx(impl, 'owner'));
  assert.match(res.content, /1 account\(s\) have NEVER refreshed/);
  assert.match(res.content, /1 account\(s\) older than 30 hours/);
});

test('channel_streams says a single-account failure is NOT a reason to swap', async () => {
  const { impl } = queryStub(['1|COOKING|2|f|2026-08-26|0', '1|COOKING|3|f|2026-08-26|1'].join('\n'));
  const res = await channelHealth.run({ query: 'channel_streams', channel_number: 1 }, ctx(impl, 'owner'));
  assert.match(res.content, /FAILING ON ONE ACCOUNT IS NOT A REASON TO SWAP/);
  assert.match(res.content, /true BY CONSTRUCTION/);
  assert.match(res.content, /never from the channel's display name/);
});

test('an unknown query name is refused and names the ones that exist', async () => {
  const { commands, impl } = queryStub('');
  const res = await channelHealth.run({ query: 'drop_everything' }, ctx(impl, 'owner'));
  assert.equal(res.ok, false);
  assert.match(res.content, /epg_coverage, channel_profiles, m3u_staleness, channel_streams/);
  assert.deepEqual(commands, []);
});

test('the command is code-composed: psql, pipe-separated, on the privileged host', () => {
  const cmd = commandFor('channel_streams' as QueryName, 42);
  assert.match(cmd, /^docker exec dispatcharr psql -U dispatch -d dispatcharr -At -F'\|' -c /);
  assert.match(cmd, /channel_number = 42/);
});
