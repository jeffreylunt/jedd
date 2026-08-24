import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testConfig } from './helpers.js';
import { normaliseHandle, roleFor, roleSatisfies } from '../src/permissions.js';

const config = testConfig();

test('the owner is recognised across phone-number formatting', () => {
  for (const handle of ['+18015550123', '18015550123', '8015550123', '+1 (801) 555-0123']) {
    assert.equal(roleFor(handle, config), 'owner', `${handle} should be the owner`);
  }
});

test('anyone else is a guest', () => {
  for (const handle of ['+18015550999', 'someone@example.com', 'Preston2005']) {
    assert.equal(roleFor(handle, config), 'guest', `${handle} should be a guest`);
  }
});

test('a near-miss number is NOT the owner', () => {
  assert.equal(roleFor('+18015550124', config), 'guest');
});

test('🔴 SUFFIX ATTACK: a handle ENDING in the owner number is NOT the owner', () => {
  // The original normaliser compared the last 10 digits, so every handle below
  // resolved to owner — a complete authentication bypass for anyone who can
  // choose their own handle. The one-digit-different control above shares no
  // suffix with the owner, so it could never have detected this. These can.
  for (const handle of [
    '+448015550123', // different country code, same trailing digits
    '008015550123', // international prefix form
    '9998015550123', // arbitrary digits prepended
    '+1180155501238015550123', // owner number embedded then repeated
    '15558015550123',
  ]) {
    assert.equal(roleFor(handle, config), 'guest', `${handle} must NOT be the owner`);
  }
});

test('a handle that merely CONTAINS the owner number is not the owner', () => {
  assert.equal(roleFor('8015550123456', config), 'guest');
  assert.equal(roleFor('user+18015550123@example.com', config), 'guest');
});

test('legitimate formatting of the owner number still matches', () => {
  // The failing control for the fix above: if the normaliser became so strict
  // that real formatting variation stopped matching, the owner would be locked
  // out and the suffix test would still pass.
  for (const handle of ['+1 801-555-0123', '(801) 555-0123', '18015550123', '801.555.0123']) {
    assert.equal(roleFor(handle, config), 'owner', `${handle} should still be the owner`);
  }
});

test('malformed and empty handles fail closed to guest', () => {
  for (const handle of ['', '   ', '+', 'null', 'undefined']) {
    assert.equal(roleFor(handle, config), 'guest');
  }
});

test('an empty owner handle cannot be matched by an empty sender', () => {
  const broken = testConfig({ ownerHandle: '' });
  assert.equal(roleFor('', broken), 'guest');
  assert.equal(roleFor('anything', broken), 'guest');
});

test('a non-phone handle is not collapsed to digits', () => {
  // "user801555 0123" must not be mangled into the owner's number.
  assert.equal(normaliseHandle('user8015550123'), 'user8015550123');
  assert.equal(roleFor('user8015550123', config), 'guest');
});

test('roleSatisfies: guests never satisfy an owner requirement', () => {
  assert.equal(roleSatisfies('owner', 'owner'), true);
  assert.equal(roleSatisfies('owner', 'guest'), true);
  assert.equal(roleSatisfies('guest', 'guest'), true);
  assert.equal(roleSatisfies('guest', 'owner'), false);
});
