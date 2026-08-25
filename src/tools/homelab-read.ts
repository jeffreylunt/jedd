import { planRead, renderRead, stripCredentials, READ_SERVICES } from '../homelab-read.js';
import type { FetchImpl } from '../media/arr.js';
import { fail, ok, type Tool } from './types.js';

/**
 * THE GENERIC READ. One tool instead of twenty curated verbs, for READS ONLY.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * Jeff, 2026-08-25: *"a generic read ability would be great"*, and earlier:
 * *"I'm wondering if we can just let Jedd make the direct api calls itself."*
 *
 * The failure it removes is **"nobody wrote that verb"**. V1 answered a question
 * about Seinfeld season 2 wrongly, and never offered to fetch it, for one reason:
 * the read that would have answered it — `/episode?seriesId=80&seasonNumber=2` —
 * is a plain GET that no human had authored a tool for. Every future instance of
 * that shape is now reachable without anybody writing anything.
 *
 * ── WHY THE SPLIT IS BY VERB, NOT BY CAPABILITY ──────────────────────────────
 *
 * Reads generic, writes curated, and **one reason decides it and it is not about
 * trusting the model**: `DELETE /series/{id}?deleteFiles=true` erases media from
 * disk. Every other mistake Jedd can make is a text message Jeff can correct;
 * that one is not recoverable. Here the method is a literal in the fetch call
 * below, so no write endpoint is reachable at all — see `src/homelab-read.ts`.
 *
 * ── 🔴 GUEST-LEVEL, GATED BY WHAT THE DATA IS ABOUT ──────────────────────────
 *
 * Jeff, 2026-08-25: *"All users should have read access to everything in the
 * library, etc, but not other users information or server secrets"*, then:
 * *"Owner can ask about all information, but not secrets or keys since we don't
 * want them in message logs."*
 *
 * So the gate is **not a role**, it is a rule about the DATA — the three tiers
 * live in `src/homelab-read.ts`. CONTENT is everyone's; PERSON is the owner's;
 * SECRET is nobody's, enforced with no role logic at all.
 *
 * ⚠️ An earlier version was `minRole: 'owner'`, which left the path denylist
 * backstopped by a role gate: a missed path was contained to Jeff. **It is not
 * backstopped any more.** A path that should be PERSON and is not listed is
 * visible to every guest in the house. When in doubt, deny — un-denying is one
 * line, and a leak is not.
 *
 * ⚠️ This is what retired `homelab_status`. That tool existed because a guest
 * had no way to ask "is the server up"; now they do, and `/System/Info/Public`
 * is the cheap form of it. The retirement was safe ONLY because nothing named
 * it — `assertNamedProducersExist` would have thrown for `catalogue_search` or
 * any of the four docker tools. Absence of a guard is not permission.
 */

/** Records shown when the caller does not say. */
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;
/** Output ceiling, in characters. Exceeding it drops RECORDS — never bytes. */
const MAX_OUTPUT_CHARS = 6000;
/**
 * 🔴 A RESPONSE CEILING THAT REFUSES RATHER THAN TRUNCATES.
 *
 * `/LiveTv/Programs` unfiltered is 13.4 MB; Radarr's `/movie` is 1.43 MB for 250
 * films. Buffering the first to bound it is a minute of wasted transfer and a
 * spike in a process that is also serving iMessage. Above this we say what we
 * saw and how to narrow it, which is an actionable refusal rather than a
 * plausible-looking partial answer.
 */
const MAX_RESPONSE_BYTES = 4_000_000;

const NARROW_ADVICE =
  'Narrow it: Jellyfin takes `limit` (and `limit: 0` returns just TotalRecordCount), ' +
  '/LiveTv/Programs takes minStartDate/maxStartDate/channelIds, and the arrs take `pageSize`.';

