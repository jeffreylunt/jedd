import type { Config } from './config.js';
import type { Tool } from './tools/types.js';
import { ModelTimeoutError } from './turn-notice.js';

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /**
   * Images on a USER turn, as BARE base64 — no `data:` prefix, no wrapper.
   *
   * 🔴 THE ENCODING IS PART OF THE CONTRACT, AND GETTING IT WRONG IS SILENT.
   * Ollama's `/api/chat` takes `messages[].images` as a plain array of base64
   * strings; a `data:image/png;base64,…` string is accepted by the HTTP layer,
   * fails to decode inside, and surfaces as the model simply never mentioning
   * the picture. There is no error and no warning — the reply just reads like
   * the image was never sent, which is indistinguishable from the model
   * choosing not to talk about it.
   */
  images?: string[];
  /**
   * What to tell the model about this turn's attachments, expanded into a
   * `system` message at request-build time.
   *
   * 🔴 STORED ON THE TURN, NOT PUSHED AS ITS OWN HISTORY ENTRY, AND THE
   * DIFFERENCE IS A BUG THAT ALREADY EXISTED.
   *
   * It was a separate `{role:'system'}` message. `boundHistoryImages` later
   * stripped the BYTES off an older turn to protect `num_ctx` — and could not
   * see the note, which went on saying *"they attached one image, which is on
   * this message and you can see it"* about a picture that was no longer in the
   * request. The model was being told, in the system role, that it could see
   * something it had not been given; the reply describes an image out of
   * nothing. Keeping the note ON the turn is what lets one pass rewrite both.
   */
  imageNote?: string;
  /**
   * What the person actually typed, when `content` is not that.
   *
   * 🔴 EXISTS FOR THE PROVENANCE GATES, WHICH ARE A SECURITY BOUNDARY.
   * `appearsInOwnTurns` (`kindle.ts`) is a substring test over `ctx.userTurns`,
   * and it is the ONLY thing standing between the model and storing an invented
   * Kindle address or minting a Jellyfin invite for an invented number. A
   * captionless photo has no text, so `content` becomes a machine-composed
   * marker — and machine text inside `userTurns` makes that gate answer
   * questions about a sentence nobody typed.
   */
  rawText?: string;
  /** Present on assistant messages that requested tools. */
  toolCalls?: LlmToolCall[];
  /** Present on tool messages: which call this answers. */
  toolCallId?: string;
  toolName?: string;
}

export interface LlmReply {
  text: string;
  toolCalls: LlmToolCall[];
}

export interface LlmClient {
  readonly label: string;
  chat(messages: LlmMessage[], tools: Tool[]): Promise<LlmReply>;
}

function toOllamaMessages(messages: LlmMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', content: m.content, tool_name: m.toolName };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content,
        tool_calls: m.toolCalls.map((c) => ({
          function: { name: c.name, arguments: c.arguments },
        })),
      };
    }
    /**
     * ⚠️ `images` IS OMITTED WHEN EMPTY RATHER THAN SENT AS `[]`. An empty array
     * on every text turn is a change to the request shape of every existing
     * conversation in order to say nothing, and this stack has already shown
     * (`tool_choice`) that it will silently ignore a field rather than complain
     * about one — so a shape nobody needs is a shape nobody can verify.
     */
    if (m.role === 'user' && m.images?.length) {
      return { role: m.role, content: m.content, images: m.images };
    }
    return { role: m.role, content: m.content };
  });
}

/**
 * Turn the stored history into the exact message list one request carries.
 *
 * Two jobs, done in ONE pass because they are the same decision:
 *
 * 1. **Bound the images.** An image left in history is re-sent on every
 *    subsequent call. `num_ctx` is 16384 and is deliberately not raised — it is
 *    what keeps the model fully resident in VRAM, and raising it is what
 *    produces 110-second turns. So a conversation with a few photos in it would
 *    otherwise spend its whole window re-describing pictures nobody is asking
 *    about, and it would do it by DEGRADING: the oldest real messages fall out
 *    of the window first, so the symptom is Jedd forgetting the conversation
 *    rather than any error pointing back here.
 *
 * 2. **Expand each turn's note**, so what the model is told about a picture is
 *    DERIVED from whether the bytes actually travelled. A note stored as its own
 *    history entry cannot be kept honest by a later pass, and the stale version
 *    of it is the worst sentence in the system: *"you can see it"*, in the
 *    system role, about an image that was dropped.
 *
 * 🔴 BOTH A TURN COUNT AND A TOTAL IMAGE COUNT. `keepTurns` alone is not a
 * bound: a turn may carry up to `maxCount` images, so "keep 2 turns" permitted
 * eight images in one request — double the per-turn cap, and plausibly the whole
 * input budget once the system prompt and tool schemas are counted.
 *
 * ⚠️ COPIES; DOES NOT MUTATE. Whether a turn's picture travels is decided per
 * REQUEST, so the tool loop's later calls in the same turn all agree with each
 * other and nothing is destroyed mid-turn.
 */
