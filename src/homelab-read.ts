import type { Config } from './config.js';
import type { Role } from './permissions.js';

/**
 * THE GENERIC READ — the gate and the bound, as pure functions.
 *
 * ── 🔴 WHY THIS FILE LOOKS NOTHING LIKE `command-gate.ts` ────────────────────
 *
 * `command-gate.ts` parses a shell string character by character, unpicking
 * flag clusters and quoting, because **the model composes the command text
 * there** and the only defence is to read what it wrote. That fight is
 * unwinnable in principle and merely survivable in practice.
 *
 * Here the model composes NOTHING that reaches a transport. It names a
 * `service` from a closed enum, a `path`, and a `query` object. So:
 *
 *  - **The method is GET by construction.** It is a literal in the fetch call.
 *    There is no argument that can make it anything else, so no write endpoint
 *    is reachable no matter what path is passed — `DELETE /series/{id}` is not
 *    "blocked", it is unrepresentable.
 *  - **The host is allowlisted by construction.** The base URL comes from
 *    `config`, selected by the enum. A path cannot name a host, and the two
 *    forms that could — a scheme (`http://…`) and a protocol-relative `//host` —
 *    are refused below rather than being relied on to fail harmlessly.
 *  - **The credential is chosen by code**, never named by the caller. There is
 *    no way to point Jellyfin's token at somebody else's server.
 *
 * **Do not add a `method` parameter. Do not add a `url` parameter.** Both convert
 * this file from a lookup table into a parser, and the parser is the thing we
 * are deliberately not building.
 */

export type ReadService = 'jellyfin' | 'sonarr' | 'radarr' | 'prowlarr' | 'qbittorrent';

/**
 * 🔴 WHY THIS ENUM IS FOUR AND NOT SEVEN. Measured 2026-08-25, not assumed.
 *
 * The survey's rule is *"generic GET is right where the API is uniform and
 * honest"*. Two homelab services are neither, and half-adding them would ship a
 * capability that fails after the model has offered it:
 *
 *  - **qBittorrent WAS excluded and is now INCLUDED (2026-08-26).** The original
 *    reason was that `config.qbittorrent.baseUrl` is `172.20.0.1:8080`, the
 *    docker bridge gateway, reachable only from hp — so this needed "a SECOND
 *    url for a second transport", which was left as a decision rather than
 *    guessed. That decision has now been taken: `config.qbittorrent.lanUrl`
 *    exists, the two fields are named for their TRANSPORT (hp-side vs Mac-side)
 *    rather than competing for one truth, and the LAN address is measured
 *    working unauthenticated — `/torrents/info` returns all 121 torrents in
 *    7 ms. It needs no credential at all: `bypass_local_auth=true`.
 *  - **Dispatcharr is EXCLUDED because its API is closed to us.** Everything
 *    except `/api/core/version/` (37 B, already reported by `livetv_status`)
 *    returns 401, and the one open read, `/output/epg`, is 10.3 MB of XML.
 *    `channel_health` gets that data from its database instead.
 */
interface ServiceSpec {
  label: string;
  baseUrl(config: Config): string;
  /** The credential header, chosen by code. Empty when the service needs none. */
  auth(config: Config): Record<string, string>;
  /** Present when the service cannot be read at all, e.g. no API key configured. */
  unconfigured(config: Config): string | null;
  /** SECRET — denied to EVERYONE. No role is consulted. */
  secret: DeniedPath[];
  /** PERSON — denied to guests, allowed to the owner. */
  person: DeniedPath[];
  /** Operationally harmful regardless of what it returns. Denied to everyone. */
  operational: DeniedPath[];
}

interface DeniedPath {
  /** Lower-cased path prefix. Matched against the lower-cased request path. */
  prefix: string;
  why: string;
  /**
   * Match this path EXACTLY rather than its whole subtree.
   *
   * ⚠️ Exists for `/System/Info`, whose narrower sibling `/System/Info/Public` is
   * the endpoint we actually want people using. A subtree deny would take both
   * and leave no way to ask "is the server up".
   */
  exact?: boolean;
  /**
   * What KIND of thing this is, for the refusal the user reads. Defaults to
   * PERSONAL.
   *
   * 🔴 The refusal text is user-visible, so it has to be TRUE. `/System/Info` is
   * denied to guests and is not about a person at all — labelling it PERSONAL
   * would have the model relay a false reason, and a denylist whose stated
   * reasons drift from its actual rule stops being extensible by anyone.
   */
  headline?: string;
}

/**
 * 🔴 A DENYLIST, NOT AN ALLOWLIST, AND THE CHOICE IS THE WHOLE POINT.
 *
 * A path allowlist rebuilds exactly the failure this tool exists to remove:
 * *"nobody wrote that verb"*. It answered the questions we thought of in
 * advance, and the Seinfeld defect was a question we had not
 * (`/episode?seriesId=80&seasonNumber=2` — a plain GET nobody had authored).
 *
 * So: **allow by default.** The denylist is small on purpose and it has a RULE,
 * which is what makes it extensible by someone who was not here:
 *
 *   ⚠️ **DENY ANYTHING THAT MAKES JELLYFIN TALK TO THE TUNER, OR AN ARR TALK TO
 *   AN INDEXER.**
 *
 * Both classes are *cheap-looking GETs with side effects*, and that is why no
 * amount of response-size bounding catches them:
 *
 *  - `/LiveTv/Channels` iterates the tuner. Against a HEALTHY tuner it answers
 *    from cache in 0.42 s and logs nothing — measured twice. Against a DEAD one
 *    it wedged Jellyfin site-wide for hours on 2026-07-26. **It is fast right up
 *    until it is catastrophic, and a dead tuner is precisely the state someone
 *    is in when they ask about live TV.** So the rule is "never call it", not
 *    "call it when the tuner is up".
 *  - An arr's `/release` and Prowlarr's `/api/v1/search` run a LIVE indexer
 *    search on GET: 20.9 s measured warm, 35-45 s cold, and they consume the
 *    indexer rate limits that Sonarr's and Radarr's `/health` are already
 *    complaining about. A read that costs half a minute and can disable an
 *    indexer is not a read.
 *
 * ⚠️ Prefix-matched and lower-cased, so `/LiveTv/Channels/{id}` and
 * `/livetv/channels` are both refused. `/LiveTv/Programs`, `/LiveTv/GuideInfo`
 * and `/Search/Hints` are NOT denied and must not be: measured against
 * Jellyfin's own log, they produce **zero** tuner, HDHomerun, guide or stream
 * lines, and `/Search/Hints` returns `ChannelId` itself so the channel join
 * needs no enumeration at all.
 */