export function makeHomelabRead(fetchImpl?: FetchImpl): Tool {
  return {
    name: 'homelab_read',
    /**
     * ── 🔴 THE CHEATSHEET IS PART OF THE CAPABILITY, NOT DOCUMENTATION ───────
     *
     * Every trap below was MEASURED against the live servers on 2026-08-25, each
     * with a control. They are defects of these servers that no amount of care
     * detects from the response: a plausible query returns HTTP 200, a full
     * body, and the wrong thing, with no error anywhere. That is exactly the
     * class a generic GET cannot defend against on its own, so the knowledge has
     * to travel WITH the tool.
     *
     * ⚠️ It is long, and deliberately. The measured cost of the whole registry is
     * ~4,600 tokens at owner on a 131,072-token context — tokens are not the
     * binding constraint here, and a wrong answer about tonight's football is.
     */
    description:
      'Make a read-only GET against one homelab service and get the JSON back, bounded. Use it for ' +
      'anything no other tool covers: the arrs\' calendar / queue / history / wanted / episode lists, ' +
      "Jellyfin's items, guide and playback reports, Prowlarr's indexer health. `service` picks the " +
      'host and the credential, `path` is the endpoint under it, `query` is the querystring as an ' +
      'object. It is a GET and only a GET, so nothing here can change anything.\n' +
      'MEASURED TRAPS — these servers return HTTP 200 and the WRONG DATA, with no error:\n' +
      '1. Jellyfin /LiveTv/Programs SILENTLY IGNORES searchTerm. A nonsense term returns the same ' +
      '183,522 records as a real one — proven with a control. NEVER search programmes that way. Use ' +
      '/Search/Hints?searchTerm=…&includeItemTypes=LiveTvProgram, which really does match — but only ' +
      'on the programme NAME, never the description, so a match listed under a generic title with the ' +
      'teams in its sub-title is invisible to it.\n' +
      '2. /Search/Hints ALSO ignores minStartDate. Most hits it returns have ALREADY AIRED (11 of 13 ' +
      'measured). Compare StartDate against the current time yourself before saying anything about ' +
      '"tonight" — every result from this tool states the time it was read, so use THAT as now; do ' +
      'not go looking for a clock elsewhere and do not guess.\n' +
      '3. A HIT IS USUALLY A REPLAY, and NO structured flag detects it: IsRepeat is absent on exactly ' +
      'the ones that matter and the category is often Show rather than Sport. The marker is in the ' +
      'PROSE. Read Overview via /LiveTv/Programs with channelIds set to the ChannelId that ' +
      '/Search/Hints gave you, a minStartDate/maxStartDate window, and fields=Overview,ChannelInfo. ' +
      '"Coverage from Match Week 1", "Highlights from", "Final:", and a title ending "Hls", all mean a ' +
      'rebroadcast of a match already played. Say so plainly instead of announcing a fixture.\n' +
      '4. THE GUIDE IS ABOUT 4 DAYS DEEP, not the 7 that /LiveTv/GuideInfo claims. Measured density ' +
      'collapses after ~3 days and the tail is placeholder text. So finding no fixture means "not in ' +
      'the next few days", NEVER "no such match" — say which one you mean.\n' +
      'CHEAP MOVES: Jellyfin limit=0 returns TotalRecordCount and nothing else. /LiveTv/Programs ' +
      'returns ChannelName as null unless you ask for fields=ChannelInfo. An arr /queue defaults to ' +
      'pageSize=10 and will hand you 10 of 15 without saying so. Sonarr /history/since is unpaged and ' +
      'huge; use /history with pageSize.\n' +
      'WHAT IS REFUSED, and every refusal says which of these it is. Everything about the CONTENT is ' +
      'open to everyone: the library, what is missing, the queue, the guide, channel line-ups, ' +
      'indexer health, and an arr /history (what was grabbed and when). PERSONAL data — who is ' +
      'watching what, who logged in, the user list — is Jeff\'s only; for anyone else say so plainly ' +
      'rather than implying it is broken. SECRETS — API keys, passwords, tokens, the config and ' +
      'download-client and indexer endpoints — are refused to EVERYONE INCLUDING JEFF, because a ' +
      'credential quoted into a reply is copied into the message thread and the logs. If he asks, say ' +
      'that; do not look for another route, there is not one. Also refused: anything enumerating ' +
      'Jellyfin channels or tuners, and the release-search endpoints. For per-channel Live TV health ' +
      'use channel_health. For "is the server up", /System/Info/Public is the cheap read.\n' +
      'Any credential that slips through on an allowed path is stripped from the response before you ' +
      'see it, and the result says what was removed. Report that it was withheld; never guess at it.\n' +
      'Output is bounded by RECORD COUNT and field projection, never by bytes, and the first line ' +
      'always says how many of how many you got. "showing 25 of 1744" means 1,719 you have not seen.',
    minRole: 'guest',
    writes: false,
    parameters: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          enum: READ_SERVICES,
          description: 'Which service to read. Picks the host and the credential; you never supply either.',
        },
        path: {
          type: 'string',
          description:
            'The endpoint under that service, starting with "/" — e.g. "/Search/Hints", ' +
            '"/LiveTv/Programs", "/calendar", "/wanted/missing", "/api/v1/indexerstatus" (Prowlarr has ' +
            'NO path prefix, so its paths start /api/v1). Do NOT put a querystring here.',
        },
        query: {
          type: 'object',
          description:
            'Querystring parameters as an object, e.g. {"searchTerm": "Crystal Palace", ' +
            '"includeItemTypes": "LiveTvProgram", "limit": 20}. Arrays are joined with commas.',
        },
        limit: {
          type: 'number',
          description:
            `How many RECORDS to show you (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}). This bounds ` +
            "the OUTPUT only — it is not sent to the server. Put the server's own limit/pageSize in " +
            '`query` as well, or it will fetch everything and you will only see this many.',
        },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Show only these top-level keys of each record, e.g. ["Name","ChannelName","StartDate"]. ' +
            'Use it whenever records are large — it is the only thing that makes /Sessions readable.',
        },
      },
      required: ['service', 'path'],
    },

    async run(args, ctx) {
      const plan = planRead(args['service'], args['path'], args['query'], ctx.config, ctx.role);
      if (!plan.allowed) return fail(`${plan.reason}\nNothing was requested.`);

      const limit = clamp(args['limit'], DEFAULT_LIMIT, 1, MAX_LIMIT);
      const fields = readFields(args['fields']);
      if ('error' in fields) return fail(fields.error);

      const doFetch: FetchImpl = fetchImpl ?? ((u, i) => fetch(u, i));
      let res: Response;
      try {
        res = await doFetch(plan.url, {
          // 🔴 The method is a LITERAL. This line is why no write endpoint is
          // reachable through this tool regardless of what path was passed.
          method: 'GET',
          headers: plan.headers,
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e) {
        return fail(
          `Could not reach ${plan.label} at ${plan.url}: ${(e as Error).message}. ` +
            'This is UNKNOWN, not an empty result.',
        );
      }

      const declared = Number(res.headers.get('content-length') ?? NaN);
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
        return fail(
          `${plan.label} ${plan.url} would return ${declared.toLocaleString()} bytes, over the ` +
            `${MAX_RESPONSE_BYTES.toLocaleString()}-byte ceiling, so it was NOT read. ${NARROW_ADVICE}`,
        );
      }

      /**
       * 🔴 THE CEILING IS ENFORCED WHILE READING, NOT AFTER.
       *
       * Found on the first live run: `/LiveTv/Programs` unfiltered came back
       * **92,968,348 bytes** — seven times what the survey measured a few hours
       * earlier — with NO `content-length`, because Jellyfin chunks it. So the
       * header check above did not fire, `res.text()` buffered all 93 MB, and the
       * refusal arrived 15.8 seconds later having already done the damage.
       *
       * ⚠️ The declared-length check is still worth keeping: when a server does
       * declare, this costs nothing at all. It is the cheap half of the pair, not
       * the reliable one. **A cap that can only be applied after the read is not
       * a cap**, and this process is also serving iMessage.
       */
      const read = await readBounded(res, MAX_RESPONSE_BYTES);
      if ('error' in read) return fail(`${plan.label} answered but the body could not be read: ${read.error}.`);
      if (read.exceeded) {
        return fail(
          // ⚠️ The STATUS leads when there is one to report. An oversized error
          // body otherwise renders an HTTP 500 as "that response was too big",
          // which points at the query instead of at the server.
          (res.ok ? `${plan.label} ${plan.url}` : `${plan.label} ${plan.url} → HTTP ${res.status}, and its body`) +
            ` exceeded the ${MAX_RESPONSE_BYTES.toLocaleString()}-byte ceiling (stopped reading at ` +
            `${read.bytes.toLocaleString()} bytes; the full response is larger). Nothing is shown, ` +
            `rather than part of it. ${NARROW_ADVICE}`,
        );
      }
      const text = read.text;

      if (!res.ok) {
        return fail(`${plan.label} ${plan.url} → HTTP ${res.status}. Body: ${text.slice(0, 400)}`);
      }

      /**
       * ⚠️ AN EMPTY BODY IS ITS OWN FACT, NOT THE WRONG-PREFIX SIGNATURE.
       *
       * `JSON.parse('')` throws exactly like `JSON.parse('<!doctype html>')`
       * does, so both used to be reported as "your base URL is wrong" — a
       * confident and specific diagnosis of the wrong thing for a 204 or an
       * empty 200.
       */
      if (!text.trim()) {
        return fail(
          `${plan.label} ${plan.url} returned HTTP ${res.status} with an EMPTY body — no JSON at all. ` +
            'That is not a wrong URL and not an error; it is a response with nothing in it. UNKNOWN.',
        );
      }

      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        /**
         * ⚠️ A 200 THAT IS NOT JSON IS A WRONG BASE URL, NOT A BROKEN SERVICE.
         *
         * Measured: `GET /prowlarr/api/v1/system/status` returns HTTP 200 with
         * `text/html` — the single-page app. Sonarr does the opposite and 307s.
         * A tool that gates on the status code alone silently ingests a web page
         * and reports it as data. "Your URL is wrong" and "the homelab is down"
         * lead to completely different actions, so they are reported apart.
         */
        return fail(
          `${plan.label} ${plan.url} returned HTTP ${res.status} but the body is NOT JSON (starts ` +
            `"${text.slice(0, 60).replace(/\s+/g, ' ')}"). That is the signature of a wrong base URL — ` +
            'the SPA served HTML with a 200 — not of an unreachable service. The data is UNKNOWN.',
        );
      }

      /**
       * 🔴 THE CURRENT TIME SHIPS WITH THE DATA. FOUND BY THE FIRST LIVE TURN.
       *
       * Two of the four traps are *"compare StartDate against now yourself"*, and
       * on the first real run the model could not. It has no clock: the system
       * prompt carries no date, `hp_shell date` is refused by the command gate,
       * and an outbound time API is unreachable. So it spent **four tool calls**
       * hunting — `date`, `/proc/uptime`, worldtimeapi, `stat /proc/1` — then
       * hedged its whole answer on not knowing, and labelled an Aug 22 broadcast
       * as the LIVE one.
       *
       * An instruction to filter by date that the model cannot execute is not a
       * cheatsheet, it is a trap of our own making. The time is a fact this
       * process has and the model does not, so it travels WITH the records whose
       * dates need comparing, at the moment they were read — not stamped once
       * into a system prompt that a long-lived pm2 conversation would outlive.
       */
      /**
       * 🔴 THE SECOND GUARD, RUN ON EVERY RESPONSE FROM EVERY PATH FOR EVERY
       * CALLER — including the owner, and including paths nobody thought were
       * dangerous. There is no role check here and there must never be one.
       *
       * The path denylist is the belt; this is the braces. Neither is sufficient:
       * a denylist only blocks what somebody thought of, and a stripper only
       * catches what it recognises.
       */
      const stripped = stripCredentials(body);
      const redactionNote = stripped.redacted.length
        ? `\n🔴 REDACTED before you saw it: ${stripped.redacted.join(', ')}. These are credentials, ` +
          'and they are removed for everyone including Jeff — a secret quoted into a reply is copied ' +
          'into the message thread, the history and the log file. Do not ask for them another way; ' +
          'there is no other way. Tell the user the field exists and was withheld.'
        : '';

      return ok(
        `GET ${plan.url}\n` +
          `(read at ${new Date().toISOString()} — compare any StartDate against THIS, not against a guess)\n` +
          renderRead(stripped.value, { limit, fields: fields.value, maxChars: MAX_OUTPUT_CHARS }) +
          missingOverviewNote(stripped.value) +
          redactionNote,
      );
    },
  };
}

