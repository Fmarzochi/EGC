'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const script = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'egc-memory-save.js');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    return false;
  }
}

function runScript(input, env = {}) {
  const result = spawnSync('node', [script], {
    encoding: 'utf8',
    input: typeof input === 'string' ? input : JSON.stringify(input),
    timeout: 10000,
    env: Object.assign({}, process.env, env),
  });
  return {
    code: result.status ?? 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-save-test-'));
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function stateFileFor(stateDir, projectPath) {
  const parts = projectPath.replace(/\\/g, '/').split('/').filter(Boolean);
  const slug = parts.slice(-2).join('--').replace(/[^a-zA-Z0-9-_]/g, '_') || 'default';
  return path.join(stateDir, `${slug}.md`);
}

function runTests() {
  console.log('\n=== Testing egc-memory-save.js ===\n');

  let passed = 0;
  let failed = 0;
  const run = (name, fn) => (test(name, fn) ? passed++ : failed++);

  console.log('Output contract:');

  run('passes through input fields', () => {
    const result = runScript({ foo: 'bar' });
    assert.strictEqual(result.code, 0);
    const out = JSON.parse(result.stdout);
    assert.strictEqual(out.foo, 'bar');
  });

  run('emits promptForAssistant', () => {
    const result = runScript({});
    assert.strictEqual(result.code, 0);
    const out = JSON.parse(result.stdout);
    assert.ok(typeof out.promptForAssistant === 'string' && out.promptForAssistant.length > 0);
    assert.ok(out.promptForAssistant.includes('update_state'));
  });

  run('exits 0 on empty stdin', () => {
    const result = runScript('{}');
    assert.strictEqual(result.code, 0);
  });

  run('exits 0 on malformed stdin', () => {
    const result = runScript('not-json');
    assert.strictEqual(result.code, 0);
  });

  console.log('\nDirect disk write -- new state file:');

  run('creates state file when none exists', () => {
    withTmpDir(projectPath => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-home-'));
      try {
        const stateDir = path.join(home, '.egc', 'state');
        const filePath = stateFileFor(stateDir, projectPath);
        assert.ok(!fs.existsSync(filePath), 'file should not exist before run');
        runScript({}, { PWD: projectPath, HOME: home });
        assert.ok(fs.existsSync(filePath), 'file should be created');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  });

  run('new file contains project path', () => {
    withTmpDir(projectPath => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-home-'));
      try {
        runScript({}, { PWD: projectPath, HOME: home });
        const filePath = stateFileFor(path.join(home, '.egc', 'state'), projectPath);
        const content = fs.readFileSync(filePath, 'utf-8');
        assert.ok(content.includes(`project: ${projectPath}`));
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  });

  run('new file contains updated timestamp', () => {
    withTmpDir(projectPath => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-home-'));
      try {
        const before = Date.now();
        runScript({}, { PWD: projectPath, HOME: home });
        const filePath = stateFileFor(path.join(home, '.egc', 'state'), projectPath);
        const content = fs.readFileSync(filePath, 'utf-8');
        const match = content.match(/^updated: (.+)$/m);
        assert.ok(match, 'updated line must exist');
        assert.ok(new Date(match[1]).getTime() >= before);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  });

  run('new file contains session-snapshot marker under Next Session', () => {
    withTmpDir(projectPath => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-home-'));
      try {
        runScript({}, { PWD: projectPath, HOME: home });
        const filePath = stateFileFor(path.join(home, '.egc', 'state'), projectPath);
        const content = fs.readFileSync(filePath, 'utf-8');
        const nextIdx = content.indexOf('## Next Session');
        assert.ok(nextIdx >= 0, '## Next Session section must exist');
        const afterNext = content.slice(nextIdx);
        assert.ok(afterNext.includes('[session-snapshot '), 'marker must be present');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  });

  console.log('\nDirect disk write -- existing state file:');

  run('updates updated timestamp in existing file', () => {
    withTmpDir(projectPath => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-home-'));
      try {
        const stateDir = path.join(home, '.egc', 'state');
        fs.mkdirSync(stateDir, { recursive: true });
        const filePath = stateFileFor(stateDir, projectPath);
        const oldTs = '2020-01-01T00:00:00.000Z';
        fs.writeFileSync(filePath, [
          '# Project State',
          `project: ${projectPath}`,
          `updated: ${oldTs}`,
          '',
          '## Context',
          'old context',
          '',
          '## Next Session',
          '',
        ].join('\n'));

        runScript({}, { PWD: projectPath, HOME: home });
        const content = fs.readFileSync(filePath, 'utf-8');
        assert.ok(!content.includes(oldTs), 'old timestamp must be replaced');
        assert.ok(/^updated: \d{4}-/m.test(content), 'new timestamp must exist');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  });

  run('preserves existing decisions and context', () => {
    withTmpDir(projectPath => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-home-'));
      try {
        const stateDir = path.join(home, '.egc', 'state');
        fs.mkdirSync(stateDir, { recursive: true });
        const filePath = stateFileFor(stateDir, projectPath);
        fs.writeFileSync(filePath, [
          '# Project State',
          `project: ${projectPath}`,
          `updated: 2020-01-01T00:00:00.000Z`,
          '',
          '## Context',
          'This is the project context.',
          '',
          '## Active Decisions',
          '- use squash merges',
          '',
          '## Next Session',
          '',
        ].join('\n'));

        runScript({}, { PWD: projectPath, HOME: home });
        const content = fs.readFileSync(filePath, 'utf-8');
        assert.ok(content.includes('This is the project context.'));
        assert.ok(content.includes('- use squash merges'));
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  });

  run('removes stale session markers before inserting fresh one', () => {
    withTmpDir(projectPath => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-home-'));
      try {
        const stateDir = path.join(home, '.egc', 'state');
        fs.mkdirSync(stateDir, { recursive: true });
        const filePath = stateFileFor(stateDir, projectPath);
        fs.writeFileSync(filePath, [
          '# Project State',
          `project: ${projectPath}`,
          `updated: 2020-01-01T00:00:00.000Z`,
          '',
          '## Next Session',
          '- [session-snapshot 2020-01-01T00:00:00.000Z]',
          '- [session-snapshot 2020-06-01T00:00:00.000Z]',
          '',
        ].join('\n'));

        runScript({}, { PWD: projectPath, HOME: home });
        const content = fs.readFileSync(filePath, 'utf-8');
        const markers = (content.match(/\[session-snapshot /g) || []).length;
        assert.strictEqual(markers, 1, 'exactly one fresh marker must remain');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  });

  run('state file is chmod 600 on non-Windows', () => {
    if (process.platform === 'win32') { console.log('      (skipped on Windows)'); passed++; return; }
    withTmpDir(projectPath => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-home-'));
      try {
        runScript({}, { PWD: projectPath, HOME: home });
        const filePath = stateFileFor(path.join(home, '.egc', 'state'), projectPath);
        const mode = fs.statSync(filePath).mode & 0o777;
        assert.strictEqual(mode, 0o600);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests();