/**
 * 🔴 THREE CLASSES OF DATA, IMPLEMENTED THREE DIFFERENT WAYS ON PURPOSE.
 *
 * Jeff, 2026-08-25: *"All users should have read access to everything in the
 * library, etc, but not other users information or server secrets"*, then:
 * *"Owner can ask about all information, but not secrets or keys since we don't
 * want them in message logs."*
 *
 * | class   | guest | owner |
 * |---------|-------|-------|
 * | CONTENT | ✅    | ✅    |
 * | PERSON  | ❌    | ✅    |
 * | SECRET  | ❌    | ❌ nobody |
 *
 * The boundary is a RULE about **what the data is about**, not about who is
 * asking — which is what makes it extensible by someone who was not here:
 *
 *   ⚠️ **ALLOW anything about the CONTENT. DENY anything about a PERSON or a
 *   SECRET.**
 *
 * ── 🔴 WHY SECRET TAKES NO ROLE ARGUMENT, AND WHY THAT MATTERS ───────────────
 *
 * The owner is denied secrets too, and the reason is **not** trust — it is that
 * a secret in a Jedd reply does not stop at the screen. It lands in the iMessage
 * thread, in the replayed history, and in `data/jedd.log`. **Reading it once
 * persists it in three places, none of which anyone will remember to clean.**
 *
 * So `secretVerdict` **does not take a role parameter at all**. It cannot
 * consult one, cannot be widened by a role bug, a spoofed handle, or a future
 * refactor of who counts as owner — there is no code path to get it wrong. That
 * is the same principle as `method: 'GET'` being a literal: the strongest guard
 * on the highest-consequence class is enforced by construction, not by a check.
 *
 * `personVerdict` IS role-gated, and that is the weakest guard here. It is
 * acceptable only because the consequence is a privacy slip between household
 * members rather than a credential leak. Do not move anything from SECRET to
 * PERSON to make it convenient for the owner.
 */
const TUNER_WHY =
  'it enumerates Jellyfin channels/tuners. That call wedged Jellyfin site-wide for hours on ' +
  '2026-07-26 against a dead tuner — and a dead tuner is exactly the state someone is in when they ' +
  'ask about live TV. Use /Search/Hints?searchTerm=…&includeItemTypes=LiveTvProgram instead: it ' +
  'returns ChannelId and ChannelName itself, so you never need the channel list. For per-channel ' +
  'health use channel_health, which reads a results file and never touches a stream.';

const INDEXER_WHY =
  'a GET here runs a LIVE indexer search — 20.9 s measured, 35-45 s cold — and burns the indexer ' +
  'rate limits that Sonarr and Radarr are already reporting as unhealthy. It looks like a cheap read ' +
  'and is not. Use search_episode, which is the curated verb for finding a release.';

/**
 * SECRET paths, denied to EVERYONE. Every arr entry below was MEASURED on
 * 2026-08-25 — none of it is precautionary.
 *
 * ⚠️ `/config/host` on **both** Sonarr and Radarr returns a populated
 * `password` (44 chars) and `apiKey` (32 chars) on a plain GET. Nothing about
 * the path suggests danger; it reads like "server settings".
 */
const ARR_SECRET_PATHS: DeniedPath[] = [
  {
    prefix: '/config',
    why:
      'the arr config surface returns credentials on a plain GET — MEASURED: /config/host on both ' +
      'Sonarr and Radarr hands back a 44-character password and a 32-character apiKey. Nothing about ' +
      'the path warns you.',
  },
  {
    prefix: '/downloadclient',
    why: 'it carries the download client password inside its `fields` array (MEASURED on Sonarr).',
  },
  {
    /**
     * 🔴 DENIED ON ALL THREE, INCLUDING PROWLARR, AND THIS IS A DELIBERATE STEP
     * BEYOND WHAT THE MEASUREMENT ALONE SHOWED.
     *
     * Measured: Sonarr `/indexer` carries **4** populated `apiKey` values and
     * Radarr **3**, all inside `fields[]` as `{name, value}` pairs. Prowlarr's
     * `/api/v1/indexer` came back **clean** — but only because all six of its
     * indexers happen to be PUBLIC trackers today. **That is a fact about the
     * current tracker list, not a property of the endpoint**, and it becomes
     * false the moment one private tracker is added, silently.
     *
     * ⚠️ It costs nothing, and that is why it is worth doing: indexer HEALTH is
     * `/indexerstatus` and `/indexerstats`, which are DIFFERENT path segments
     * and stay allowed. Segment matching is what makes over-denying cheap here
     * — the same property that keeps `/releaseprofile` readable.
     */
    prefix: '/indexer',
    why:
      'indexer definitions carry tracker credentials in their `fields` array — MEASURED: 4 populated ' +
      'apiKey values on Sonarr, 3 on Radarr. Indexer HEALTH is a different path and is allowed: use ' +
      '/indexerstatus (which lists only the broken ones) or /indexerstats.',
  },
  { prefix: '/notification', why: 'notification connections carry webhook URLs, tokens and passwords.' },
  { prefix: '/importlist', why: 'import lists carry credentials for the services they pull from.' },
  {
    prefix: '/applications',
    why:
      "Prowlarr's application links carry the API keys of the apps they sync to — MEASURED: 2 " +
      'populated apiKey values, which are Sonarr’s and Radarr’s own keys.',
  },
  { prefix: '/settings', why: 'the settings surface is where credentials live.' },
  { prefix: '/system/backup', why: 'a backup contains the whole configuration database, credentials included.' },
];

