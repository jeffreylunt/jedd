import type { FetchImpl } from './client.js';

/**
 * Inbound image attachments.
 *
 * Every fact encoded here was MEASURED on 2026-09-01 against the live
 * BlueBubbles 1.9.9 server on :1234, and cross-read against the TypeScript
 * sources shipped inside `BlueBubbles.app/Contents/Resources/app.asar`. None of
 * it was documented anywhere beforehand, and two of the measurements contradict
 * what a reasonable person would have assumed. See
 * `plans/inbound-images/plan.md` in the space for the full capture.
 */

/**
 * The attachment shape as it arrives on a `new-message` WEBHOOK.
 *
 * ⚠️ THIS IS THE *REDUCED* SHAPE, AND THE DIFFERENCE MATTERS.
 *
 * `Server.handleNewMessage` serialises the message TWICE. The rich copy goes
 * straight to the socket server and never reaches a webhook; the copy we get is
 * the one built with `isForNotification: true`, and `AttachmentSerializer` drops
 * six fields for it — `transferState`, `isOutgoing`, `hideAttachment`,
 * `isSticker`, `originalGuid`, `hasLivePhoto`.
 *
 * So do NOT write a guard against `transferState`: it is never there. Reading
 * an attachment's readiness off a field the webhook does not carry is a check
 * that silently evaluates `undefined` forever.
 */
export interface InboundAttachment {
  guid: string;
  /** May be absent, and may disagree with `uti`. See `typeVerdict`. */
  mimeType: string;
  /** The macOS Uniform Type Identifier, e.g. `public.heic`. */
  uti: string;
  /** The filename as sent, e.g. `IMG_9465.HEIC`. Used only to name it to a human. */
  transferName: string;
  /**
   * 🔴 WHAT THE SENDER'S FILE WEIGHED — *NOT* WHAT THE DOWNLOAD WILL WEIGH.
   *
   * MEASURED: a HEIC declaring `totalBytes: 3_631_404` downloaded as
   * **5_409_496 bytes** of JPEG, because BlueBubbles transcodes HEIC on the way
   * out (below). That is 49% larger than declared.
   *
   * A ceiling enforced on this number ALONE therefore admits a file half again
   * over the limit, and does it while looking like it checked. This value is
   * only ever a cheap PRE-filter; the real ceiling is counted off the wire in
   * `fetchImage`.
   */
  totalBytes: number;
}

/**
 * What we may send to a vision model.
 *
 * 🔴 DECIDED ON `mimeType` ALONE WHEN IT IS PRESENT, WITH `uti` AS A FALLBACK
 * FOR WHEN IT IS NOT — deliberately NOT `mimeType OR uti`.
 *
 * The tempting form is "allow it if EITHER field is allowlisted", because the
 * same file genuinely reports different types depending on which endpoint you
 * ask: `/message/query` returned `mimeType: "image/heic"` for the photo below,
 * while `/attachment/{guid}` returned `mimeType: "image/jpeg"` for that same
 * row, and `uti` stayed `public.heic` throughout.
 *
 * But an OR over two type fields makes each one OPTIONAL: a `video/quicktime`
 * carrying any allowlisted `uti` would be admitted by the half that agreed with
 * it, and the disagreement — the one thing actually worth noticing — becomes
 * the reason it passed. Deciding on one field at a time keeps the verdict
 * deterministic, and costs nothing here because BOTH observed `mimeType` values
 * for a HEIC (`image/heic` and `image/jpeg`) are on this list anyway.
 */
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/tiff',
  'image/bmp',
]);

const ALLOWED_UTI = new Set([
  'public.jpeg',
  'public.png',
  'public.heic',
  'public.heif',
  'public.tiff',
  'public.image',
  'com.compuserve.gif',
  'org.webmproject.webp',
  'com.microsoft.bmp',
]);

export interface ImageLimits {
  /** Longest edge we ask BlueBubbles to resize to before sending bytes. */
  maxWidth: number;
  /** Hard ceiling, applied BOTH to the declared size and to the bytes read. */
  maxBytes: number;
  /** How many images one turn may carry. */
  maxCount: number;
}

export const DEFAULT_IMAGE_LIMITS: ImageLimits = {
  maxWidth: 1024,
  maxBytes: 12 * 1024 * 1024,
  maxCount: 4,
};

/**
 * Why an attachment will not be looked at. Each one is a DIFFERENT SENTENCE to
 * the person who sent it, which is the whole reason they are not one enum
 * member called `failed`:
 *
 *  - `unsupported` — we know what it is and it is not an image. "That's a video,
 *    I can only look at pictures."
 *  - `oversize`    — it is an image and it is too big. "That photo is 40 MB."
 *  - `unfetchable` — it should have worked and did not. "I can see you sent a
 *    photo but I couldn't get it off the server."
 *
 * Collapsing these loses the only information the person could act on.
 */
export type RejectReason = 'unsupported' | 'oversize' | 'unfetchable';

export interface RejectedAttachment {
  reason: RejectReason;
  /** Human-facing filename, for the sentence Jedd says. */
  name: string;
  /** What we knew that made us reject it — a mime type, a byte count, an error. */
  detail: string;
}

