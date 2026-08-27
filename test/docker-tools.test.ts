import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExecImpl } from '../src/hp.js';
import { isValidContainerName } from '../src/safety.js';
import { containerNetns, dockerInspect, dockerLogs, dockerPs } from '../src/tools/docker.js';
import { restartContainer } from '../src/tools/homelab.js';
import type { Tool, ToolContext } from '../src/tools/types.js';
import { testConfig } from './helpers.js';

/**
 * The docker tools run on the PRIVILEGED ssh identity. Everything here exists
 * because of that one fact.
 *
 * `hp_shell` is unprivileged by OS enforcement, so a smuggled interpreter fails
 * at the kernel. These tools have no such backstop: their command text reaches
 * hp as the admin account, and the only defence between a model-supplied
 * container name and a privileged remote shell is `isValidContainerName`.
 *
 * So the tests assert the thing that is NOT observable from a return value: that
 * a refused name produced **no ssh call at all**. A tool that refuses in its
 * reply while having already run the command would look identical from the
 * outside, and that is precisely the shape of the bug this file is here to catch.
 */

/** Every ssh invocation a tool made: the host it used and the command it sent. */
interface SshLog {
  calls: { host: string; command: string }[];
  exec: ExecImpl;
}

/**
 * An exec stub that records each ssh call and answers from a script.
 *
 * `respond` receives the command string, so a test can answer `docker inspect`
 * differently from `docker exec … readlink` within one tool run.
 */
function sshSpy(
  respond: (command: string) => { stdout?: string; stderr?: string; error?: unknown } = () => ({}),
): SshLog {
  const calls: { host: string; command: string }[] = [];
  const exec: ExecImpl = (_file, args, _options, callback) => {
    const host = args[4] ?? '';
    const command = args[5] ?? '';
    calls.push({ host, command });
    const r = respond(command);
    setImmediate(() => callback(r.error ?? null, r.stdout ?? '', r.stderr ?? ''));
  };
  return { calls, exec };
}

function ctxWith(spy: SshLog, overrides = {}): ToolContext {
  return {
    role: 'owner',
    senderHandle: '+18015550123',
    config: testConfig(overrides),
    exec: spy.exec,
  };
}

/**
 * 🔴 `HostConfig.NetworkMode` is `container:<64-hex-id>` — never
 * `container:gluetun`. An earlier fixture invented the friendly form, and the
 * tool passed its tests while being permanently silent on the real homelab. This
 * id was read off hp.
 */
const PEER_ID = '416dbdcb8b98323a2a2bc946f8d43c54901d8180045e0270ba6cd6cc837af4dc';

const DOCKER_TOOLS: Tool[] = [dockerPs, dockerInspect, dockerLogs, containerNetns];
const NAMED_TOOLS: Tool[] = [dockerInspect, dockerLogs, containerNetns];

/**
 * A spy that answers every command with the shape hp really returns, so a tool
 * runs to completion instead of short-circuiting into an early branch.
 */
function realisticSpy(): SshLog {
  return sshSpy((command) => {
    if (command.includes('HostConfig.NetworkMode')) return { stdout: `container:${PEER_ID}\n` };
    if (command.includes('{{.Name}}')) return { stdout: '/gluetun\n' };
    if (command.includes('readlink')) return { stdout: 'net:[4026532519]\n' };
    if (command.startsWith('docker ps -a') && command.includes('gluetun')) {
      return { stdout: 'gluetun|Up 2 weeks\n' };
    }
    if (command.startsWith('docker ps -a')) return { stdout: 'sonarr|Up 2 hours\n' };
    return { stdout: 'status=running\n' };
  });
}

/**
 * Names that are not names. Each one, interpolated unescaped into
 * `docker inspect … ${name}`, executes a second command as the admin account.
 */
const INJECTIONS = [
  'sonarr; docker restart gluetun',
  'sonarr && docker restart gluetun',
  'sonarr | docker restart gluetun',
  'sonarr$(docker restart gluetun)',
  'sonarr`docker restart gluetun`',
  "sonarr'; docker restart gluetun; '",
  'sonarr\ndocker restart gluetun',
  'sonarr --format {{.Id}}',
  '$(id)',
  '../../etc/passwd',
  '-sonarr',
  '.sonarr',
  'sonarr gluetun',
  '',
  ' ',
];