export function buildRequestMessages(
  messages: LlmMessage[],
  bounds: { keepTurns: number; maxImages: number },
): LlmMessage[] {
  const reversed: LlmMessage[] = [];
  let imageTurnsKept = 0;
  let imagesKept = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const count = m.images?.length ?? 0;

    if (m.role !== 'user' || (count === 0 && !m.imageNote)) {
      reversed.push(m);
      continue;
    }

    const keep =
      count > 0 && imageTurnsKept < bounds.keepTurns && imagesKept + count <= bounds.maxImages;

    if (keep) {
      imageTurnsKept += 1;
      imagesKept += count;
      reversed.push(m);
      if (m.imageNote) reversed.push({ role: 'system', content: m.imageNote });
      continue;
    }

    if (count === 0) {
      // No bytes were ever attached to this turn — the note is about an
      // attachment that FAILED, which is a past-tense fact and cannot go stale.
      reversed.push(m);
      if (m.imageNote) reversed.push({ role: 'system', content: m.imageNote });
      continue;
    }

    const { images: _dropped, imageNote: _note, ...rest } = m;
    reversed.push(rest);
    reversed.push({
      role: 'system',
      content:
        'An image they sent earlier in this conversation is no longer attached to this request. ' +
        'You cannot see it any more — do not describe it or claim to have seen it. If they ask ' +
        'about it, say you would need them to send it again.',
    });
  }

  return reversed.reverse();
}

/**
 * Drop from the STORED history the images that can never travel again.
 *
 * 🔴 THIS IS NOT THE SAME DECISION AS `buildRequestMessages` AND IT MUTATES ON
 * PURPOSE.
 *
 * `histories` in `agent.ts` is a per-sender map that nothing prunes. At the
 * defaults that is up to four 12 MB images — ~64 MB of base64 — retained for the
 * life of a process that shares a Mac with a resident 27B model, per
 * image-bearing turn, forever.
 *
 * The bound is safe because the window only ever moves FORWARD: a turn that has
 * already fallen outside `keepTurns` can only get older, so its bytes were
 * already unreachable. Freeing them loses nothing that could have been used.
 */
export function pruneStoredImages(messages: LlmMessage[], keepTurns: number): void {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'user' || !m.images?.length) continue;
    seen += 1;
    if (seen > keepTurns) {
      delete m.images;
      delete m.imageNote;
    }
  }
}

export const TURN_TIMEOUT_MS = 900_000;

export class OllamaClient implements LlmClient {
  readonly label: string;

  constructor(private readonly config: Config) {
    this.label = `ollama:${config.llm.model}`;
  }

