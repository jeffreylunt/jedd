import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Config } from '../src/config.js';
import { normaliseHandle, roleFor, roleSatisfies } from '../src/permissions.js';

const config = { ownerHandle: '+18015550123' } as Config;

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

test('a near-miss number is NOT the owner (failing control for the normaliser)', () => {
  // One digit different. If normalisation ever became sloppy enough to pass
  // this, the whole boundary is gone.
  assert.equal(roleFor('+18015550124', config), 'guest');
});

test('malformed and empty handles fail closed to guest', () => {
  for (const handle of ['', '   ', '+', 'null', 'undefined']) {
    assert.equal(roleFor(handle, config), 'guest');
  }
});

test('an empty owner handle cannot be matched by an empty sender', () => {
  const broken = { ownerHandle: '' } as Config;
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
