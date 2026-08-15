'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'bootstrap-cognitive.js');
const SCRIPT_SOURCE = fs.readFileSync(SCRIPT_PATH, 'utf8');

// Derived from the script itself so a protocol bump never breaks this suite
// again: every scenario asserts against the CURRENT version, and the
// upgrade-from-legacy cases stay meaningful at any version number.
const PROTOCOL_VERSION = Number(/const PROTOCOL_VERSION = (\d+);/.exec(SCRIPT_SOURCE)[1]);
const V = `v${PROTOCOL_VERSION}`;

function mktempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'egc-bootstrap-cognitive-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function run(homeDir) {
  return execFileSync('node', [SCRIPT_PATH], {
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    encoding: 'utf8',
  });
}

// Copies bootstrap-cognitive.js into a throwaway "fake repo" whose
// .opencode/.codebuddy source files are intentionally absent, so __dirname
// resolution inside the copy sees them as missing without ever touching
// this real repo's actual .opencode/instructions/EGC_MEMORY.md or
// .codebuddy/MEMORY.md -- exercises the markdownProtocolBody() fallback
// branch (only reachable if those repo files ever went missing, e.g. from
// an npm package that excluded them).
function mktempFakeRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-bootstrap-fakerepo-'));
  const scriptsDir = path.join(repoDir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.copyFileSync(SCRIPT_PATH, path.join(scriptsDir, 'bootstrap-cognitive.js'));
  return path.join(scriptsDir, 'bootstrap-cognitive.js');
}

function runScript(scriptPath, homeDir) {
  return execFileSync('node', [scriptPath], {
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    encoding: 'utf8',
  });
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
    return true;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    return false;
  }
}

const SESSION_BUS_COMMANDS = [
  'session_announce', 'session_peers', 'session_events', 'session_send',
  'claim_path', 'release_path',
  'working_memory_get', 'working_memory_set', 'working_memory_list',
];