test('🔴 isValidContainerName refuses every shape that would become a second command', () => {
  for (const bad of INJECTIONS) {
    assert.equal(isValidContainerName(bad), false, `"${bad}" must be refused`);
  }
});

test('CONTROL: real homelab container names are still accepted', () => {
  // Without this, a validator that returned false for everything would pass the
  // test above while deleting the capability entirely.
  for (const good of [
    'sonarr',
    'gluetun',
    'jellyfin',
    'audiobookshelf-audiobookshelf-1',
    'qbittorrent',
    'dispatcharr',
    'a',
    'my_app.v2-1',
  ]) {
    assert.equal(isValidContainerName(good), true, `"${good}" must be accepted`);
  }
});

test('🔴 a refused container name produces NO ssh call — the command is not merely reported as refused', async () => {
  for (const tool of NAMED_TOOLS) {
    for (const bad of INJECTIONS) {
      const spy = sshSpy();
      const result = await tool.run({ container: bad }, ctxWith(spy));
      assert.equal(result.ok, false, `${tool.name} must refuse "${bad}"`);
      assert.equal(
        spy.calls.length,
        0,
        `${tool.name} ran ${spy.calls.length} ssh call(s) for refused input "${bad}": ` +
          `${spy.calls.map((c) => c.command).join(' ;; ')}`,
      );
    }
  }
});

test('🔴 restart_container validates its name with the SAME validator — and runs nothing when it refuses', async () => {
  // The write path had its own weaker inline regex, which accepted `-sonarr` and
  // `.sonarr`. Two validators guarding one privileged identity means tightening
  // the one everybody looks at leaves the one that actually restarts things.
  for (const bad of INJECTIONS) {
    const spy = sshSpy();
    const result = await restartContainer.run({ container: bad }, ctxWith(spy, { readOnly: false }));
    assert.equal(result.ok, false, `restart_container must refuse "${bad}"`);
    assert.equal(
      spy.calls.length,
      0,
      `restart_container ran ssh for refused input "${bad}": ${spy.calls.map((c) => c.command).join(' ;; ')}`,
    );
  }

  // Control: a valid name gets past validation and does reach ssh for its
  // evidence-gathering read, so the assertion above is about the name.
  //
  // The stub fails that read deliberately, which stops the tool right there. A
  // control that let this tool run to completion would reach Jellyfin over the
  // real network and then the restart branch — a test that can restart a
  // container is not a test.
  const spy = sshSpy(() => ({ error: new Error('ssh: no route to host') }));
  const control = await restartContainer.run({ container: 'sonarr' }, ctxWith(spy, { readOnly: false }));
  assert.equal(spy.calls.length, 1, 'restart_container made no ssh call even for a valid name');
  assert.equal(control.ok, false);
  assert.match(control.content, /Refusing to restart something I cannot see/);
});

test('CONTROL: a VALID name does reach ssh, so the spy above could have seen a leak', async () => {
  for (const tool of NAMED_TOOLS) {
    const spy = realisticSpy();
    await tool.run({ container: 'sonarr' }, ctxWith(spy));
    assert.ok(spy.calls.length > 0, `${tool.name} made no ssh call even for a valid name`);
  }
});

test('🔴 every docker tool uses the ADMIN identity on EVERY ssh call it makes', async () => {
  // Pointing one of these at the shell account would not fail loudly — it would
  // return "permission denied" and read as a broken container.
  //
  // ⚠️ The spy must answer each command PLAUSIBLY, or the tool short-circuits and
  // the later call sites are never reached. An earlier version answered every
  // non-readlink command with `sonarr|Up 2 hours`, which sent container_netns
  // down its "nothing to compare" branch: the peer-resolution ssh call was never
  // made, and pointing THAT call at the shell host left the suite green. A test
  // whose fixture stops the subject early is asserting about a shorter program
  // than the one that ships.
  const config = { adminSshHost: 'admin-host', shellSshHost: 'shell-host' };
  const expectedCalls: Record<string, number> = {
    docker_ps: 1,
    docker_inspect: 1,
    docker_logs: 1,
    // NetworkMode, subject ps, subject readlink, peer name, peer ps, peer readlink
    container_netns: 6,
  };
  for (const tool of DOCKER_TOOLS) {
    const spy = realisticSpy();
    await tool.run({ container: 'sonarr' }, ctxWith(spy, config));
    assert.equal(
      spy.calls.length,
      expectedCalls[tool.name],
      `${tool.name} made ${spy.calls.length} ssh call(s), expected ${expectedCalls[tool.name]}: ` +
        `${spy.calls.map((c) => c.command).join(' ;; ')}`,
    );
    for (const call of spy.calls) {
      assert.equal(call.host, 'admin-host', `${tool.name} used "${call.host}" for: ${call.command}`);
    }
  }
});