/**
 * 🔴 `/Auth/Keys` IS THE ONE TO KNOW ABOUT, and it was not on anyone's list.
 *
 * MEASURED 2026-08-25: `GET /Auth/Keys` returns **four live 32-character
 * `AccessToken` values** — Jellyfin API keys, in plaintext, from a read that
 * looks like administrative housekeeping. This is the single most dangerous
 * endpoint found on any of the four services.
 */
const JELLYFIN_SECRET_PATHS: DeniedPath[] = [
  {
    prefix: '/auth',
    why:
      'it hands back live API keys — MEASURED: /Auth/Keys returns four 32-character AccessToken ' +
      'values in plaintext. The whole /Auth subtree is denied rather than just that one path.',
  },
  { prefix: '/quickconnect', why: 'it is an authentication flow and deals in tokens.' },
  { prefix: '/system/configuration', why: 'the server configuration surface is where credentials live.' },
  {
    prefix: '/plugins',
    why:
      'plugin configuration holds the credentials each plugin uses — the Xtream plugin in particular ' +
      'holds the IPTV provider login. The plugin LIST is denied with the rest of the subtree rather ' +
      'than carved out.',
  },
  { prefix: '/startup', why: 'the setup wizard creates accounts and sets passwords.' },
  { prefix: '/system/logs', why: 'log files quote request URLs, which carry tokens and API keys.' },
  {
    prefix: '/livetv/listingproviders',
    why: 'listing providers store the IPTV provider username and password.',
  },
];

/**
 * PERSON paths — who watched what, who logged in, from where, and who has an
 * account. Denied to guests, allowed to the owner.
 *
 * ⚠️ NOT `/Persons`. That is Jellyfin's endpoint for CAST MEMBERS — actors in
 * the library — and it is CONTENT. Matching is by segment, so `/users` does not
 * touch it; do not "tidy" these into a `/person*` pattern.
 */
const JELLYFIN_PERSON_PATHS: DeniedPath[] = [
  { prefix: '/sessions', why: 'it shows who is watching what, right now, and on which device.' },
  {
    prefix: '/users',
    why:
      'it lists every account with their last login and last activity — MEASURED: 19 real people, by ' +
      'name. This also covers /Users/{id}/Items, which carries that user’s own watch state; search ' +
      'the library with /Items instead, which is not scoped to a person.',
  },
  { prefix: '/devices', why: 'it maps devices to the people who last used them.' },
  { prefix: '/system/activitylog', why: 'it is a log of who did what and when, by name.' },
  {
    prefix: '/user_usage_stats',
    why: 'the Playback Reporting plugin reports per-user viewing history.',
  },
  /**
   * 🔴 SERVER TOPOLOGY — the class the CONTENT/PERSON/SECRET rule does not
   * obviously catch, which is exactly why it needed deciding rather than
   * inferring.
   *
   * `/System/Info` carries `CachePath`, `LogPath`, `ProgramDataPath`,
   * `InternalMetadataPath`, `TranscodingTempPath`, `WebPath`, `LocalAddress` and
   * the server `Id`. None of that is a credential and none of it is about a
   * person, so the rule allows it — and it is still strictly more than the
   * retired `homelab_status` ever showed, which was version and server name.
   *
   * ⚠️ **The replacement must not show more than the thing it replaced.**
   * `/System/Info/Public` is seven keys and answers "is the server up" exactly,
   * so `exact: true` keeps that sibling open while closing this one.
   */
  {
    prefix: '/system/info',
    exact: true,
    headline: 'SERVER INTERNALS: it is about the server\'s own layout, not about the library',
    why:
      'it lists filesystem paths, the LAN address and the server id. Use /System/Info/Public instead ' +
      '— it answers "is the server up and what version" and nothing else.',
  },
];

