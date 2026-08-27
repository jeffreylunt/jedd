import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { test } from 'node:test';
import { unzipSingleTextEntry } from '../src/media/irc-unzip.js';

/**
 * The results archive comes from a stranger. These cover the shapes that would
 * otherwise turn a hostile or merely odd archive into a MANUFACTURED ABSENCE —
 * "IRC found nothing", when the truth is "we could not read the listing".
 */

interface Entry {
  name: string;
  body: Buffer;
}

/** Build a multi-entry ZIP with a correct central directory. */
function makeZip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const cds: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = deflateRawSync(e.body);
    const nameBuf = Buffer.from(e.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32BE(0x504b0304, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(e.body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const all = Buffer.concat([local, nameBuf, data]);
    locals.push(all);

    const cd = Buffer.alloc(46);
    cd.writeUInt32BE(0x504b0102, 0);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(e.body.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    cds.push(Buffer.concat([cd, nameBuf]));
    offset += all.length;
  }
  const localAll = Buffer.concat(locals);
  const cdAll = Buffer.concat(cds);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32BE(0x504b0506, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdAll.length, 12);
  eocd.writeUInt32LE(localAll.length, 16);
  return Buffer.concat([localAll, cdAll, eocd]);
}

test('a single-entry results zip reads', () => {
  const z = makeZip([{ name: 'results.txt', body: Buffer.from('!Bsk A.epub ::INFO:: 1MB') }]);
  const r = unzipSingleTextEntry(z);
  assert.equal(r.state, 'ok');
  if (r.state === 'ok') assert.match(r.text, /!Bsk A\.epub/);
});

test('🔴 the .txt is found even when it is NOT the first entry', () => {
  // Reading entry 0 blindly returned the junk and reported "nothing fetchable".
  const z = makeZip([
    { name: 'junk.bin', body: Buffer.from('GARBAGE-NOT-RESULTS') },
    { name: 'results.txt', body: Buffer.from('!Bsk Real.epub ::INFO:: 2MB') },
  ]);
  const r = unzipSingleTextEntry(z);
  assert.equal(r.state, 'ok');
  if (r.state === 'ok') {
    assert.match(r.text, /!Bsk Real\.epub/);
    assert.ok(!r.text.includes('GARBAGE'), 'the wrong entry must not be returned as the listing');
  }
});

test('🔴 an archive with no listing is REPORTED, not read as an empty result', () => {
  const z = makeZip([{ name: 'surprise.exe', body: Buffer.from('MZ...') }]);
  const r = unzipSingleTextEntry(z);
  assert.equal(r.state, 'failed');
  assert.match(r.detail, /no \.txt listing/);
  assert.match(r.detail, /not an empty result/);
  assert.match(r.detail, /surprise\.exe/, 'name what it actually held');
});

test('non-ZIP input fails closed', () => {
  assert.equal(unzipSingleTextEntry(Buffer.from('not a zip at all')).state, 'failed');
  assert.equal(unzipSingleTextEntry(Buffer.alloc(0)).state, 'failed');
  assert.equal(unzipSingleTextEntry(Buffer.alloc(4, 0)).state, 'failed');
});

test('a truncated archive fails closed rather than throwing', () => {
  const z = makeZip([{ name: 'results.txt', body: Buffer.from('!Bsk A.epub') }]);
  for (const cut of [10, 30, z.length - 5]) {
    const r = unzipSingleTextEntry(z.subarray(0, cut));
    assert.equal(r.state, 'failed', `cut at ${cut}`);
  }
});

test('🔴 a declared decompression bomb is refused before inflating', () => {
  const z = makeZip([{ name: 'results.txt', body: Buffer.from('x') }]);
  // Overstate the uncompressed size in the central directory.
  const eocd = z.length - 22;
  const cdOffset = z.readUInt32LE(eocd + 16);
  z.writeUInt32LE(4 * 1024 * 1024 * 1024 - 1, cdOffset + 24);
  const r = unzipSingleTextEntry(z);
  assert.equal(r.state, 'failed');
  assert.match(r.detail, /refusing/);
});

test('a zero-entry directory is refused', () => {
  const z = makeZip([{ name: 'results.txt', body: Buffer.from('x') }]);
  z.writeUInt16LE(0, z.length - 22 + 10);
  assert.equal(unzipSingleTextEntry(z).state, 'failed');
});
