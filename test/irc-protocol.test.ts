import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bareNick, intToIp, parseDccSend, parseSearchResults, parseSize } from '../src/media/irc-protocol.js';

/**
 * 🔴 THE REAL RESULTS FILE, verbatim.
 *
 * Captured from `SearchOok` on 2026-08-26 for the query "project hail mary" —
 * DCC-fetched, unzipped, and pasted here unedited including the odd spacing.
 * Every grammar surprise this parser exists for is in these lines, and a fixture
 * written from the documented format would contain none of them.
 */
const REAL_RESULTS = `Search results from SearchBot v3.00.13 by Ook, searching dll written by Ook, Based on Searchbot v2.22 by Dukelupus
Searched 15 lists for "project hail mary" , found 27 matches. Enjoy!
This list includes results from ALL the lists SearchBot v3.00.13 currently has, some of these servers may be offline.
Always check to be sure the server you want to make a request from is actually in the channel, otherwise your request will have no effect.

!artemis_serv 19e6ed17f8f3 | Andy Weir - Project Hail Mary (Audiobook).zip ::INFO:: 794.50MB
!Ashurbanipal ihdfQTTsviTV9ot4B8V+MQ - Andy Weir - Project Hail Mary [eng]  (EPUB) 2.5 MB - [Science Fiction, Adult, Mystery, Thriller, Fantasy]
!Bsk Project Hail Mary - Andy Weir.epub ::INFO:: 2.5MB
!Bsk Weir, Andy - Project Hail Mary - Weir, Andy.epub ::INFO:: 9.37MB
!Dumbledore Andy Weir - Project Hail Mary (Retail).epub
!Dumbledore Andy Weir - Project Hail Mary (epub).epub
!Firebound %0D13448072AD% Andy Weir - Project Hail Mary (Retail).epub  ::INFO:: 9.80 MB
!Oatmeal Project Hail Mary - Andy Weir.epub ::INFO:: 654.35KB
!Ook Andy Weir - Project Hail Mary (epub).rar  ::INFO:: 9MB ::HASH:: 3e5ffb77a1195ac4
!PCplagueSrv Project Hail Mary - Andy Weir.azw3     ::INFO:: 4.82 MiB
!peapod Andy Weir - Project Hail Mary(mobi).rar  ::INFO:: 2.34MB
!peapod Project Hail Mary - Andy Weir(azw3).rar  ::INFO:: 1.61MB
!TrainFiles 89545d3f6f7a | Weir, Andy - Project Hail Mary (audiobook).zip ::INFO:: 444.50MB
!Wench Andy Weir - Project Hail Mary.mobi  ::INFO:: 2.8MB
`;

test('the documented ::INFO:: grammar parses, command and size both', () => {
  const { results } = parseSearchResults(REAL_RESULTS);
  const bsk = results.find((r) => r.command === '!Bsk Project Hail Mary - Andy Weir.epub');
  assert.ok(bsk, 'the plainest real line must parse');
  assert.equal(bsk.bot, 'Bsk');
  assert.equal(bsk.ext, '.epub');
  assert.equal(bsk.sizeBytes, Math.round(2.5 * 1024 ** 2));
});

test('🔴 a line with NO ::INFO:: still parses, with size UNDEFINED not zero', () => {
  const { results } = parseSearchResults(REAL_RESULTS);
  const d = results.find((r) => r.command === '!Dumbledore Andy Weir - Project Hail Mary (Retail).epub');
  assert.ok(d, 'the old note said every line has ::INFO::; this one does not');
  assert.equal(d.sizeBytes, undefined, 'a missing size must not read as an empty file');
});

test('🔴 the Ashurbanipal grammar is SKIPPED, not guessed at', () => {
  const { results, unparsed } = parseSearchResults(REAL_RESULTS);
  assert.ok(!results.some((r) => r.bot === 'Ashurbanipal'), 'we do not understand this grammar');
  assert.ok(unparsed >= 1, 'and it must be COUNTED, not silently dropped');
  // The specific harm avoided: split("::")[0] would have sent the genre tags.
  assert.ok(!results.some((r) => r.command.includes('[Science Fiction')));
});

test('::HASH:: as a third field does not leak into the command', () => {
  const { results } = parseSearchResults(REAL_RESULTS);
  assert.ok(!results.some((r) => r.command.includes('3e5ffb77a1195ac4')));
});

test('🔴 archives are filtered even when the title says (epub)', () => {
  const { results } = parseSearchResults(REAL_RESULTS);
  // "Andy Weir - Project Hail Mary (epub).rar" is a RAR wearing the word epub.
  assert.ok(!results.some((r) => r.ext === '.rar'), 'taking the LAST .ext match would offer this');
  assert.ok(!results.some((r) => r.command.toLowerCase().endsWith('.rar')));
});