// Claude Code and Gemini CLI share injectProtocol() with Windsurf/Zed below,
// but unlike those two, no other test in this suite ever creates ~/.claude
// or ~/.gemini, so their install and error-catch branches were never
// exercised. Split out to keep runTests() shallow, same reasoning as the
// helpers below.
async function runClaudeCodeAndGeminiCliTests() {
  let passed = 0;
  let failed = 0;

  if (await test('Claude Code: appends the protocol block to an existing CLAUDE.md that has no marker at all, preserving prior content', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.claude'));
      const target = path.join(home, '.claude', 'CLAUDE.md');
      const original = '# My custom instructions\n\nKeep this line.\n';
      fs.writeFileSync(target, original, 'utf8');

      const output = run(home);
      assert.ok(/Claude Code: memory protocol installed/.test(output), `should report install, got: ${output}`);

      const content = fs.readFileSync(target, 'utf8');
      assert.ok(content.includes('Keep this line.'), 'prior content must be preserved, not overwritten');
      assert.ok(content.includes(`<!-- egc-memory-protocol:${V} -->`), 'protocol block must be appended');
      assert.strictEqual(fs.readFileSync(target + '.egc.bak', 'utf8'), original, 'backup must hold the pre-append content');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('Claude Code: logs an error instead of crashing when the CLAUDE.md path is structurally broken', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.claude'));
      // CLAUDE.md is a directory, not a file: readFileSync on it fails structurally
      // (EISDIR) on every OS, unlike a permission-based failure.
      fs.mkdirSync(path.join(home, '.claude', 'CLAUDE.md'));
      const output = run(home);
      assert.ok(/Claude Code: unexpected error:/.test(output), 'should report the error, not crash');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('writes Gemini CLI GEMINI.md when ~/.gemini exists', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.gemini'));
      const output = run(home);
      assert.ok(/Gemini CLI: memory protocol installed/.test(output), 'should report install');
      const target = path.join(home, '.gemini', 'GEMINI.md');
      const content = fs.readFileSync(target, 'utf8');
      assert.ok(/<!-- egc-memory-protocol(?::v\d+)? -->/.test(content), 'marker must be present');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('Gemini CLI: logs an error instead of crashing when the GEMINI.md path is structurally broken', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.gemini'));
      fs.mkdirSync(path.join(home, '.gemini', 'GEMINI.md'));
      const output = run(home);
      assert.ok(/Gemini CLI: unexpected error:/.test(output), 'should report the error, not crash');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  return [passed, failed];
}

// Split out from runTests() to keep its cyclomatic complexity down: covers
// the two non-markdown protocol formats (Cursor's JSON cursor.rules, Codex's
// TOML persistent_instructions), each needing its own upgrade-from-legacy
// and stay-idempotent-at-current-version case.
async function runCursorAndCodexUpgradeTests() {
  let passed = 0;
  let failed = 0;

  if (await test('Cursor settings.json: a pre-versioning legacy cursor.rules (no marker, no closing tag) is upgraded by appending the current version with the Crusher tag, never deleting the old text', () => {
    const home = mktempHome();
    try {
      const cursorSettingsDir = path.join(home, '.config', 'Cursor', 'User');
      fs.mkdirSync(cursorSettingsDir, { recursive: true });
      const settingsFile = path.join(cursorSettingsDir, 'settings.json');
      fs.writeFileSync(settingsFile, JSON.stringify({
        'editor.fontSize': 14,
        'cursor.rules': '[egc-memory-protocol] Legacy pre-Crusher rules mentioning get_state and update_state.',
      }), 'utf8');

      const output = run(home);
      assert.ok(output.includes(`Cursor: memory protocol upgraded v1 -> ${V}`), `should report a v1 upgrade to the current version, got: ${output}`);

      const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      assert.strictEqual(parsed['editor.fontSize'], 14, 'unrelated settings must be preserved');
      assert.ok(parsed['cursor.rules'].includes('Legacy pre-Crusher rules'), 'the old unclosed legacy block is never deleted, since there is no reliable end marker to cut it at');
      assert.ok(parsed['cursor.rules'].includes('[egc-token-crusher]'), 'upgraded cursor.rules must include the Crusher tag');
      assert.ok(parsed['cursor.rules'].includes(`[egc-memory-protocol:${V}]`), 'marker must be stamped with the current version');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('Cursor settings.json: rules the user appended after an old unclosed legacy block survive the upgrade (cubic review, PR #1095)', () => {
    const home = mktempHome();
    try {
      const cursorSettingsDir = path.join(home, '.config', 'Cursor', 'User');
      fs.mkdirSync(cursorSettingsDir, { recursive: true });
      const settingsFile = path.join(cursorSettingsDir, 'settings.json');
      fs.writeFileSync(settingsFile, JSON.stringify({
        'cursor.rules': '[egc-memory-protocol] Legacy pre-Crusher rules mentioning get_state and update_state.\n\nAlways use tabs, never spaces, in this project.',
      }), 'utf8');

      run(home);

      const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      assert.ok(
        parsed['cursor.rules'].includes('Always use tabs, never spaces, in this project.'),
        'a rule the user appended after the old unclosed EGC block must survive the upgrade, not be silently deleted'
      );
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('Cursor settings.json: a current-version install is left untouched on rerun (idempotent)', () => {
    const home = mktempHome();
    try {
      const cursorSettingsDir = path.join(home, '.config', 'Cursor', 'User');
      fs.mkdirSync(cursorSettingsDir, { recursive: true });
      const settingsFile = path.join(cursorSettingsDir, 'settings.json');
      fs.writeFileSync(settingsFile, JSON.stringify({ 'editor.fontSize': 14 }), 'utf8');

      run(home);
      const second = run(home);
      assert.ok(second.includes(`Cursor: already configured (${V})`), `second run should report already configured, got: ${second}`);
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('Codex config.toml: a pre-versioning legacy persistent_instructions (no marker) is upgraded to the current version with the Crusher text, staying a valid single-line TOML string', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.codex'));
      const tomlPath = path.join(home, '.codex', 'config.toml');
      fs.writeFileSync(tomlPath, 'persistent_instructions = "State lives at ~/.egc/state/<slug>.md. Legacy pre-Crusher text mentioning get_state and update_state."\n', 'utf8');

      const output = run(home);
      assert.ok(output.includes(`Codex: memory protocol upgraded v1 -> ${V}`), `should report a v1 upgrade to the current version, got: ${output}`);

      const content = fs.readFileSync(tomlPath, 'utf8');
      const match = content.match(/^persistent_instructions = "(.*)"$/m);
      assert.ok(match, 'persistent_instructions must remain a single-line double-quoted TOML string');
      assert.ok(!match[1].includes('"'), 'the TOML string value must not contain an unescaped double-quote');
      assert.ok(match[1].includes(`[egc-protocol:${V}]`), 'upgraded value must carry the current version marker');
      assert.ok(match[1].includes('Token Crusher Protocol'), 'upgraded value must include the Crusher section');
      assert.ok(match[1].includes('Legacy pre-Crusher text'), 'pre-marker legacy text is left in place rather than guessed-and-removed');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('Codex config.toml: escapes double quotes and backslashes when upgrading a single-quoted persistent_instructions (cubic review, PR #1095)', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.codex'));
      const tomlPath = path.join(home, '.codex', 'config.toml');
      fs.writeFileSync(tomlPath, 'persistent_instructions = \'Legacy text mentioning get_state with a "quoted word" and a backslash \\ here.\'\n', 'utf8');

      run(home);

      const content = fs.readFileSync(tomlPath, 'utf8');
      assert.ok(/^persistent_instructions = "/m.test(content), 'must be rewritten as a double-quoted TOML string');
      assert.ok(content.includes('\\"quoted word\\"'), 'the original double quotes must be escaped, not left bare inside the new double-quoted string');
      assert.ok(content.includes('backslash \\\\ here'), 'the original backslash must be escaped (doubled), not left bare');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('Codex config.toml: a current-version install is left untouched on rerun (idempotent)', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.codex'));
      run(home);
      const second = run(home);
      assert.ok(second.includes(`Codex: already configured (${V})`), `second run should report already configured, got: ${second}`);
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  return [passed, failed];
}

// Additional Cursor/Codex branches not covered by the upgrade-focused tests
// above: the injectProtocol() fallback used when no settings.json exists at
// all, the invalid-JSON skip path, Codex's two skip statuses (multiline and
// unrecognized), Codex appending fresh when the key is entirely absent, and
// both bootstrap functions' own top-level catch blocks. Split out for the
// same complexity-budget reason as runCursorAndCodexUpgradeTests().
async function runCursorAndCodexEdgeCaseTests() {
  let passed = 0;
  let failed = 0;

  if (await test('Cursor: falls back to injectProtocol on ~/.cursor/rules when no settings.json exists anywhere', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.cursor'));
      const output = run(home);
      assert.ok(/Cursor: memory protocol installed/.test(output), `should report install, got: ${output}`);
      const target = path.join(home, '.cursor', 'rules');
      const content = fs.readFileSync(target, 'utf8');
      assert.ok(content.includes(`<!-- egc-memory-protocol:${V} -->`), 'protocol block must be written to ~/.cursor/rules');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('Cursor: settings.json with invalid JSON (JSONC-style) is skipped without modification', () => {
    const home = mktempHome();
    try {
      const cursorSettingsDir = path.join(home, '.config', 'Cursor', 'User');
      fs.mkdirSync(cursorSettingsDir, { recursive: true });
      const settingsFile = path.join(cursorSettingsDir, 'settings.json');
      const invalidJson = '{\n  // a JSONC comment, invalid in strict JSON\n  "editor.fontSize": 14,\n}\n';
      fs.writeFileSync(settingsFile, invalidJson, 'utf8');

      const output = run(home);
      assert.ok(/settings\.json is not valid JSON \(JSONC\?\): skipping/.test(output), `should report the skip, got: ${output}`);
      assert.strictEqual(fs.readFileSync(settingsFile, 'utf8'), invalidJson, 'invalid settings.json must be left untouched');
      assert.ok(!fs.existsSync(settingsFile + '.egc.bak'), 'no backup should be written when the file is skipped');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('Cursor: logs an error instead of crashing when the settings.json path is structurally broken', () => {
    const home = mktempHome();
    try {
      const cursorSettingsDir = path.join(home, '.config', 'Cursor', 'User');
      fs.mkdirSync(cursorSettingsDir, { recursive: true });
      // settings.json is a directory, not a file: readFileSync on it fails
      // structurally (EISDIR) on every OS, unlike a permission-based failure.
      fs.mkdirSync(path.join(cursorSettingsDir, 'settings.json'));
      const output = run(home);
      assert.ok(/Cursor: unexpected error:/.test(output), 'should report the error, not crash');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('Codex: a triple-quoted multiline persistent_instructions is skipped without modification', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.codex'));
      const tomlPath = path.join(home, '.codex', 'config.toml');
      const original = 'persistent_instructions = """\nLegacy multiline text mentioning get_state.\n"""\n';
      fs.writeFileSync(tomlPath, original, 'utf8');

      const output = run(home);
      assert.ok(/Codex: persistent_instructions multiline: skipping/.test(output), `should report the skip, got: ${output}`);
      assert.strictEqual(fs.readFileSync(tomlPath, 'utf8'), original, 'multiline persistent_instructions must be left untouched');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('Codex: an unrecognized (non-string) persistent_instructions value is skipped without modification', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.codex'));
      const tomlPath = path.join(home, '.codex', 'config.toml');
      const original = 'persistent_instructions = 12345\n';
      fs.writeFileSync(tomlPath, original, 'utf8');

      const output = run(home);
      assert.ok(/Codex: persistent_instructions in unrecognized format: skipping/.test(output), `should report the skip, got: ${output}`);
      assert.strictEqual(fs.readFileSync(tomlPath, 'utf8'), original, 'unrecognized persistent_instructions must be left untouched');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('Codex: an existing config.toml with no persistent_instructions key at all gets one appended fresh', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.codex'));
      const tomlPath = path.join(home, '.codex', 'config.toml');
      const original = '[some_other_section]\nfoo = "bar"\n';
      fs.writeFileSync(tomlPath, original, 'utf8');

      const output = run(home);
      assert.ok(/Codex: memory protocol installed/.test(output), `should report a fresh install, got: ${output}`);

      const content = fs.readFileSync(tomlPath, 'utf8');
      assert.ok(content.includes('[some_other_section]'), 'pre-existing unrelated TOML content must be preserved');
      assert.ok(content.includes('foo = "bar"'), 'pre-existing unrelated TOML content must be preserved');
      const match = content.match(/^persistent_instructions = "(.*)"$/m);
      assert.ok(match, 'persistent_instructions must be appended as a single-line double-quoted TOML string');
      assert.ok(match[1].includes(`[egc-protocol:${V}]`), 'appended value must carry the current version marker');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('Codex: logs an error instead of crashing when the config.toml path is structurally broken', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.codex'));
      // config.toml is a directory, not a file: readFileSync on it fails
      // structurally (EISDIR) on every OS, unlike a permission-based failure.
      fs.mkdirSync(path.join(home, '.codex', 'config.toml'));
      const output = run(home);
      assert.ok(/Codex: unexpected error:/.test(output), 'should report the error, not crash');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  return [passed, failed];
}

// Same complexity-budget reasoning as above: the 4 standalone markdown
// targets (OpenCode, Trae, CodeBuddy, Continue.dev) each need the same pair
// of upgrade-from-legacy / stay-idempotent-at-current-version cases.
async function runStandaloneTargetUpgradeTests() {
  const STANDALONE_TARGETS = [
    { home: '.opencode', target: ['.opencode', 'instructions', 'EGC_MEMORY.md'], label: 'OpenCode' },
    { home: '.trae', target: ['.trae', 'MEMORY.md'], label: 'Trae (.trae)' },
    { home: '.trae-cn', target: ['.trae-cn', 'MEMORY.md'], label: 'Trae (.trae-cn)' },
    { home: '.codebuddy', target: ['.codebuddy', 'MEMORY.md'], label: 'CodeBuddy' },
    { home: '.continue', target: ['.continue', 'prompts', 'egc-memory.prompt'], label: 'Continue.dev' },
  ];

  let passed = 0;
  let failed = 0;

  for (const spec of STANDALONE_TARGETS) {
    if (await test(`${spec.label}: a pre-versioning legacy install (no marker at all) is upgraded to the current version with the Crusher section, not left frozen`, () => {
      const home = mktempHome();
      try {
        fs.mkdirSync(path.join(home, spec.home), { recursive: true });
        const target = path.join(home, ...spec.target);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, '# EGC Session Memory\n\nLegacy pre-marker content, written before versioning existed. Mentions get_state and update_state so the old plain existsSync check would have skipped it forever.\n', 'utf8');

        const output = run(home);
        assert.ok(output.includes(`${spec.label}: memory protocol upgraded`), `should report an upgrade for ${spec.label}, got: ${output}`);

        const content = fs.readFileSync(target, 'utf8');
        assert.ok(content.includes('EGC Token Crusher Protocol'), 'upgraded content must include the Crusher section');
        assert.ok(content.includes(`<!-- egc-memory-protocol:${V} -->`), 'upgraded content must carry the current version marker');
      } finally {
        cleanup(home);
      }
    })) passed++; else failed++;

    if (await test(`${spec.label}: a current-version install is left untouched on rerun (idempotent)`, () => {
      const home = mktempHome();
      try {
        fs.mkdirSync(path.join(home, spec.home), { recursive: true });
        run(home);
        const second = run(home);
        assert.ok(second.includes(`${spec.label}: already configured (${V})`), `second run should report ${spec.label} as already configured, got: ${second}`);
      } finally {
        cleanup(home);
      }
    })) passed++; else failed++;
  }

  return [passed, failed];
}

// Each standalone markdown target's own top-level catch block (OpenCode,
// Trae, CodeBuddy, Continue.dev) was never exercised by any existing test,
// since none of them ever hand injectStandaloneProtocol() a structurally
// broken path. Split out for the same complexity-budget reason as the
// helpers above.
async function runStandaloneCatchBlockTests() {
  const BROKEN_PATH_TARGETS = [
    { home: '.opencode', target: ['.opencode', 'instructions', 'EGC_MEMORY.md'], label: 'OpenCode' },
    { home: '.trae', target: ['.trae', 'MEMORY.md'], label: 'Trae' },
    { home: '.codebuddy', target: ['.codebuddy', 'MEMORY.md'], label: 'CodeBuddy' },
    { home: '.continue', target: ['.continue', 'prompts', 'egc-memory.prompt'], label: 'Continue.dev' },
  ];

  let passed = 0;
  let failed = 0;

  for (const spec of BROKEN_PATH_TARGETS) {
    if (await test(`${spec.label}: logs an error instead of crashing when its target path is structurally broken`, () => {
      const home = mktempHome();
      try {
        fs.mkdirSync(path.join(home, spec.home), { recursive: true });
        // The target file is itself a directory: readFileSync on it fails
        // structurally (EISDIR) on every OS, unlike a permission-based failure.
        fs.mkdirSync(path.join(home, ...spec.target), { recursive: true });
        const output = run(home);
        assert.ok(output.includes(`${spec.label}: unexpected error:`), `should report the error for ${spec.label}, not crash, got: ${output}`);
      } finally {
        cleanup(home);
      }
    })) passed++; else failed++;
  }

  return [passed, failed];
}

// Kiro's bootstrap function was entirely untested: with no ~/.kiro directory
// created by any test above, the early existsSync guard always took the
// false branch, so the hook-copy loop, the installed/already-configured
// messages, and the catch block never ran.
async function runKiroTests() {
  let passed = 0;
  let failed = 0;

  if (await test('Kiro: installs session hooks when ~/.kiro exists and the hooks directory is missing', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.kiro'));
      const output = run(home);
      assert.ok(/Kiro: session hooks installed/.test(output), `should report install, got: ${output}`);

      const hooksDir = path.join(home, '.kiro', 'hooks');
      for (const hook of ['session-restore.kiro.hook', 'session-save.kiro.hook']) {
        assert.ok(fs.existsSync(path.join(hooksDir, hook)), `${hook} must be copied into ~/.kiro/hooks`);
      }
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('Kiro: already-installed hooks are left untouched on rerun (idempotent)', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.kiro'));
      run(home);
      const second = run(home);
      assert.ok(/Kiro: already configured/.test(second), `second run should report already configured, got: ${second}`);
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('Kiro: logs an error instead of crashing when the hooks path is structurally broken', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.kiro'));
      // hooks is a file, not a directory: copying a hook into it fails
      // structurally (ENOTDIR) on every OS, unlike a permission-based failure.
      fs.writeFileSync(path.join(home, '.kiro', 'hooks'), 'not a directory', 'utf8');
      const output = run(home);
      assert.ok(/Kiro: unexpected error:/.test(output), 'should report the error, not crash');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  return [passed, failed];
}

async function runTests() {
  console.log('\n=== Testing scripts/bootstrap-cognitive.js ===\n');
  let passed = 0;
  let failed = 0;

  {
    const [claudeGeminiPassed, claudeGeminiFailed] = await runClaudeCodeAndGeminiCliTests();
    passed += claudeGeminiPassed;
    failed += claudeGeminiFailed;
  }

  {
    const [cursorCodexPassed, cursorCodexFailed] = await runCursorAndCodexUpgradeTests();
    passed += cursorCodexPassed;
    failed += cursorCodexFailed;
  }

  {
    const [cursorCodexEdgePassed, cursorCodexEdgeFailed] = await runCursorAndCodexEdgeCaseTests();
    passed += cursorCodexEdgePassed;
    failed += cursorCodexEdgeFailed;
  }

  if (await test('BLOCK advertises all 9 session bus commands', () => {
    for (const cmd of SESSION_BUS_COMMANDS) {
      assert.ok(SCRIPT_SOURCE.includes(cmd), `BLOCK must reference ${cmd}`);
    }
  })) passed++; else failed++;

  if (await test('BLOCK advertises all 5 core protocol commands (Guardian Protocol + reduce_context)', () => {
    for (const cmd of ['orchestrate_task', 'validate_command', 'validate_write', 'reduce_context', 'auto_learn']) {
      assert.ok(SCRIPT_SOURCE.includes(cmd), `BLOCK must reference ${cmd}`);
    }
  })) passed++; else failed++;

  if (await test('installs all 9 session bus commands for Cursor, Codex, OpenCode, Trae, CodeBuddy, and Continue.dev', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.codex'));
      fs.mkdirSync(path.join(home, '.opencode'));
      fs.mkdirSync(path.join(home, '.trae'));
      fs.mkdirSync(path.join(home, '.codebuddy'));
      fs.mkdirSync(path.join(home, '.continue'));
      // No .cursor/.config/Cursor -> exercises the injectProtocol(BLOCK) fallback,
      // already covered by the BLOCK-wide assertion above; here we cover the
      // 5 harnesses that used to ship an abbreviated, hand-duplicated copy.
      run(home);

      const filesToCheck = [
        path.join(home, '.codex', 'config.toml'),
        path.join(home, '.opencode', 'instructions', 'EGC_MEMORY.md'),
        path.join(home, '.trae', 'MEMORY.md'),
        path.join(home, '.codebuddy', 'MEMORY.md'),
        path.join(home, '.continue', 'prompts', 'egc-memory.prompt'),
      ];
      for (const filePath of filesToCheck) {
        const content = fs.readFileSync(filePath, 'utf8');
        for (const cmd of SESSION_BUS_COMMANDS) {
          assert.ok(content.includes(cmd), `${filePath} must reference ${cmd}`);
        }
      }
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('markdownProtocolBody fallback (OpenCode/CodeBuddy) has full session bus and Guardian if the repo source .md ever goes missing', () => {
    let fakeScript;
    let home;
    try {
      fakeScript = mktempFakeRepo();
      home = mktempHome();
      fs.mkdirSync(path.join(home, '.opencode'));
      fs.mkdirSync(path.join(home, '.codebuddy'));
      runScript(fakeScript, home);

      const opencodeContent = fs.readFileSync(path.join(home, '.opencode', 'instructions', 'EGC_MEMORY.md'), 'utf8');
      const codebuddyContent = fs.readFileSync(path.join(home, '.codebuddy', 'MEMORY.md'), 'utf8');
      for (const content of [opencodeContent, codebuddyContent]) {
        for (const cmd of SESSION_BUS_COMMANDS) {
          assert.ok(content.includes(cmd), `fallback content must reference ${cmd}`);
        }
        assert.ok(content.includes('orchestrate_task'), 'fallback content must include Guardian Protocol');
      }
    } finally {
      if (home) cleanup(home);
      if (fakeScript) cleanup(path.dirname(path.dirname(fakeScript)));
    }
  })) passed++; else failed++;

  if (await test('installs all 9 session bus commands for Cursor via settings.json', () => {
    const home = mktempHome();
    try {
      const cursorSettingsDir = path.join(home, '.config', 'Cursor', 'User');
      fs.mkdirSync(cursorSettingsDir, { recursive: true });
      const settingsFile = path.join(cursorSettingsDir, 'settings.json');
      fs.writeFileSync(settingsFile, JSON.stringify({ 'editor.fontSize': 14 }), 'utf8');

      run(home);

      const written = fs.readFileSync(settingsFile, 'utf8');
      const parsed = JSON.parse(written); // throws if bootstrap wrote invalid JSON
      assert.strictEqual(parsed['editor.fontSize'], 14, 'unrelated settings must be preserved');
      for (const cmd of SESSION_BUS_COMMANDS) {
        assert.ok(parsed['cursor.rules'].includes(cmd), `cursor.rules must reference ${cmd}`);
      }
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('Codex config.toml stays a single-line valid TOML string after install', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.codex'));
      run(home);
      const tomlPath = path.join(home, '.codex', 'config.toml');
      const content = fs.readFileSync(tomlPath, 'utf8');
      const match = content.match(/^persistent_instructions = "(.*)"$/m);
      assert.ok(match, 'persistent_instructions must be a single-line double-quoted TOML string');
      assert.ok(!match[1].includes('"'), 'the TOML string value must not contain an unescaped double-quote');
      for (const cmd of SESSION_BUS_COMMANDS) {
        assert.ok(match[1].includes(cmd), `Codex persistent_instructions must reference ${cmd}`);
      }
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('rules/common/memory.md (Antigravity + Cline, via rules-core) has Guardian and all 9 session bus commands', () => {
    const memoryMd = fs.readFileSync(path.join(REPO_ROOT, 'rules', 'common', 'memory.md'), 'utf8');
    for (const cmd of ['orchestrate_task', 'validate_command', 'validate_write', 'reduce_context', 'auto_learn']) {
      assert.ok(memoryMd.includes(cmd), `rules/common/memory.md must reference ${cmd}`);
    }
    for (const cmd of SESSION_BUS_COMMANDS) {
      assert.ok(memoryMd.includes(cmd), `rules/common/memory.md must reference ${cmd}`);
    }
  })) passed++; else failed++;

  if (await test('writes Windsurf global_rules.md when ~/.codeium exists', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.codeium'));
      const output = run(home);
      assert.ok(/Windsurf: memory protocol installed/.test(output), 'should report install');
      const target = path.join(home, '.codeium', 'windsurf', 'memories', 'global_rules.md');
      const content = fs.readFileSync(target, 'utf8');
      assert.ok(/<!-- egc-memory-protocol(?::v\d+)? -->/.test(content), 'marker must be present');
      assert.ok(content.includes('EGC Session Memory'), 'protocol block must be present');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('skips Windsurf when ~/.codeium does not exist', () => {
    const home = mktempHome();
    try {
      const output = run(home);
      assert.ok(!/\[cognitive\] Windsurf:/.test(output), 'should not mention Windsurf at all');
      assert.ok(!fs.existsSync(path.join(home, '.codeium')), 'must not create ~/.codeium');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('Windsurf install is idempotent (no duplicate marker on rerun)', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.codeium'));
      run(home);
      const second = run(home);
      assert.ok(/Windsurf: already configured/.test(second), 'second run should detect existing config');
      const target = path.join(home, '.codeium', 'windsurf', 'memories', 'global_rules.md');
      const content = fs.readFileSync(target, 'utf8');
      assert.strictEqual(
        (content.match(/<!-- egc-memory-protocol(?::v\d+)? -->/g) || []).length,
        1,
        'only one protocol marker after two runs'
      );
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('upgrades a v1-marked file (pre-Token-Crusher) to the current protocol version, preserving surrounding content', () => {
    const home = mktempHome();
    try {
      const codeiumDir = path.join(home, '.codeium');
      fs.mkdirSync(codeiumDir);
      const targetDir = path.join(codeiumDir, 'windsurf', 'memories');
      fs.mkdirSync(targetDir, { recursive: true });
      const target = path.join(targetDir, 'global_rules.md');
      const oldBlock = [
        '<!-- egc-memory-protocol -->',
        '## EGC Session Memory',
        '',
        'Old v1 content, no Token Crusher section yet.',
        '<!-- /egc-memory-protocol -->',
        '',
      ].join('\n');
      fs.writeFileSync(target, `# My custom rules\n\nKeep this line.\n\n${oldBlock}\nKeep this line too.\n`, 'utf8');

      const output = run(home);
      assert.ok(output.includes(`Windsurf: memory protocol upgraded v1 -> ${V}`), 'should report a v1 upgrade to the current version');

      const content = fs.readFileSync(target, 'utf8');
      assert.ok(content.includes('Keep this line.'), 'content before the block must survive');
      assert.ok(content.includes('Keep this line too.'), 'content after the block must survive');
      assert.ok(content.includes('EGC Token Crusher Protocol'), 'upgraded block must include the new Crusher section');
      assert.strictEqual(
        (content.match(/<!-- egc-memory-protocol(?::v\d+)? -->/g) || []).length,
        1,
        'exactly one protocol marker after the upgrade, no duplication'
      );
      assert.ok(content.includes(`<!-- egc-memory-protocol:${V} -->`), 'marker must be stamped with the current version');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  {
    const [standalonePassed, standaloneFailed] = await runStandaloneTargetUpgradeTests();
    passed += standalonePassed;
    failed += standaloneFailed;
  }

  {
    const [standaloneCatchPassed, standaloneCatchFailed] = await runStandaloneCatchBlockTests();
    passed += standaloneCatchPassed;
    failed += standaloneCatchFailed;
  }

  {
    const [kiroPassed, kiroFailed] = await runKiroTests();
    passed += kiroPassed;
    failed += kiroFailed;
  }

  if (await test('writes Zed AGENTS.md when ~/.config/zed exists', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.config', 'zed'), { recursive: true });
      const output = run(home);
      assert.ok(/Zed: memory protocol installed/.test(output), 'should report install');
      const target = path.join(home, '.config', 'zed', 'AGENTS.md');
      const content = fs.readFileSync(target, 'utf8');
      assert.ok(/<!-- egc-memory-protocol(?::v\d+)? -->/.test(content), 'marker must be present');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('skips Zed when ~/.config/zed does not exist', () => {
    const home = mktempHome();
    try {
      const output = run(home);
      assert.ok(!/\[cognitive\] Zed:/.test(output), 'should not mention Zed at all');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('logs an error instead of crashing when the Windsurf target path is structurally broken', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.codeium'));
      // 'windsurf' is a file, not a directory: mkdirSync('.codeium/windsurf/memories', {recursive:true})
      // fails structurally (ENOTDIR) on every OS, unlike a permission-based failure.
      fs.writeFileSync(path.join(home, '.codeium', 'windsurf'), 'not a directory', 'utf8');
      const output = run(home);
      assert.ok(/Windsurf: unexpected error:/.test(output), 'should report the error, not crash');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('logs an error instead of crashing when the Zed AGENTS.md path is structurally broken', () => {
    const home = mktempHome();
    try {
      const zedDir = path.join(home, '.config', 'zed');
      fs.mkdirSync(zedDir, { recursive: true });
      // AGENTS.md is a directory, not a file: readFileSync on it fails structurally
      // (EISDIR) on every OS, unlike a permission-based failure.
      fs.mkdirSync(path.join(zedDir, 'AGENTS.md'));
      const output = run(home);
      assert.ok(/Zed: unexpected error:/.test(output), 'should report the error, not crash');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('does not target a home-level file for Cline or Aider (project-only harnesses)', () => {
    assert.ok(
      !SCRIPT_SOURCE.includes("'.clinerules'"),
      'Cline has no home target per docs/spec/integration-tiers.md -- must not be added here'
    );
    assert.ok(
      !SCRIPT_SOURCE.includes('.aider.conf.yml'),
      'Aider has no home target per docs/spec/integration-tiers.md -- must not be added here'
    );
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
