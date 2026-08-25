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

const MTIME = 1_787_498_113; // 2026-08-23 15:15:13Z, the live file's real mtime
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

function ctx(exec: ExecImpl): ToolContext {
  return { role: 'owner', senderHandle: '+18015550123', config: testConfig(), exec };
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
  assert.match(res.content.split('\n')[0] ?? '', /Stream check last ran 2026-08-23 15:15 UTC — 3h ago/);
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
  assert.match(res.content, /last ran unknown UTC/);
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

test('the tool declares itself a read and is owner-only', () => {
  assert.equal(channelHealth.writes, false);
  assert.equal(channelHealth.minRole, 'owner');
});