test('🔴 the 794MB and 444MB audiobook zips never reach the list', () => {
  const { results } = parseSearchResults(REAL_RESULTS);
  assert.ok(!results.some((r) => r.command.includes('Audiobook')));
  assert.ok(!results.some((r) => r.command.includes('audiobook')));
  assert.ok(!results.some((r) => (r.sizeBytes ?? 0) > 100 * 1024 ** 2));
});

test('.mobi is filtered from the offer list', () => {
  const { results, filtered } = parseSearchResults(REAL_RESULTS);
  assert.ok(!results.some((r) => r.ext === '.mobi'));
  assert.ok(filtered > 0);
});

test('an .azw3 with irregular whitespace before ::INFO:: parses', () => {
  const { results } = parseSearchResults(REAL_RESULTS);
  const p = results.find((r) => r.bot === 'PCplagueSrv');
  assert.ok(p);
  assert.equal(p.command, '!PCplagueSrv Project Hail Mary - Andy Weir.azw3');
  assert.equal(p.ext, '.azw3');
  assert.equal(p.sizeBytes, Math.round(4.82 * 1024 ** 2), 'MiB must parse like MB');
});

test('a %HEX% token is kept in the command but dropped from the title', () => {
  const { results } = parseSearchResults(REAL_RESULTS);
  const f = results.find((r) => r.bot === 'Firebound');
  assert.ok(f);
  assert.match(f.command, /%0D13448072AD%/, 'the bot expects its own token back verbatim');
  assert.ok(!f.title.includes('%0D13448072AD%'), 'but a human should not see it');
});

test('every surviving result is a sendable format', () => {
  const { results } = parseSearchResults(REAL_RESULTS);
  assert.ok(results.length > 0);
  for (const r of results) assert.ok(['.epub', '.azw3', '.pdf'].includes(r.ext), r.command);
});

test('sizes parse across every spelling the bots use', () => {
  assert.equal(parseSize('::INFO:: 2.5MB'), Math.round(2.5 * 1024 ** 2));
  assert.equal(parseSize('::INFO:: 9.80 MB'), Math.round(9.8 * 1024 ** 2));
  assert.equal(parseSize('::INFO:: 4.82 MiB'), Math.round(4.82 * 1024 ** 2));
  assert.equal(parseSize('::INFO:: 654.35KB'), Math.round(654.35 * 1024));
  assert.equal(parseSize('::INFO:: 794.50MB'), Math.round(794.5 * 1024 ** 2));
  assert.equal(parseSize('no size here'), undefined);
});

test('DCC SEND parses both the bare and the quoted filename form', () => {
  const bare = parseDccSend('\x01DCC SEND SearchOok_results.txt.zip 1544780096 2050 1152\x01');
  assert.equal(bare.state, 'ok');
  if (bare.state === 'ok') {
    assert.equal(bare.filename, 'SearchOok_results.txt.zip');
    assert.equal(bare.ip, '92.19.121.64');
    assert.equal(bare.port, 2050);
    assert.equal(bare.size, 1152);
  }

  const quoted = parseDccSend('\x01DCC SEND "Project Hail Mary - Andy Weir.epub" 2985527812 10056 2622079\x01');
  assert.equal(quoted.state, 'ok');
  if (quoted.state === 'ok') {
    assert.equal(quoted.filename, 'Project Hail Mary - Andy Weir.epub');
    assert.equal(quoted.ip, '177.243.138.4');
    assert.equal(quoted.size, 2622079);
  }
});

test('DCC SEND works without the CTCP \\x01 delimiters', () => {
  const v = parseDccSend('DCC SEND book.epub 1544780096 2050 1152');
  assert.equal(v.state, 'ok');
});

test('🔴 passive DCC (port 0) is its own state, never attempted', () => {
  const v = parseDccSend('\x01DCC SEND "x.epub" 2985527812 0 2622079 12345\x01');
  assert.equal(v.state, 'passive');
  if (v.state === 'passive') assert.match(v.detail, /incoming connection|not supported/i);
});

test('a malformed DCC line is unparsed rather than half-read', () => {
  assert.equal(parseDccSend('\x01DCC SEND broken\x01').state, 'unparsed');
  assert.equal(parseDccSend('just a chat message').state, 'unparsed');
});

test('intToIp uses big-endian byte order', () => {
  assert.equal(intToIp(2130706433), '127.0.0.1');
  assert.equal(intToIp(0), '0.0.0.0');
});

test('bareNick strips every op prefix the roster uses', () => {
  assert.equal(bareNick('@Bsk'), 'Bsk');
  assert.equal(bareNick('+Ook'), 'Ook');
  assert.equal(bareNick('~x'), 'x');
  assert.equal(bareNick('Oatmeal'), 'Oatmeal');
});

test('header and blurb lines never become results', () => {
  const { results } = parseSearchResults(REAL_RESULTS);
  assert.ok(!results.some((r) => r.command.includes('Search results from')));
  assert.ok(!results.some((r) => r.command.includes('Always check')));
});
