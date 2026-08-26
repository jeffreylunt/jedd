/**
 * NAMED READ-ONLY QUERIES against Dispatcharr's Postgres.
 *
 * ── 🔴 WHY A CLOSED ENUM AND NOT SQL THE MODEL WRITES ───────────────────────
 *
 * Dispatcharr's HTTP API answers 401 on everything these jobs need, so the data
 * is only reachable through `psql` inside the container — which runs on the
 * **privileged** ssh identity, the one where `isValidContainerName` is described
 * as "the entire defence".
 *
 * Model-composed SQL there is strictly worse than a model-composed path:
 * `DELETE`, `UPDATE` and `DROP` become *representable*. So the SQL is a literal
 * in this file and the model picks a NAME. Same principle as `method: 'GET'`
 * being a literal in `homelab-read.ts`: the dangerous thing is not blocked, it
 * is unrepresentable.
 *
 * ── 🔴 INTEGERS ONLY. A CHANNEL NAME NEVER REACHES SQL. ─────────────────────
 *
 * The one hole in any query below is a channel NUMBER, validated as an integer.
 * The job spec records why: *"ONE NAME PER CALL. Never `WHERE name IN (...)` —
 * Python repr leaked into SQL and crashed it 2026-08-14."*
 *
 * A caller holding a name maps it to a number against the roster `channel_health`
 * already fetches. **Escaping is a promise; a type constraint is a proof.**
 *
 * ── 🔴 EXPLICIT COLUMNS, NEVER `SELECT *` — TWO MEASURED CREDENTIAL CARRIERS ─
 *
 * Measured 2026-08-26 against the live database:
 *
 *  1. **`m3u_m3uaccount` has populated `username` and `password` columns** — 10
 *     characters each on all three live accounts. They are the IPTV provider
 *     login. A `SELECT *` on that table hands them over.
 *  2. **`dispatcharr_channels_stream.url` is Xtream format** —
 *     `http://znq234.live/live/<credential>/...` — so the secret is a PATH
 *     SEGMENT, not a querystring parameter.
 *
 * ⚠️ **`stripCredentials` cannot save us from either.** Its URL scrubber rewrites
 * querystring keys (`passkey=`, `apikey=`); a credential sitting in a path
 * segment matches nothing, and `username`/`password` only get caught if the
 * column is actually selected AND non-empty. **The column whitelist below is the
 * entire defence**, which is why no query here selects `*`, `url`, `username` or
 * `password`.
 */

export type QueryName = 'epg_coverage' | 'channel_profiles' | 'm3u_staleness' | 'channel_streams';

export const QUERY_NAMES: QueryName[] = [
  'epg_coverage',
  'channel_profiles',
  'm3u_staleness',
  'channel_streams',
];

interface QuerySpec {
  /** One line, for the tool's own output. */
  what: string;
  /** Needs a channel number. The ONLY parameter any query takes. */
  needsChannel: boolean;
  /** Builds the SQL. `channel` is already validated as an integer. */
  sql(channel: number): string;
  /**
   * 🔴 THE CONTROL. A query that silently returns nothing looks exactly like a
   * clean result, and this system keeps meeting that shape. When a query has a
   * row count it MUST produce for the answer to mean anything, it is asserted
   * here BEFORE the rows are interpreted.
   */
  control?: { minRows: number; why: string };
  /** What the numbers mean. Verdicts live in the OUTPUT, never the description. */
  note(rows: string[][]): string;
}

