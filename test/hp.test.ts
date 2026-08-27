import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clip, renderOutcome, runOnHp, type ExecImpl } from '../src/hp.js';

/** An exec stub that reports whatever the case needs. */
function stubExec(result: {
  error?: unknown;
  stdout?: string;
  stderr?: string;
  capture?: (file: string, args: string[]) => void;
}): ExecImpl {
  return (file, args, _options, callback) => {
    result.capture?.(file, args);
    setImmediate(() => callback(result.error ?? null, result.stdout ?? '', result.stderr ?? ''));
  };
}

test('a successful command reports exit code 0 and its output', async () => {
  const outcome = await runOnHp('hp', 'uptime', 5000, stubExec({ stdout: 'load 0.1\n' }));
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.stdout, 'load 0.1\n');
  assert.equal(outcome.timedOut, false);
});

test('🔴 a failure with NO numeric code is still a failure, not an empty success', async () => {
  // This is the whole point of the module. An ssh transport error (host down, key
  // refused, DNS failure) arrives as an Error with no `code`. If that mapped to
  // exitCode 0 with empty stdout, every such failure would read to the model as
  // "the command ran and found nothing" — the most expensive false green in this
  // homelab's history.
  const outcome = await runOnHp(
    'hp',
    'docker ps',
    5000,
    stubExec({ error: new Error('ssh: connect to host hp port 22: No route to host') }),
  );
  assert.equal(outcome.exitCode, 1, 'a transport error must NOT report exit code 0');
  assert.notEqual(outcome.exitCode, 0);
});

test('a non-zero exit code is preserved exactly', async () => {
  const outcome = await runOnHp(
    'hp',
    'grep nothing file',
    5000,
    stubExec({ error: Object.assign(new Error('exit 1'), { code: 1 }) }),
  );
  assert.equal(outcome.exitCode, 1);
});

test('a killed (timed-out) command is flagged as timed out', async () => {
  const outcome = await runOnHp(
    'hp',
    'sleep 999',
    5,
    stubExec({ error: Object.assign(new Error('killed'), { killed: true }) }),
  );
  assert.equal(outcome.timedOut, true);
  assert.notEqual(outcome.exitCode, 0);
});

test('the command is passed to ssh as ONE argv element, never through a local shell', async () => {
  // If the command were interpolated into a local shell string, a command
  // containing shell metacharacters would execute on THIS machine.
  let seenFile = '';
  let seenArgs: string[] = [];
  const nasty = 'docker ps; echo pwned > /tmp/x';
  await runOnHp(
    'hp',
    nasty,
    5000,
    stubExec({
      capture: (file, args) => {
        seenFile = file;
        seenArgs = args;
      },
    }),
  );
  assert.equal(seenFile, 'ssh', 'must invoke ssh directly, not a shell');
  assert.equal(seenArgs.at(-1), nasty, 'the command must be a single unsplit argv element');
  assert.equal(seenArgs.filter((a) => a === nasty).length, 1);
  assert.ok(seenArgs.includes('hp'), 'the host must be passed to ssh');
});

test('renderOutcome always states the exit code and labels empty streams', () => {
  const rendered = renderOutcome({ exitCode: 1, stdout: '', stderr: '', timedOut: false });
  assert.match(rendered, /exit_code=1/);
  // Both streams must be present and explicitly marked empty — an omitted stderr
  // is how a failure comes to look like an empty result.
  assert.match(rendered, /stdout:\n\(empty\)/);
  assert.match(rendered, /stderr:\n\(empty\)/);
});

test('renderOutcome surfaces stderr even when stdout has content', () => {
  const rendered = renderOutcome({
    exitCode: 2,
    stdout: 'partial output',
    stderr: 'Error response from daemon: No such container',
    timedOut: false,
  });
  assert.match(rendered, /exit_code=2/);
  assert.match(rendered, /No such container/);
});

test('a timeout is called out in the rendered output', () => {
  const rendered = renderOutcome({ exitCode: 1, stdout: '', stderr: '', timedOut: true });
  assert.match(rendered, /TIMED OUT/);
});

test('clip keeps both ends and says how much it dropped', () => {
  const long = `START${'x'.repeat(50_000)}END`;
  const clipped = clip(long, 1000);
  assert.ok(clipped.length < long.length);
  assert.match(clipped, /^START/);
  assert.match(clipped, /END$/);
  assert.match(clipped, /characters omitted/);
});

test('clip leaves short text untouched', () => {
  assert.equal(clip('short', 1000), 'short');
});
