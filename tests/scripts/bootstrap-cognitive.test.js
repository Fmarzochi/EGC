'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'bootstrap-cognitive.js');
const SCRIPT_SOURCE = fs.readFileSync(SCRIPT_PATH, 'utf8');

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

async function runTests() {
  console.log('\n=== Testing scripts/bootstrap-cognitive.js ===\n');
  let passed = 0;
  let failed = 0;

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
      assert.ok(/Windsurf: memory protocol upgraded v1 -> v2/.test(output), 'should report a v1 -> v2 upgrade');

      const content = fs.readFileSync(target, 'utf8');
      assert.ok(content.includes('Keep this line.'), 'content before the block must survive');
      assert.ok(content.includes('Keep this line too.'), 'content after the block must survive');
      assert.ok(content.includes('EGC Token Crusher Protocol'), 'upgraded block must include the new Crusher section');
      assert.strictEqual(
        (content.match(/<!-- egc-memory-protocol(?::v\d+)? -->/g) || []).length,
        1,
        'exactly one protocol marker after the upgrade, no duplication'
      );
      assert.ok(content.includes('<!-- egc-memory-protocol:v2 -->'), 'marker must be stamped with the current version');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

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