  async chat(messages: LlmMessage[], tools: Tool[]): Promise<LlmReply> {
    // Wall clock for ONE model turn, including a cold model load.
    //
    // RAISED 240s -> 900s on 2026-08-26 at Jeff's explicit request, after this
    // timeout silently killed the same real request TWICE in twenty minutes.
    // Measured both times: "Give me the other 14" (a 14-item list) aborted at
    // ~240s. The first failure ALSO involved a cold load -- the ollama runner
    // started the same second the message arrived and took ~10 min -- but the
    // SECOND failed on a model that was already resident and demonstrably
    // generating (runner CPU climbing 2.2 -> 11.6%). So a cold load is NOT
    // required to blow this budget: a long enough generation does it alone.
    //
    // AND THE ABORT IS NOW VISIBLE. It used to be the worse half of this: the
    // controller fired, `fetch` threw, the turn died and NOTHING was said, so a
    // killed turn and a message that never arrived were the same event to
    // whoever sent it. It is classified as a `ModelTimeoutError` below and
    // `main.ts` answers it with a sentence that names the timeout.
    //
    // 🔴 CLASSIFIED FROM `controller.signal`, NOT FROM `e.name`. Several tools
    // here run their own `AbortSignal.timeout`, so `AbortError` is a name four
    // other components also produce; this controller is aborted from exactly one
    // place. The reasoning is written out in `turn-notice.ts`.

    /**
     * ⚠️ READ PER CALL FROM CONFIG, WITH THE CONSTANT AS THE DEFAULT. The
     * constant stays exported because `presence.ts` derives the typing ceiling
     * from it; the override exists because this number has already been changed
     * once under pressure and because a timeout nobody can make fire is a
     * timeout nobody has tested. See `config.parseTurnTimeout`.
     */
    const limitMs = this.config.llm.turnTimeoutMs ?? TURN_TIMEOUT_MS;
    const controller = new AbortController();
    const startedAt = Date.now();
    const timer = setTimeout(() => controller.abort(), limitMs);
    let body: {
      done_reason?: string;
      message?: {
        content?: string;
        thinking?: string;
        tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[];
      };
    };
    try {
      const res = await fetch(`${this.config.llm.baseUrl.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.config.llm.model,
          messages: toOllamaMessages(messages),
          tools: tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
          stream: false,
          think: true,
          keep_alive: '30m',
          options: { temperature: 0.2, num_ctx: 16384, num_predict: 3000 },
        }),
      });

      if (!res.ok) {
        // ⚠️ CAPTURED BEFORE THE AWAIT. If the abort lands while the error body
        // is being read, the throw below never happens and the status would be
        // lost with it — leaving a timeout that cannot say the server had
        // already answered 500.
        const status = res.status;
        throw new Error(`Ollama HTTP ${status}: ${(await res.text()).slice(0, 300)}`);
      }
      /**
       * 🔴 THE BODY READ IS INSIDE THE TIMER, AND IT USED NOT TO BE.
       *
       * `clearTimeout` sat in a `finally` around the `fetch` alone. `fetch`
       * resolves on HEADERS — the body is still arriving — so a response whose
       * headers landed at 899s and whose body then stalled had no deadline left
       * on it at all: `res.json()` would wait forever, the turn would never end,
       * and (since the queue's lane is only released when the turn returns) that
       * person would never be answered again. That is this same defect in its
       * worst form, so it is closed here rather than left as the next report.
       */
      body = (await res.json()) as typeof body;
    } catch (e) {
      if (controller.signal.aborted) throw new ModelTimeoutError(Date.now() - startedAt, limitMs, e);
      throw e;
    } finally {
      clearTimeout(timer);
    }

    const raw = body.message?.tool_calls ?? [];
    const toolCalls: LlmToolCall[] = raw.flatMap((call, i) => {
      const name = call.function?.name;
      if (!name) return [];
      let args: Record<string, unknown> = {};
      const rawArgs = call.function?.arguments;
      if (typeof rawArgs === 'string') {
        try {
          args = JSON.parse(rawArgs) as Record<string, unknown>;
        } catch {
          args = {};
        }
      } else if (rawArgs && typeof rawArgs === 'object') {
        args = rawArgs as Record<string, unknown>;
      }
      // Ollama supplies its own call id; use it rather than inventing one.
      return [{ id: call.id ?? `call_${Date.now()}_${i}`, name, arguments: args }];
    });

    const text = body.message?.content ?? '';

    // ⚠️ Empty content on a TOOL-CALLING turn is normal — the model returns a
    // call and no prose. The real budget failure is `done_reason: "length"` with
    // nothing to show for it, so that is what gets flagged, not emptiness.
    if (body.done_reason === 'length' && !text.trim() && toolCalls.length === 0) {
      throw new Error(
        'Model hit its token budget without producing an answer or a tool call ' +
          '(done_reason=length). Reasoning consumed the whole num_predict allowance.',
      );
    }

    // `message.thinking` is deliberately NOT returned. It is reasoning, not reply,
    // and must never reach the user or the transcript.
    return { text, toolCalls };
  }
}

/**
 * Is the model endpoint actually there, and does it have the model we ask for?
 *
 * 🔴 WARN, NEVER FATAL — AND THE DISTINCTION IS THE WHOLE DESIGN.
 *
 * Config PRESENCE is statically checkable and cannot become true later, so
 * hard-failing on it is right. REACHABILITY is a fact about this second: an
 * Ollama that is restarting at 03:00 is serving again at 03:05. Exiting on it
 * would convert a two-minute blip into a dead bot, and under a supervisor into
 * a restart loop. So this reports and returns; it never decides.
 *
 * ⚠️ IT IS NOT DECORATION. Nothing else contacts the model before serving, and
 * a wrong `LLM_BASE_URL` produces the worst failure this system has: the process
 * boots, the healthcheck passes, the webhook registers, and then EVERY turn
 * throws — so a person texts and gets silence, indefinitely, with the only
 * evidence in a log. This line is the difference between finding that out at
 * boot and finding it out from a user who thinks the bot is ignoring them.
 */
export async function probeLlm(
  config: Config,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; detail: string }> {
  const base = config.llm.baseUrl.replace(/\/$/, '');
  try {
    const r = await fetchImpl(`${base}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    if (!r.ok) return { ok: false, detail: `${base} answered http ${r.status}` };
    const body = (await r.json()) as { models?: { name?: string }[] };
    const names = (body.models ?? []).map((m) => m.name).filter(Boolean) as string[];
    if (!names.includes(config.llm.model)) {
      /**
       * Reachable but WITHOUT the configured model is its own failure, and a
       * distinct one: the endpoint answers, so every connectivity check passes,
       * and the model name is only wrong at generation time. Name what IS there
       * — a typo is obvious next to the real list and invisible on its own.
       */
      return {
        ok: false,
        detail:
          `${base} is reachable but has no model named "${config.llm.model}". ` +
          `It offers: ${names.slice(0, 8).join(', ') || '(none)'}${names.length > 8 ? ', …' : ''}`,
      };
    }
    return { ok: true, detail: `${base} has ${config.llm.model}` };
  } catch (e) {
    return { ok: false, detail: `${base} is unreachable: ${(e as Error).message}` };
  }
}

export function createLlmClient(config: Config): LlmClient {
  switch (config.llm.provider) {
    case 'ollama':
      return new OllamaClient(config);
    case 'anthropic':
      throw new Error(
        'The Anthropic client is not implemented yet — the LlmClient interface is the seam for it. ' +
          'Set LLM_PROVIDER=ollama.',
      );
    default:
      throw new Error(`Unknown LLM provider: ${String(config.llm.provider)}`);
  }
}
