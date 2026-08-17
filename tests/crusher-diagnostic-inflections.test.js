'use strict';

const assert = require('node:assert');
const path = require('node:path');

const { crushOutput } = require(
  path.join(__dirname, '..', 'scripts', 'lib', 'crusher', 'engine.js')
);

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    return true;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    return false;
  }
}

let passed = 0;
let failed = 0;
const run = (name, fn) => { if (test(name, fn)) passed++; else failed++; };

console.log('\n=== Testing Token Crusher diagnostic inflections ===\n');

run('preserves common English diagnostic inflections outside the summary tail', () => {
  const lines = [];
  for (let i = 0; i < 150; i++) lines.push(`  ok test case number ${i} completed normally`);

  lines.push("thread 'tests::handles_bad_input' panicked at src/lib.rs:42:5:");
  lines.push('2 warnings generated');
  lines.push('There were 3 failures');
  lines.push('4 errors detected');
  lines.push('2 exceptions raised');
  lines.push('test retry_path fails intermittently');
  lines.push('compiler warned about an obsolete flag');

  for (let i = 150; i < 300; i++) lines.push(`  ok test case number ${i} completed normally`);
  lines.push('done');

  const result = crushOutput('cargo test', lines.join('\n'));
  assert.ok(result, 'large cargo test output should be crushed');
  assert.ok(result.crushed.includes('panicked at src/lib.rs:42:5'), 'Rust panic location survives');
  assert.ok(result.crushed.includes('2 warnings generated'), 'plural warnings survive');
  assert.ok(result.crushed.includes('3 failures'), 'plural failures survive');
  assert.ok(result.crushed.includes('4 errors detected'), 'plural errors survive');
  assert.ok(result.crushed.includes('2 exceptions raised'), 'plural exceptions survive');
  assert.ok(result.crushed.includes('retry_path fails'), 'present-tense fails survives');
  assert.ok(result.crushed.includes('compiler warned'), 'past-tense warned survives');
});

run('does not treat diagnostic-looking identifier substrings as keep words', () => {
  const lines = [];
  for (let i = 0; i < 150; i++) lines.push(`  ok test case number ${i} completed normally`);

  lines.push('panicRoom is a feature flag');
  lines.push('warningsCount=2');
  lines.push('failureMode=true');
  lines.push('errorCode=500');
  lines.push('failsafe enabled');

  for (let i = 150; i < 300; i++) lines.push(`  ok test case number ${i} completed normally`);
  lines.push('done');

  const result = crushOutput('cargo test', lines.join('\n'));
  assert.ok(result, 'large cargo test output should be crushed');
  assert.ok(!result.crushed.includes('panicRoom'), 'panicRoom is not a panic diagnostic');
  assert.ok(!result.crushed.includes('warningsCount'), 'warningsCount is not a warning diagnostic');
  assert.ok(!result.crushed.includes('failureMode'), 'failureMode is not a failure diagnostic');
  assert.ok(!result.crushed.includes('errorCode'), 'errorCode is not an error diagnostic');
  assert.ok(!result.crushed.includes('failsafe'), 'failsafe is not a failure diagnostic');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