export interface ClassifiedAttachments {
  usable: InboundAttachment[];
  rejected: RejectedAttachment[];
  /**
   * Images that were fine but fell outside `maxCount`. Counted, not rejected:
   * the person is told "you sent 7, I looked at the first 4", which is a
   * different statement from "4 of your images were bad".
   */
  overflow: number;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function displayName(a: { transferName: string; guid: string }): string {
  return a.transferName || a.guid || 'an attachment';
}

/**
 * Is this thing an image we can decode? PURE.
 *
 * Exported so the allowlist itself can be tested without building a payload.
 */
export function typeVerdict(mimeType: string, uti: string): 'image' | 'other' {
  const mime = mimeType.trim().toLowerCase();
  if (mime) return ALLOWED_MIME.has(mime) ? 'image' : 'other';
  const u = uti.trim().toLowerCase();
  if (u) return ALLOWED_UTI.has(u) ? 'image' : 'other';
  return 'other';
}

/**
 * Turn a webhook's `attachments` array into decisions. PURE — no I/O.
 *
 * Pure for the same reason `classifyPayload` is: every rule below is a measured
 * property of a real payload, and a rule that needs a live server to exercise is
 * a rule nobody re-checks after they change it.
 *
 * ⚠️ AN ABSENT OR EMPTY ARRAY IS NOT AN ERROR AND NOT A REJECTION. It is the
 * ordinary shape of a plain text message, and it is ALSO the shape of the
 * dropped-MMS case (a green/SMS photo whose text part synced and whose image
 * part never did — the message arrives with `attachments: []`). Those two are
 * indistinguishable from here, and must be: the caller knows whether it was
 * expecting an image, and this function does not.
 */
export function classifyAttachments(raw: unknown, limits: ImageLimits): ClassifiedAttachments {
  const list = Array.isArray(raw) ? raw : [];
  const usable: InboundAttachment[] = [];
  const rejected: RejectedAttachment[] = [];
  let overflow = 0;

  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const guid = str(rec['guid']);
    // Without a guid there is no download URL, so there is nothing to attempt.
    // Silent skip rather than a reject: we cannot even name it to a human.
    if (!guid) continue;

    const att: InboundAttachment = {
      guid,
      mimeType: str(rec['mimeType']),
      uti: str(rec['uti']),
      transferName: str(rec['transferName']),
      totalBytes:
        typeof rec['totalBytes'] === 'number' && Number.isFinite(rec['totalBytes'])
          ? rec['totalBytes']
          : 0,
    };

    if (typeVerdict(att.mimeType, att.uti) !== 'image') {
      rejected.push({
        reason: 'unsupported',
        name: displayName(att),
        detail: att.mimeType || att.uti || 'an unknown type',
      });
      continue;
    }

    /**
     * The CHEAP half of the ceiling. It rejects before a byte moves, which is
     * the point — a 60 MB photo should not be transcoded by the Mac and pushed
     * over the network just to be discarded at the end.
     *
     * ⚠️ It is emphatically NOT the whole ceiling. `totalBytes` under-reports a
     * HEIC by ~49% (see the field docs), so passing here means "worth trying",
     * never "small enough". `fetchImage` counts the real bytes.
     */
    if (att.totalBytes > limits.maxBytes) {
      rejected.push({
        reason: 'oversize',
        name: displayName(att),
        detail: `${Math.round(att.totalBytes / 1024 / 1024)} MB, over the ${Math.round(
          limits.maxBytes / 1024 / 1024,
        )} MB limit`,
      });
      continue;
    }

    if (usable.length >= limits.maxCount) {
      overflow += 1;
      continue;
    }
    usable.push(att);
  }

  return { usable, rejected, overflow };
}

export type FetchedImage =
  | { ok: true; base64: string; bytes: number; contentType: string; name: string }
  | { ok: false; reason: RejectReason; name: string; detail: string };

/**
 * The download URL.
 *
 * 🔴 `width` IS LOAD-BEARING AND IS NOT AN OPTIMISATION. It does three jobs at
 * once, all of them measured:
 *
 *  1. **It decodes HEIC.** iPhone photos arrive as `public.heic`, which no Go
 *     image decoder in the Ollama stack will read. BlueBubbles resizes through
 *     Electron's `nativeImage` and then — `attachmentRouter.ts`, the comment
 *     reads *"Force setting it to a PNG because all resized images are PNGs"* —
 *     hard-sets the response to `image/png`. Measured: a `public.heic` came back
 *     `image/png`, 1024x768. **This is why the Dockerfile needs no libheif.**
 *  2. **It bounds the bytes.** 5_409_496 → 1_319_699 on the photo measured.
 *  3. **It bounds the vision tokens**, which is the one that would otherwise
 *     hurt silently: `num_ctx` is 16384 and a 5712x4284 image is a lot of
 *     patches. A context blown by an image does not announce itself.
 *
 * ⚠️ NEVER `original=true`. That branch skips the convert step entirely and
 * hands back raw HEIC — the exact bytes nothing downstream can read.
 *
 * ⚠️ `width` is a REQUEST, not a guarantee: the resize path is skipped for
 * `image/gif` and for anything non-image, so a large GIF still arrives at full
 * size. That is precisely why the byte ceiling below is enforced on the wire and
 * not assumed from this parameter.
 */
