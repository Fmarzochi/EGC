'use strict';
/**
 * Tests for dashboard/port.js — Fmarzochi/EGC#897
 *
 * port.js is require-cached after the first load, so each scenario is run in
 * a child process that inherits only the env vars we set explicitly.
 */

const { test } = require('node:test');
const assert  = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const NODE     = process.execPath;
const PORT_MOD = path.join(__dirname, '..', 'dashboard', 'port.js');

/**
 * Evaluate `require('./port').PORT` in a fresh child process with the given env,
 * returning the numeric PORT value.
 */
function loadPort(env = {}) {
  const script = `process.stdout.write(String(require(${JSON.stringify(PORT_MOD)}).PORT))`;
  const out = execFileSync(NODE, ['-e', script], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return Number(out.trim());
}

// ---------------------------------------------------------------------------

test('defaults to 7890 when EGC_PORT is not set', () => {
  const env = { ...process.env };
  delete env.EGC_PORT;
  const script = `process.stdout.write(String(require(${JSON.stringify(PORT_MOD)}).PORT))`;
  const out = execFileSync(NODE, ['-e', script], { env, encoding: 'utf8' });
  assert.equal(Number(out.trim()), 7890);
});

test('honours EGC_PORT when set to a valid number', () => {
  assert.equal(loadPort({ EGC_PORT: '8123' }), 8123);
});

test('honours EGC_PORT=1 (minimum valid port)', () => {
  assert.equal(loadPort({ EGC_PORT: '1' }), 1);
});

test('honours EGC_PORT=65535 (maximum valid port)', () => {
  assert.equal(loadPort({ EGC_PORT: '65535' }), 65535);
});

test('falls back to 7890 when EGC_PORT is not a number', () => {
  assert.equal(loadPort({ EGC_PORT: 'banana' }), 7890);
});

test('falls back to 7890 when EGC_PORT is 0 (out of range)', () => {
  assert.equal(loadPort({ EGC_PORT: '0' }), 7890);
});

test('falls back to 7890 when EGC_PORT is 65536 (out of range)', () => {
  assert.equal(loadPort({ EGC_PORT: '65536' }), 7890);
});

test('falls back to 7890 when EGC_PORT is empty string', () => {
  assert.equal(loadPort({ EGC_PORT: '' }), 7890);
});

test('PORT export is a number, not a string', () => {
  const script = `process.stdout.write(typeof require(${JSON.stringify(PORT_MOD)}).PORT)`;
  const out = execFileSync(NODE, ['-e', script], { encoding: 'utf8' });
  assert.equal(out.trim(), 'number');
});
