import { inflateRawSync } from 'node:zlib';

/**
 * Read the single text entry out of SearchBot's results `.txt.zip`.
 *
 * A dependency-free ZIP reader exists here because the alternative was adding an
 * npm package to open **an archive handed to us by a stranger**, and this
 * project's whole ebook path is built around not doing that. The scope is
 * deliberately tiny: one entry, in memory, never written to disk, so there is no
 * path-traversal surface at all.
 *
 * ⚠️ Reads sizes from the **central directory**, not the local file header. When
 * general-purpose flag bit 3 is set the local header carries zeroes and the real
 * sizes live in a trailing data descriptor — the same class of trap as the EPUB
 * flags field, and the central directory is the copy that is always populated.
 */

export type UnzipOutcome =
  | { state: 'ok'; text: string }
  | { state: 'failed'; detail: string };

/** Refuse to inflate a decompression bomb. Results files measure ~2.5 KB. */
const MAX_INFLATED_BYTES = 8 * 1024 * 1024;

export function unzipSingleTextEntry(buf: Buffer): UnzipOutcome {
  try {
    if (buf.length < 22) return { state: 'failed', detail: `only ${buf.length} bytes — not a ZIP.` };
    if (buf.readUInt32BE(0) !== 0x504b0304) {
      return { state: 'failed', detail: 'the results file is not a ZIP archive.' };
    }

    const eocd = findEocd(buf);
    if (eocd < 0) return { state: 'failed', detail: 'no ZIP central directory found.' };

    const entries = buf.readUInt16LE(eocd + 10);
    if (entries < 1) return { state: 'failed', detail: 'the ZIP is empty.' };
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (cdOffset + 46 > buf.length) return { state: 'failed', detail: 'the ZIP directory is truncated.' };
    if (buf.readUInt32BE(cdOffset) !== 0x504b0102) {
      return { state: 'failed', detail: 'the ZIP directory is malformed.' };
    }

    const method = buf.readUInt16LE(cdOffset + 10);
    const compressedSize = buf.readUInt32LE(cdOffset + 20);
    const uncompressedSize = buf.readUInt32LE(cdOffset + 24);
    const nameLen = buf.readUInt16LE(cdOffset + 28);
    const localOffset = buf.readUInt32LE(cdOffset + 42);

    if (uncompressedSize > MAX_INFLATED_BYTES) {
      return { state: 'failed', detail: `the results file claims ${uncompressedSize} bytes — refusing.` };
    }
    if (localOffset + 30 > buf.length) return { state: 'failed', detail: 'the ZIP entry is truncated.' };

    // The local header's own name/extra lengths are what locate the data; the
    // central directory's extra-field length is a DIFFERENT number.
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buf.length) return { state: 'failed', detail: 'the ZIP entry data is truncated.' };

    const data = buf.subarray(dataStart, dataEnd);
    let text: Buffer;
    if (method === 0) {
      text = data;
    } else if (method === 8) {
      text = inflateRawSync(data, { maxOutputLength: MAX_INFLATED_BYTES });
    } else {
      return { state: 'failed', detail: `unsupported ZIP compression method ${method}.` };
    }
    void nameLen;
    void entries;
    return { state: 'ok', text: text.toString('utf8') };
  } catch (e) {
    // A stranger's archive must not be able to throw into a caller.
    return { state: 'failed', detail: `could not read the results archive: ${(e as Error).message}` };
  }
}

/** Scan backwards for the End Of Central Directory signature. */
function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 65_557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32BE(i) === 0x504b0506) return i;
  }
  return -1;
}