const SERVICES: Record<ReadService, ServiceSpec> = {
  jellyfin: {
    label: 'Jellyfin',
    baseUrl: (c) => c.jellyfin.baseUrl,
    auth: (c) => ({ 'X-Emby-Token': c.jellyfin.apiKey }),
    unconfigured: (c) => (c.jellyfin.apiKey ? null : 'JELLYFIN_API_KEY is not configured'),
    secret: JELLYFIN_SECRET_PATHS,
    person: JELLYFIN_PERSON_PATHS,
    operational: [
      { prefix: '/livetv/channels', why: TUNER_WHY },
      { prefix: '/livetv/tuners', why: TUNER_WHY },
      { prefix: '/livetv/tunerhosts', why: TUNER_WHY },
      /**
       * ⚠️ BOTH spellings, listed in full, because matching is by PATH SEGMENT
       * and not by raw string prefix — `/livetv/channelmapping` does not match
       * `/livetv/channelmappings`.
       *
       * Segment matching is the right rule and this is the price of it. A raw
       * prefix would also deny Sonarr's `/releaseprofile`, a harmless config
       * read, off the back of the `/release` ban — silently removing a
       * capability that has nothing to do with indexers. Over-denying is not
       * free just because it is the cautious direction: it rebuilds "nobody
       * wrote that verb" one endpoint at a time.
       */
      { prefix: '/livetv/channelmappings', why: TUNER_WHY },
      { prefix: '/livetv/channelmappingoptions', why: TUNER_WHY },
    ],
  },
  sonarr: {
    label: 'Sonarr',
    baseUrl: (c) => c.sonarr.baseUrl,
    auth: (c) => ({ 'X-Api-Key': c.sonarr.apiKey }),
    unconfigured: (c) => (c.sonarr.apiKey ? null : 'SONARR_API_KEY is not configured'),
    secret: ARR_SECRET_PATHS,
    // ⚠️ An arr has no PERSON surface: /history records what was grabbed and
    // when, with NO requester field — verified over 30 real rows. It is content.
    person: [],
    operational: [{ prefix: '/release', why: INDEXER_WHY }],
  },
  radarr: {
    label: 'Radarr',
    baseUrl: (c) => c.radarr.baseUrl,
    auth: (c) => ({ 'X-Api-Key': c.radarr.apiKey }),
    unconfigured: (c) => (c.radarr.apiKey ? null : 'RADARR_API_KEY is not configured'),
    secret: ARR_SECRET_PATHS,
    // ⚠️ An arr has no PERSON surface: /history records what was grabbed and
    // when, with NO requester field — verified over 30 real rows. It is content.
    person: [],
    operational: [{ prefix: '/release', why: INDEXER_WHY }],
  },
  /**
   * 🔴 NO CREDENTIAL, AND THAT IS NOT AN OVERSIGHT. qBittorrent has
   * `bypass_local_auth=true` with `bypass_auth_subnet_whitelist=0.0.0.0/0`, so
   * it accepts unauthenticated reads from the LAN. There is no header to send.
   *
   * ⚠️ That is also a standing security finding in the homelab space, not a
   * property to rely on. This tool adds a READER to an endpoint that was already
   * open; it does not widen the exposure. If auth is ever turned on, this spec
   * needs a credential and will start returning 403 until it gets one.
   */
  qbittorrent: {
    label: 'qBittorrent',
    baseUrl: (c) => c.qbittorrent.lanUrl,
    auth: () => ({}),
    unconfigured: (c) => (c.qbittorrent.lanUrl ? null : 'QBITTORRENT_LAN_URL is not configured'),
    secret: [
      {
        /**
         * MEASURED 2026-08-26: 223 preference keys, 17 credential-shaped —
         * `proxy_password`, `dyndns_password`, `mail_notification_password`,
         * `web_ui_api_key`, `web_ui_https_key_path`, plus `web_ui_username`
         * ("admin") and the auth posture itself (`bypass_local_auth`,
         * `bypass_auth_subnet_whitelist`).
         *
         * 🔴 EVERY PASSWORD FIELD IS EMPTY TODAY, AND THAT IS EXACTLY WHY IT IS
         * DENIED. That is a fact about the current configuration, not about the
         * endpoint — the same reasoning that denies Prowlarr's `/indexer` while
         * its trackers happen to be public. And the credential stripper does NOT
         * cover it: it skips empty values by design, and `web_ui_username` and
         * the whitelist are not credential-NAMED at all.
         */
        prefix: '/api/v2/app/preferences',
        why:
          'it returns the whole configuration including proxy, dyndns and mail credentials, the ' +
          'WebUI username and API key, and the authentication posture — MEASURED: 17 ' +
          'credential-shaped keys of 223. They are empty today; that is a fact about this box ' +
          'right now, not about the endpoint.',
      },
      {
        /**
         * The classic passkey carrier for a private tracker. Public trackers
         * today, same "fact about today" argument as above. The stripper's
         * `scrubUrl` is the backstop for tracker URLs that appear in
         * `/torrents/info`, which is allowed because that field is the same data
         * — denying one and allowing the other would be theatre.
         */
        prefix: '/api/v2/rss',
        why:
          'RSS feed URLs are where a private tracker puts its passkey. Nothing else here needs ' +
          'them.',
      },
    ],
    // A torrent client knows what is being downloaded. It does not know WHO
    // asked for it — there is no per-user field anywhere in the 66 a torrent
    // carries. Content, not people.
    person: [],
    /**
     * ⚠️ EMPTY, AND THE REASON IS STRUCTURAL. qBittorrent's v2 API does every
     * mutating action over POST — `torrents/delete`, `torrents/pause`,
     * `app/setPreferences`, `torrents/topPrio`. The method here is a GET
     * literal, so none of them is reachable and none needs denying. Unlike the
     * arrs, there is no cheap-looking GET with a side effect to guard against.
     */
    operational: [],
  },
  prowlarr: {
    label: 'Prowlarr',
    baseUrl: (c) => c.prowlarr.baseUrl,
    auth: (c) => ({ 'X-Api-Key': c.prowlarr.apiKey }),
    unconfigured: (c) => (c.prowlarr.apiKey ? null : 'PROWLARR_API_KEY is not configured'),
    // Prowlarr has no path prefix, so its SECRET paths sit under /api/v1.
    secret: ARR_SECRET_PATHS.map((d) => ({ ...d, prefix: `/api/v1${d.prefix}` })),
    person: [],
    operational: [{ prefix: '/api/v1/search', why: INDEXER_WHY }],
  },
};

export const READ_SERVICES = Object.keys(SERVICES) as ReadService[];

export type ReadPlan =
  | { allowed: true; service: ReadService; label: string; url: string; headers: Record<string, string> }
  | { allowed: false; reason: string };

/**
 * Characters a path may contain. Deliberately narrow — every real endpoint on
 * these four services is ASCII words, slashes, dots, hyphens and the occasional
 * hex GUID. Anything else is refused with the character named, rather than being
 * silently encoded into something that means a different thing.
 *
 * 🔴 `%` IS NOT IN THIS SET, AND ITS ABSENCE IS LOAD-BEARING.
 *
 * `/LiveTv/%43hannels` is `/LiveTv/Channels` to Jellyfin and to the arrs — they
 * percent-decode the path before matching a route — but it is NOT `/livetv/channels`
 * to any string comparison, and `new URL` deliberately leaves `%43` alone, so
 * normalising first does not catch it either. `%2e%2e` is worse: it is a
 * dot-segment to the URL parser, so `/%2e%2e/%2e%2e/%2e%2e/release` climbs out
 * from under `/sonarr/api/v3` while still carrying the API key.
 *
 * Percent-escapes are never NEEDED here: search terms and dates go in `query`,
 * which encodes them properly, and the only path-embedded identifiers on these
 * services are hex GUIDs and integers. So the whole class is refused rather than
 * decoded — and the refusal names the character.
 */
const PATH_CHARS = /^[A-Za-z0-9/._~()@:,+-]+$/;