/**
 * 🔴 SAY THAT THE DECIDING FIELD IS ABSENT, AT THE MOMENT IT IS ABSENT.
 *
 * Measured over three live turns on the Crystal Palace question: two answered
 * correctly, and the third stopped after `/Search/Hints`, led with *"next one is
 * tonight, 22:00"* and merely OFFERED to check whether it was a replay. It had
 * been told, in the description, that a hit is usually a replay and that the
 * marker is in `Overview` — and `/Search/Hints` does not return `Overview`, so at
 * the moment it decided it was finished, nothing in front of it said otherwise.
 *
 * This is not prose-policing and it is not a guard over the reply: the tool is
 * reporting a **property of the records it just returned** — these have a start
 * time and no description, so the live-or-replay question is not yet answerable
 * from them. That is the repo's own rule (return the fact, do not make a guard
 * guess it back out of English), and it is keyed on the DATA rather than on the
 * endpoint name, so it fires equally for `/LiveTv/Programs` fetched without
 * `fields=Overview` — the same defect by the other route.
 */
function missingOverviewNote(body: unknown): string {
  const rows = Array.isArray(body)
    ? body
    : ((body as Record<string, unknown> | null)?.['Items'] ??
        (body as Record<string, unknown> | null)?.['SearchHints']);
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const scheduled = rows.filter(
    (r): r is Record<string, unknown> => !!r && typeof r === 'object' && 'StartDate' in r,
  );
  if (scheduled.length === 0) return '';
  if (scheduled.some((r) => typeof r['Overview'] === 'string' && r['Overview'].trim())) return '';
  return (
    '\n⚠️ These records have a StartDate but NO Overview, so you cannot yet tell a live fixture from ' +
    'a replay or a highlights package — and most guide hits are replays. Before you answer, read the ' +
    'description: GET /LiveTv/Programs with channelIds set to the ChannelId above, a ' +
    'minStartDate/maxStartDate window around the slot, and fields=Overview,ChannelInfo. "Coverage ' +
    'from Match Week N", "Highlights from", "Final:" and a title ending "Hls" all mean a rebroadcast.'
  );
}

