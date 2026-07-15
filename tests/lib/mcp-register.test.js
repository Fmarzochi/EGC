/**
 * Tests for scripts/lib/mcp-register.js (issue #550)
 *
 * Covers the target list (including the new Continue.dev entry, which
 * writes a Continue YAML block file rather than JSON), the JSON/TOML merge
 * behavior, and the registerMcpServers() orchestrator that scripts/init.js
 * delegates to.
 *
 * Run with: node tests/lib/mcp-register.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildMcpRegistrationTargets,
  registerJson,
  registerToml,
  registerContinueYaml,
  registerMcpServers,
} = require('../../scripts/lib/mcp-register');

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    return true;
  } catch (err) {
    console.log(`  \u2717 ${name}`);
    console.log(`    Error: ${err.message}`);
    return false;
  }
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-register-test-'));
}

const bins = {
  guardianBin: '/fake/mcp/servers/egc-guardian/build/index.js',
  memoryBin: '/fake/mcp/servers/egc-memory/build/index.js',
};

function runTests() {
  console.log('\n=== Testing scripts/lib/mcp-register.js ===\n');

  let passed = 0;
  let failed = 0;

  // ── buildMcpRegistrationTargets ──────────────────────────────────

  (test('includes a Continue.dev target pointed at the mcpServers directory', () => {
    const targets = buildMcpRegistrationTargets('/home/person');
    const continueTarget = targets.find(t => t.name === 'Continue.dev');
    assert.ok(continueTarget, 'Continue.dev target should exist');
    assert.strictEqual(
      continueTarget.path,
      path.join('/home/person', '.continue', 'mcpServers'),
      'Continue.dev should write into the mcpServers folder, not a single file or config.json'
    );
    assert.strictEqual(continueTarget.format, 'continue-yaml');
  }) ? passed++ : failed++);

  (test('Continue.dev gate is false when ~/.continue does not exist', () => {
    const tmpHome = makeTempDir();
    const targets = buildMcpRegistrationTargets(tmpHome);
    const continueTarget = targets.find(t => t.name === 'Continue.dev');
    assert.strictEqual(continueTarget.gate(), false);
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('Continue.dev gate is true when ~/.continue exists', () => {
    const tmpHome = makeTempDir();
    fs.mkdirSync(path.join(tmpHome, '.continue'));
    const targets = buildMcpRegistrationTargets(tmpHome);
    const continueTarget = targets.find(t => t.name === 'Continue.dev');
    assert.strictEqual(continueTarget.gate(), true);
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('does not drop any of the pre-existing targets', () => {
    const targets = buildMcpRegistrationTargets('/home/person');
    const names = targets.map(t => t.name);
    for (const expected of [
      'Antigravity CLI', 'Gemini CLI', 'Claude Code (global)', 'Cursor',
      'Kiro', 'Codex CLI', 'OpenCode',
    ]) {
      assert.ok(names.includes(expected), `${expected} should still be a target`);
    }
  }) ? passed++ : failed++);

  // ── registerJson (generic - used by Cursor, Claude, Gemini, Kiro, etc.) ──

  (test('registerJson creates a fresh file with both mcp servers', () => {
    const tmpHome = makeTempDir();
    const target = path.join(tmpHome, '.cursor', 'mcp.json');
    const changed = registerJson(target, bins);

    assert.strictEqual(changed, true);
    const written = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.deepStrictEqual(written.mcpServers['egc-guardian'], { command: 'node', args: [bins.guardianBin] });
    assert.deepStrictEqual(written.mcpServers['egc-memory'], { command: 'node', args: [bins.memoryBin] });

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerJson preserves unrelated existing mcpServers entries', () => {
    const tmpHome = makeTempDir();
    const dir = path.join(tmpHome, '.cursor');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'mcp.json');
    fs.writeFileSync(target, JSON.stringify({
      mcpServers: { 'some-other-server': { command: 'npx', args: ['-y', 'other'] } },
    }, null, 2));

    registerJson(target, bins);

    const written = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.ok(written.mcpServers['some-other-server'], 'pre-existing unrelated server should survive the merge');
    assert.ok(written.mcpServers['egc-guardian'], 'egc-guardian should be added');
    assert.ok(written.mcpServers['egc-memory'], 'egc-memory should be added');

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerJson is idempotent: second run reports no change', () => {
    const tmpHome = makeTempDir();
    const target = path.join(tmpHome, '.cursor', 'mcp.json');

    const firstRun = registerJson(target, bins);
    const secondRun = registerJson(target, bins);

    assert.strictEqual(firstRun, true, 'first run should report a change');
    assert.strictEqual(secondRun, false, 'second run should report no change (already registered)');

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerJson throws (not returns false) on unparseable existing content', () => {
    const tmpHome = makeTempDir();
    const dir = path.join(tmpHome, '.cursor');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'mcp.json');
    fs.writeFileSync(target, 'not valid json {{{');

    // Throwing (rather than quietly returning false) matters: false is
    // also the return value for "already fully registered, nothing to do",
    // and the orchestrator needs to tell those two apart to know whether
    // to warn.
    assert.throws(() => registerJson(target, bins), /not valid JSON/);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'not valid json {{{', 'existing content should be untouched, not clobbered');

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  // ── registerToml (unchanged behavior, guards against regressions) ──

  (test('registerToml appends both mcp_servers blocks to a fresh file', () => {
    const tmpHome = makeTempDir();
    const target = path.join(tmpHome, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '');

    const changed = registerToml(target, bins);

    assert.strictEqual(changed, true);
    const content = fs.readFileSync(target, 'utf8');
    assert.ok(content.includes('name = "egc-guardian"'));
    assert.ok(content.includes('name = "egc-memory"'));

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerToml escapes backslashes in Windows-style bin paths', () => {
    const tmpHome = makeTempDir();
    const target = path.join(tmpHome, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '');
    const winPath = 'C:\\Users\\person\\egc\\mcp\\servers\\egc-guardian\\build\\index.js';

    registerToml(target, { guardianBin: winPath, memoryBin: bins.memoryBin });

    const content = fs.readFileSync(target, 'utf8');
    // "\U" is reserved in TOML for an 8-hex-digit Unicode escape - a raw,
    // unescaped backslash from a Windows path breaks the string the moment
    // it's followed by a hex-ish character (as "\Users" would be here).
    assert.ok(
      content.includes('C:\\\\Users\\\\person\\\\egc\\\\mcp\\\\servers\\\\egc-guardian\\\\build\\\\index.js'),
      'backslashes should be doubled for a valid TOML basic string'
    );

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerToml output (including Windows paths) parses with a real TOML parser', () => {
    let TOML;
    try {
      TOML = require('@iarna/toml');
    } catch (_) {
      console.log('    (skipped: @iarna/toml not installed)');
      return;
    }

    const tmpHome = makeTempDir();
    const target = path.join(tmpHome, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '');
    const winPath = 'C:\\Users\\person\\egc-guardian\\index.js';

    registerToml(target, { guardianBin: winPath, memoryBin: bins.memoryBin });

    const parsed = TOML.parse(fs.readFileSync(target, 'utf8'));
    const guardianEntry = parsed.mcp_servers.find(s => s.name === 'egc-guardian');
    assert.strictEqual(guardianEntry.args[0], winPath, 'path should round-trip exactly through a real TOML parser');

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerToml restores a commented-out entry instead of treating it as already registered (audit EGC-128)', () => {
    const tmpHome = makeTempDir();
    const target = path.join(tmpHome, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // A plain substring check for '"egc-guardian"' would match this
    // commented-out line and wrongly conclude the server is registered.
    fs.writeFileSync(
      target,
      '# [[mcp_servers]]\n# name = "egc-guardian"\n# command = "node"\n# args = ["/old/path.js"]\n'
    );

    const changed = registerToml(target, bins);

    assert.strictEqual(changed, true, 'should re-register egc-guardian since the only entry is commented out');
    const content = fs.readFileSync(target, 'utf8');
    const activeLines = content
      .split('\n')
      .filter(line => !line.trim().startsWith('#'));
    assert.ok(
      activeLines.some(line => line.includes('name = "egc-guardian"')),
      'an active (uncommented) egc-guardian entry should now exist'
    );

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerToml treats an existing active entry as already registered (no duplicate)', () => {
    const tmpHome = makeTempDir();
    const target = path.join(tmpHome, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    registerToml(target, bins);
    const firstWrite = fs.readFileSync(target, 'utf8');

    const changed = registerToml(target, bins);

    assert.strictEqual(changed, false, 'should be a no-op the second time');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), firstWrite, 'should not duplicate the entries');

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  // ── registerContinueYaml ─────────────────────────────────────────

  (test('registerContinueYaml writes two files, one server each', () => {
    const tmpHome = makeTempDir();
    const targetDir = path.join(tmpHome, '.continue', 'mcpServers');
    const changed = registerContinueYaml(targetDir, bins);

    assert.strictEqual(changed, true);
    const guardianContent = fs.readFileSync(path.join(targetDir, 'egc-guardian.yaml'), 'utf8');
    const memoryContent = fs.readFileSync(path.join(targetDir, 'egc-memory.yaml'), 'utf8');

    // Required top-level block metadata per Continue's docs
    assert.ok(/^name: .+/m.test(guardianContent) && /^version: .+/m.test(guardianContent) && /^schema: v1$/m.test(guardianContent));
    assert.ok(/^name: .+/m.test(memoryContent) && /^version: .+/m.test(memoryContent) && /^schema: v1$/m.test(memoryContent));

    // Each file defines exactly one server - Continue's real schema rejects
    // a block file with more than one mcpServers entry, confirmed against
    // the actual @continuedev/config-yaml package below.
    assert.ok(guardianContent.includes('- name: egc-guardian'));
    assert.ok(!guardianContent.includes('egc-memory'), 'guardian file should not also define memory');
    assert.ok(memoryContent.includes('- name: egc-memory'));
    assert.ok(!memoryContent.includes('egc-guardian'), 'memory file should not also define guardian');
    assert.ok(guardianContent.includes(bins.guardianBin));
    assert.ok(memoryContent.includes(bins.memoryBin));

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerContinueYaml is idempotent: second run reports no change', () => {
    const tmpHome = makeTempDir();
    const targetDir = path.join(tmpHome, '.continue', 'mcpServers');

    const firstRun = registerContinueYaml(targetDir, bins);
    const secondRun = registerContinueYaml(targetDir, bins);

    assert.strictEqual(firstRun, true, 'first run should report a change');
    assert.strictEqual(secondRun, false, 'second run should report no change (content identical)');

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerContinueYaml regenerates a file if its bin path changes', () => {
    const tmpHome = makeTempDir();
    const targetDir = path.join(tmpHome, '.continue', 'mcpServers');

    registerContinueYaml(targetDir, bins);
    const changed = registerContinueYaml(targetDir, {
      guardianBin: '/new/path/egc-guardian/index.js',
      memoryBin: bins.memoryBin,
    });

    assert.strictEqual(changed, true, 'a changed bin path should be treated as a real change');
    const guardianContent = fs.readFileSync(path.join(targetDir, 'egc-guardian.yaml'), 'utf8');
    assert.ok(guardianContent.includes('/new/path/egc-guardian/index.js'));

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerContinueYaml double-quotes bin paths with YAML-special characters', () => {
    const tmpHome = makeTempDir();
    const targetDir = path.join(tmpHome, '.continue', 'mcpServers');
    // "#" starts a YAML comment, ": " is a mapping key/value separator -
    // both are legal in a real directory name and both break a bare
    // (unquoted) scalar.
    const trickyPath = '/home/person/my #projects/egc: guardian/index.js';

    registerContinueYaml(targetDir, { guardianBin: trickyPath, memoryBin: bins.memoryBin });

    const content = fs.readFileSync(path.join(targetDir, 'egc-guardian.yaml'), 'utf8');
    assert.ok(
      content.includes(`      - ${JSON.stringify(trickyPath)}`),
      'path should be wrapped in a double-quoted scalar, not inserted bare'
    );

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerContinueYaml output with tricky characters round-trips through the real Continue parser', () => {
    let parseBlock;
    try {
      parseBlock = require('@continuedev/config-yaml').parseBlock;
    } catch (_) {
      console.log('    (skipped: @continuedev/config-yaml not installed)');
      return;
    }

    const tmpHome = makeTempDir();
    const targetDir = path.join(tmpHome, '.continue', 'mcpServers');
    const trickyPath = '/home/person/my #projects/egc: guardian/index.js';

    registerContinueYaml(targetDir, { guardianBin: trickyPath, memoryBin: bins.memoryBin });

    const content = fs.readFileSync(path.join(targetDir, 'egc-guardian.yaml'), 'utf8');
    const parsed = parseBlock(content);
    assert.strictEqual(
      parsed.mcpServers[0].args[0],
      trickyPath,
      'path should round-trip exactly through the real block schema parser'
    );

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  // Real schema validation, not just "is this valid YAML" - uses the
  // actual published @continuedev/config-yaml package (the same one
  // Continue's own core imports) to parse what we generate. Skips itself
  // gracefully if the package isn't installed, e.g. offline CI, rather
  // than failing the whole suite over an optional cross-check.
  (test('registerContinueYaml output validates against the real Continue block schema', () => {
    let parseBlock;
    try {
      parseBlock = require('@continuedev/config-yaml').parseBlock;
    } catch (_) {
      console.log('    (skipped: @continuedev/config-yaml not installed)');
      return;
    }

    const tmpHome = makeTempDir();
    const targetDir = path.join(tmpHome, '.continue', 'mcpServers');
    registerContinueYaml(targetDir, bins);

    const guardianContent = fs.readFileSync(path.join(targetDir, 'egc-guardian.yaml'), 'utf8');
    const memoryContent = fs.readFileSync(path.join(targetDir, 'egc-memory.yaml'), 'utf8');

    const guardianParsed = parseBlock(guardianContent);
    const memoryParsed = parseBlock(memoryContent);
    assert.strictEqual(guardianParsed.mcpServers[0].name, 'egc-guardian');
    assert.strictEqual(memoryParsed.mcpServers[0].name, 'egc-memory');

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  // ── registerMcpServers orchestrator ─────────────────────────────

  (test('registerMcpServers writes Continue.dev config when ~/.continue exists', () => {
    const tmpHome = makeTempDir();
    fs.mkdirSync(path.join(tmpHome, '.continue'));

    const registered = [];
    registerMcpServers(tmpHome, bins, {
      dryRun: false,
      onRegister: (target) => registered.push(target.name),
    });

    assert.ok(registered.includes('Continue.dev'), 'Continue.dev should be reported as registered');
    const dir = path.join(tmpHome, '.continue', 'mcpServers');
    assert.ok(fs.readFileSync(path.join(dir, 'egc-guardian.yaml'), 'utf8').includes('- name: egc-guardian'));
    assert.ok(fs.readFileSync(path.join(dir, 'egc-memory.yaml'), 'utf8').includes('- name: egc-memory'));

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerMcpServers skips Continue.dev entirely when ~/.continue is absent', () => {
    const tmpHome = makeTempDir();

    const registered = [];
    registerMcpServers(tmpHome, bins, {
      dryRun: false,
      onRegister: (target) => registered.push(target.name),
    });

    assert.ok(!registered.includes('Continue.dev'), 'Continue.dev should not be touched when not installed');
    assert.ok(!fs.existsSync(path.join(tmpHome, '.continue')), 'no .continue dir should be created as a side effect');

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerMcpServers in dry-run mode writes nothing', () => {
    const tmpHome = makeTempDir();
    fs.mkdirSync(path.join(tmpHome, '.continue'));

    const skipped = [];
    registerMcpServers(tmpHome, bins, {
      dryRun: true,
      onSkip: (target) => skipped.push(target.name),
    });

    assert.ok(skipped.includes('Continue.dev'));
    assert.ok(!fs.existsSync(path.join(tmpHome, '.continue', 'mcpServers')), 'dry-run must not write any files');

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  // Regression guard for the P1 fix: onRegister must never fire when
  // nothing was actually written. A gated target (Cursor) whose existing
  // config is unparseable should report through onWarn instead, and the
  // file must be left alone rather than overwritten.
  (test('registerMcpServers calls onWarn (not onRegister) when an existing JSON target is broken', () => {
    const tmpHome = makeTempDir();
    const dir = path.join(tmpHome, '.cursor');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'mcp.json'), 'not valid json {{{');

    const registered = [];
    const warned = [];
    registerMcpServers(tmpHome, bins, {
      dryRun: false,
      onRegister: (target) => registered.push(target.name),
      onWarn: (target) => warned.push(target.name),
    });

    assert.ok(!registered.includes('Cursor'), 'onRegister must not fire when nothing was written');
    assert.ok(warned.includes('Cursor'), 'onWarn should fire so the failure is not silent');
    assert.strictEqual(
      fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8'),
      'not valid json {{{',
      'broken file must be left untouched, not overwritten'
    );

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  // The other side of the same fix: a target that's already fully
  // registered is a legitimate no-op, not a failure, and must stay
  // silent - re-running `egc init` on an already-set-up machine shouldn't
  // print a warning for every tool that's already correctly configured.
  (test('registerMcpServers stays silent (no onRegister, no onWarn) on an already-registered target', () => {
    const tmpHome = makeTempDir();
    const dir = path.join(tmpHome, '.cursor');
    fs.mkdirSync(dir, { recursive: true });
    // Pre-register by calling registerJson directly, simulating a second
    // `egc init` run on a machine that's already set up.
    registerJson(path.join(dir, 'mcp.json'), bins);

    const registered = [];
    const warned = [];
    registerMcpServers(tmpHome, bins, {
      dryRun: false,
      onRegister: (target) => registered.push(target.name),
      onWarn: (target) => warned.push(target.name),
    });

    assert.ok(!registered.includes('Cursor'), 'nothing changed, so onRegister should not fire again');
    assert.ok(!warned.includes('Cursor'), 'an already-registered target is not an error and should not warn');

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