test('🔴 no docker tool declares a free-form STRING parameter other than the container name', () => {
  // The whole reason these are safe on the privileged identity is that the only
  // string that ever reaches the remote shell is a validated container name. A
  // `grep`/`format`/`args` parameter would quietly reintroduce model-composed
  // command text with none of the OS backstop hp_shell has.
  for (const tool of DOCKER_TOOLS) {
    const props = (tool.parameters as { properties?: Record<string, { type?: string }> }).properties ?? {};
    for (const [name, schema] of Object.entries(props)) {
      if (schema.type === 'string') {
        assert.equal(
          name,
          'container',
          `${tool.name} declares a string parameter "${name}" — that is model-composed command text`,
        );
      }
    }
  }
});

test('docker_logs clamps its numbers and emits only digits into the command', async () => {
  const cases: { tail: unknown; since: unknown; expectTail: number }[] = [
    { tail: 999_999, since: undefined, expectTail: 1000 },
    { tail: -5, since: undefined, expectTail: 1 },
    { tail: undefined, since: undefined, expectTail: 100 },
    { tail: 12.9, since: undefined, expectTail: 12 },
  ];
  for (const c of cases) {
    const spy = sshSpy(() => ({ stdout: 'a log line\n' }));
    await dockerLogs.run({ container: 'jellyfin', tail: c.tail }, ctxWith(spy));
    assert.match(spy.calls[0]?.command ?? '', new RegExp(`^docker logs --tail ${c.expectTail} jellyfin 2>&1$`));
  }

  // A string in a number field must not be interpolated as text.
  const spy = sshSpy(() => ({ stdout: 'x\n' }));
  await dockerLogs.run({ container: 'jellyfin', tail: '5; docker restart gluetun' }, ctxWith(spy));
  assert.equal(spy.calls[0]?.command, 'docker logs --tail 100 jellyfin 2>&1');

  const spySince = sshSpy(() => ({ stdout: 'x\n' }));
  await dockerLogs.run({ container: 'jellyfin', since_minutes: 99_999 }, ctxWith(spySince));
  assert.equal(spySince.calls[0]?.command, 'docker logs --tail 100 --since 1440m jellyfin 2>&1');
});

test('docker_ps: exit 0 with no rows is UNKNOWN, not "no containers"', async () => {
  const spy = sshSpy(() => ({ stdout: '   \n' }));
  const result = await dockerPs.run({}, ctxWith(spy));
  assert.equal(result.ok, false);
  assert.match(result.content, /UNKNOWN/);

  // Control: real rows are reported as a success, so the assertion above is
  // about emptiness rather than about the tool never succeeding.
  const spyOk = sshSpy(() => ({ stdout: 'sonarr|Up 2 hours|linuxserver/sonarr\n' }));
  const good = await dockerPs.run({}, ctxWith(spyOk));
  assert.equal(good.ok, true);
  assert.match(good.content, /sonarr\|Up 2 hours/);
});

test('docker_ps: a failing ssh call never reads as an empty container list', async () => {
  const spy = sshSpy(() => ({ error: new Error('ssh: connect to host hp port 22: No route to host') }));
  const result = await dockerPs.run({}, ctxWith(spy));
  assert.equal(result.ok, false);
  assert.match(result.content, /UNKNOWN/);
});

