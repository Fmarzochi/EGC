'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { INLINE_RESOLVE, INLINE_RESOLVE_FN } = require('../../scripts/lib/resolve-egc-root');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message || String(error));
    failed += 1;
  }
}

const REPO = path.join(__dirname, '..', '..');
const read = relative => fs.readFileSync(path.join(REPO, relative), 'utf8');
const count = (text, needle) => text.split(needle).length - 1;
// What every older copy started with: the retired Gemini CLI's home as the EGC root.
const OLD_RESOLVER_MARKS = ["d=p.join(h,'.gemini')", "claudeDir=path.join(home,'.gemini')", "p.join(d,'plugins'"];

const sessionsDoc = read('commands/sessions.md');
const skillHealthDoc = read('commands/skill-health.md');
const autoUpdateDoc = read('commands/auto-update.md');
const hookCommands = (() => {
  const hooks = JSON.parse(read('hooks/hooks.json'));
  const commands = [];
  const walk = node => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      if (typeof node.command === 'string') commands.push(node.command);
      Object.values(node).forEach(walk);
    }
  };
  walk(hooks.hooks);
  return commands;
})();

test('sessions command resolves the root with the shared resolver in all six scripts', () => {
  assert.strictEqual(count(sessionsDoc, `const _r = ${INLINE_RESOLVE};`), 6);
});

test('skill-health command resolves the root that holds skills-health.js', () => {
  assert.strictEqual(count(skillHealthDoc, `${INLINE_RESOLVE_FN}('scripts/skills-health.js')`), 3);
});

test('auto-update command resolves the root that holds auto-update.js', () => {
  assert.strictEqual(count(autoUpdateDoc, `${INLINE_RESOLVE_FN}('scripts/auto-update.js')`), 1);
});

test('every hook that runs an EGC script embeds the shared resolver', () => {
  const runningScripts = hookCommands.filter(command => command.includes('scripts/'));
  assert.ok(runningScripts.length > 0, 'hooks.json should run EGC scripts');
  for (const command of runningScripts) {
    assert.ok(command.includes(INLINE_RESOLVE_FN), `not the shared resolver: ${command.slice(0, 100)}...`);
  }
});

test('no command or hook keeps the resolver of the retired Gemini CLI', () => {
  for (const [name, text] of [['sessions.md', sessionsDoc], ['skill-health.md', skillHealthDoc], ['auto-update.md', autoUpdateDoc], ['hooks.json', hookCommands.join('\n')]]) {
    for (const mark of OLD_RESOLVER_MARKS) {
      assert.ok(!text.includes(mark), `${name} still holds ${mark}`);
    }
    assert.ok(!text.includes('${GEMINI_PLUGIN_ROOT'), `${name} still expands GEMINI_PLUGIN_ROOT in the shell`);
  }
});

console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

process.exit(failed > 0 ? 1 : 0);