export function downloadUrl(
  baseUrl: string,
  password: string,
  guid: string,
  maxWidth: number,
): string {
  const base = baseUrl.replace(/\/$/, '');
  return (
    `${base}/api/v1/attachment/${encodeURIComponent(guid)}/download` +
    `?password=${encodeURIComponent(password)}&width=${encodeURIComponent(String(maxWidth))}`
  );
}

export interface FetchImageOptions {
  baseUrl: string;
  password: string;
  limits: ImageLimits;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

/**
 * Download ONE attachment and return it as the base64 Ollama wants.
 *
 * 🔴 THE BYTES ARE COUNTED AS THEY ARRIVE AND THE STREAM IS CANCELLED THE
 * MOMENT THE CEILING IS CROSSED.
 *
 * The obvious implementation is `await res.arrayBuffer()` and then check
 * `byteLength`, and it is wrong in the way that matters: by the time it can
 * check, the whole file is already in memory and already came over the network.
 * That turns the ceiling into a REPORT about a transfer that has finished
 * rather than a LIMIT on one — which is the same thing as no limit when the
 * failure being guarded against is a 200 MB video. BlueBubbles streams the file
 * (`fs.createReadStream`, chunked, and it sets no `Content-Length`), so
 * `content-length` cannot be trusted to pre-empt this either.
 *
 * ⚠️ EVERY FAILURE HERE IS `unfetchable`, INCLUDING A CLEAN 404. We deliberately
 * do not read meaning out of BlueBubbles' status codes, because they do not
 * carry it: measured, an unknown guid returns **500** — not 404 — because
 * `force` defaults to true, the private API is enabled on this server, and the
 * route then dereferences a null attachment (`Cannot read properties of null
 * (reading 'filePath')`). A row whose file is missing from disk is ALSO a 500.
 * A taxonomy built on those codes would be a taxonomy of one BlueBubbles bug.
 */
export async function fetchImage(
  att: InboundAttachment,
  opts: FetchImageOptions,
): Promise<FetchedImage> {
  const name = displayName(att);
  const doFetch = opts.fetchImpl ?? fetch;
  const url = downloadUrl(opts.baseUrl, opts.password, att.guid, opts.limits.maxWidth);

  let res: Response;
  try {
    res = await doFetch(url, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
  } catch (e) {
    return { ok: false, reason: 'unfetchable', name, detail: (e as Error).message };
  }

  if (!res.ok) {
    return { ok: false, reason: 'unfetchable', name, detail: `http ${res.status}` };
  }

  const contentType = res.headers?.get?.('content-type') ?? '';

  let buf: Uint8Array;
  try {
    buf = await readCapped(res, opts.limits.maxBytes);
  } catch (e) {
    if (e instanceof OversizeError) {
      return {
        ok: false,
        reason: 'oversize',
        name,
        detail: `larger than the ${Math.round(opts.limits.maxBytes / 1024 / 1024)} MB limit`,
      };
    }
    return { ok: false, reason: 'unfetchable', name, detail: (e as Error).message };
  }

  /**
   * ⚠️ A ZERO-BYTE 200 IS A FAILURE, AND IT IS NOT HYPOTHETICAL. It is what an
   * attachment that never finished syncing looks like from here: the row exists,
   * so the route answers, and there is nothing behind it. Handing an empty
   * string to the model as though it were a picture is the worst of the
   * available outcomes — it produces a confident description of nothing.
   */
  if (buf.byteLength === 0) {
    return { ok: false, reason: 'unfetchable', name, detail: 'the server returned an empty file' };
  }

  return {
    ok: true,
    name,
    bytes: buf.byteLength,
    contentType,
    /**
     * 🔴 BARE BASE64 — NO `data:` PREFIX. Ollama's `/api/chat` takes
     * `messages[].images` as raw base64 strings and does not parse data URLs; a
     * prefixed string is accepted by the HTTP layer and then fails to decode,
     * which surfaces as the model simply not mentioning the image rather than as
     * an error.
     */
    base64: Buffer.from(buf).toString('base64'),
  };
}

class OversizeError extends Error {}

/**
 * Read a response body, refusing to hold more than `maxBytes` of it.
 *
 * Prefers the stream so the ceiling can actually STOP a transfer — `cancel()`
 * tears down the connection rather than politely reading to the end. The
 * `arrayBuffer` fallback exists only for a `Response`-alike without a body
 * stream, and is honest about what it is: a check after the fact.
 */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    const ab = await res.arrayBuffer();
    if (ab.byteLength > maxBytes) throw new OversizeError('over cap');
    return new Uint8Array(ab);
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // Stop the transfer. Do not read the rest just to measure it.
        await reader.cancel().catch(() => {});
        throw new OversizeError('over cap');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
