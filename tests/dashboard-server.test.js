'use strict';
/**
 * Regression tests for Fmarzochi/EGC#500
 *
 * Exercises the real createAccumulator() factory shared with
 * dashboard/server.js so these tests guard the production fix.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAccumulator } = require('../dashboard/accumulator');

// ---------------------------------------------------------------------------
// Tests — every scenario that should be caught by the guard clause
// ---------------------------------------------------------------------------

test('valid event with ide string creates provider state and counts tool calls', () => {
  const { providerState, accumulateEvent } = createAccumulator();
  assert.equal(Object.keys(providerState).length, 0);

  accumulateEvent({ ide: 'claude', event: 'pre_tool' });

  assert.ok(providerState.claude, 'provider state should exist for claude');
  assert.equal(providerState.claude.ide, 'claude');
  assert.equal(providerState.claude.toolCalls, 1);
  assert.ok(providerState.claude.running, 'provider should be marked running');
});

test('event without ide property does not create provider state', () => {
  const { providerState, accumulateEvent } = createAccumulator();
  accumulateEvent({ event: 'pre_tool' });
  assert.equal(Object.keys(providerState).length, 0);
});

test('event with explicitly undefined ide does not create provider state', () => {
  const { providerState, accumulateEvent } = createAccumulator();
  accumulateEvent({ ide: undefined, event: 'pre_tool' });
  assert.equal(Object.keys(providerState).length, 0);
});

test('event with empty string ide does not create provider state', () => {
  const { providerState, accumulateEvent } = createAccumulator();
  accumulateEvent({ ide: '', event: 'pre_tool' });
  assert.equal(Object.keys(providerState).length, 0);
});

test('event with numeric ide does not create provider state (typeof check)', () => {
  const { providerState, accumulateEvent } = createAccumulator();
  accumulateEvent({ ide: 42, event: 'pre_tool' });
  assert.equal(Object.keys(providerState).length, 0);
});

test('null event argument does not crash and creates no state', () => {
  const { providerState, accumulateEvent } = createAccumulator();
  accumulateEvent(null);
  assert.equal(Object.keys(providerState).length, 0);
});

test('undefined event argument does not crash and creates no state', () => {
  const { providerState, accumulateEvent } = createAccumulator();
  accumulateEvent(undefined);
  assert.equal(Object.keys(providerState).length, 0);
});

test('multiple valid events accumulate on the same provider', () => {
  const { providerState, accumulateEvent } = createAccumulator();

  accumulateEvent({ ide: 'claude', event: 'pre_tool' });
  accumulateEvent({ ide: 'claude', event: 'pre_tool' });
  accumulateEvent({ ide: 'claude', event: 'pre_tool' });

  assert.equal(providerState.claude.toolCalls, 3);
  assert.equal(Object.keys(providerState).length, 1,
    'only one provider should exist');
});

test('valid event returns true', () => {
  const { accumulateEvent } = createAccumulator();
  assert.equal(accumulateEvent({ ide: 'gemini', event: 'pre_tool' }), true);
});

test('invalid event returns false (broadcast guard)', () => {
  const { accumulateEvent } = createAccumulator();
  assert.equal(accumulateEvent({ event: 'pre_tool' }), false);
  assert.equal(accumulateEvent(null), false);
  assert.equal(accumulateEvent(undefined), false);
  assert.equal(accumulateEvent({ ide: '' }), false);
  assert.equal(accumulateEvent({ ide: 42 }), false);
});
