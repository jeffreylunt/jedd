import { runOnHp, type ExecImpl } from '../hp.js';
import { isValidInfoHash, magnetFor } from './prowlarr.js';

/**
 * Handing a torrent to qBittorrent.
 *
 * ── 🔴 WHY THIS GOES OVER SSH INSTEAD OF BEING AN HTTP CLIENT ────────────────
 *
 * Measured 2026-08-24: qBittorrent's API at `172.20.0.1:8080` answers **200 from
 * hp and 000 from the Mac**, where V2 runs. That address is the **docker bridge
 * gateway**, routable only on hp, because qBittorrent lives in
 * `gluetun-torrents`' network namespace. There is no route from here, and adding
 * one would mean putting a torrent client's API on the LAN.
 *
 * So the call is made ON hp, which is what the existing shed tools already do.
 *
 * ── 🔴 THE infoHash IS INTERPOLATED INTO A PRIVILEGED SHELL COMMAND ──────────
 *
 * `runOnHp` uses the ADMIN ssh identity. The convention is that a tool
 * interpolating **model-supplied** strings into a shell command belongs on the
 * unprivileged identity — this string is not model-supplied, but it is not ours
 * either: it comes from Prowlarr, which aggregates third-party indexers.
 *
 * So it is validated as exactly 40 hex characters **before** it can reach a
 * command line, the same discipline as `isValidContainerName`. That validation
 * is the entire defence on this identity, and `magnetFor` refuses rather than
 * trusting its caller.
 */

export type GrabOutcome =
  | { state: 'started'; detail: string }
  /** Already in the client. 🔴 SUCCESS — V1 read this as a failure and said "retry". */
  | { state: 'already-have'; detail: string }
  | { state: 'failed'; detail: string }
  /** The call did not complete. The grab MAY have landed. Never a "no". */
  | { state: 'unknown'; detail: string };

export interface GrabInput {
  adminSshHost: string;
  qbitBaseUrl: string;
  infoHash: string;
  title: string;
  category: string;
  savePath?: string;
  exec?: ExecImpl;
}

/** Single-quote for the remote shell. The magnet is ours, but quote it anyway. */
function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/**
 * Make sure the category exists before using it.
 *
 * A fresh qBittorrent has no categories, and adding with an unknown one puts the
 * download in the wrong place — where the mover and the SMTP step will never
 * find it. It fails by producing a file nobody looks at, which is worse than
 * failing loudly.
 */
export async function ensureCategory(input: {
  adminSshHost: string;
  qbitBaseUrl: string;
  category: string;
  savePath?: string;
  exec?: ExecImpl;
}): Promise<void> {
  const body =
    `category=${encodeURIComponent(input.category)}` +
    (input.savePath ? `&savePath=${encodeURIComponent(input.savePath)}` : '');
  // createCategory is idempotent-ish: it errors if the category exists, which is
  // fine and deliberately ignored.
  await runOnHp(
    input.adminSshHost,
    `curl -s --max-time 10 -X POST ${shellQuote(`${input.qbitBaseUrl}/api/v2/torrents/createCategory`)} ` +
      `--data ${shellQuote(body)}`,
    20_000,
    input.exec,
  );
}

/**
 * Add a torrent and jump it to the front of the queue.
 *
 * Queue-jumping matters: an ebook is a few megabytes behind possibly hours of
 * video, and a person waiting on a book they asked for a minute ago is the case
 * this exists to serve.
 */
export async function grabTorrent(input: GrabInput): Promise<GrabOutcome> {
  if (!isValidInfoHash(input.infoHash)) {
    return {
      state: 'failed',
      detail: `Refusing to grab: "${input.infoHash}" is not a valid infoHash. Nothing was sent.`,
    };
  }
  const magnet = magnetFor(input.infoHash, input.title);

  await ensureCategory({
    adminSshHost: input.adminSshHost,
    qbitBaseUrl: input.qbitBaseUrl,
    category: input.category,
    savePath: input.savePath,
    exec: input.exec,
  });

  const form =
    `urls=${encodeURIComponent(magnet)}` +
    `&category=${encodeURIComponent(input.category)}` +
    (input.savePath ? `&savepath=${encodeURIComponent(input.savePath)}` : '');

  const add = await runOnHp(
    input.adminSshHost,
    `curl -s -w '\\n%{http_code}' --max-time 20 -X POST ` +
      `${shellQuote(`${input.qbitBaseUrl}/api/v2/torrents/add`)} --data ${shellQuote(form)}`,
    40_000,
    input.exec,
  );

  if (add.exitCode !== 0) {
    return {
      state: 'unknown',
      detail:
        `Could not reach qBittorrent to add "${input.title}" (exit ${add.exitCode}: ` +
        `${add.stderr.trim().slice(0, 120)}). The grab MAY have landed — check before retrying.`,
    };
  }

  const lines = add.stdout.trim().split('\n');
  const status = Number(lines[lines.length - 1]);
  const bodyText = lines.slice(0, -1).join('\n').trim();

  // 🔴 qBittorrent answers 409 for a torrent it already holds. That is SUCCESS.
  // V1's ebook path read this as a download FAILURE and told the user to retry,
  // which is the one action guaranteed never to work.
  if (status === 409 || /already in the download list/i.test(bodyText)) {
    return { state: 'already-have', detail: `"${input.title}" is already downloading or downloaded.` };
  }
  if (status !== 200 || /fail/i.test(bodyText)) {
    return {
      state: 'failed',
      detail: `qBittorrent refused the add (http ${status}${bodyText ? `: ${bodyText.slice(0, 120)}` : ''}).`,
    };
  }

  // Best effort — a failure to prioritise is not a failure to grab, so it is
  // reported but never downgrades the outcome.
  const bumped = await runOnHp(
    input.adminSshHost,
    `curl -s --max-time 10 -X POST ${shellQuote(`${input.qbitBaseUrl}/api/v2/torrents/topPrio`)} ` +
      `--data ${shellQuote(`hashes=${input.infoHash.toLowerCase()}`)}`,
    20_000,
    input.exec,
  );

  return {
    state: 'started',
    detail:
      `"${input.title}" handed to qBittorrent in category ${input.category}` +
      (bumped.exitCode === 0 ? ' and moved to the front of the queue.' : ' (could not change its queue position).'),
  };
}
