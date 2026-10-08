/**
 * Tests for scripts/lib/package-manager.js
 *
 * Run with: node tests/lib/package-manager.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const pm = require('../../scripts/lib/package-manager');

function test(name, fn) {
  try {
    fn();
    console.log(` ✓ ${name}`);
    return true;
  } catch (_err) {
    console.log(` ✗ ${name}`);
    console.log(` Error: ${_err.message}`);
    return false;
  }
}

function createTestDir() {
  const testDir = path.join(os.tmpdir(), `pm-test-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  return testDir;
}

function cleanupTestDir(testDir) {
  fs.rmSync(testDir, { recursive: true, force: true });
}

function withIsolatedHome(fn) {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-home-'));
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  process.env.HOME = isolatedHome;
  process.env.USERPROFILE = isolatedHome;

  try {
    return fn(isolatedHome);
  } finally {
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }

    if (originalUserProfile !== undefined) {
      process.env.USERPROFILE = originalUserProfile;
    } else {
      delete process.env.USERPROFILE;
    }

    fs.rmSync(isolatedHome, { recursive: true, force: true });
  }
}

function runTests() {
  console.log('\n=== Testing package-manager.js ===\n');

  let passed = 0;
  let failed = 0;
  const tally = ok => (ok ? passed++ : failed++);

  // PACKAGE_MANAGERS constant tests
  console.log('PACKAGE_MANAGERS Constant:');

  tally(test('PACKAGE_MANAGERS has all expected managers', () => {
    assert.ok(pm.PACKAGE_MANAGERS.npm, 'Should have npm');
    assert.ok(pm.PACKAGE_MANAGERS.pnpm, 'Should have pnpm');
    assert.ok(pm.PACKAGE_MANAGERS.yarn, 'Should have yarn');
    assert.ok(pm.PACKAGE_MANAGERS.bun, 'Should have bun');
  }));

  tally(test('Each manager has required properties', () => {
    const requiredProps = ['name', 'lockFile', 'installCmd', 'runCmd', 'execCmd', 'testCmd', 'buildCmd', 'devCmd'];
    for (const [name, config] of Object.entries(pm.PACKAGE_MANAGERS)) {
      for (const prop of requiredProps) {
        assert.ok(config[prop], `${name} should have ${prop}`);
      }
    }
  }));

  // detectFromLockFile tests
  console.log('\ndetectFromLockFile:');

  tally(test('detects npm from package-lock.json', () => {
    const testDir = createTestDir();
    try {
      fs.writeFileSync(path.join(testDir, 'package-lock.json'), '{}');
      const result = pm.detectFromLockFile(testDir);
      assert.strictEqual(result, 'npm');
    } finally {
      cleanupTestDir(testDir);
    }
  }));

  tally(test('detects pnpm from pnpm-lock.yaml', () => {
    const testDir = createTestDir();
    try {
      fs.writeFileSync(path.join(testDir, 'pnpm-lock.yaml'), '');
      const result = pm.detectFromLockFile(testDir);
      assert.strictEqual(result, 'pnpm');
    } finally {
      cleanupTestDir(testDir);
    }
  }));

  tally(test('detects yarn from yarn.lock', () => {
    const testDir = createTestDir();
    try {
      fs.writeFileSync(path.join(testDir, 'yarn.lock'), '');
      const result = pm.detectFromLockFile(testDir);
      assert.strictEqual(result, 'yarn');
    } finally {
      cleanupTestDir(testDir);
    }
  }));

  tally(test('detects bun from bun.lockb', () => {
    const testDir = createTestDir();
    try {
      fs.writeFileSync(path.join(testDir, 'bun.lockb'), '');
      const result = pm.detectFromLockFile(testDir);
      assert.strictEqual(result, 'bun');
    } finally {
      cleanupTestDir(testDir);
    }
  }));

  tally(test('returns null when no lock file exists', () => {
    const testDir = createTestDir();
    try {
      const result = pm.detectFromLockFile(testDir);
      assert.strictEqual(result, null);
    } finally {
      cleanupTestDir(testDir);
    }
  }));

  tally(test('respects detection priority (pnpm > npm)', () => {
    const testDir = createTestDir();
    try {
      fs.writeFileSync(path.join(testDir, 'package-lock.json'), '{}');
      fs.writeFileSync(path.join(testDir, 'pnpm-lock.yaml'), '');
      const result = pm.detectFromLockFile(testDir);
      // pnpm has higher priority in DETECTION_PRIORITY
      assert.strictEqual(result, 'pnpm');
    } finally {
      cleanupTestDir(testDir);
    }
  }));

  // detectFromPackageJson tests
  console.log('\ndetectFromPackageJson:');

  tally(test('detects package manager from packageManager field', () => {
    const testDir = createTestDir();
    try {
      fs.writeFileSync(path.join(testDir, 'package.json'), JSON.stringify({ name: 'test', packageManager: 'pnpm@8.6.0' }));
      const result = pm.detectFromPackageJson(testDir);
      assert.strictEqual(result, 'pnpm');
    } finally {
      cleanupTestDir(testDir);
    }
  }));

  tally(test('handles packageManager without version', () => {
    const testDir = createTestDir();
    try {
      fs.writeFileSync(path.join(testDir, 'package.json'), JSON.stringify({ name: 'test', packageManager: 'yarn' }));
      const result = pm.detectFromPackageJson(testDir);
      assert.strictEqual(result, 'yarn');
    } finally {
      cleanupTestDir(testDir);
    }
  }));

  tally(test('returns null when no packageManager field', () => {
    const testDir = createTestDir();
    try {
      fs.writeFileSync(path.join(testDir, 'package.json'), JSON.stringify({ name: 'test' }));
      const result = pm.detectFromPackageJson(testDir);
      assert.strictEqual(result, null);
    } finally {
      cleanupTestDir(testDir);
    }
  }));

  tally(test('returns null when no package.json exists', () => {
    const testDir = createTestDir();
    try {
      const result = pm.detectFromPackageJson(testDir);
      assert.strictEqual(result, null);
    } finally {
      cleanupTestDir(testDir);
    }
  }));

  // getAvailablePackageManagers tests
  console.log('\ngetAvailablePackageManagers:');

  tally(test('returns array of available managers', () => {
    const available = pm.getAvailablePackageManagers();
    assert.ok(Array.isArray(available), 'Should return array');
    // npm should always be available with Node.js
    assert.ok(available.includes('npm'), 'npm should be available');
  }));

  // getPackageManager tests
  console.log('\ngetPackageManager:');

  tally(test('returns object with name, config, and source', () => {
    const result = pm.getPackageManager();
    assert.ok(result.name, 'Should have name');
    assert.ok(result.config, 'Should have config');
    assert.ok(result.source, 'Should have source');
  }));

  tally(test('respects environment variable', () => {
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      process.env.GEMINI_PACKAGE_MANAGER = 'yarn';
      const result = pm.getPackageManager();
      assert.strictEqual(result.name, 'yarn');
      assert.strictEqual(result.source, 'environment');
    } finally {
      if (originalEnv !== undefined) {
        process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      } else {
        delete process.env.GEMINI_PACKAGE_MANAGER;
      }
    }
  }));

  tally(test('EGC_PACKAGE_MANAGER wins over the old GEMINI_PACKAGE_MANAGER, which is still honored alone', () => {
    const originalEgc = process.env.EGC_PACKAGE_MANAGER;
    const originalGemini = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      process.env.EGC_PACKAGE_MANAGER = 'pnpm';
      process.env.GEMINI_PACKAGE_MANAGER = 'yarn';
      assert.strictEqual(pm.getPackageManager().name, 'pnpm');
      delete process.env.EGC_PACKAGE_MANAGER;
      assert.strictEqual(pm.getPackageManager().name, 'yarn');
    } finally {
      for (const [name, value] of [['EGC_PACKAGE_MANAGER', originalEgc], ['GEMINI_PACKAGE_MANAGER', originalGemini]]) {
        if (value !== undefined) process.env[name] = value;
        else delete process.env[name];
      }
    }
  }));

  tally(test('the project preference lives in .egc/package-manager.json, and an old .gemini/package-manager.json is still read', () => {
    const originalEgc = process.env.EGC_PACKAGE_MANAGER;
    const originalGemini = process.env.GEMINI_PACKAGE_MANAGER;
    delete process.env.EGC_PACKAGE_MANAGER;
    delete process.env.GEMINI_PACKAGE_MANAGER;
    const testDir = createTestDir();
    try {
      pm.setProjectPackageManager('yarn', testDir);
      const written = JSON.parse(fs.readFileSync(path.join(testDir, '.egc', 'package-manager.json'), 'utf8'));
      assert.strictEqual(written.packageManager, 'yarn');
      assert.ok(!fs.existsSync(path.join(testDir, '.gemini')), 'nothing is written under .gemini');
      assert.strictEqual(pm.getPackageManager({ projectDir: testDir }).source, 'project-config');

      const legacyDir = createTestDir();
      try {
        fs.mkdirSync(path.join(legacyDir, '.gemini'), { recursive: true });
        fs.writeFileSync(path.join(legacyDir, '.gemini', 'package-manager.json'), JSON.stringify({ packageManager: 'pnpm' }));
        const detected = pm.getPackageManager({ projectDir: legacyDir });
        assert.strictEqual(detected.name, 'pnpm');
        assert.strictEqual(detected.source, 'project-config');
      } finally {
        cleanupTestDir(legacyDir);
      }
    } finally {
      cleanupTestDir(testDir);
      for (const [name, value] of [['EGC_PACKAGE_MANAGER', originalEgc], ['GEMINI_PACKAGE_MANAGER', originalGemini]]) {
        if (value !== undefined) process.env[name] = value;
        else delete process.env[name];
      }
    }
  }));

  tally(test('detects from lock file in project', () => {
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    delete process.env.GEMINI_PACKAGE_MANAGER;
    const testDir = createTestDir();
    try {
      fs.writeFileSync(path.join(testDir, 'bun.lockb'), '');
      const result = pm.getPackageManager({ projectDir: testDir });
      assert.strictEqual(result.name, 'bun');
      assert.strictEqual(result.source, 'lock-file');
    } finally {
      cleanupTestDir(testDir);
      if (originalEnv !== undefined) {
        process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      }
    }
  }));

  // getRunCommand tests
  console.log('\ngetRunCommand:');

  tally(test('returns correct install command', () => {
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      process.env.GEMINI_PACKAGE_MANAGER = 'pnpm';
      const cmd = pm.getRunCommand('install');
      assert.strictEqual(cmd, 'pnpm install');
    } finally {
      if (originalEnv !== undefined) {
        process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      } else {
        delete process.env.GEMINI_PACKAGE_MANAGER;
      }
    }
  }));

  tally(test('returns correct test command', () => {
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      process.env.GEMINI_PACKAGE_MANAGER = 'npm';
      const cmd = pm.getRunCommand('test');
      assert.strictEqual(cmd, 'npm test');
    } finally {
      if (originalEnv !== undefined) {
        process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      } else {
        delete process.env.GEMINI_PACKAGE_MANAGER;
      }
    }
  }));

  // getExecCommand tests
  console.log('\ngetExecCommand:');

  tally(test('returns correct exec command for npm', () => {
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      process.env.GEMINI_PACKAGE_MANAGER = 'npm';
      const cmd = pm.getExecCommand('prettier', '--write .');
      assert.strictEqual(cmd, 'npx prettier --write .');
    } finally {
      if (originalEnv !== undefined) {
        process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      } else {
        delete process.env.GEMINI_PACKAGE_MANAGER;
      }
    }
  }));

  tally(test('returns correct exec command for pnpm', () => {
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      process.env.GEMINI_PACKAGE_MANAGER = 'pnpm';
      const cmd = pm.getExecCommand('eslint', '.');
      assert.strictEqual(cmd, 'pnpm dlx eslint .');
    } finally {
      if (originalEnv !== undefined) {
        process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      } else {
        delete process.env.GEMINI_PACKAGE_MANAGER;
      }
    }
  }));

  // getCommandPattern tests
  console.log('\ngetCommandPattern:');

  tally(test('generates pattern for dev command', () => {
    const pattern = pm.getCommandPattern('dev');
    assert.ok(pattern.includes('npm run dev'), 'Should include npm');
    assert.ok(pattern.includes('pnpm'), 'Should include pnpm');
    assert.ok(pattern.includes('yarn dev'), 'Should include yarn');
    assert.ok(pattern.includes('bun run dev'), 'Should include bun');
  }));

  tally(test('pattern matches actual commands', () => {
    const pattern = pm.getCommandPattern('test');
    const regex = new RegExp(pattern);
    assert.ok(regex.test('npm test'), 'Should match npm test');
    assert.ok(regex.test('pnpm test'), 'Should match pnpm test');
    assert.ok(regex.test('yarn test'), 'Should match yarn test');
    assert.ok(regex.test('bun test'), 'Should match bun test');
    assert.ok(!regex.test('cargo test'), 'Should not match cargo test');
  }));

  // getSelectionPrompt tests
  console.log('\ngetSelectionPrompt:');

  tally(test('returns informative prompt', () => {
    const prompt = pm.getSelectionPrompt();
    assert.ok(prompt.includes('Supported package managers'), 'Should list supported managers');
    assert.ok(prompt.includes('EGC_PACKAGE_MANAGER'), 'Should mention env var');
    assert.ok(!prompt.includes('.gemini'), 'the prompt points at the EGC directory, not at a fixed ~/.gemini');
    assert.ok(prompt.includes('lock file'), 'Should mention lock file option');
  }));

  // setProjectPackageManager tests
  console.log('\nsetProjectPackageManager:');

  tally(test('sets project package manager', () => {
    const testDir = createTestDir();
    try {
      const result = pm.setProjectPackageManager('pnpm', testDir);
      assert.strictEqual(result.packageManager, 'pnpm');
      assert.ok(result.setAt, 'Should have setAt timestamp');
      const configPath = path.join(testDir, '.egc', 'package-manager.json');
      assert.ok(fs.existsSync(configPath), 'Config file should exist');
      const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.strictEqual(saved.packageManager, 'pnpm');
    } finally {
      cleanupTestDir(testDir);
    }
  }));

  tally(test('rejects unknown package manager', () => {
    assert.throws(() => {
      pm.setProjectPackageManager('cargo');
    }, /Unknown package manager/);
  }));

  // setPreferredPackageManager tests
  console.log('\nsetPreferredPackageManager:');

  tally(test('rejects unknown package manager', () => {
    assert.throws(() => {
      pm.setPreferredPackageManager('pip');
    }, /Unknown package manager/);
  }));

  // detectFromPackageJson edge cases
  console.log('\ndetectFromPackageJson (edge cases):');

  tally(test('handles invalid JSON in package.json', () => {
    const testDir = createTestDir();
    try {
      fs.writeFileSync(path.join(testDir, 'package.json'), 'NOT VALID JSON');
      const result = pm.detectFromPackageJson(testDir);
      assert.strictEqual(result, null);
    } finally {
      cleanupTestDir(testDir);
    }
  }));

  tally(test('returns null for unknown package manager in packageManager field', () => {
    const testDir = createTestDir();
    try {
      fs.writeFileSync(path.join(testDir, 'package.json'), JSON.stringify({ name: 'test', packageManager: 'deno@1.0' }));
      const result = pm.detectFromPackageJson(testDir);
      assert.strictEqual(result, null);
    } finally {
      cleanupTestDir(testDir);
    }
  }));

  // getExecCommand edge cases
  console.log('\ngetExecCommand (edge cases):');

  tally(test('returns exec command without args', () => {
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      process.env.GEMINI_PACKAGE_MANAGER = 'npm';
      const cmd = pm.getExecCommand('prettier');
      assert.strictEqual(cmd, 'npx prettier');
    } finally {
      if (originalEnv !== undefined) {
        process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      } else {
        delete process.env.GEMINI_PACKAGE_MANAGER;
      }
    }
  }));

  // getRunCommand additional cases
  console.log('\ngetRunCommand (additional):');

  tally(test('returns correct build command', () => {
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      process.env.GEMINI_PACKAGE_MANAGER = 'npm';
      assert.strictEqual(pm.getRunCommand('build'), 'npm run build');
    } finally {
      if (originalEnv !== undefined) {
        process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      } else {
        delete process.env.GEMINI_PACKAGE_MANAGER;
      }
    }
  }));

  tally(test('returns correct dev command', () => {
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      process.env.GEMINI_PACKAGE_MANAGER = 'npm';
      assert.strictEqual(pm.getRunCommand('dev'), 'npm run dev');
    } finally {
      if (originalEnv !== undefined) {
        process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      } else {
        delete process.env.GEMINI_PACKAGE_MANAGER;
      }
    }
  }));

  tally(test('returns correct custom script command', () => {
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      process.env.GEMINI_PACKAGE_MANAGER = 'npm';
      assert.strictEqual(pm.getRunCommand('lint'), 'npm run lint');
    } finally {
      if (originalEnv !== undefined) {
        process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      } else {
        delete process.env.GEMINI_PACKAGE_MANAGER;
      }
    }
  }));

  // DETECTION_PRIORITY tests
  console.log('\nDETECTION_PRIORITY:');

  tally(test('has pnpm first', () => {
    assert.strictEqual(pm.DETECTION_PRIORITY[0], 'pnpm');
  }));

  tally(test('has npm last', () => {
    assert.strictEqual(pm.DETECTION_PRIORITY[pm.DETECTION_PRIORITY.length - 1], 'npm');
  }));

  // getCommandPattern additional cases
  console.log('\ngetCommandPattern (additional):');

  tally(test('generates pattern for install command', () => {
    const pattern = pm.getCommandPattern('install');
    const regex = new RegExp(pattern);
    assert.ok(regex.test('npm install'), 'Should match npm install');
    assert.ok(regex.test('pnpm install'), 'Should match pnpm install');
    assert.ok(regex.test('yarn'), 'Should match yarn (install implicit)');
    assert.ok(regex.test('bun install'), 'Should match bun install');
  }));

  tally(test('generates pattern for custom action', () => {
    const pattern = pm.getCommandPattern('lint');
    const regex = new RegExp(pattern);
    assert.ok(regex.test('npm run lint'), 'Should match npm run lint');
    assert.ok(regex.test('pnpm lint'), 'Should match pnpm lint');
    assert.ok(regex.test('yarn lint'), 'Should match yarn lint');
    assert.ok(regex.test('bun run lint'), 'Should match bun run lint');
  }));

  // getPackageManager robustness tests
  console.log('\ngetPackageManager (robustness):');

  tally(test('falls through on corrupted project config JSON', () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-robust-'));
    const claudeDir = path.join(testDir, '.gemini');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'package-manager.json'), '{not valid json!!!');
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      delete process.env.GEMINI_PACKAGE_MANAGER;
      const result = pm.getPackageManager({ projectDir: testDir });
      // Should fall through to default (npm) since project config is corrupt
      assert.ok(result.name, 'Should return a package manager');
      assert.ok(result.source !== 'project-config', 'Should not use corrupt project config');
    } finally {
      if (originalEnv !== undefined) {
        process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      }
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  }));

  tally(test('falls through on project config with unknown PM', () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-robust-'));
    const claudeDir = path.join(testDir, '.gemini');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'package-manager.json'), JSON.stringify({ packageManager: 'nonexistent-pm' }));
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      delete process.env.GEMINI_PACKAGE_MANAGER;
      const result = pm.getPackageManager({ projectDir: testDir });
      assert.ok(result.name, 'Should return a package manager');
      assert.ok(result.source !== 'project-config', 'Should not use unknown PM config');
    } finally {
      if (originalEnv !== undefined) {
        process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      }
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  }));

  // getRunCommand validation tests
  console.log('\ngetRunCommand (validation):');

  tally(test('rejects empty script name', () => {
    assert.throws(() => pm.getRunCommand(''), /non-empty string/);
  }));

  tally(test('rejects null script name', () => {
    assert.throws(() => pm.getRunCommand(null), /non-empty string/);
  }));

  tally(test('rejects script name with shell metacharacters', () => {
    assert.throws(() => pm.getRunCommand('test; rm -rf /'), /unsafe characters/);
  }));

  tally(test('rejects script name with backticks', () => {
    assert.throws(() => pm.getRunCommand('test`whoami`'), /unsafe characters/);
  }));

  tally(test('accepts scoped package names', () => {
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      process.env.GEMINI_PACKAGE_MANAGER = 'npm';
      const cmd = pm.getRunCommand('@scope/my-script');
      assert.strictEqual(cmd, 'npm run @scope/my-script');
    } finally {
      if (originalEnv !== undefined) {
        process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      } else {
        delete process.env.GEMINI_PACKAGE_MANAGER;
      }
    }
  }));

  // getExecCommand validation tests
  console.log('\ngetExecCommand (validation):');

  tally(test('rejects empty binary name', () => {
    assert.throws(() => pm.getExecCommand(''), /non-empty string/);
  }));

  tally(test('rejects null binary name', () => {
    assert.throws(() => pm.getExecCommand(null), /non-empty string/);
  }));

  tally(test('rejects binary name with shell metacharacters', () => {
    assert.throws(() => pm.getExecCommand('prettier; cat /etc/passwd'), /unsafe characters/);
  }));

  tally(test('accepts dotted binary names like tsc', () => {
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      process.env.GEMINI_PACKAGE_MANAGER = 'npm';
      const cmd = pm.getExecCommand('tsc');
      assert.strictEqual(cmd, 'npx tsc');
    } finally {
      if (originalEnv !== undefined) {
        process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      } else {
        delete process.env.GEMINI_PACKAGE_MANAGER;
      }
    }
  }));

  // getPackageManager source detection tests
  console.log('\ngetPackageManager (source detection):');

  tally(test('detects from valid project-config (.gemini/package-manager.json)', () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-projcfg-'));
    const claudeDir = path.join(testDir, '.gemini');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'package-manager.json'), JSON.stringify({ packageManager: 'pnpm' }));
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      delete process.env.GEMINI_PACKAGE_MANAGER;
      const result = pm.getPackageManager({ projectDir: testDir });
      assert.strictEqual(result.name, 'pnpm', 'Should detect pnpm from project config');
      assert.strictEqual(result.source, 'project-config', 'Source should be project-config');
    } finally {
      if (originalEnv !== undefined) {
        process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      }
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  }));

  tally(test('project-config takes priority over package.json', () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-priority-'));
    const claudeDir = path.join(testDir, '.gemini');
    fs.mkdirSync(claudeDir, { recursive: true });
    // Project config says bun
    fs.writeFileSync(path.join(claudeDir, 'package-manager.json'), JSON.stringify({ packageManager: 'bun' }));
    // package.json says yarn
    fs.writeFileSync(path.join(testDir, 'package.json'), JSON.stringify({ packageManager: 'yarn@4.0.0' }));
    // Lock file says npm
    fs.writeFileSync(path.join(testDir, 'package-lock.json'), '{}');
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      delete process.env.GEMINI_PACKAGE_MANAGER;
      const result = pm.getPackageManager({ projectDir: testDir });
      assert.strictEqual(result.name, 'bun', 'Project config should win over package.json and lock file');
      assert.strictEqual(result.source, 'project-config');
    } finally {
      if (originalEnv !== undefined) {
        process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      }
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  }));

  tally(test('package.json takes priority over lock file', () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-pj-lock-'));
    // package.json says yarn
    fs.writeFileSync(path.join(testDir, 'package.json'), JSON.stringify({ packageManager: 'yarn@4.0.0' }));
    // Lock file says npm
    fs.writeFileSync(path.join(testDir, 'package-lock.json'), '{}');
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      delete process.env.GEMINI_PACKAGE_MANAGER;
      const result = pm.getPackageManager({ projectDir: testDir });
      assert.strictEqual(result.name, 'yarn', 'package.json should win over lock file');
      assert.strictEqual(result.source, 'package.json');
    } finally {
      if (originalEnv !== undefined) {
        process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      }
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  }));

  tally(test('defaults to npm when no config found', () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-default-'));
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      delete process.env.GEMINI_PACKAGE_MANAGER;
      withIsolatedHome(() => {
        const result = pm.getPackageManager({ projectDir: testDir });
        assert.strictEqual(result.name, 'npm', 'Should default to npm');
        assert.strictEqual(result.source, 'default');
      });
    } finally {
      if (originalEnv !== undefined) {
        process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      }
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  }));

  // setPreferredPackageManager success
  console.log('\nsetPreferredPackageManager (success):');

  tally(test('successfully saves preferred package manager', () => {
    // This writes to ~/.gemini/package-manager.json: read original to restore
    const utils = require('../../scripts/lib/utils');
    const configPath = path.join(utils.getEGCDir(), 'package-manager.json');
    const original = utils.readFile(configPath);
    try {
      const config = pm.setPreferredPackageManager('bun');
      assert.strictEqual(config.packageManager, 'bun');
      assert.ok(config.setAt, 'Should have setAt timestamp');
      const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.strictEqual(saved.packageManager, 'bun');
    } finally {
      if (original) {
        fs.writeFileSync(configPath, original, 'utf8');
      } else {
        try {
          fs.unlinkSync(configPath);
        } catch (_err) {
          // ignore
        }
      }
    }
  }));

  // getCommandPattern completeness
  console.log('\ngetCommandPattern (completeness):');

  tally(test('generates pattern for test command', () => {
    const pattern = pm.getCommandPattern('test');
    assert.ok(pattern.includes('npm test'), 'Should include npm test');
    assert.ok(pattern.includes('pnpm test'), 'Should include pnpm test');
    assert.ok(pattern.includes('bun test'), 'Should include bun test');
  }));

  tally(test('generates pattern for build command', () => {
    const pattern = pm.getCommandPattern('build');
    assert.ok(pattern.includes('npm run build'), 'Should include npm run build');
    assert.ok(pattern.includes('yarn build'), 'Should include yarn build');
  }));

  // getRunCommand PM-specific format tests
  console.log('\ngetRunCommand (PM-specific formats):');

  tally(test('pnpm custom script: pnpm (no run keyword)', () => {
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      process.env.GEMINI_PACKAGE_MANAGER = 'pnpm';
      const cmd = pm.getRunCommand('lint');
      assert.strictEqual(cmd, 'pnpm lint', 'pnpm uses "pnpm <script>" format');
    } finally {
      if (originalEnv !== undefined) process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      else delete process.env.GEMINI_PACKAGE_MANAGER;
    }
  }));

  tally(test('yarn custom script: yarn <script>', () => {
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      process.env.GEMINI_PACKAGE_MANAGER = 'yarn';
      const cmd = pm.getRunCommand('format');
      assert.strictEqual(cmd, 'yarn format', 'yarn uses "yarn <script>" format');
    } finally {
      if (originalEnv !== undefined) process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      else delete process.env.GEMINI_PACKAGE_MANAGER;
    }
  }));

  tally(test('bun custom script: bun run <script>', () => {
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      process.env.GEMINI_PACKAGE_MANAGER = 'bun';
      const cmd = pm.getRunCommand('typecheck');
      assert.strictEqual(cmd, 'bun run typecheck', 'bun uses "bun run <script>" format');
    } finally {
      if (originalEnv !== undefined) process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      else delete process.env.GEMINI_PACKAGE_MANAGER;
    }
  }));

  tally(test('npm custom script: npm run <script>', () => {
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      process.env.GEMINI_PACKAGE_MANAGER = 'npm';
      const cmd = pm.getRunCommand('lint');
      assert.strictEqual(cmd, 'npm run lint', 'npm uses "npm run <script>" format');
    } finally {
      if (originalEnv !== undefined) process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      else delete process.env.GEMINI_PACKAGE_MANAGER;
    }
  }));

  tally(test('pnpm install returns pnpm install', () => {
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      process.env.GEMINI_PACKAGE_MANAGER = 'pnpm';
      assert.strictEqual(pm.getRunCommand('install'), 'pnpm install');
    } finally {
      if (originalEnv !== undefined) process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      else delete process.env.GEMINI_PACKAGE_MANAGER;
    }
  }));

  tally(test('yarn install returns yarn (no install keyword)', () => {
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      process.env.GEMINI_PACKAGE_MANAGER = 'yarn';
      assert.strictEqual(pm.getRunCommand('install'), 'yarn');
    } finally {
      if (originalEnv !== undefined) process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      else delete process.env.GEMINI_PACKAGE_MANAGER;
    }
  }));

  tally(test('bun test returns bun test', () => {
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      process.env.GEMINI_PACKAGE_MANAGER = 'bun';
      assert.strictEqual(pm.getRunCommand('test'), 'bun test');
    } finally {
      if (originalEnv !== undefined) process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      else delete process.env.GEMINI_PACKAGE_MANAGER;
    }
  }));

  // getExecCommand PM-specific format tests
  console.log('\ngetExecCommand (PM-specific formats):');

  tally(test('pnpm exec: pnpm dlx <binary>', () => {
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      process.env.GEMINI_PACKAGE_MANAGER = 'pnpm';
      assert.strictEqual(pm.getExecCommand('prettier', '--write .'), 'pnpm dlx prettier --write .');
    } finally {
      if (originalEnv !== undefined) process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      else delete process.env.GEMINI_PACKAGE_MANAGER;
    }
  }));

  tally(test('yarn exec: yarn dlx <binary>', () => {
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      process.env.GEMINI_PACKAGE_MANAGER = 'yarn';
      assert.strictEqual(pm.getExecCommand('eslint', '.'), 'yarn dlx eslint .');
    } finally {
      if (originalEnv !== undefined) process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      else delete process.env.GEMINI_PACKAGE_MANAGER;
    }
  }));

  tally(test('bun exec: bunx <binary>', () => {
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      process.env.GEMINI_PACKAGE_MANAGER = 'bun';
      assert.strictEqual(pm.getExecCommand('tsc', '--noEmit'), 'bunx tsc --noEmit');
    } finally {
      if (originalEnv !== undefined) process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      else delete process.env.GEMINI_PACKAGE_MANAGER;
    }
  }));

  tally(test('ignores unknown env var package manager', () => {
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      process.env.GEMINI_PACKAGE_MANAGER = 'totally-fake-pm';
      const result = pm.getPackageManager();
      // Should ignore invalid env var and fall through
      assert.notStrictEqual(result.name, 'totally-fake-pm', 'Should not use unknown PM');
    } finally {
      if (originalEnv !== undefined) {
        process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      } else {
        delete process.env.GEMINI_PACKAGE_MANAGER;
      }
    }
  }));

  // ─── Round 21: getExecCommand args validation ───
  console.log('\ngetExecCommand (args validation):');

  tally(test('rejects args with shell metacharacter semicolon', () => {
    assert.throws(() => pm.getExecCommand('prettier', '; rm -rf /'), /unsafe characters/);
  }));

  tally(test('rejects args with pipe character', () => {
    assert.throws(() => pm.getExecCommand('prettier', '--write . | cat'), /unsafe characters/);
  }));

  tally(test('rejects args with backtick injection', () => {
    assert.throws(() => pm.getExecCommand('prettier', '`whoami`'), /unsafe characters/);
  }));

  tally(test('rejects args with dollar sign', () => {
    assert.throws(() => pm.getExecCommand('prettier', '$HOME'), /unsafe characters/);
  }));

  tally(test('rejects args with ampersand', () => {
    assert.throws(() => pm.getExecCommand('prettier', '--write . && echo pwned'), /unsafe characters/);
  }));

  tally(test('allows safe args like --write .', () => {
    const cmd = pm.getExecCommand('prettier', '--write .');
    assert.ok(cmd.includes('--write .'), 'Should include safe args');
  }));

  tally(test('allows empty args without trailing space', () => {
    const cmd = pm.getExecCommand('prettier', '');
    assert.ok(!cmd.endsWith(' '), 'Should not have trailing space for empty args');
  }));

  // ─── Round 21: getCommandPattern regex escaping ───
  console.log('\ngetCommandPattern (regex escaping):');

  tally(test('escapes dot in action name for regex safety', () => {
    const pattern = pm.getCommandPattern('test.all');
    // The dot should be escaped to \. in the pattern
    const regex = new RegExp(pattern);
    assert.ok(regex.test('npm run test.all'), 'Should match literal dot');
    assert.ok(!regex.test('npm run testXall'), 'Should NOT match arbitrary character in place of dot');
  }));

  tally(test('escapes brackets in action name', () => {
    const pattern = pm.getCommandPattern('build[prod]');
    const regex = new RegExp(pattern);
    assert.ok(regex.test('npm run build[prod]'), 'Should match literal brackets');
  }));

  tally(test('escapes parentheses in action name', () => {
    // Should not throw when compiled as regex
    const pattern = pm.getCommandPattern('foo(bar)');
    assert.doesNotThrow(() => new RegExp(pattern), 'Should produce valid regex with escaped parens');
  }));

  // ── Round 27: input validation and escapeRegex edge cases ──
  console.log('\ngetRunCommand (non-string input):');

  tally(test('rejects undefined script name', () => {
    assert.throws(() => pm.getRunCommand(undefined), /non-empty string/);
  }));

  tally(test('rejects numeric script name', () => {
    assert.throws(() => pm.getRunCommand(123), /non-empty string/);
  }));

  tally(test('rejects boolean script name', () => {
    assert.throws(() => pm.getRunCommand(true), /non-empty string/);
  }));

  console.log('\ngetExecCommand (non-string binary):');

  tally(test('rejects undefined binary name', () => {
    assert.throws(() => pm.getExecCommand(undefined), /non-empty string/);
  }));

  tally(test('rejects numeric binary name', () => {
    assert.throws(() => pm.getExecCommand(42), /non-empty string/);
  }));

  console.log('\ngetCommandPattern (escapeRegex completeness):');

  tally(test('escapes all regex metacharacters in action', () => {
    // All regex metacharacters: . * + ? ^ $ { } ( ) | [ ] \
    const action = 'test.*+?^${}()|[]\\\\';
    const pattern = pm.getCommandPattern(action);
    // Should produce a valid regex without throwing
    assert.doesNotThrow(() => new RegExp(pattern), 'Should produce valid regex');
    // Should match the literal string
    const regex = new RegExp(pattern);
    assert.ok(regex.test(`npm run ${action}`), 'Should match literal metacharacters');
  }));

  tally(test('escapeRegex preserves alphanumeric chars', () => {
    const pattern = pm.getCommandPattern('simple-test');
    const regex = new RegExp(pattern);
    assert.ok(regex.test('npm run simple-test'), 'Should match simple action name');
    assert.ok(!regex.test('npm run simpleXtest'), 'Dash should not match arbitrary char');
  }));

  console.log('\ngetPackageManager (global config edge cases):');

  tally(test('ignores global config with non-string packageManager', () => {
    // This tests the path through loadConfig where packageManager is not a valid PM name
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      delete process.env.GEMINI_PACKAGE_MANAGER;
      // getPackageManager should fall through to default when no valid config exists
      const result = pm.getPackageManager({ projectDir: os.tmpdir() });
      assert.ok(result.name, 'Should return a package manager name');
      assert.ok(result.config, 'Should return config object');
    } finally {
      if (originalEnv !== undefined) {
        process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      }
    }
  }));

  // ── Round 30: getCommandPattern with special action patterns ──
  console.log('\nRound 30: getCommandPattern edge cases:');

  tally(test('escapes pipe character in action name', () => {
    const pattern = pm.getCommandPattern('lint|fix');
    const regex = new RegExp(pattern);
    assert.ok(regex.test('npm run lint|fix'), 'Should match literal pipe');
    assert.ok(!regex.test('npm run lint'), 'Pipe should be literal, not regex OR');
  }));

  tally(test('escapes dollar sign in action name', () => {
    const pattern = pm.getCommandPattern('deploy$prod');
    const regex = new RegExp(pattern);
    assert.ok(regex.test('npm run deploy$prod'), 'Should match literal dollar sign');
  }));

  tally(test('handles action with leading/trailing spaces gracefully', () => {
    // Spaces aren't special in regex but good to test the full pattern
    const pattern = pm.getCommandPattern(' dev ');
    const regex = new RegExp(pattern);
    assert.ok(regex.test('npm run dev '), 'Should match action with spaces');
  }));

  tally(test('known action "dev" does NOT use escapeRegex path', () => {
    // "dev" is a known action with hardcoded patterns, not the generic path
    const pattern = pm.getCommandPattern('dev');
    // Should match pnpm dev (without \"run\")
    const regex = new RegExp(pattern);
    assert.ok(regex.test('pnpm dev'), 'Known action pnpm dev should match');
  }));

  // ── Round 31: setProjectPackageManager write verification ──
  console.log('\nsetProjectPackageManager (write verification, Round 31):');

  tally(test('setProjectPackageManager creates the .egc directory if missing', () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-mkdir-'));
    try {
      const egcDir = path.join(testDir, '.egc');
      assert.ok(!fs.existsSync(egcDir), '.egc should not pre-exist');
      pm.setProjectPackageManager('npm', testDir);
      assert.ok(fs.existsSync(egcDir), '.egc should be created');
      const configPath = path.join(egcDir, 'package-manager.json');
      assert.ok(fs.existsSync(configPath), 'Config file should be created');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  }));

  tally(test('setProjectPackageManager includes setAt timestamp', () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-ts-'));
    try {
      const before = new Date().toISOString();
      const config = pm.setProjectPackageManager('yarn', testDir);
      const after = new Date().toISOString();
      assert.ok(config.setAt >= before, 'setAt should be >= before');
      assert.ok(config.setAt <= after, 'setAt should be <= after');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  }));

  // ── Round 31: getExecCommand safe argument edge cases ──
  console.log('\ngetExecCommand (safe argument edge cases, Round 31):');

  tally(test('allows colons in args (e.g. --fix:all)', () => {
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      process.env.GEMINI_PACKAGE_MANAGER = 'npm';
      const cmd = pm.getExecCommand('eslint', '--fix:all');
      assert.ok(cmd.includes('--fix:all'), 'Colons should be allowed in args');
    } finally {
      if (originalEnv !== undefined) process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      else delete process.env.GEMINI_PACKAGE_MANAGER;
    }
  }));

  tally(test('allows at-sign in args (e.g. @latest)', () => {
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      process.env.GEMINI_PACKAGE_MANAGER = 'npm';
      const cmd = pm.getExecCommand('create-next-app', '@latest');
      assert.ok(cmd.includes('@latest'), 'At-sign should be allowed in args');
    } finally {
      if (originalEnv !== undefined) process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      else delete process.env.GEMINI_PACKAGE_MANAGER;
    }
  }));

  tally(test('allows equals in args (e.g. --config=path)', () => {
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      process.env.GEMINI_PACKAGE_MANAGER = 'npm';
      const cmd = pm.getExecCommand('prettier', '--config=.prettierrc');
      assert.ok(cmd.includes('--config=.prettierrc'), 'Equals should be allowed');
    } finally {
      if (originalEnv !== undefined) process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      else delete process.env.GEMINI_PACKAGE_MANAGER;
    }
  }));

  // ── Round 34: getExecCommand non-string args & packageManager type ──
  console.log('\nRound 34: getExecCommand non-string args:');

  tally(test('getExecCommand with args=0 produces command without extra args', () => {
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      process.env.GEMINI_PACKAGE_MANAGER = 'npm';
      const cmd = pm.getExecCommand('prettier', 0);
      // 0 is falsy, so ternary `args ? ' ' + args : ''` yields ''
      assert.ok(!cmd.includes(' 0'), 'Should not append 0 as args');
      assert.ok(cmd.includes('prettier'), 'Should include binary name');
    } finally {
      if (originalEnv !== undefined) process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      else delete process.env.GEMINI_PACKAGE_MANAGER;
    }
  }));

  tally(test('getExecCommand with args=false produces command without extra args', () => {
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      process.env.GEMINI_PACKAGE_MANAGER = 'npm';
      const cmd = pm.getExecCommand('eslint', false);
      assert.ok(!cmd.includes('false'), 'Should not append false as args');
      assert.ok(cmd.includes('eslint'), 'Should include binary name');
    } finally {
      if (originalEnv !== undefined) process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      else delete process.env.GEMINI_PACKAGE_MANAGER;
    }
  }));

  tally(test('getExecCommand with args=null produces command without extra args', () => {
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      process.env.GEMINI_PACKAGE_MANAGER = 'npm';
      const cmd = pm.getExecCommand('tsc', null);
      assert.ok(!cmd.includes('null'), 'Should not append null as args');
      assert.ok(cmd.includes('tsc'), 'Should include binary name');
    } finally {
      if (originalEnv !== undefined) process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      else delete process.env.GEMINI_PACKAGE_MANAGER;
    }
  }));

  console.log('\nRound 34: detectFromPackageJson with non-string packageManager:');

  tally(test('detectFromPackageJson handles array packageManager field gracefully', () => {
    const tmpDir = createTestDir();
    try {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ packageManager: ['pnpm@8', 'yarn@3'] }));
      // Should not crash: try/catch in detectFromPackageJson catches TypeError
      const result = pm.getPackageManager({ projectDir: tmpDir });
      assert.ok(result.name, 'Should fallback to a valid package manager');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }));

  tally(test('detectFromPackageJson handles numeric packageManager field gracefully', () => {
    const tmpDir = createTestDir();
    try {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ packageManager: 42 }));
      const result = pm.getPackageManager({ projectDir: tmpDir });
      assert.ok(result.name, 'Should fallback to a valid package manager');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }));

  // ── Round 48: detectFromPackageJson format edge cases ──
  console.log('\nRound 48: detectFromPackageJson (version format edge cases):');

  tally(test('returns null for packageManager with non-@ separator', () => {
    const testDir = createTestDir();
    try {
      fs.writeFileSync(path.join(testDir, 'package.json'), JSON.stringify({ name: 'test', packageManager: 'pnpm+8.6.0' }));
      const result = pm.detectFromPackageJson(testDir);
      // split('@') on 'pnpm+8.6.0' returns ['pnpm+8.6.0'], which doesn't match PACKAGE_MANAGERS
      assert.strictEqual(result, null, 'Non-@ format should not match any package manager');
    } finally {
      cleanupTestDir(testDir);
    }
  }));

  tally(test('extracts package manager from caret version like yarn@^4.0.0', () => {
    const testDir = createTestDir();
    try {
      fs.writeFileSync(path.join(testDir, 'package.json'), JSON.stringify({ name: 'test', packageManager: 'yarn@^4.0.0' }));
      const result = pm.detectFromPackageJson(testDir);
      assert.strictEqual(result, 'yarn', 'Caret version should still extract PM name');
    } finally {
      cleanupTestDir(testDir);
    }
  }));

  // getPackageManager falls through corrupted global config to npm default
  tally(test('getPackageManager falls through corrupted global config to npm default', () => {
    const tmpDir = createTestDir();
    const projDir = path.join(tmpDir, 'proj');
    fs.mkdirSync(projDir, { recursive: true });

    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;
    const origPM = process.env.GEMINI_PACKAGE_MANAGER;

    try {
      const claudeDir = path.join(tmpDir, '.gemini');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(path.join(claudeDir, 'package-manager.json'), '{ invalid json !!!', 'utf8');

      process.env.HOME = tmpDir;
      process.env.USERPROFILE = tmpDir;
      delete process.env.GEMINI_PACKAGE_MANAGER;

      // Re-require to pick up new HOME
      delete require.cache[require.resolve('../../scripts/lib/package-manager')];
      delete require.cache[require.resolve('../../scripts/lib/utils')];
      const freshPM = require('../../scripts/lib/package-manager');

      // Empty project dir: no lock file, no package.json, no project config
      const result = freshPM.getPackageManager({ projectDir: projDir });
      assert.strictEqual(result.name, 'npm', 'Should fall through to npm default');
      assert.strictEqual(result.source, 'default', 'Source should be default');
    } finally {
      process.env.HOME = origHome;
      process.env.USERPROFILE = origUserProfile;
      if (origPM !== undefined) process.env.GEMINI_PACKAGE_MANAGER = origPM;

      delete require.cache[require.resolve('../../scripts/lib/package-manager')];
      delete require.cache[require.resolve('../../scripts/lib/utils')];
      cleanupTestDir(tmpDir);
    }
  }));

  // ── Round 69: getPackageManager global-config success path ──
  console.log('\nRound 69: getPackageManager (global-config success):');

  tally(test('getPackageManager returns source global-config when valid global config exists', () => {
    const tmpDir = createTestDir();
    const projDir = path.join(tmpDir, 'proj');
    fs.mkdirSync(projDir, { recursive: true });

    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;
    const origPM = process.env.GEMINI_PACKAGE_MANAGER;

    try {
      const claudeDir = path.join(tmpDir, '.gemini');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(path.join(claudeDir, 'package-manager.json'), JSON.stringify({ packageManager: 'pnpm', setAt: '2026-01-01T00:00:00Z' }), 'utf8');

      process.env.HOME = tmpDir;
      process.env.USERPROFILE = tmpDir;
      delete process.env.GEMINI_PACKAGE_MANAGER;

      // Re-require to pick up new HOME
      delete require.cache[require.resolve('../../scripts/lib/package-manager')];
      delete require.cache[require.resolve('../../scripts/lib/utils')];
      const freshPM = require('../../scripts/lib/package-manager');

      // Empty project dir: no lock file, no package.json, no project config
      const result = freshPM.getPackageManager({ projectDir: projDir });
      assert.strictEqual(result.name, 'pnpm', 'Should detect pnpm from global config');
      assert.strictEqual(result.source, 'global-config', 'Source should be global-config');
      assert.ok(result.config, 'Should include config object');
      assert.strictEqual(result.config.lockFile, 'pnpm-lock.yaml', 'Config should match pnpm');
    } finally {
      process.env.HOME = origHome;
      process.env.USERPROFILE = origUserProfile;
      if (origPM !== undefined) process.env.GEMINI_PACKAGE_MANAGER = origPM;

      delete require.cache[require.resolve('../../scripts/lib/package-manager')];
      delete require.cache[require.resolve('../../scripts/lib/utils')];
      cleanupTestDir(tmpDir);
    }
  }));

  // ── Round 71: setPreferredPackageManager save failure wraps error ──
  console.log('\nRound 71: setPreferredPackageManager (save failure):');

  tally(test('setPreferredPackageManager throws wrapped error when save fails', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      console.log(' (skipped: chmod ineffective on Windows/root)');
      return;
    }
    const isoHome = path.join(os.tmpdir(), `egc-pm-r71-${Date.now()}`);
    const claudeDir = path.join(isoHome, '.gemini');
    fs.mkdirSync(claudeDir, { recursive: true });
    const savedHome = process.env.HOME;
    const savedProfile = process.env.USERPROFILE;
    try {
      process.env.HOME = isoHome;
      process.env.USERPROFILE = isoHome;
      delete require.cache[require.resolve('../../scripts/lib/package-manager')];
      delete require.cache[require.resolve('../../scripts/lib/utils')];
      const freshPm = require('../../scripts/lib/package-manager');
      // Make .gemini directory read-only: can't create new files (package-manager.json)
      fs.chmodSync(claudeDir, 0o555);
      assert.throws(() => {
        freshPm.setPreferredPackageManager('npm');
      }, /Failed to save package manager preference/);
    } finally {
      try {
        fs.chmodSync(claudeDir, 0o755);
      } catch (_err) {
        /* best-effort */
      }
      process.env.HOME = savedHome;
      process.env.USERPROFILE = savedProfile;
      delete require.cache[require.resolve('../../scripts/lib/package-manager')];
      delete require.cache[require.resolve('../../scripts/lib/utils')];
      fs.rmSync(isoHome, { recursive: true, force: true });
    }
  }));

  // ── Round 72: setProjectPackageManager save failure wraps error ──
  console.log('\nRound 72: setProjectPackageManager (save failure):');

  tally(test('setProjectPackageManager throws wrapped error when write fails', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      console.log(' (skipped: chmod ineffective on Windows/root)');
      return;
    }
    const isoProject = path.join(os.tmpdir(), `egc-pm-proj-r72-${Date.now()}`);
    const claudeDir = path.join(isoProject, '.egc');
    fs.mkdirSync(claudeDir, { recursive: true });
    // Make the .egc directory read-only: can't create new files
    fs.chmodSync(claudeDir, 0o555);
    try {
      assert.throws(() => {
        pm.setProjectPackageManager('npm', isoProject);
      }, /Failed to save package manager config/);
    } finally {
      fs.chmodSync(claudeDir, 0o755);
      fs.rmSync(isoProject, { recursive: true, force: true });
    }
  }));

  // ── Round 80: getExecCommand with truthy non-string args ──
  console.log('\nRound 80: getExecCommand (truthy non-string args):');

  tally(test('getExecCommand with args=42 (truthy number) appends stringified value', () => {
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      process.env.GEMINI_PACKAGE_MANAGER = 'npm';
      // args=42: truthy, so typeof check at line 334 short-circuits
      // (typeof 42 !== 'string'), skipping validation. Line 339:
      // 42 ? ' ' + 42 -> ' 42' -> appended.
      const cmd = pm.getExecCommand('prettier', 42);
      assert.ok(cmd.includes('prettier'), 'Should include binary name');
      assert.ok(cmd.includes('42'), 'Truthy number should be stringified and appended');
    } finally {
      if (originalEnv !== undefined) process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      else delete process.env.GEMINI_PACKAGE_MANAGER;
    }
  }));

  // ── Round 86: detectFromPackageJson with empty (0-byte) package.json ──
  console.log('\nRound 86: detectFromPackageJson (empty package.json):');

  tally(test('detectFromPackageJson returns null for empty (0-byte) package.json', () => {
    // package-manager.js line 109-111: readFile returns "" for empty file.
    // "" is falsy -> if (content) is false -> skips JSON.parse -> returns null.
    const testDir = createTestDir();
    fs.writeFileSync(path.join(testDir, 'package.json'), '');
    const result = pm.detectFromPackageJson(testDir);
    assert.strictEqual(result, null, 'Empty package.json should return null (content="" is falsy)');
    cleanupTestDir(testDir);
  }));

  // ── Round 91: getCommandPattern with empty action string ──
  console.log('\nRound 91: getCommandPattern (empty action):');

  tally(test('getCommandPattern with empty string returns valid regex pattern', () => {
    // package-manager.js line 401-409: Empty action falls to the else branch.
    // escapeRegex('') returns '', producing patterns like 'npm run ', 'yarn '.
    // The resulting combined regex should be compilable (not throw).
    const pattern = pm.getCommandPattern('');
    assert.ok(typeof pattern === 'string', 'Should return a string');
    assert.ok(pattern.length > 0, 'Should return non-empty pattern');
    const regex = new RegExp(pattern);
    assert.ok(regex instanceof RegExp, 'Pattern should compile to valid RegExp');
    // The pattern should match package manager commands with trailing space
    assert.ok(regex.test('npm run '), 'Should match "npm run " with trailing space');
    assert.ok(regex.test('yarn '), 'Should match "yarn " with trailing space');
  }));

  // ── Round 91: detectFromPackageJson with whitespace-only packageManager ──
  console.log('\nRound 91: detectFromPackageJson (whitespace-only packageManager):');

  tally(test('detectFromPackageJson returns null for whitespace-only packageManager field', () => {
    // package-manager.js line 114-119: \" \" is truthy, so enters the if block.
    // \" \".split('@')[0] = \" \" which doesn't match any PACKAGE_MANAGERS key.
    const testDir = createTestDir();
    fs.writeFileSync(
      path.join(testDir, 'package.json'),
      JSON.stringify({ packageManager: ' ' })
    );
    const result = pm.detectFromPackageJson(testDir);
    assert.strictEqual(result, null, 'Whitespace-only packageManager should return null');
    cleanupTestDir(testDir);
  }));

  // ── Round 92: detectFromPackageJson with empty string packageManager ──
  console.log('\nRound 92: detectFromPackageJson (empty string packageManager):');

  tally(test('detectFromPackageJson returns null for empty string packageManager field', () => {
    // package-manager.js line 114: if (pkg.packageManager): empty string \"\" is falsy,
    // so the if block is skipped entirely. Function returns null without attempting split.
    // This is distinct from Round 91's whitespace test (\" \" is truthy and enters the if).
    const testDir = createTestDir();
    fs.writeFileSync(
      path.join(testDir, 'package.json'),
      JSON.stringify({ name: 'test', packageManager: '' })
    );
    const result = pm.detectFromPackageJson(testDir);
    assert.strictEqual(result, null, 'Empty string packageManager should return null (falsy)');
    cleanupTestDir(testDir);
  }));

  // ── Round 94: detectFromPackageJson with scoped package name ──
  console.log('\nRound 94: detectFromPackageJson (scoped package name @scope/pkg@version):');

  tally(test('detectFromPackageJson returns null for scoped package name (@scope/pkg@version)', () => {
    // package-manager.js line 116: pmName = pkg.packageManager.split('@')[0]\
    // For \"@pnpm/exe@8.0.0\", split('@') -> ['', 'pnpm/exe', '8.0.0'], so [0] = ''\
    // PACKAGE_MANAGERS[''] is undefined -> returns null.\
    // Scoped npm packages like @pnpm/exe are a real-world pattern but the\
    // packageManager field spec uses unscoped names (e.g., \"pnpm@8\"), so returning\
    // null is the correct defensive behaviour for this edge case.
    const testDir = createTestDir();
    fs.writeFileSync(
      path.join(testDir, 'package.json'),
      JSON.stringify({ name: 'test', packageManager: '@pnpm/exe@8.0.0' })
    );
    const result = pm.detectFromPackageJson(testDir);
    assert.strictEqual(result, null, 'Scoped package name should return null (split("@")[0] is empty string)');
    cleanupTestDir(testDir);
  }));

  // ── Round 94: getPackageManager with empty string GEMINI_PACKAGE_MANAGER ──
  console.log('\nRound 94: getPackageManager (empty string GEMINI_PACKAGE_MANAGER env var):');

  tally(test('getPackageManager skips empty string GEMINI_PACKAGE_MANAGER (falsy short-circuit)', () => {
    // package-manager.js line 168: if (envPm && PACKAGE_MANAGERS[envPm])\
    // Empty string '' is falsy: the && short-circuits before checking PACKAGE_MANAGERS.\
    // This is distinct from the 'totally-fake-pm' test (truthy but unknown PM).
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      process.env.GEMINI_PACKAGE_MANAGER = '';
      const result = pm.getPackageManager();
      assert.notStrictEqual(result.source, 'environment', 'Empty string env var should NOT be treated as environment source');
      assert.ok(result.name, 'Should still return a valid package manager name');
    } finally {
      if (originalEnv !== undefined) {
        process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      } else {
        delete process.env.GEMINI_PACKAGE_MANAGER;
      }
    }
  }));

  // ── Round 104: detectFromLockFile with null projectDir (no input validation) ──
  console.log('\nRound 104: detectFromLockFile (null projectDir: throws TypeError):');

  tally(test('detectFromLockFile(null) throws TypeError (path.join rejects null)', () => {
    // package-manager.js line 95: `path.join(projectDir, pm.lockFile)`: there is no\
    // guard checking that projectDir is a string before passing it to path.join().\
    // When projectDir is null, path.join(null, 'package-lock.json') throws a TypeError\
    // because path.join only accepts string arguments.
    assert.throws(
      () => pm.detectFromLockFile(null),
      { name: 'TypeError' },
      'path.join(null, ...) should throw TypeError (no input validation in detectFromLockFile)'
    );
  }));

  // ── Round 105: getExecCommand with object args (bypasses SAFE_ARGS_REGEX, coerced to [object Object]) ──
  console.log('\nRound 105: getExecCommand (object args: typeof bypass coerces to [object Object]):');

  tally(test('getExecCommand with args={} bypasses SAFE_ARGS validation and coerces to "[object Object]"', () => {
    // package-manager.js line 334: `if (args && typeof args === 'string' && !SAFE_ARGS_REGEX.test(args))`
    // SAFE_ARGS_REGEX check is entirely SKIPPED.\
    // Line 339: `args ? ' ' + args : ''`: object is truthy, so it reaches\
    // string concatenation which calls {}.toString() -> \"[object Object]\"\
    // Final command: "npx prettier [object Object]": brackets bypass validation.
    const cmd = pm.getExecCommand('prettier', {});
    assert.ok(cmd.includes('[object Object]'), 'Object args should be coerced to "[object Object]" via implicit toString()');
    // Verify the SAFE_ARGS regex WOULD reject this string if it were a string arg
    assert.throws(
      () => pm.getExecCommand('prettier', '[object Object]'),
      /unsafe characters/,
      'Same string as explicit string arg is correctly rejected by SAFE_ARGS_REGEX'
    );
  }));

  // ── Round 109: getExecCommand with ../ path traversal in binary: SAFE_NAME_REGEX allows it ──
  console.log('\nRound 109: getExecCommand (path traversal in binary: SAFE_NAME_REGEX permits ../ in binary name):');

  tally(test('getExecCommand accepts ../../../etc/passwd as binary because SAFE_NAME_REGEX allows ../', () => {
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      process.env.GEMINI_PACKAGE_MANAGER = 'npm';
      // SAFE_NAME_REGEX = /^[@a-zA-Z0-9_.\\/-\\\\]+$/ individually allows . and /\
      const cmd = pm.getExecCommand('../../../etc/passwd');
      assert.strictEqual(cmd, 'npx ../../../etc/passwd', 'Path traversal in binary passes SAFE_NAME_REGEX because . and / are individually allowed');
      // Also verify scoped path traversal
      const cmd2 = pm.getExecCommand('@scope/../../evil');
      assert.strictEqual(cmd2, 'npx @scope/../../evil', 'Scoped path traversal also passes the regex');
    } finally {
      if (originalEnv !== undefined) {
        process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      } else {
        delete process.env.GEMINI_PACKAGE_MANAGER;
      }
    }
  }));

  // ── Round 108: getRunCommand with path traversal: SAFE_NAME_REGEX allows ../ sequences ──
  console.log('\nRound 108: getRunCommand (path traversal: SAFE_NAME_REGEX permits ../ via allowed / and . chars):');

  tally(test('getRunCommand accepts @scope/../../evil because SAFE_NAME_REGEX allows ../', () => {
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      process.env.GEMINI_PACKAGE_MANAGER = 'npm';
      // SAFE_NAME_REGEX = /^[@a-zA-Z0-9_.\\/-\\\\]+$/ allows each char individually,\
      // so '../' passes despite being a path traversal sequence
      const cmd = pm.getRunCommand('@scope/../../evil');
      assert.strictEqual(cmd, 'npm run @scope/../../evil', 'Path traversal passes SAFE_NAME_REGEX because / and . are individually allowed');
      // Also verify plain ../ passes
      const cmd2 = pm.getRunCommand('../../../etc/passwd');
      assert.strictEqual(cmd2, 'npm run ../../../etc/passwd', 'Bare ../ traversal also passes the regex');
    } finally {
      if (originalEnv !== undefined) {
        process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      } else {
        delete process.env.GEMINI_PACKAGE_MANAGER;
      }
    }
  }));

  // Round 111: getExecCommand with newline in args
  console.log('\n' + String.raw`Round 111: getExecCommand (newline in args: SAFE_ARGS_REGEX \s matches \n):`);

  tally(test('getExecCommand accepts newline in args because SAFE_ARGS_REGEX includes newline', () => {
    // SAFE_ARGS_REGEX = /^[@a-zA-Z0-9\\s_.\\/:=,'\"*+-\\]+$/
    // \\s matches whitespace including newline
    const originalEnv = process.env.GEMINI_PACKAGE_MANAGER;
    try {
      process.env.GEMINI_PACKAGE_MANAGER = 'npm';
      // Newline in args should pass SAFE_ARGS_REGEX because \\s matches newline
      const cmd = pm.getExecCommand('prettier', 'file.js\necho injected');
      assert.strictEqual(cmd, 'npx prettier file.js\necho injected', 'Newline passes SAFE_ARGS_REGEX');
      // Tab also passes
      const cmd2 = pm.getExecCommand('eslint', 'file.js\t--fix');
      assert.strictEqual(cmd2, 'npx eslint file.js\t--fix', 'Tab also passes SAFE_ARGS_REGEX via \\s');
      // Carriage return also passes
      const cmd3 = pm.getExecCommand('tsc', 'src\r--strict');
      assert.strictEqual(cmd3, 'npx tsc src\r--strict', 'Carriage return passes via \\s');
    } finally {
      if (originalEnv !== undefined) process.env.GEMINI_PACKAGE_MANAGER = originalEnv;
      else delete process.env.GEMINI_PACKAGE_MANAGER;
    }
  }));

  // Summary
  console.log('\n=== Test Results ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total: ${passed + failed}
`);

  process.exit(failed > 0 ? 1 : 0);
}

runTests();
