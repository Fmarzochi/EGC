'use strict';
/**
 * The hook surfaces of the tools EGC installs into are written the way
 * .git/hooks is: the person and the installer write them, the agent does
 * not, and reading stays free. A hook configuration (Claude Code's
 * settings.json, the hooks.json of Codex, Antigravity, Cursor, Copilot,
 * Devin Desktop, Trae and OpenHands, Devin Local's config.json, Kiro's agent
 * files and hook panel, Cline's hooks directory, Junie's config.json, Crush's
 * crush.json, the plugin directories of OpenCode, Amp and Goose, CodeBuddy's
 * and Qwen's settings.json) and the directories EGC installs its hook scripts
 * into run on the next session without anyone reading them first.
 *
 * Run with: node tests/egc-guardian-hook-surfaces.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'validator.js');

if (!fs.existsSync(buildPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}

const { validateCommand, validateWrite } = require(buildPath);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${error.message}`);
    failed++;
  }
}

// A stand-in for a home directory and for a project, so the paths below are
// judged by their shape alone, never by the machine the test runs on.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-hook-surfaces-'));
const project = path.join(home, 'work', 'app');
fs.mkdirSync(project, { recursive: true });

function at(root, ...segments) {
  return path.join(root, ...segments);
}

const HOOK_CONFIGURATIONS = [
  at(home, '.claude', 'settings.json'),
  at(project, '.claude', 'settings.json'),
  at(project, '.claude', 'settings.local.json'),
  at(home, '.claude', 'hooks', 'pre-commit.sh'),
  at(project, '.claude', 'hooks', 'quality-gate.md'),
  at(home, '.codex', 'hooks.json'),
  at(home, '.gemini', 'config', 'hooks.json'),
  at(home, '.gemini', 'antigravity-cli', 'hooks.json'),
  at(project, '.agents', 'hooks.json'),
  at(home, '.cursor', 'hooks.json'),
  at(project, '.cursor', 'hooks.json'),
  at(home, '.copilot', 'hooks', 'hooks.json'),
  at(home, '.codeium', 'windsurf', 'hooks.json'),
  at(project, '.windsurf', 'hooks.json'),
  at(project, '.devin', 'hooks.json'),
  at(project, '.devin', 'hooks.v1.json'),
  at(project, '.devin', 'config.local.json'),
  at(home, '.config', 'devin', 'config.json'),
  at(project, '.kiro', 'agents', 'default.json'),
  at(home, '.kiro', 'agents', 'reviewer.json'),
  at(project, '.kiro', 'hooks', 'quality-gate.kiro.hook'),
  at(project, '.clinerules', 'hooks', 'PreToolUse'),
  at(project, '.clinerules', 'hooks', 'PreToolUse.ps1'),
  at(project, '.openhands', 'hooks.json'),
  at(home, '.openhands', 'hooks.json'),
  at(home, '.agents', 'plugins', 'egc-guardian', 'hooks', 'hooks.json'),
  at(home, '.junie', 'config.json'),
  at(home, '.config', 'crush', 'crush.json'),
  at(home, 'crush-config', 'crush', 'crush.json'),
  at(project, 'crush.json'),
  at(project, '.crush.json'),
  at(home, '.config', 'opencode', 'plugins', 'opencode-egc-plugin.js'),
  at(home, '.config', 'opencode', 'plugin', 'anything.ts'),
  at(home, '.config', 'amp', 'plugins', 'egc-guardian-crusher.ts'),
  at(project, '.trae', 'hooks.json'),
  at(project, '.codebuddy', 'settings.json'),
  at(project, '.qwen', 'settings.json'),
];

const HOOK_SCRIPT_DIRECTORIES = [
  at(home, '.claude', 'scripts', 'hooks', 'bash-hook-dispatcher.js'),
  at(home, '.claude', 'scripts', 'lib', 'utils.js'),
  at(home, '.claude', 'egc', 'hooks', 'claude-session-start.js'),
  at(home, '.gemini', 'scripts', 'hooks', 'gateguard-fact-force.js'),
  at(home, '.agents', 'scripts', 'hooks', 'crusher-hook.js'),
  at(home, '.codex', 'scripts', 'hooks', 'pre-bash-guardian-validate.js'),
  at(home, '.config', 'opencode', 'scripts', 'hooks', 'opencode-session-start.js'),
  at(home, '.junie', 'scripts', 'hooks', 'junie-guardian-adapter.js'),
  at(home, '.config', 'crush', 'scripts', 'hooks', 'crush-guardian-adapter.js'),
  at(home, '.codeium', 'windsurf', 'scripts', 'hooks', 'windsurf-guardian-adapter.js'),
  at(home, '.agents', 'plugins', 'egc-guardian', 'scripts', 'hooks', 'goose-guardian-adapter.js'),
  at(project, '.cursor', 'hooks', 'before-shell-execution.js'),
  at(project, '.cursor', 'scripts', 'hooks', 'cursor-guardian-adapter.js'),
  at(project, '.agents', 'scripts', 'lib', 'utils.js'),
  at(project, '.trae', 'scripts', 'hooks', 'crusher-hook.js'),
  at(project, '.clinerules', 'scripts', 'hooks', 'cline-guardian-adapter.js'),
  at(project, '.windsurf', 'scripts', 'hooks', 'windsurf-gateguard-adapter.js'),
  at(project, '.codebuddy', 'scripts', 'hooks', 'gateguard-fact-force.js'),
  at(project, '.qwen', 'scripts', 'hooks', 'pre-bash-guardian-validate.js'),
  at(project, '.kiro', 'scripts', 'hooks', 'kiro-guardian-adapter.js'),
];

// What stays writable: the files next to a hook surface that are not one,
// and a repository's own sources, including the EGC repository's scripts.
const STILL_WRITABLE = [
  at(home, '.claude', 'CLAUDE.md'),
  at(home, '.claude', 'skills', 'tdd-workflow', 'SKILL.md'),
  at(home, '.claude', 'projects', 'app', 'memory', 'MEMORY.md'),
  at(home, '.claude', 'egc', 'notes.md'),
  at(home, '.gemini', 'config', 'rules', 'egc.md'),
  at(home, '.config', 'opencode', 'egc-memory.md'),
  at(home, '.config', 'crush', 'CRUSH.md'),
  at(home, '.kiro', 'steering', 'security.md'),
  at(project, '.kiro', 'skills', 'api-design', 'SKILL.md'),
  at(project, '.agents', 'skills', 'egc', 'SKILL.md'),
  at(project, '.cursor', 'rules', 'egc-context.mdc'),
  at(project, 'scripts', 'hooks', 'session-end.js'),
  at(project, 'scripts', 'lib', 'utils.js'),
  at(project, 'hooks', 'hooks.json'),
  at(project, '.opencode', 'plugins', 'egc-hooks.ts'),
  at(project, 'settings.json'),
  at(project, 'src', 'hooks', 'useThing.ts'),
  at(project, 'config.json'),
];

console.log('\n=== Testing the hook surfaces of the tools ===\n');

test('a hook configuration of a tool is not written by the agent', () => {
  for (const file of HOOK_CONFIGURATIONS) {
    const verdict = validateWrite(file, project);
    assert.strictEqual(verdict.allowed, false, `${file} must be refused`);
  }
});

test('a directory EGC installs hook scripts into is not written by the agent', () => {
  for (const file of HOOK_SCRIPT_DIRECTORIES) {
    const verdict = validateWrite(file, project);
    assert.strictEqual(verdict.allowed, false, `${file} must be refused`);
  }
});

test('the files next to a hook surface, and a repository of its own, stay writable', () => {
  for (const file of STILL_WRITABLE) {
    const verdict = validateWrite(file, project);
    assert.strictEqual(verdict.allowed, true, `${file}: ${verdict.reason}`);
  }
});

test('a link does not take a hook surface out of the rule, in either direction', () => {
  // A hook script that is a link to a file elsewhere: the tool still runs
  // what the link leads to, so the name under the hooks directory counts.
  const elsewhere = at(home, 'elsewhere', 'dispatcher.js');
  fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
  fs.writeFileSync(elsewhere, '');
  const hooksDir = at(home, '.claude', 'scripts', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.symlinkSync(elsewhere, at(hooksDir, 'dispatcher.js'));
  const refusedAsSurface = (file, message) => {
    const verdict = validateWrite(file, project);
    assert.strictEqual(verdict.allowed, false, message);
    assert.match(verdict.reason, /hook surface of a tool/, `${message}, with the hook surface named as the reason`);
  };
  refusedAsSurface(at(hooksDir, 'dispatcher.js'), 'a linked hook script must be refused');
  assert.strictEqual(validateWrite(elsewhere, project).allowed, true, 'the file the link leads to is not a hook surface by itself');
  // A tool directory that is itself a link: the tool reads its hooks there.
  const realConfig = at(home, 'real-cursor');
  fs.mkdirSync(realConfig, { recursive: true });
  fs.symlinkSync(realConfig, at(home, '.cursor'));
  refusedAsSurface(at(home, '.cursor', 'hooks.json'), 'a hooks.json behind a linked tool directory must be refused');
  // A link that leads into a hook surface is refused as the surface is.
  fs.symlinkSync(at(home, '.claude'), at(home, 'shortcut'));
  refusedAsSurface(at(home, 'shortcut', 'settings.json'), 'a link into a tool directory must be refused');
});

test('every hook surface is read freely', () => {
  for (const file of [...HOOK_CONFIGURATIONS, ...HOOK_SCRIPT_DIRECTORIES]) {
    for (const command of [`cat ${file}`, `head -n 5 ${file}`, `grep -n hooks ${file}`]) {
      const verdict = validateCommand(command, project);
      assert.strictEqual(verdict.allowed, true, `${command}: ${verdict.reason}`);
    }
  }
});

test('the shell does not write a hook surface either', () => {
  const settings = at(home, '.claude', 'settings.json');
  const script = at(home, '.claude', 'scripts', 'hooks', 'bash-hook-dispatcher.js');
  for (const command of [
    `echo x > ${settings}`,
    `cp /tmp/settings.json ${settings}`,
    `tee ${at(home, '.codex', 'hooks.json')} < /tmp/hooks.json`,
    `cp /tmp/dispatcher.js ${script}`,
    `sed -i s/a/b/ ${at(project, '.cursor', 'hooks.json')}`,
    `cp /tmp/pre-commit.sh ${at(home, '.claude', 'hooks', 'pre-commit.sh')}`,
  ]) {
    const verdict = validateCommand(command, project);
    assert.ok(!verdict.allowed && !verdict.advisory, `${command} must be refused, got ${JSON.stringify(verdict)}`);
  }
});

fs.rmSync(home, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