/** `docker exec` + psql, unaligned and pipe-separated — same shape as the roster. */
export function commandFor(name: QueryName, channel: number): string {
  const spec = QUERIES[name];
  // Single quotes inside the SQL are escaped for the shell's double-quoted
  // context; the only interpolated value is an integer, checked by the caller.
  const sql = spec.sql(channel).replace(/"/g, '\\"');
  return (
    "docker exec dispatcharr psql -U dispatch -d dispatcharr -At -F'|' -c " + `"${sql}"`
  );
}

export const QUERIES: Record<QueryName, QuerySpec> = {
  /**
   * Channels with no programme ending in the future.
   *
   * 🔴 THE TABLE IS `epg_programdata` AND THE COLUMN IS `end_time`. Verified
   * against `information_schema` on the live database, because the job specs
   * disagree with themselves here: there is **no** `dispatcharr_epg_programdata`
   * and **no** `stop_time`. A query naming either fails hard, which makes the
   * night's EPG result UNKNOWN rather than PASS — and a hard failure that reads
   * as a pass is the whole hazard.
   */
  epg_coverage: {
    what: 'channels with NO programme ending in the future',
    needsChannel: false,
    sql: () =>
      'select c.channel_number, c.name from dispatcharr_channels_channel c ' +
      'where not exists (select 1 from epg_programdata p ' +
      'where p.epg_id = c.epg_data_id and p.end_time > now()) ' +
      'order by c.channel_number',
    note: (rows) =>
      `${rows.length} channel(s) have no future EPG data.\n` +
      '⚠️ MOST OF THESE ARE NORMAL AND ESCALATING THEM IS PURE NOISE. The expected EPG-less set is ' +
      'the handful of baseline channels plus however many MLS/PPV slots exist right now — those are ' +
      'created per matchday and removed after, so their count moves and a remembered total is ' +
      'always wrong. Judge the RULE, never an arithmetic total: raise it only if a channel that is ' +
      'NOT baseline and NOT MLS/PPV and NOT the probe artifact appears, and name it.',
  },

  /**
   * How many channels sit on each stream profile.
   *
   * ⚠️ `Redirect` is the broken one — it returns a 302 and zero bytes where
   * `Proxy` streams. The channel row is authoritative for this field, not the
   * stream row.
   */
  channel_profiles: {
    what: 'channel count per stream profile',
    needsChannel: false,
    sql: () =>
      "select coalesce(sp.name, '(none)'), c.stream_profile_id, count(*) " +
      'from dispatcharr_channels_channel c ' +
      'left join core_streamprofile sp on sp.id = c.stream_profile_id ' +
      'group by 1, 2 order by 3 desc',
    note: () =>
      '⚠️ Do NOT judge this against a remembered total — the old "222 Proxy / 20 Redirect" figure is ' +
      'stale and the channel count moves with MLS/PPV. What matters is a LARGE unexplained drop ' +
      'against the last known-good reading, or a provider\'s channels vanishing.',
  },

  /**
   * When each provider account last refreshed a stream.
   *
   * 🔴 KEYED ON **STREAM** FRESHNESS, NEVER THE ACCOUNT ROW'S OWN `status` OR
   * `updated_at` — those are proven frozen and read as healthy forever.
   *
   * 🔴 `where a.server_url is not null` IS LOAD-BEARING, NOT TIDINESS. Account 1
   * is the local 'custom' account with no server URL and no streams; without
   * this it trips a NULL alarm permanently. Scope by the REASON (it has no
   * server) rather than by `id <> 1`, which would silently stop working if the
   * ids ever moved.
   */
  m3u_staleness: {
    what: 'per-account stream refresh age',
    needsChannel: false,
    sql: () =>
      'select a.id, a.name, max(s.updated_at), ' +
      'round(extract(epoch from (now() - max(s.updated_at))) / 3600, 1), count(s.id) ' +
      'from m3u_m3uaccount a ' +
      'left join dispatcharr_channels_stream s on s.m3u_account_id = a.id ' +
      'where a.server_url is not null ' +
      'group by a.id, a.name order by a.id',
    control: {
      minRows: 3,
      why:
        'three provider accounts have a server_url (2, 3 and 4). Fewer rows than that means the ' +
        'query did not see what it was meant to see, and a short result here is INDISTINGUISHABLE ' +
        'from a healthy one',
    },
    note: (rows) => {
      const stale = rows.filter((r) => Number(r[3]) > 30);
      const never = rows.filter((r) => !r[2]);
      const lines: string[] = [];
      if (never.length) {
        lines.push(
          `🔴 ${never.length} account(s) have NEVER refreshed a stream — a much louder signal than ` +
            'a stale one, and a different fault.',
        );
      }
      lines.push(
        stale.length
          ? `🔴 ${stale.length} account(s) older than 30 hours.`
          : 'All accounts refreshed within 30 hours.',
      );
      return lines.join('\n');
    },
  },

  /**
   * Which provider accounts serve one channel, and whether their rows are stale.
   *
   * ⚠️ `order` is a RESERVED WORD in Postgres and must be quoted. Measured — the
   * unquoted form is a syntax error, which is the good failure, but a silent one
   * would not have been.
   *
   * ⚠️ `s.url` is deliberately ABSENT. It is Xtream format with the account
   * credential in the path, and no redactor in this repo can see a secret that
   * is a path segment rather than a query parameter.
   */
  channel_streams: {
    what: 'which provider accounts serve one channel',
    needsChannel: true,
    sql: (channel) =>
      'select c.channel_number, c.name, s.m3u_account_id, s.is_stale, s.last_seen, cs."order" ' +
      'from dispatcharr_channels_channel c ' +
      'join dispatcharr_channels_channelstream cs on cs.channel_id = c.id ' +
      'join dispatcharr_channels_stream s on s.id = cs.stream_id ' +
      `where c.channel_number = ${channel} ` +
      'order by cs."order"',
    note: (rows) => {
      const accounts = [...new Set(rows.map((r) => r[2]))].filter(Boolean);
      const stale = rows.filter((r) => r[3] === 't');
      return (
        `Served by ${accounts.length} account(s): ${accounts.join(', ') || '(none)'}. ` +
        `${stale.length} of ${rows.length} row(s) marked stale.\n` +
        '🔴 FAILING ON ONE ACCOUNT IS NOT A REASON TO SWAP. Live accounts are 2, 3 and 4 (account 1 ' +
        'is local and has no streams), and failover covers a single-account failure — the check ' +
        'script only ever probes account 3, so "it failed on account 3" is true BY CONSTRUCTION and ' +
        'is not a finding. A swap needs the channel to fail on ALL THREE.\n' +
        '⚠️ Judge staleness from THIS row, never from the channel\'s display name — legacy suffixes ' +
        'persist on channels already remapped to healthy streams, and reading the name gives a ' +
        'confident wrong answer that causes needless swaps.'
      );
    },
  },
};

/** Split `-At -F'|'` output into rows. Blank lines dropped, nothing else touched. */
export function parseRows(stdout: string): string[][] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split('|'));
}

/**
 * A channel number, or the refusal text.
 *
 * 🔴 THIS IS THE ONLY VALUE THAT REACHES SQL, so it is the only thing standing
 * between a model and the privileged identity. Integer or nothing.
 */
export function asChannelNumber(v: unknown): number | string {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  return (
    'That query needs `channel_number` as a whole number, and it is the only value that ever ' +
    `reaches the database — got ${JSON.stringify(v)}. A channel NAME is deliberately not accepted: ` +
    'run this tool without a query to get the roster, read the number off it, and pass that.'
  );
}