/**
 * Script a container_netns run against the shapes docker ACTUALLY emits.
 *
 * 🔴 `HostConfig.NetworkMode` is `container:<64-hex-id>` — never
 * `container:gluetun`. An earlier fixture here invented the friendly form, and
 * the tool passed its tests while being permanently silent on the real homelab:
 * every container it was written for fell down the "nothing to compare" branch.
 * The id below is a real one, read off hp.
 */
function netnsSpy(
  subject: { status?: string; inode?: string },
  peer: { status?: string; inode?: string; name?: string },
  mode = `container:${PEER_ID}`,
): SshLog {
  const peerName = peer.name ?? 'gluetun';
  return sshSpy((command) => {
    if (command.includes('HostConfig.NetworkMode')) return { stdout: `${mode}\n` };
    if (command.includes('{{.Name}}')) {
      return peer.name === null ? { error: new Error('no such container') } : { stdout: `/${peerName}\n` };
    }
    if (command.startsWith('docker ps -a') && command.includes(`^${peerName}`)) {
      return peer.status === undefined ? { error: new Error('boom') } : { stdout: `${peerName}|${peer.status}\n` };
    }
    if (command.startsWith('docker ps -a')) {
      return subject.status === undefined ? { error: new Error('boom') } : { stdout: `sonarr|${subject.status}\n` };
    }
    if (command.includes(`docker exec ${peerName}`)) {
      return peer.inode ? { stdout: `net:[${peer.inode}]\n` } : { error: new Error('exec failed') };
    }
    if (command.includes('docker exec')) {
      return subject.inode ? { stdout: `net:[${subject.inode}]\n` } : { error: new Error('exec failed') };
    }
    return {};
  });
}

