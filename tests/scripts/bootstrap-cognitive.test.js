'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withoutConfigHomeVariables } = require('../fixtures/harness-variables');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'bootstrap-cognitive.js');
const SCRIPT_SOURCE = fs.readFileSync(SCRIPT_PATH, 'utf8');

// Derived from the script itself so a protocol bump never breaks this suite
// again: every scenario asserts against the CURRENT version, and the
// upgrade-from-legacy cases stay meaningful at any version number.
const PROTOCOL_VERSION = Number(/const PROTOCOL_VERSION = (\d+);/.exec(SCRIPT_SOURCE)[1]);
const V = `v${PROTOCOL_VERSION}`;

const DECISION_ROUTE_LINE = '- Save/remember this decision → call `update_state` (decisions field); use `store_decision` only for history logging or `lesson_save` for lessons';
const DECISION_RECALL_LINE = '- What failed? What did we decide? → check `get_state` first (what `update_state` saved), then `search_history` or `query_history` for the `store_decision` history';

function mktempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'egc-bootstrap-cognitive-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function run(homeDir, extraEnv = {}) {
  const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir, XDG_CONFIG_HOME: path.join(homeDir, '.config'), ...extraEnv };
  if (!('CRUSH_GLOBAL_CONFIG' in extraEnv)) {
    delete env.CRUSH_GLOBAL_CONFIG;
  }
  return execFileSync('node', [SCRIPT_PATH], {
    env,
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

  const libSource = path.join(REPO_ROOT, 'scripts', 'lib');
  const libTarget = path.join(scriptsDir, 'lib');
  if (fs.existsSync(libSource)) {
    fs.cpSync(libSource, libTarget, { recursive: true });
  }

  return path.join(scriptsDir, 'bootstrap-cognitive.js');
}

function runScript(scriptPath, homeDir) {
  // An inherited XDG_CONFIG_HOME or CRUSH_GLOBAL_CONFIG would send the
  // bootstrap to the real config directories instead of the temporary home.
  const env = withoutConfigHomeVariables({ ...process.env, HOME: homeDir, USERPROFILE: homeDir });
  return execFileSync('node', [scriptPath], {
    env,
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

// Claude Code and Gemini CLI share injectProtocol() with Devin Desktop/Zed below,
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

  // A file that once got the block twice (an old install appended a second
  // one) must end with one current block: the first check used to stop at
  // the current block on top and leave a stale one below it for good.
  const LEGACY_BLOCK = [
    '<!-- egc-memory-protocol -->',
    '## EGC Session Memory',
    '',
    'State files live at `~/.egc/state/<project-slug>.md`: plain Markdown, one file per project.',
    '<!-- /egc-memory-protocol -->',
    '',
  ].join('\n');
  const MARKERS_RE = /<!-- egc-memory-protocol(?::v\d+)? -->/g;

  if (await test('Claude Code: a current block with a stale one below keeps a single current block, the rest untouched', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.claude'));
      const target = path.join(home, '.claude', 'CLAUDE.md');
      run(home);
      const installed = fs.readFileSync(target, 'utf8');
      const doubled = `${installed}\n## My rules\n\nKeep this line.\n\n${LEGACY_BLOCK}\nKeep this line too.\n`;
      fs.writeFileSync(target, doubled, 'utf8');

      const output = run(home);
      assert.ok(/Claude Code: memory protocol kept once, 1 stale block removed/.test(output), `should report the cleanup, got: ${output}`);
      const content = fs.readFileSync(target, 'utf8');
      assert.strictEqual((content.match(MARKERS_RE) || []).length, 1, 'exactly one protocol block');
      assert.ok(content.includes(`<!-- egc-memory-protocol:${V} -->`), 'the block left is the current one');
      assert.ok(!content.includes('plain Markdown'), 'the stale block is gone');
      assert.ok(content.includes('Keep this line.') && content.includes('Keep this line too.') && content.includes('## My rules'), 'content around the blocks must survive');
      assert.strictEqual(fs.readFileSync(target + '.egc.bak', 'utf8'), doubled, 'backup must hold the file as it was');
      assert.ok(/Claude Code: already configured/.test(run(home)), 'a rerun finds it configured');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('Claude Code: two stale blocks become one current block where the first stood', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.claude'));
      const target = path.join(home, '.claude', 'CLAUDE.md');
      const v1 = LEGACY_BLOCK.replace('<!-- egc-memory-protocol -->', '<!-- egc-memory-protocol:v1 -->');
      fs.writeFileSync(target, `# Top\n\n${v1}\nMiddle line.\n\n${LEGACY_BLOCK}\nBottom line.\n`, 'utf8');

      const output = run(home);
      assert.ok(/Claude Code: memory protocol kept once, 1 stale block removed \(v1 -> v\d+\)/.test(output), `should report the cleanup, got: ${output}`);
      const content = fs.readFileSync(target, 'utf8');
      assert.strictEqual((content.match(MARKERS_RE) || []).length, 1, 'exactly one protocol block');
      assert.ok(content.indexOf(`<!-- egc-memory-protocol:${V} -->`) < content.indexOf('Middle line.'), 'the current block takes the place of the first');
      assert.ok(content.includes('# Top') && content.includes('Middle line.') && content.includes('Bottom line.'), 'content around the blocks must survive');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('protocol carries the busy-session drain rule in both the block and Codex forms (#1293)', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.claude'));
      fs.mkdirSync(path.join(home, '.codex'));
      run(home);

      const block = fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8');
      assert.ok(
        block.includes('Busy sessions drain too'),
        'markdown protocol must tell busy sessions to drain each turn'
      );

      const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
      assert.ok(
        toml.includes('including loop ticks and scheduled wakeups'),
        'Codex protocol must tell busy sessions to drain each turn'
      );
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('protocol says the state store is owned by the server and what to do without get_state, in the block and Codex forms (#1395)', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.claude'));
      fs.mkdirSync(path.join(home, '.codex'));
      const cursorSettingsDir = path.join(home, '.config', 'Cursor', 'User');
      fs.mkdirSync(cursorSettingsDir, { recursive: true });
      fs.writeFileSync(path.join(cursorSettingsDir, 'settings.json'), JSON.stringify({ 'editor.fontSize': 14 }), 'utf8');
      run(home);

      const block = fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8');
      assert.ok(block.includes('Never read or write those files directly'), 'the block must forbid touching state files directly');
      assert.ok(block.includes('encrypted at rest'), 'the block must say the files are encrypted');
      assert.ok(block.includes('say so and point at `egc init`'), 'the block must say what to do when get_state is missing');
      assert.ok(!block.includes('plain Markdown'), 'the block must no longer call the state files plain Markdown');
      assert.ok(block.includes('when the prompt library is installed for this tool'), 'the review line must depend on the library being installed');

      const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
      assert.ok(toml.includes('never read or write those files directly'), 'the Codex line must carry the same rule');
      assert.ok(toml.includes('say the server is not registered and point at egc init'), 'and the same fallback');
      assert.ok(!toml.includes('State lives at'), 'the Codex line must no longer point at a state file path');
      assert.ok(toml.includes('review PR->review-pr agents when the prompt library is installed'), 'the Codex line must carry the same condition');

      const cursorRules = JSON.parse(fs.readFileSync(path.join(cursorSettingsDir, 'settings.json'), 'utf8'))['cursor.rules'];
      assert.ok(cursorRules.includes('never read or write those files directly'), 'the Cursor rules must carry the same rule');
      assert.ok(cursorRules.includes('say the server is not registered and point at egc init'), 'and the same fallback');
      assert.ok(!cursorRules.includes('State lives at'), 'the Cursor rules must no longer point at a state file path');
      assert.ok(cursorRules.includes('review PR->review-pr agents when the prompt library is installed'), 'the Cursor rules must carry the same condition');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('protocol routes a decision to update_state and recalls it from get_state first, in the block, standalone, Codex and Cursor forms (#1524)', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.claude'));
      fs.mkdirSync(path.join(home, '.codex'));
      fs.mkdirSync(path.join(home, '.opencode'));
      const cursorSettingsDir = path.join(home, '.config', 'Cursor', 'User');
      fs.mkdirSync(cursorSettingsDir, { recursive: true });
      fs.writeFileSync(path.join(cursorSettingsDir, 'settings.json'), '{}', 'utf8');
      run(home);

      const markdownForms = [
        ['block', fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8')],
      ];
      for (const [label, text] of markdownForms) {
        assert.ok(text.includes(DECISION_ROUTE_LINE), `the ${label} must route a decision to update_state`);
        assert.ok(text.includes(DECISION_RECALL_LINE), `the ${label} must recall decisions from get_state first`);
        assert.ok(!text.includes('call `lesson_save` or `store_decision`'), `the ${label} must drop the old route`);
      }

      const compactForms = [
        ['Codex line', fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')],
        ['Cursor rules', JSON.parse(fs.readFileSync(path.join(cursorSettingsDir, 'settings.json'), 'utf8'))['cursor.rules']],
      ];
      for (const [label, text] of compactForms) {
        assert.ok(text.includes('save this decision->update_state'), `the ${label} must route a decision to update_state`);
        assert.ok(text.includes('what failed or what did we decide->get_state first'), `the ${label} must recall decisions from get_state first`);
        assert.ok(!text.includes('save this->lesson_save or store_decision'), `the ${label} must drop the old route`);
      }
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('every protocol copy shipped in the repository carries the same decision routing as the installed block (#1524)', () => {
    const copies = [
      'CLAUDE.md',
      'GEMINI.md',
      'rules/common/memory.md',
      '.cursor/rules/common-auto-intuition.md',
      '.opencode/instructions/EGC_MEMORY.md',
      '.codebuddy/MEMORY.md',
      '.trae/MEMORY.md',
      '.trae/rules/egc-context.md',
    ];
    for (const relative of copies) {
      const text = fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');
      assert.ok(text.includes(DECISION_ROUTE_LINE), `${relative} must route a decision to update_state`);
      assert.ok(text.includes(DECISION_RECALL_LINE), `${relative} must recall decisions from get_state first`);
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

  if (await test('writes GEMINI.md into ~/.gemini for Antigravity (Gemini home) when it exists', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.gemini'));
      const output = run(home);
      assert.ok(output.includes('Antigravity (Gemini home): memory protocol installed'), 'should report install');
      const target = path.join(home, '.gemini', 'GEMINI.md');
      const content = fs.readFileSync(target, 'utf8');
      assert.ok(/<!-- egc-memory-protocol(?::v\d+)? -->/.test(content), 'marker must be present');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('Antigravity (Gemini home): logs an error instead of crashing when the GEMINI.md path is structurally broken', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.gemini'));
      fs.mkdirSync(path.join(home, '.gemini', 'GEMINI.md'));
      const output = run(home);
      assert.ok(output.includes('Antigravity (Gemini home): unexpected error:'), 'should report the error, not crash');
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

  if (await test('Cursor settings.json: a current closed block with a stale closed one after it keeps a single current block, the user rules untouched', () => {
    const home = mktempHome();
    try {
      const cursorSettingsDir = path.join(home, '.config', 'Cursor', 'User');
      fs.mkdirSync(cursorSettingsDir, { recursive: true });
      const settingsFile = path.join(cursorSettingsDir, 'settings.json');
      fs.writeFileSync(settingsFile, JSON.stringify({ 'cursor.rules': 'Always use tabs.' }), 'utf8');
      run(home);
      const current = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))['cursor.rules'];
      const stale = '[egc-memory-protocol:v2] Old closed block. [/egc-memory-protocol]';
      fs.writeFileSync(settingsFile, JSON.stringify({ 'cursor.rules': `${current}\n\nNever commit secrets.\n\n${stale}` }), 'utf8');

      const output = run(home);
      assert.ok(output.includes(`Cursor: memory protocol kept once, 1 stale block removed (${V} -> ${V})`), `should report the cleanup, got: ${output}`);
      const rules = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))['cursor.rules'];
      assert.strictEqual((rules.match(/\[egc-memory-protocol:v\d+\]/g) || []).length, 1, 'exactly one protocol block');
      assert.ok(rules.includes(`[egc-memory-protocol:${V}]`) && !rules.includes('Old closed block'), 'the current block stays, the stale one goes');
      assert.ok(rules.indexOf(`[egc-memory-protocol:${V}]`) < rules.indexOf('Never commit secrets.'), 'the current block keeps the place of the first');
      assert.ok(rules.includes('Always use tabs.') && rules.includes('Never commit secrets.'), 'the user rules survive');
      assert.ok(run(home).includes(`Cursor: already configured (${V})`), 'a rerun finds it configured');
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

async function runOpenCodeTests() {
  let passed = 0;
  let failed = 0;

  if (await test('OpenCode: creates egc-memory.md and opencode.json when dir exists', () => {
    const home = mktempHome();
    try {
      const configDir = path.join(home, '.config', 'opencode');
      fs.mkdirSync(configDir, { recursive: true });

      run(home);

      const memoryFile = path.join(configDir, 'egc-memory.md');
      const configPath = path.join(configDir, 'opencode.json');
      assert.strictEqual(fs.existsSync(memoryFile), true, 'egc-memory.md should be created');
      assert.strictEqual(fs.existsSync(configPath), true, 'opencode.json should be created');

      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.deepStrictEqual(config.instructions, [memoryFile], 'instructions should list egc-memory.md');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('OpenCode: appends egc-memory.md to existing instructions in opencode.json', () => {
    const home = mktempHome();
    try {
      const configDir = path.join(home, '.config', 'opencode');
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = path.join(configDir, 'opencode.json');
      fs.writeFileSync(configPath, JSON.stringify({ instructions: ['/custom/rule.md'], other: true }), 'utf8');

      run(home);

      const memoryFile = path.join(configDir, 'egc-memory.md');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.strictEqual(config.other, true, 'existing config fields preserved');
      assert.deepStrictEqual(config.instructions, ['/custom/rule.md', memoryFile], 'egc-memory.md appended');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('OpenCode: idempotent rerun adds egc-memory.md only once', () => {
    const home = mktempHome();
    try {
      const configDir = path.join(home, '.config', 'opencode');
      fs.mkdirSync(configDir, { recursive: true });

      run(home);
      run(home);

      const memoryFile = path.join(configDir, 'egc-memory.md');
      const configPath = path.join(configDir, 'opencode.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.strictEqual(config.instructions.filter(i => i === memoryFile).length, 1, 'listed exactly once');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('OpenCode: updates opencode.json when jsonc exists without instructions', () => {
    const home = mktempHome();
    try {
      const configDir = path.join(home, '.config', 'opencode');
      fs.mkdirSync(configDir, { recursive: true });
      const jsoncPath = path.join(configDir, 'opencode.jsonc');
      const initialJsoncContent = '{\n  // User comments\n  "theme": "dark"\n}\n';
      fs.writeFileSync(jsoncPath, initialJsoncContent, 'utf8');

      run(home);

      const memoryFile = path.join(configDir, 'egc-memory.md');
      const configPath = path.join(configDir, 'opencode.json');
      assert.strictEqual(fs.readFileSync(jsoncPath, 'utf8'), initialJsoncContent, 'jsonc remains untouched');
      assert.strictEqual(fs.existsSync(configPath), true, 'opencode.json created');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.deepStrictEqual(config.instructions, [memoryFile]);
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('OpenCode: warns and skips config update when opencode.jsonc has instructions', () => {
    const home = mktempHome();
    try {
      const configDir = path.join(home, '.config', 'opencode');
      fs.mkdirSync(configDir, { recursive: true });
      const jsoncPath = path.join(configDir, 'opencode.jsonc');
      fs.writeFileSync(jsoncPath, '{\n  "instructions": ["/some/file.md"]\n}\n', 'utf8');

      const output = run(home);

      const configPath = path.join(configDir, 'opencode.json');
      assert.strictEqual(fs.existsSync(configPath), false, 'opencode.json not created');
      assert.strictEqual(output.includes('opencode.jsonc contains an instructions list'), true, 'console warning printed');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('OpenCode: skips update on invalid JSON syntax', () => {
    const home = mktempHome();
    try {
      const configDir = path.join(home, '.config', 'opencode');
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = path.join(configDir, 'opencode.json');
      fs.writeFileSync(configPath, '{ invalid json... }', 'utf8');

      const output = run(home);

      assert.strictEqual(
        output.includes('invalid JSON syntax') || output.includes('left untouched'),
        true,
        'logs skip error'
      );
      assert.strictEqual(fs.readFileSync(configPath, 'utf8'), '{ invalid json... }', 'invalid json untouched');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('OpenCode: respects XDG_CONFIG_HOME env variable', () => {
    const home = mktempHome();
    try {
      const customXdg = path.join(home, 'custom_xdg');
      const configDir = path.join(customXdg, 'opencode');
      fs.mkdirSync(configDir, { recursive: true });

      execFileSync('node', [SCRIPT_PATH], {
        env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: customXdg },
        encoding: 'utf8',
      });

      const memoryFile = path.join(configDir, 'egc-memory.md');
      const configPath = path.join(configDir, 'opencode.json');
      assert.strictEqual(fs.existsSync(memoryFile), true, 'egc-memory.md created in XDG dir');
      assert.strictEqual(fs.existsSync(configPath), true, 'opencode.json created in XDG dir');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('OpenCode: AGENTS.md remains 100% untouched', () => {
    const home = mktempHome();
    try {
      const configDir = path.join(home, '.config', 'opencode');
      fs.mkdirSync(configDir, { recursive: true });
      const agentsPath = path.join(configDir, 'AGENTS.md');
      const initialAgentsContent = '# Custom AGENTS file\nDo not touch.';
      fs.writeFileSync(agentsPath, initialAgentsContent, 'utf8');

      run(home);

      assert.strictEqual(fs.readFileSync(agentsPath, 'utf8'), initialAgentsContent, 'AGENTS.md preserved byte-for-byte');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('OpenCode: cleans up legacy EGC_MEMORY.md only if EGC marker is present', () => {
    const home = mktempHome();
    try {
      const configDir = path.join(home, '.config', 'opencode');
      fs.mkdirSync(configDir, { recursive: true });

      const legacyDir = path.join(home, '.opencode', 'instructions');
      fs.mkdirSync(legacyDir, { recursive: true });

      const legacyFileWithMarker = path.join(legacyDir, 'EGC_MEMORY.md');
      fs.writeFileSync(
        legacyFileWithMarker,
        '<!-- egc-memory-protocol:v1 -->\n# EGC Session Memory\nProtocol content...\n<!-- /egc-memory-protocol -->',
        'utf8'
      );
  
      run(home);

      assert.strictEqual(fs.existsSync(legacyFileWithMarker), false, 'legacy file with marker deleted');

      fs.writeFileSync(legacyFileWithMarker, '# My Custom Rules\nNo EGC marker here.', 'utf8');
      run(home);
      assert.strictEqual(fs.existsSync(legacyFileWithMarker), true, 'legacy file without marker preserved');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('OpenCode: does nothing if OpenCode config dir does not exist', () => {
    const home = mktempHome();
    try {
      run(home);

      const configDir = path.join(home, '.config', 'opencode');
      assert.strictEqual(fs.existsSync(configDir), false, 'missing dir remains uncreated');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('OpenCode: leaves file untouched when instructions key is not an array', () => {
    const home = mktempHome();
    try {
      const configDir = path.join(home, '.config', 'opencode');
      fs.mkdirSync(configDir, { recursive: true });

      const configPath = path.join(configDir, 'opencode.json');
      const initialContent = JSON.stringify({ instructions: "not-an-array" }, null, 2) + '\n';
      fs.writeFileSync(configPath, initialContent, 'utf8');
    
      const output = run(home);
    
      const actualContent = fs.readFileSync(configPath, 'utf8');
      assert.strictEqual(actualContent, initialContent, 'config file remains untouched');
      assert.strictEqual(
        output.includes('invalid instructions list') || output.includes('left untouched'),
        true,
        'logs invalid instructions error'
      );
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('OpenCode: second run is idempotent and does not touch opencode.json mtimeMs', async () => {
    const home = mktempHome();
    try {
      const configDir = path.join(home, '.config', 'opencode');
      fs.mkdirSync(configDir, { recursive: true });
    
      run(home);
    
      const configPath = path.join(configDir, 'opencode.json');
      assert.strictEqual(fs.existsSync(configPath), true, 'opencode.json created on first run');
      
      const statsFirstRun = fs.statSync(configPath);
      const contentFirstRun = fs.readFileSync(configPath, 'utf8');
    
      await new Promise((resolve) => setTimeout(resolve, 50));
    
      run(home);
    
      const statsSecondRun = fs.statSync(configPath);
      const contentSecondRun = fs.readFileSync(configPath, 'utf8');
    
      assert.strictEqual(contentSecondRun, contentFirstRun, 'content remains identical');
      assert.strictEqual(statsSecondRun.mtimeMs, statsFirstRun.mtimeMs, 'mtimeMs was not modified on second run');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('OpenCode: preserves legacy EGC_MEMORY.md when jsonc requires manual configuration', () => {
    const home = mktempHome();
    try {
      const configDir = path.join(home, '.config', 'opencode');
      fs.mkdirSync(configDir, { recursive: true });

      const jsoncPath = path.join(configDir, 'opencode.jsonc');
      fs.writeFileSync(jsoncPath, '{\n  "instructions": []\n}', 'utf8');

      const legacyDir = path.join(home, '.opencode', 'instructions');
      fs.mkdirSync(legacyDir, { recursive: true });
      const legacyFile = path.join(legacyDir, 'EGC_MEMORY.md');
      fs.writeFileSync(
        legacyFile,
        '<!-- egc-memory-protocol:v1 -->\n# EGC Session Memory\nProtocol content...\n<!-- /egc-memory-protocol -->',
        'utf8'
      );

      run(home);

      assert.strictEqual(fs.existsSync(legacyFile), true, 'legacy file preserved when jsonc requires manual action');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('OpenCode: refuses to write when config path is a symlink outside allowed roots', () => {
    const home = mktempHome();
    const outsideDir = mktempHome();
    try {
      const targetOutsideConfig = path.join(outsideDir, 'external-opencode');
      fs.mkdirSync(targetOutsideConfig, { recursive: true });
    
      const configDir = path.join(home, '.config', 'opencode');
      fs.mkdirSync(path.dirname(configDir), { recursive: true });
      
      try {
        fs.symlinkSync(targetOutsideConfig, configDir, 'dir');
      } catch {
        console.log('  [SKIP] symlink not available on this runner');
        return;
      }
    
      const output = run(home);
    
      const outsideMemoryFile = path.join(targetOutsideConfig, 'egc-memory.md');
      const outsideConfigFile = path.join(targetOutsideConfig, 'opencode.json');
      assert.strictEqual(fs.existsSync(outsideMemoryFile), false, 'outside memory file was not created');
      assert.strictEqual(fs.existsSync(outsideConfigFile), false, 'outside config file was not created');
      assert.strictEqual(
        output.includes('leads through a link'),
        true,
        'logs boundary protection error'
      );
    } finally {
      cleanup(home);
      cleanup(outsideDir);
    }
  })) passed++; else failed++;

  return [passed, failed];
}

// Same complexity-budget reasoning as above: the 4 standalone markdown
// targets (Trae, CodeBuddy) each need the same pair
// of upgrade-from-legacy / stay-idempotent-at-current-version cases.
async function runStandaloneTargetUpgradeTests() {
  const STANDALONE_TARGETS = [
    { home: '.trae', target: ['.trae', 'MEMORY.md'], label: 'Trae (.trae)' },
    { home: '.trae-cn', target: ['.trae-cn', 'MEMORY.md'], label: 'Trae (.trae-cn)' },
    { home: '.codebuddy', target: ['.codebuddy', 'MEMORY.md'], label: 'CodeBuddy' },
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

// Trae, CodeBuddy, Continue.dev) was never exercised by any existing test,
// since none of them ever hand injectStandaloneProtocol() a structurally
// broken path. Split out for the same complexity-budget reason as the
// helpers above.
async function runStandaloneCatchBlockTests() {
  const BROKEN_PATH_TARGETS = [
    { home: '.trae', target: ['.trae', 'MEMORY.md'], label: 'Trae' },
    { home: '.codebuddy', target: ['.codebuddy', 'MEMORY.md'], label: 'CodeBuddy' },
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

async function runProtocolContentTests() {
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

  if (await test('every form of the protocol tells the agent to give validate_write the directory it works in', () => {
    assert.ok(SCRIPT_SOURCE.includes('validate_write({ filepath: "<path>", cwd: "<absolute working directory>" })'), 'the Markdown protocol names cwd');
    const withoutCwd = SCRIPT_SOURCE.match(/validate_write(?![^.\n]*\bcwd\b)/g) || [];
    assert.deepStrictEqual(withoutCwd, [], 'every form the script installs names cwd in the sentence that calls validate_write');
    for (const file of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'rules/common/memory.md', '.trae/MEMORY.md', '.trae/rules/egc-context.md',
      '.opencode/instructions/INSTRUCTIONS.md', '.opencode/instructions/EGC_MEMORY.md', '.kiro/steering/development-workflow.md',
      '.cursor/rules/common-development-workflow.md', '.codebuddy/MEMORY.md', '.agents/AGENTS.md']) {
      const text = fs.readFileSync(path.join(__dirname, '..', '..', ...file.split('/')), 'utf8');
      const calls = text.match(/validate_write\(\{[^}]*\}\)/g) || [];
      assert.ok(calls.length > 0, `${file} shows the validate_write call`);
      assert.deepStrictEqual(calls.filter(call => !/\bcwd\b/.test(call)), [], `${file} still calls validate_write without cwd`);
    }
  })) passed++; else failed++;

  if (await test('every protocol the script installs names cwd wherever it calls validate_write', () => {
    const home = mktempHome();
    try {
      for (const dir of ['.codex', '.opencode', '.trae', '.codebuddy', '.gemini', '.claude']) fs.mkdirSync(path.join(home, dir), { recursive: true });
      const cursorSettings = path.join(home, '.config', 'Cursor', 'User', 'settings.json');
      fs.mkdirSync(path.dirname(cursorSettings), { recursive: true });
      fs.writeFileSync(cursorSettings, '{}', 'utf8');
      run(home);
      const written = [];
      const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else written.push(full);
        }
      };
      walk(home);
      const calling = written.filter(file => fs.readFileSync(file, 'utf8').includes('validate_write'));
      assert.ok(calling.length >= 5, `the protocol reaches the tools: ${calling.map(file => path.relative(home, file)).join(', ')}`);
      for (const file of calling) {
        const text = fs.readFileSync(file, 'utf8').replaceAll(String.raw`\"`, '"');
        assert.deepStrictEqual(text.match(/validate_write(?![^.\n]*\bcwd\b)/g) || [], [], `${path.relative(home, file)} calls validate_write without cwd`);
      }
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('installs all 9 session bus commands for Cursor, Codex, Trae, and CodeBuddy', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.codex'));;
      fs.mkdirSync(path.join(home, '.trae'));
      fs.mkdirSync(path.join(home, '.codebuddy'));
      // No .cursor/.config/Cursor -> exercises the injectProtocol(BLOCK) fallback,
      // already covered by the BLOCK-wide assertion above; here we cover the
      // 5 harnesses that used to ship an abbreviated, hand-duplicated copy.
      run(home);

      const filesToCheck = [
        path.join(home, '.codex', 'config.toml'),
        path.join(home, '.trae', 'MEMORY.md'),
        path.join(home, '.codebuddy', 'MEMORY.md'),
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

  if (await test('markdownProtocolBody fallback (CodeBuddy) has full session bus and Guardian if the repo source .md ever goes missing', () => {
    let fakeScript;
    let home;
    try {
      fakeScript = mktempFakeRepo();
      home = mktempHome();
      fs.mkdirSync(path.join(home, '.codebuddy'));
      runScript(fakeScript, home);

      const codebuddyContent = fs.readFileSync(path.join(home, '.codebuddy', 'MEMORY.md'), 'utf8');
      for (const content of [codebuddyContent]) {
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

  return [passed, failed];
}

async function runRemainingHarnessTests() {
  let passed = 0;
  let failed = 0;

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

  if (await test('writes Devin Desktop global_rules.md when ~/.codeium exists', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.codeium'));
      const output = run(home);
      assert.ok(/Devin Desktop: memory protocol installed/.test(output), 'should report install');
      const target = path.join(home, '.codeium', 'windsurf', 'memories', 'global_rules.md');
      const content = fs.readFileSync(target, 'utf8');
      assert.ok(/<!-- egc-memory-protocol(?::v\d+)? -->/.test(content), 'marker must be present');
      assert.ok(content.includes('EGC Session Memory'), 'protocol block must be present');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('skips Devin Desktop when ~/.codeium does not exist', () => {
    const home = mktempHome();
    try {
      const output = run(home);
      assert.ok(!/\[cognitive\] Devin Desktop:/.test(output), 'should not mention Devin Desktop at all');
      assert.ok(!fs.existsSync(path.join(home, '.codeium')), 'must not create ~/.codeium');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('Devin Desktop install is idempotent (no duplicate marker on rerun)', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.codeium'));
      run(home);
      const second = run(home);
      assert.ok(/Devin Desktop: already configured/.test(second), 'second run should detect existing config');
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
      assert.ok(output.includes(`Devin Desktop: memory protocol upgraded v1 -> ${V}`), 'should report a v1 upgrade to the current version');

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

  if (await test('logs an error instead of crashing when the Devin Desktop target path is structurally broken', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.codeium'));
      // 'windsurf' is a file, not a directory: mkdirSync('.codeium/windsurf/memories', {recursive:true})
      // fails structurally (ENOTDIR) on every OS, unlike a permission-based failure.
      fs.writeFileSync(path.join(home, '.codeium', 'windsurf'), 'not a directory', 'utf8');
      const output = run(home);
      assert.ok(/Devin Desktop: unexpected error:/.test(output), 'should report the error, not crash');
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

  if (await test('writes Crush CRUSH.md when ~/.config/crush exists', () => {
    const home = mktempHome();
    try {
      const crushDir = path.join(home, '.config', 'crush');
      fs.mkdirSync(crushDir, { recursive: true });
      const output = run(home);
      assert.ok(/Crush: memory protocol installed/.test(output), `should report install, got: ${output}`);
      const crushMd = path.join(crushDir, 'CRUSH.md');
      assert.ok(fs.existsSync(crushMd), 'CRUSH.md must exist');
      const content = fs.readFileSync(crushMd, 'utf8');
      assert.ok(content.includes('EGC Session Memory'), 'must contain session memory protocol');

      const secondOutput = run(home);
      assert.ok(/Crush: already configured/.test(secondOutput), `second run should report already configured, got: ${secondOutput}`);
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('preserves existing user instructions in Crush CRUSH.md', () => {
    const home = mktempHome();
    try {
      const crushDir = path.join(home, '.config', 'crush');
      fs.mkdirSync(crushDir, { recursive: true });
      const crushMd = path.join(crushDir, 'CRUSH.md');
      fs.writeFileSync(crushMd, '# My Personal Custom Rules\n\nDo not delete me!\n', 'utf8');
      const output = run(home);
      assert.ok(/Crush: memory protocol installed/.test(output), `should report install, got: ${output}`);
      const content = fs.readFileSync(crushMd, 'utf8');
      assert.ok(content.includes('# My Personal Custom Rules'), 'must preserve existing user instructions');
      assert.ok(content.includes('Do not delete me!'), 'must preserve existing body');
      assert.ok(content.includes('EGC Session Memory'), 'must append session memory protocol');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('skips Crush when ~/.config/crush does not exist', () => {
    const home = mktempHome();
    try {
      const output = run(home);
      assert.ok(!output.includes('Crush:'), `output should not mention Crush when dir absent: ${output}`);
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('skips Crush when ~/.config/crush exists as a file, not a directory', () => {
    const home = mktempHome();
    try {
      const crushFile = path.join(home, '.config', 'crush');
      fs.mkdirSync(path.dirname(crushFile), { recursive: true });
      fs.writeFileSync(crushFile, 'regular file', 'utf8');
      const output = run(home);
      assert.ok(!output.includes('Crush:'), `output should not mention Crush when file: ${output}`);
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('honors CRUSH_GLOBAL_CONFIG override when installing Crush CRUSH.md', () => {
    const home = mktempHome();
    try {
      const customCrushDir = path.join(home, 'custom-crush-root');
      fs.mkdirSync(customCrushDir, { recursive: true });
      const output = run(home, { CRUSH_GLOBAL_CONFIG: customCrushDir });
      assert.ok(/Crush: memory protocol installed/.test(output), `should report install, got: ${output}`);
      const target = path.join(customCrushDir, 'CRUSH.md');
      assert.ok(fs.existsSync(target), 'must install CRUSH.md into CRUSH_GLOBAL_CONFIG directory');
      const content = fs.readFileSync(target, 'utf8');
      assert.ok(content.includes('EGC Session Memory'), 'must contain EGC memory protocol');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('logs an error instead of crashing when the Crush CRUSH.md path is structurally broken', () => {
    const home = mktempHome();
    try {
      const crushDir = path.join(home, '.config', 'crush');
      fs.mkdirSync(crushDir, { recursive: true });
      fs.mkdirSync(path.join(crushDir, 'CRUSH.md'));
      const output = run(home);
      assert.ok(/Crush: unexpected error:/.test(output), 'should report the error, not crash');
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

  {
    const [openCodePassed, openCodeFailed] = await runOpenCodeTests();
    passed += openCodePassed;
    failed += openCodeFailed;
  }

  {
    const [protocolPassed, protocolFailed] = await runProtocolContentTests();
    passed += protocolPassed;
    failed += protocolFailed;
  }

  {
    const [remainingPassed, remainingFailed] = await runRemainingHarnessTests();
    passed += remainingPassed;
    failed += remainingFailed;
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