/**
 * Turn a (service, path, query) triple into the exact GET this tool will issue,
 * or explain the refusal.
 *
 * Pure: it performs no I/O and returns a value. The tool does the fetch, so a
 * test can assert on the URL a refused call would have produced — and, more
 * importantly, that a refused call produced no URL at all.
 */
/** Does `routed` fall under any of these prefixes? Returns the reason, or null. */
function matchDeny(rules: DeniedPath[], routed: string): DeniedPath | null {
  for (const rule of rules) {
    if (routed === rule.prefix) return rule;
    if (!rule.exact && routed.startsWith(`${rule.prefix}/`)) return rule;
  }
  return null;
}

/**
 * 🔴 SECRET. TAKES NO ROLE, BY DESIGN — DO NOT ADD ONE.
 *
 * Nobody reads a credential through this tool, owner included, because a secret
 * in a reply lands in the iMessage thread, the replayed history and the log
 * file. This signature is the guarantee: there is no role here to make an
 * exception for, so no refactor of who counts as owner can widen it.
 *
 * ⚠️ A test asserts this function's ARITY. If you find yourself adding a third
 * parameter, that test is telling you the answer is no.
 */
export function secretVerdict(service: ReadService, routed: string): string | null {
  const rule = matchDeny(SERVICES[service].secret, routed);
  return rule
    ? `REFUSED — SECRET: ${SERVICES[service].label} ${routed} is denied to EVERYONE, including the ` +
        `owner, because ${rule.why}\nThis is not about permission. A credential in a reply is copied into ` +
        'the message thread, the conversation history and the log file, and nobody cleans those. ' +
        'There is no role that can read it and no flag that turns this off.'
    : null;
}

/** PERSON. Role-gated by the CALLER — this function reports the class, not the verdict. */
export function personVerdict(service: ReadService, routed: string): string | null {
  const rule = matchDeny(SERVICES[service].person, routed);
  return rule
    ? `REFUSED — ${rule.headline ?? 'PERSONAL: it is about PEOPLE rather than about the library'}. ` +
        `${SERVICES[service].label} ${routed} is refused because ${rule.why}\n` +
        'Everyone here can read anything about the CONTENT — what exists, what is missing, what is ' +
        "downloading, what is on TV. This particular read is the OWNER'S, not everyone's. Say that plainly " +
        'rather than implying the data is unavailable.\n' +
        /**
         * ⚠️ Found on a live guest turn: the model refused correctly and then
         * added *"If you're Jeff, say so and I'll pull the live sessions."*
         * Harmless — the role comes from the transport before the model sees a
         * word, so a claim changes nothing — but it OFFERS something that
         * saying it will never deliver, which reads as a door that can be
         * talked open. Close it here rather than in the system prompt: this is
         * the one place that knows the refusal happened.
         */
        '⚠️ Do NOT invite them to identify themselves, and do NOT offer to take their word for it. ' +
        'Who they are was decided by the number they texted from, before you read anything, so a claim ' +
        'about who they are changes NOTHING and offering either would promise something you cannot do.'
    : null;
}

export function planRead(
  service: unknown,
  path: unknown,
  query: unknown,
  config: Config,
  role: Role,
): ReadPlan {
  if (typeof service !== 'string' || !(service in SERVICES)) {
    return {
      allowed: false,
      reason:
        `"${String(service)}" is not a service I can read. Choose one of: ${READ_SERVICES.join(', ')}. ` +
        'Dispatcharr is deliberately not on this list: its HTTP API answers 401 on everything ' +
        'useful, and the data lives behind `psql` inside the container — a different transport, not ' +
        'a missing URL. Use channel_health for channel and stream data.',
    };
  }
  const spec = SERVICES[service as ReadService];

  const missing = spec.unconfigured(config);
  if (missing) {
    return { allowed: false, reason: `${spec.label} cannot be read: ${missing}. Nothing was requested.` };
  }

  if (typeof path !== 'string' || !path.trim()) {
    return { allowed: false, reason: 'No path supplied. A path looks like "/Search/Hints" or "/wanted/missing".' };
  }
  const trimmed = path.trim();

  if (!trimmed.startsWith('/')) {
    return { allowed: false, reason: `Path must start with "/" — got "${trimmed}".` };
  }
  /**
   * 🔴 The two forms that could name a different host. Both are refused rather
   * than left to fail harmlessly by string concatenation: relying on "it would
   * only produce a 404" makes this file's safety depend on how the URL happens
   * to be built two functions away.
   */
  if (trimmed.includes('://') || trimmed.startsWith('//')) {
    return {
      allowed: false,
      reason:
        `Path may not name a host — got "${trimmed}". The host comes from \`service\`; the path is ` +
        'only the endpoint under it.',
    };
  }
  if (trimmed.includes('?') || trimmed.includes('#')) {
    return {
      allowed: false,
      reason:
        `Path may not contain "?" or "#" — got "${trimmed}". Put querystring parameters in the ` +
        '`query` object instead, e.g. {"searchTerm": "Crystal Palace", "limit": 20}.',
    };
  }
  if (!PATH_CHARS.test(trimmed)) {
    const bad = [...trimmed].find((ch) => !PATH_CHARS.test(ch)) ?? '';
    return {
      allowed: false,
      reason:
        `Path contains a character I will not send: ${JSON.stringify(bad)} in "${trimmed}". ` +
        'Search terms, dates and ids with punctuation belong in `query`, which encodes them for you.',
    };
  }

  const base = spec.baseUrl(config).replace(/\/$/, '');
  let baseUrl: URL;
  let target: URL;
  try {
    baseUrl = new URL(base);
    target = new URL(`${base}${trimmed}`);
  } catch {
    return { allowed: false, reason: `Could not form a URL from ${spec.label}'s base and "${trimmed}".` };
  }

  /**
   * 🔴 MATCH WHAT THE SERVER WILL ROUTE ON, NOT WHAT THE CALLER TYPED.
   *
   * Found by review and reproduced against the live gate: matching the raw
   * string let **every** denylist member through by inserting a dot-segment.
   *
   *   `/./LiveTv/Channels`  → fetch sends `/jellyfin/LiveTv/Channels`
   *   `/LiveTv/./Channels`  → the same
   *   `/api/v1/./search`    → the 20.9 s indexer search, on all three arrs
   *
   * `fetch` hands the URL to the WHATWG parser, which removes single-dot
   * segments and resolves double-dot ones before a byte goes out. So the string
   * the denylist inspected and the string the server received were never
   * required to be the same string, and a guard over the first is a guard over
   * nothing.
   *
   * Normalising FIRST also retires the old `..` guard entirely: a `..` that
   * climbs out of the base path now fails the containment check below, which is
   * a property of the resulting URL rather than a pattern someone remembered to
   * look for.
   */
  if (target.origin !== baseUrl.origin) {
    return {
      allowed: false,
      reason: `Path may not name a host — "${trimmed}" resolves to ${target.origin}, not ${baseUrl.origin}.`,
    };
  }
  const basePath = baseUrl.pathname.replace(/\/$/, '');
  if (basePath && target.pathname !== basePath && !target.pathname.startsWith(`${basePath}/`)) {
    return {
      allowed: false,
      reason:
        `Path escapes ${spec.label}'s API prefix — "${trimmed}" resolves to "${target.pathname}", ` +
        `which is outside "${basePath}".`,
    };
  }

  // The path RELATIVE to the API prefix, normalised — the form the denylists are
  // written in, and the form the service's own router sees.
  const routed = target.pathname.slice(basePath.length).toLowerCase();

  /**
   * 🔴 SECRET FIRST, AND WITHOUT THE ROLE.
   *
   * `role` is in scope here, and `secretVerdict` still does not receive it —
   * it takes `(service, routed)` and nothing else, so no future edit inside it
   * can accidentally make an exception for the owner. Denying the highest-
   * consequence class is the one decision that must not depend on getting
   * identity right.
   */
  const secret = secretVerdict(service as ReadService, routed);
  if (secret) return { allowed: false, reason: secret };

  const operational = matchDeny(spec.operational, routed);
  if (operational) {
    return {
      allowed: false,
      reason: `REFUSED: ${spec.label} ${target.pathname} is not readable through this tool, because ${operational.why}`,
    };
  }

  // PERSON — the only tier that consults who is asking, and the weakest guard
  // here. Acceptable because the consequence is a privacy slip between household
  // members, not a credential leak.
  if (role !== 'owner') {
    const person = personVerdict(service as ReadService, routed);
    if (person) return { allowed: false, reason: person };
  }

  const qs = buildQuery(query);
  if ('error' in qs) return { allowed: false, reason: qs.error };

  return {
    allowed: true,
    service: service as ReadService,
    label: spec.label,
    url: `${target.origin}${target.pathname}${qs.value ? `?${qs.value}` : ''}`,
    headers: { Accept: 'application/json', ...spec.auth(config) },
  };
}

