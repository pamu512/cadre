import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLane } from '../src/contract.js';

test('accepts a minimal valid lane', () => {
  const v = validateLane({
    name: 'ax-codex',
    good_at: ['edits'],
    cost: 'plan',
    talks: 'terminal',
    proves: 'diffs',
  });
  assert.equal(v.valid, true);
  assert.deepEqual(v.errors, []);
});

test('accepts a full seven-field lane', () => {
  const v = validateLane({
    name: 'maya',
    identity: 'human-reviewer',
    good_at: ['reviews', 'taste'],
    cost: 'coffee',
    talks: 'chat',
    proves: 'verdict',
    craft: ['read-before-reacting'],
    invoke: { slack: '@maya' },
  });
  assert.equal(v.valid, true);
});

test('rejects missing required fields', () => {
  const v = validateLane({ name: 'x' });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.startsWith('good_at')));
  assert.ok(v.errors.some((e) => e.startsWith('cost')));
});

test('rejects bad name shapes', () => {
  for (const name of ['-bad', 'Bad_Name', '', 'a'.repeat(40)]) {
    const v = validateLane({ name, good_at: ['x'], cost: 'free', talks: 'http', proves: 'diffs' });
    assert.equal(v.valid, false, `name "${name}" should fail`);
  }
});

test('rejects unknown enum values', () => {
  const v = validateLane({ name: 'x', good_at: ['x'], cost: 'cheap', talks: 'smtp', proves: 'vibes' });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.startsWith('cost')));
  assert.ok(v.errors.some((e) => e.startsWith('talks')));
  assert.ok(v.errors.some((e) => e.startsWith('proves')));
});

test('rejects unknown properties (closed contract)', () => {
  const v = validateLane({ name: 'x', good_at: ['x'], cost: 'free', talks: 'http', proves: 'diffs', nope: 1 });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.startsWith('nope')));
});

test('rejects empty good_at', () => {
  const v = validateLane({ name: 'x', good_at: [], cost: 'free', talks: 'http', proves: 'diffs' });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.startsWith('good_at')));
});