test('🔴 container_netns resolves the container:<id> form docker really reports', async () => {
  // The regression test for the fixture that lied. With the literal
  // `container:gluetun` comparison this run reported "nothing to compare" while
  // the namespace was in fact shared, i.e. the diagnostic answered nothing.
  const spy = netnsSpy(
    { status: 'Up 10 hours', inode: '4026532519' },
    { status: 'Up 2 weeks', inode: '4026532519' },
  );
  const result = await containerNetns.run({ container: 'sonarr' }, ctxWith(spy));
  assert.equal(result.ok, true);
  assert.match(result.content, /IS in gluetun's network namespace/);
  assert.doesNotMatch(result.content, /nothing to compare/);
  assert.ok(
    spy.calls.some((c) => c.command.includes('{{.Name}}')),
    'the peer id must be resolved to a name rather than string-matched',
  );
});

test('🔴 container_netns validates the peer reference DOCKER supplied before interpolating it', async () => {
  // The peer id comes from docker, not from the model — which is exactly the
  // reasoning that stops an injection sink from being reviewed. A compromised or
  // simply weird NetworkMode value must not become a second privileged command.
  const spy = sshSpy((command) => {
    if (command.includes('HostConfig.NetworkMode')) {
      return { stdout: 'container:abc; docker restart gluetun\n' };
    }
    if (command.startsWith('docker ps -a')) return { stdout: 'sonarr|Up 2 hours\n' };
    if (command.includes('readlink')) return { stdout: 'net:[4026532519]\n' };
    return {};
  });
  const result = await containerNetns.run({ container: 'sonarr' }, ctxWith(spy));
  assert.equal(result.ok, false);
  assert.equal(
    spy.calls.some((c) => c.command.includes('docker restart')),
    false,
    `an unusable peer reference reached ssh: ${spy.calls.map((c) => c.command).join(' ;; ')}`,
  );
});

test('container_netns: an unresolvable peer id is UNKNOWN, not a pass', async () => {
  const spy = netnsSpy(
    { status: 'Up 10 hours', inode: '4026532519' },
    { status: 'Up 2 weeks', inode: '4026532519', name: null as unknown as string },
  );
  const result = await containerNetns.run({ container: 'sonarr' }, ctxWith(spy));
  assert.equal(result.ok, false);
  assert.match(result.content, /UNKNOWN/);
});

test('🔴 container_netns validates the RESOLVED peer name too, not only the id', async () => {
  // Two sinks, one trust assumption. The resolved name is interpolated into both
  // the ps grep and `docker exec … readlink` on the ADMIN host, so validating the
  // id and not the name leaves the second half of the same path open.
  const spy = sshSpy((command) => {
    if (command.includes('HostConfig.NetworkMode')) return { stdout: `container:${PEER_ID}\n` };
    if (command.includes('{{.Name}}')) return { stdout: '/gluetun; docker restart jellyfin\n' };
    if (command.startsWith('docker ps -a')) return { stdout: 'sonarr|Up 2 hours\n' };
    if (command.includes('readlink')) return { stdout: 'net:[4026532519]\n' };
    return {};
  });
  const result = await containerNetns.run({ container: 'sonarr' }, ctxWith(spy));
  assert.equal(result.ok, false);
  assert.equal(
    spy.calls.some((c) => c.command.includes('docker restart')),
    false,
    `an unusable peer NAME reached ssh: ${spy.calls.map((c) => c.command).join(' ;; ')}`,
  );
});

test('🔴 container_netns fails CLOSED on a network mode it does not recognise', async () => {
  // A garbled read must not become "nothing to compare", which reads as fine.
  const spy = sshSpy((command) => {
    if (command.includes('HostConfig.NetworkMode')) return { stdout: 'sonarr|Up 2 hours\n' };
    if (command.startsWith('docker ps -a')) return { stdout: 'sonarr|Up 2 hours\n' };
    if (command.includes('readlink')) return { stdout: 'net:[4026532519]\n' };
    return {};
  });
  const result = await containerNetns.run({ container: 'sonarr' }, ctxWith(spy));
  assert.equal(result.ok, false);
  assert.match(result.content, /UNRECOGNISED|UNKNOWN/);

  // Control: a real standalone mode is still reported as a clean non-comparison,
  // so the check above is about garbage rather than about refusing everything.
  const bridge = sshSpy((command) => {
    if (command.includes('HostConfig.NetworkMode')) return { stdout: 'bridge\n' };
    if (command.startsWith('docker ps -a')) return { stdout: 'jellyfin|Up 6 days\n' };
    if (command.includes('readlink')) return { stdout: 'net:[4026531840]\n' };
    return {};
  });
  const ok2 = await containerNetns.run({ container: 'jellyfin' }, ctxWith(bridge));
  assert.equal(ok2.ok, true);
  assert.match(ok2.content, /nothing to compare/);
});

test('🔴 container_netns: an unreadable docker ps is UNKNOWN, never "not running"', async () => {
  // An ssh transport failure falling through to the isUp check would state
  // "sonarr is not running ()" — a definite claim built from a failed probe.
  const spy = sshSpy((command) => {
    if (command.includes('HostConfig.NetworkMode')) return { stdout: `container:${PEER_ID}\n` };
    if (command.startsWith('docker ps -a')) return { error: new Error('ssh: no route to host') };
    return {};
  });
  const result = await containerNetns.run({ container: 'sonarr' }, ctxWith(spy));
  assert.equal(result.ok, false);
  assert.match(result.content, /could not determine whether sonarr exists/);
  assert.doesNotMatch(result.content, /is not running/);
});

test('docker_inspect and docker_logs: a non-zero exit is a failure, never an empty success', async () => {
  for (const tool of [dockerInspect, dockerLogs]) {
    const spy = sshSpy(() => ({ error: new Error('No such container: ghost'), stderr: 'No such container' }));
    const result = await tool.run({ container: 'ghost' }, ctxWith(spy));
    assert.equal(result.ok, false, `${tool.name} reported ok on a failed command`);
    assert.match(result.content, /UNKNOWN/);
  }

  // Control: a successful call is still ok, so the assertions above are about the
  // exit code rather than about the tools never succeeding.
  for (const tool of [dockerInspect, dockerLogs]) {
    const spy = sshSpy(() => ({ stdout: 'status=running\n' }));
    const result = await tool.run({ container: 'sonarr' }, ctxWith(spy));
    assert.equal(result.ok, true, `${tool.name} reported failure on a clean command`);
  }
});

test('the anchored ps grep escapes the one regex metacharacter a valid name may contain', async () => {
  // `.` is legal in a container name and special in an ERE, so `^my_app.v2-1\|`
  // also matches a row for `my_appXv2-1` — and only the first row is read, so the
  // up/down verdict could come from a different container entirely.
  const spy = realisticSpy();
  await containerNetns.run({ container: 'my_app.v2-1' }, ctxWith(spy));
  const psCall = spy.calls.find((c) => c.command.startsWith('docker ps -a'));
  assert.match(psCall?.command ?? '', /\^my_app\\\.v2-1/);
});

test('container_netns: matching inodes report a healthy shared namespace', async () => {
  const spy = netnsSpy({ status: 'Up 2 hours', inode: '4026532519' }, { status: 'Up 3 hours', inode: '4026532519' });
  const result = await containerNetns.run({ container: 'sonarr' }, ctxWith(spy));
  assert.equal(result.ok, true);
  assert.match(result.content, /IS in gluetun's network namespace/);
  assert.match(result.content, /4026532519/);
});

test('🔴 container_netns: DIFFERENT inodes on a container:gluetun dependent is the stale-namespace fault', async () => {
  // docker ps says Up and docker inspect says container:gluetun in BOTH states.
  // The inode is the only thing that separates them, which is why this tool
  // exists rather than a `docker inspect` of the network mode.
  const spy = netnsSpy({ status: 'Up 2 hours', inode: '4026531999' }, { status: 'Up 3 hours', inode: '4026532519' });
  const result = await containerNetns.run({ container: 'sonarr' }, ctxWith(spy));
  assert.equal(result.ok, false);
  assert.match(result.content, /STALE NAMESPACE/);
  assert.match(result.content, /restart_arr_stack/);
});

test('🔴 container_netns: an unreadable probe is UNKNOWN and never reads as healthy', async () => {
  // Subject running but exec fails.
  const execFailed = netnsSpy({ status: 'Up 2 hours' }, { status: 'Up 3 hours', inode: '4026532519' });
  const a = await containerNetns.run({ container: 'sonarr' }, ctxWith(execFailed));
  assert.equal(a.ok, false);
  assert.match(a.content, /UNKNOWN/);

  // Subject stopped: docker exec would fail with a message that reads like a
  // namespace problem and is not one.
  const stopped = netnsSpy({ status: 'Exited (0) 5 minutes ago' }, { status: 'Up 3 hours', inode: '4026532519' });
  const b = await containerNetns.run({ container: 'sonarr' }, ctxWith(stopped));
  assert.equal(b.ok, false);
  assert.match(b.content, /not running/);

  // Subject fine, gluetun unreadable: the comparison is unknown, not a match.
  const noTunnel = netnsSpy({ status: 'Up 2 hours', inode: '4026532519' }, { status: 'Up 3 hours' });
  const c = await containerNetns.run({ container: 'sonarr' }, ctxWith(noTunnel));
  assert.equal(c.ok, false);
  assert.match(c.content, /UNKNOWN/);
});

test('container_netns: a container NOT on the tunnel is reported plainly, not as a mismatch', async () => {
  // A false alarm here would train the reader to ignore the real one.
  const spy = netnsSpy({ status: 'Up 2 hours', inode: '4026531840' }, { status: 'Up 3 hours', inode: '4026532519' }, 'bridge');
  const result = await containerNetns.run({ container: 'jellyfin' }, ctxWith(spy));
  assert.equal(result.ok, true);
  assert.match(result.content, /nothing to compare/);
  assert.doesNotMatch(result.content, /STALE/);
});

test('container_netns: garbage where an inode should be is UNKNOWN, not a comparison', async () => {
  // `readlink` exiting 0 with unexpected text must not half-parse into a verdict.
  const spy = sshSpy((command) => {
    if (command.includes('HostConfig.NetworkMode')) return { stdout: `container:${PEER_ID}\n` };
    if (command.includes('{{.Name}}')) return { stdout: '/gluetun\n' };
    if (command.startsWith('docker ps -a')) return { stdout: 'sonarr|Up 2 hours\n' };
    return { stdout: 'Error response from daemon: something went wrong\n' };
  });
  const result = await containerNetns.run({ container: 'sonarr' }, ctxWith(spy));
  assert.equal(result.ok, false);
  assert.match(result.content, /UNKNOWN is not healthy|could NOT be read/);
});