/**
 * The query object → a querystring.
 *
 * Arrays are joined with commas because that is what these servers actually
 * want (`fields=Overview,ChannelInfo`, `includeItemTypes=Movie,Series`), and a
 * model that writes `["Overview","ChannelInfo"]` means the same thing. Nested
 * objects are refused: there is no encoding of them that any of these four
 * services reads, so accepting one would send something meaningless and get a
 * plausible-looking wrong answer back.
 */
/**
 * 🔴 A CREDENTIAL IS NEVER THE CALLER'S TO NAME — INCLUDING THROUGH `query`.
 *
 * Jellyfin accepts `?api_key=` and the arrs accept `?apikey=`, both equivalent to
 * the header this file chooses. Leaving that door open meant "the credential is
 * chosen by code" was true of the HEADERS and false of the request, and it also
 * put a caller-supplied secret-shaped string into the transcript, since the tool
 * echoes the URL it issued.
 */
const CREDENTIAL_KEYS = new Set(['api_key', 'apikey', 'token', 'apitoken', 'x-emby-token', 'x-api-key']);

function buildQuery(query: unknown): { value: string } | { error: string } {
  if (query === undefined || query === null) return { value: '' };
  if (typeof query !== 'object' || Array.isArray(query)) {
    return { error: '`query` must be an object of parameters, e.g. {"limit": 20}.' };
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (CREDENTIAL_KEYS.has(key.toLowerCase())) {
      return {
        error:
          `query.${key} names a credential. The credential is chosen by code from \`service\` and is ` +
          'never yours to supply — remove it and the request will be authenticated correctly.',
      };
    }
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (!value.every(isScalar)) return { error: `query.${key} is an array containing non-scalar values.` };
      params.append(key, value.map(String).join(','));
      continue;
    }
    if (!isScalar(value)) {
      return {
        error:
          `query.${key} is a ${typeof value}. Query parameters must be strings, numbers, booleans, or ` +
          'arrays of those.',
      };
    }
    params.append(key, String(value));
  }
  return { value: params.toString() };
}

function isScalar(v: unknown): boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SECOND GUARD — strip credentials from every response, whatever the path
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 🔴 THE BRACES TO THE DENYLIST'S BELT, AND NEITHER IS SUFFICIENT ALONE.
 *
 * **A path denylist only blocks what somebody thought to block.** A credential
 * can surface from an endpoint nobody anticipated — and one nearly did here:
 * `/history` looks like pure content, and for private trackers the `downloadUrl`
 * it records carries a passkey in its querystring.
 *
 * **A field-name stripper only catches what it recognises.** This system has had
 * five redactors fail on five unrelated shapes — a field called `raw`, a
 * free-text `notes`, a settings table. So this is a NET, not a guarantee, and
 * the paths that are known to hand back credentials are denied outright as well.
 *
 * ── ⚠️ WHY THE NAMES ARE MATCHED EXACTLY AND NOT BY SUBSTRING ────────────────
 *
 * My first probe of the live servers matched `key|pass|token|auth` as
 * substrings, and on real responses that flagged **`packageAuthor`** (a person's
 * name), **`authenticationMethod`** (`"forms"`), **`proxyBypassLocalAddresses`**,
 * **`HasPassword`** and **`HasConfiguredPassword`** (booleans) — every one of
 * them a useful, harmless field. A substring stripper redacts the diagnostics
 * and teaches everyone to ignore `[REDACTED]`. Exact names, plus the `{name,
 * value}` shape below.
 */