/**
 * Read a response body, stopping as soon as it passes `ceiling`.
 *
 * Returns `exceeded` rather than a partial string, because a partial body is
 * worse than none: it is invalid JSON that looks like data.
 *
 * ⚠️ `res.body` is null only for a bodiless response — 204, 304, a HEAD. That
 * branch is NOT a fallback for large bodies and must not be described as one:
 * `res.text()` there is `''`, so no ceiling can apply. Every response with
 * content, including every stubbed `Response` in the tests, has a real
 * `ReadableStream` and takes the streaming path.
 */
async function readBounded(
  res: Response,
  ceiling: number,
): Promise<{ text: string; bytes: number; exceeded: boolean } | { error: string }> {
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    return { text: '', bytes: 0, exceeded: false };
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > ceiling) {
        // Stop the transfer. Reading the remaining 89 MB to discard it would
        // defeat the point of stopping.
        await reader.cancel().catch(() => undefined);
        return { text: '', bytes, exceeded: true };
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } catch (e) {
    return { error: (e as Error).message };
  }
  return { text: chunks.join(''), bytes, exceeded: false };
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(Math.max(n, min), max);
}

function readFields(value: unknown): { value: string[] | undefined } | { error: string } {
  if (value === undefined || value === null) return { value: undefined };
  if (!Array.isArray(value) || !value.every((f) => typeof f === 'string')) {
    return { error: '`fields` must be an array of strings, e.g. ["Name","StartDate"]. Nothing was requested.' };
  }
  const fields = (value as string[]).map((f) => f.trim()).filter(Boolean);
  return { value: fields.length ? fields : undefined };
}
