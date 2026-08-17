'use strict';

// Verifies the Scrubber write hook is wired into hooks.json so it actually runs
// at Write/Edit/MultiEdit time (the automatic activation, not just the module).

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    return true;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    Error: ${err.stack}`);
    return false;
  }
}

let passed = 0;
let failed = 0;
function check(name, fn) {
  if (test(name, fn)) passed += 1;
  else failed += 1;
}

const repoRoot = path.resolve(__dirname, '../..');
const hooks = JSON.parse(fs.readFileSync(path.join(repoRoot, 'hooks/hooks.json'), 'utf8'));

function scrubberMatcher() {
  return hooks.hooks.PreToolUse.find(m => m.id === 'pre:scrubber');
}

check('a pre:scrubber matcher is registered for Write/Edit/MultiEdit', () => {
  const m = scrubberMatcher();
  assert.ok(m, 'pre:scrubber matcher missing from hooks.json');
  assert.strictEqual(m.matcher, 'Write|Edit|MultiEdit');
  assert.ok(Array.isArray(m.hooks) && m.hooks.length === 1);
});

check('the scrubber matcher dispatches through run-with-flags to scrubber-hook.js', () => {
  const hook = scrubberMatcher().hooks[0];
  assert.strictEqual(hook.type, 'command');
  assert.ok(hook.command.includes('run-with-flags.js pre:scrubber scripts/hooks/scrubber-hook.js'));
  assert.ok(/scrubber-hook\.js standard/.test(hook.command), 'scrubber must be active in the default (standard) profile');
  assert.ok(typeof hook.timeout === 'number' && hook.timeout > 0);
});

check('the referenced scrubber hook script exists', () => {
  assert.ok(fs.existsSync(path.join(repoRoot, 'scripts/hooks/scrubber-hook.js')));
});

check('the scrubber hook exports run() so run-with-flags uses the fast require path', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'scripts/hooks/scrubber-hook.js'), 'utf8');
  assert.ok(/\bmodule\.exports\b/.test(src) && /\brun\b/.test(src));
});

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