const CREDENTIAL_FIELD_NAMES = new Set([
  'apikey',
  'api_key',
  'apisecret',
  'accesstoken',
  'refreshtoken',
  'authtoken',
  'bearertoken',
  'clientsecret',
  'cookie',
  'cookies',
  'passkey',
  'rsspasskey',
  'password',
  'passwd',
  'passphrase',
  'privatekey',
  'secret',
  'secretkey',
  'sessionid',
  'token',
  'userpasskey',
  'vipkey',
]);

/** Querystring parameters that carry a credential inside a URL-shaped VALUE. */
const CREDENTIAL_QUERY_KEYS = ['passkey', 'apikey', 'api_key', 'token', 'secret', 'rsskey', 'authkey'];

const REDACTED = '[REDACTED — credentials are never quoted into a reply]';

/** Deep structures are bounded rather than trusted; JSON.parse output cannot cycle. */
const MAX_STRIP_DEPTH = 40;

export interface StripResult {
  value: unknown;
  /** Which field names were redacted, so the output can SAY so. */
  redacted: string[];
}

/**
 * Remove credential-shaped values from a parsed response, recursively.
 *
 * 🔴 It REPLACES rather than deletes, and the caller reports what it replaced.
 * A silently removed field is indistinguishable from a field that was empty —
 * which would quietly turn "I am hiding this from you" into "there is nothing
 * there", the false-zero shape this repo refuses everywhere else.
 */
export function stripCredentials(input: unknown): StripResult {
  const redacted = new Set<string>();

  const walk = (value: unknown, depth: number): unknown => {
    if (depth > MAX_STRIP_DEPTH) return value;
    if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1));
    if (!value || typeof value !== 'object') {
      return typeof value === 'string' ? scrubUrl(value, redacted) : value;
    }

    const obj = value as Record<string, unknown>;
    /**
     * 🔴 THE `{name, value}` PAIR — the shape a key-name walker cannot see.
     *
     * Sonarr, Radarr and Prowlarr store connection settings as
     * `fields: [{ name: "password", value: "…" }]`. The KEY is `value`; the
     * credential's name is DATA. My own first probe of the live servers reported
     * `/downloadclient` as clean for exactly this reason, and it is not: it
     * carries a populated password. Measured, same day, once the walker was
     * taught this shape.
     */
    if ('name' in obj && 'value' in obj && isCredentialName(obj['name'])) {
      const hasValue = obj['value'] !== null && obj['value'] !== undefined && obj['value'] !== '';
      if (hasValue) {
        redacted.add(String(obj['name']));
        return { ...obj, value: REDACTED };
      }
    }

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (CREDENTIAL_FIELD_NAMES.has(k.toLowerCase()) && v !== null && v !== undefined && v !== '') {
        redacted.add(k);
        out[k] = REDACTED;
        continue;
      }
      out[k] = walk(v, depth + 1);
    }
    return out;
  };

  return { value: walk(input, 0), redacted: [...redacted].sort() };
}

function isCredentialName(name: unknown): boolean {
  return typeof name === 'string' && CREDENTIAL_FIELD_NAMES.has(name.toLowerCase());
}

/**
 * A credential can hide in a VALUE rather than a field name: a private tracker's
 * `downloadUrl` is `https://tracker/rss?passkey=…`, and the field is called
 * `downloadUrl`, which no name list will ever flag. Rewrites the querystring
 * parameter, keeping the rest of the URL, which is the useful part.
 */
function scrubUrl(value: string, redacted: Set<string>): string {
  if (!/[?&]/.test(value) || !/^https?:\/\//i.test(value)) return value;
  let out = value;
  for (const key of CREDENTIAL_QUERY_KEYS) {
    const re = new RegExp(`([?&]${key}=)[^&#\\s]+`, 'gi');
    if (re.test(out)) {
      redacted.add(`${key} (in a URL)`);
      out = out.replace(re, `$1[REDACTED]`);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE BOUND
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 🔴 BOUNDED BY RECORDS AND FIELDS, NEVER BY BYTES.
 *
 * A byte clip of JSON is INVALID JSON. It is also the wrong axis: Jellyfin's
 * `/Sessions` is 496 KB for five sessions, and 527 KB of that is one stale
 * session's `NowPlayingQueueFullItems`. A byte cap on that response returns
 * device blobs and **nothing about who is watching** — the exact question it was
 * called to answer. Dropping the field answers it in a few hundred bytes.
 *
 * 🔴 AND IT ALWAYS SAYS WHAT IT DROPPED. `showing 25 of 1744` is a different
 * fact from `showing 25 of 25`, and a silent truncation is indistinguishable
 * from *"that's all there is"* — which is a false zero with a helpful tone.
 * The header is emitted even when nothing was dropped, so its ABSENCE can never
 * be read as "nothing was dropped".
 */
export interface BoundOptions {
  /** How many records to show. */
  limit: number;
  /** Show only these top-level keys of each record. */
  fields?: string[];
  /** Output ceiling. Exceeding it drops RECORDS, never bytes. */
  maxChars: number;
}

/** Envelope keys these four services use for "the list is in here". */
const LIST_KEYS = ['Items', 'SearchHints', 'records', 'results', 'data'];
/** Envelope keys these four services use for "and there were this many". */
const TOTAL_KEYS = ['TotalRecordCount', 'totalRecords', 'totalCount', 'total'];

export function renderRead(body: unknown, opts: BoundOptions): string {
  const list = findList(body);
  if (!list) return renderSingle(body, opts);

  const total = list.total;
  const projected = opts.fields?.length
    ? list.records.map((r) => project(r, opts.fields as string[]))
    : list.records;

  let shown = Math.min(opts.limit, projected.length);
  let rendered = JSON.stringify(projected.slice(0, shown), null, 1);
  /**
   * Drop RECORDS until it fits. Never slice the string: half a record is not a
   * smaller answer, it is a syntactically broken one.
   *
   * Scaled by how far over the ceiling we are rather than halved — halving goes
   * 25 → 12 → 6 → 3 → 1 and throws away most of what would have fitted. `0.9`
   * leaves headroom for the records being uneven; the loop is the real guarantee.
   */
  while (rendered.length > opts.maxChars && shown > 1) {
    const next = Math.floor((shown * opts.maxChars) / rendered.length * 0.9);
    shown = Math.max(1, Math.min(next, shown - 1));
    rendered = JSON.stringify(projected.slice(0, shown), null, 1);
  }

  /**
   * 🔴 THE HEADER STATES WHAT WAS ACTUALLY RENDERED.
   *
   * When even one record is over the ceiling, `shown` is the count the shrink
   * loop STOPPED at, not the count that gets printed — and the oversized branch
   * below prints none. Reporting "showing 1 of 5" above a paragraph that shows
   * zero is a count we did not deliver, which is the same species of claim as a
   * silent truncation. So the header is built after that question is settled.
   */
  const oversized = rendered.length > opts.maxChars;
  if (oversized) shown = 0;

  const header = [`showing ${shown} of ${total} record(s)`];
  if (shown < total) header.push(`${total - shown} NOT SHOWN — narrow the query or raise \`limit\``);
  if (opts.fields?.length) header.push(`fields projected to: ${opts.fields.join(', ')}`);
  if (list.envelope.length) header.push(`envelope keys: ${list.envelope.join(', ')}`);

  if (oversized) return `${header.join(' · ')}\n${describeOversized(projected[0], opts)}`;

  /**
   * 🔴 A PROJECTION THAT MATCHED NOTHING IS A FALSE ZERO, NOT AN EMPTY RESULT.
   *
   * `fields: ["Name"]` against Sonarr rows (whose key is `title`) renders `[{},
   * {}, {}]`, which reads as "these records are empty". They are not — the
   * projection missed. Say so, and name the keys that are actually there.
   */
  if (opts.fields?.length && shown > 0 && projected.slice(0, shown).every((r) => Object.keys(r).length === 0)) {
    const available = [...new Set(list.records.slice(0, 5).flatMap((r) => Object.keys(r ?? {})))];
    return (
      `${header.join(' · ')}\n` +
      `⚠️ NONE of the requested fields exist on these records, so the projection is empty — this is ` +
      `NOT an empty result. Keys actually present: ${available.join(', ') || '(none)'}\n` +
      rendered
    );
  }

  return `${header.join(' · ')}\n${rendered}`;
}

/** Not a list — a single object (`/System/Info`, `/Items/Counts`, `/queue/status`). */
function renderSingle(body: unknown, opts: BoundOptions): string {
  const value =
    opts.fields?.length && body && typeof body === 'object' && !Array.isArray(body)
      ? project(body as Record<string, unknown>, opts.fields)
      : body;
  const rendered = JSON.stringify(value, null, 1);
  const projection = opts.fields?.length ? ` · fields projected to: ${opts.fields.join(', ')}` : '';
  // Same rule as the list branch: the count reports what was RENDERED. A body
  // too large to print is "showing 0", not "showing 1".
  if (rendered !== undefined && rendered.length <= opts.maxChars) {
    return `showing 1 record (not a list)${projection}\n${rendered}`;
  }
  return `showing 0 of 1 record (not a list, and too large to print)${projection}\n${describeOversized(value, opts)}`;
}

/**
 * The last resort, and it still refuses to lie: instead of a truncated record,
 * emit the record's SHAPE with each field's size, so the caller can pick a
 * projection that fits. `/Sessions` lands here, and the map immediately shows
 * that one key holds 500 KB.
 */
function describeOversized(record: unknown, opts: BoundOptions): string {
  // ⚠️ Absence is not a measurement. Saying "the value is larger than N" about a
  // value that is not there states a size fact about nothing.
  if (record === undefined || record === null) {
    return '⚠️ There is no record here to show. This is UNKNOWN, not an empty result.';
  }
  if (typeof record !== 'object') {
    return `⚠️ The single value is larger than ${opts.maxChars} characters and cannot be shown.`;
  }
  const sizes = Object.entries(record as Record<string, unknown>)
    .map(([k, v]) => ({ k, n: JSON.stringify(v)?.length ?? 0 }))
    .sort((a, b) => b.n - a.n)
    .map(({ k, n }) => `${k} (${n} chars)`);
  return (
    `⚠️ ONE record is larger than ${opts.maxChars} characters, so NOTHING is shown rather than half ` +
    `a record. Re-run with \`fields\` set to the ones you need. Fields present, largest first:\n  ` +
    sizes.join('\n  ')
  );
}

interface FoundList {
  records: Record<string, unknown>[];
  total: number;
  /** The other keys of the envelope object, so the caller knows they were there. */
  envelope: string[];
}

function findList(body: unknown): FoundList | null {
  if (Array.isArray(body)) {
    return { records: body.map(asRecord), total: body.length, envelope: [] };
  }
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  for (const key of LIST_KEYS) {
    const value = obj[key];
    if (!Array.isArray(value)) continue;
    /**
     * 🔴 THE SERVER'S OWN TOTAL WINS, WHEN IT HAS ONE.
     *
     * Sonarr's `/queue` defaults to `pageSize=10` against `totalRecords=15`, and
     * `/wanted/missing?pageSize=20` returns 20 rows of 1,744. Counting the array
     * would report "20 of 20" — a truncation the SERVER performed, reported by
     * us as completeness. The envelope is the only place that fact exists.
     */
    const total = TOTAL_KEYS.map((t) => obj[t]).find((v) => typeof v === 'number') as number | undefined;
    return {
      records: value.map(asRecord),
      total: total ?? value.length,
      envelope: Object.keys(obj).filter((k) => k !== key),
    };
  }
  return null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
}

function project(record: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (f in record) out[f] = record[f];
  return out;
}
