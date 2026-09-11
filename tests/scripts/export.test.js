'use strict';

/**
 * Tests for scripts/export.js (`egc export`): plain-text and JSON export of
 * the decrypted memory document for a project or the global scope.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'export.js');
const stateCrypto = require('../../scripts/lib/state-crypto');
const { CLI_TIMEOUT_MS } = require('../fixtures/subprocess-timeouts');
const { parseArgs, parseHeader, toJson } = require('../../scripts/export.js');

const SAMPLE = `# Project State
project: /home/dev/projects/orbit-tracker
author: dev
updated: 2026-01-15T12:00:00.000Z

## Context
Satellite tracking dashboard in beta. Realtime pipeline done, alerting in progress.

## Active Decisions
- Use SQLite for the event store: zero-ops requirement on user machines
- Alert thresholds live in config, not code: operators tune them without redeploys

## Do Not Repeat
- WebSocket reconnect without backoff: melted the server during the 01/10 outage

## Preferences
- Tests colocated with modules

## Next Session
- Wire the alert webhook to the notification service
- Load-test the realtime pipeline at 10x current traffic
`;

function projectSlug(projectPath) {
  const parts = projectPath.replaceAll('\\', '/').split('/').filter(Boolean);
  return parts.slice(-2).join('--').replace(/[^a-zA-Z0-9-_]/g, '_') || 'default';
}

function mktemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function stateDirFor(homeDir) {
  const dir = path.join(homeDir, '.egc', 'state');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFlatState(homeDir, projectPath, content) {
  fs.writeFileSync(path.join(stateDirFor(homeDir), `${projectSlug(projectPath)}.md`), content, 'utf8');
}

function run(args, homeDir, cwd) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: cwd || homeDir,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    timeout: CLI_TIMEOUT_MS,
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

async function main() {
  console.log('scripts/export.js (egc export)');
  let passed = 0;
  let failed = 0;
  const tally = (ok) => { if (ok) passed++; else failed++; };

  tally(await test('parseArgs: defaults to project scope, plain text, cwd', () => {
    const opts = parseArgs([]);
    assert.strictEqual(opts.scope, 'project');
    assert.strictEqual(opts.json, false);
    assert.strictEqual(opts.project, null);
  }));

  tally(await test('parseArgs: accepts --project, --scope, --json and the = forms', () => {
    const opts = parseArgs(['--project', '/tmp/x', '--scope=global', '--json']);
    assert.strictEqual(opts.project, '/tmp/x');
    assert.strictEqual(opts.scope, 'global');
    assert.strictEqual(opts.json, true);
    assert.strictEqual(parseArgs(['--project=/tmp/y']).project, '/tmp/y');
  }));

  tally(await test('parseArgs: rejects unknown arguments and unknown scopes', () => {
    assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
    assert.throws(() => parseArgs(['--scope', 'team']), /unknown scope/);
    assert.throws(() => parseArgs(['--project']), /needs a path/);
  }));

  tally(await test('parseHeader: reads the key: value block after the H1 and stops at the first section', () => {
    const header = parseHeader(SAMPLE);
    assert.strictEqual(header.project, '/home/dev/projects/orbit-tracker');
    assert.strictEqual(header.author, 'dev');
    assert.strictEqual(header.updated, '2026-01-15T12:00:00.000Z');
    assert.strictEqual(header.branch, undefined);
  }));

  tally(await test('toJson: maps the five sections and keeps unknown sections aside', () => {
    const doc = toJson(`${SAMPLE}\n## Global Memory\n- shared lesson\n`, 'project');
    assert.strictEqual(doc.format, 'ami');
    assert.strictEqual(doc.scope, 'project');
    assert.strictEqual(doc.project, '/home/dev/projects/orbit-tracker');
    assert.strictEqual(doc.context, 'Satellite tracking dashboard in beta. Realtime pipeline done, alerting in progress.');
    assert.strictEqual(doc.active_decisions.length, 2);
    assert.strictEqual(doc.do_not_repeat.length, 1);
    assert.deepStrictEqual(doc.preferences, ['Tests colocated with modules']);
    assert.strictEqual(doc.next_session.length, 2);
    assert.deepStrictEqual(doc.other_sections['Global Memory'], ['shared lesson']);
  }));

  tally(await test('plain text: prints the stored document byte for byte', () => {
    const home = mktemp('egc-export-text-');
    const project = path.join(home, 'projects', 'orbit-tracker');
    fs.mkdirSync(project, { recursive: true });
    try {
      writeFlatState(home, project, SAMPLE);
      const result = run(['--project', project], home);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(result.stdout, SAMPLE);
    } finally {
      cleanup(home);
    }
  }));

  tally(await test('plain text: uses the current directory when --project is absent', () => {
    const home = mktemp('egc-export-cwd-');
    const project = path.join(home, 'projects', 'orbit-tracker');
    fs.mkdirSync(project, { recursive: true });
    try {
      writeFlatState(home, project, SAMPLE);
      const result = run([], home, project);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes('## Active Decisions'));
    } finally {
      cleanup(home);
    }
  }));

  tally(await test('--json: parses header and sections', () => {
    const home = mktemp('egc-export-json-');
    const project = path.join(home, 'projects', 'orbit-tracker');
    fs.mkdirSync(project, { recursive: true });
    try {
      writeFlatState(home, project, SAMPLE);
      const result = run(['--project', project, '--json'], home);
      assert.strictEqual(result.status, 0, result.stderr);
      const doc = JSON.parse(result.stdout);
      assert.strictEqual(doc.updated, '2026-01-15T12:00:00.000Z');
      assert.strictEqual(doc.active_decisions[0], 'Use SQLite for the event store: zero-ops requirement on user machines');
      assert.strictEqual(doc.next_session[1], 'Load-test the realtime pipeline at 10x current traffic');
    } finally {
      cleanup(home);
    }
  }));

  tally(await test('encrypted state: decrypts with the key in the home directory', () => {
    const home = mktemp('egc-export-enc-');
    const project = path.join(home, 'projects', 'orbit-tracker');
    fs.mkdirSync(project, { recursive: true });
    try {
      const keyPath = path.join(home, '.egc', 'encryption.key');
      const encrypted = stateCrypto.encryptStateBuffer(SAMPLE, keyPath);
      assert.ok(stateCrypto.isEncryptedBuffer(encrypted));
      fs.writeFileSync(path.join(stateDirFor(home), `${projectSlug(project)}.md`), encrypted);
      const result = run(['--project', project], home);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(result.stdout, SAMPLE);
      assert.ok(!result.stdout.includes(stateCrypto.MAGIC), 'no encryption header in the export');
    } finally {
      cleanup(home);
    }
  }));

  tally(await test('encrypted state without a key: exit 3 and nothing on stdout', () => {
    const home = mktemp('egc-export-nokey-');
    const otherHome = mktemp('egc-export-otherkey-');
    const project = path.join(home, 'projects', 'orbit-tracker');
    fs.mkdirSync(project, { recursive: true });
    try {
      const encrypted = stateCrypto.encryptStateBuffer(SAMPLE, path.join(otherHome, 'encryption.key'));
      fs.writeFileSync(path.join(stateDirFor(home), `${projectSlug(project)}.md`), encrypted);
      const result = run(['--project', project], home);
      assert.strictEqual(result.status, 3, result.stderr);
      assert.strictEqual(result.stdout, '');
      assert.ok(result.stderr.includes('encrypted'));
    } finally {
      cleanup(home);
      cleanup(otherHome);
    }
  }));

  tally(await test('no memory: exit 2 with a message on stderr', () => {
    const home = mktemp('egc-export-none-');
    const project = path.join(home, 'projects', 'empty');
    fs.mkdirSync(project, { recursive: true });
    try {
      const result = run(['--project', project], home);
      assert.strictEqual(result.status, 2);
      assert.strictEqual(result.stdout, '');
      assert.ok(result.stderr.includes('no memory for'));
    } finally {
      cleanup(home);
    }
  }));

  tally(await test('--scope global: prints the global document', () => {
    const home = mktemp('egc-export-global-');
    try {
      const globalDir = path.join(home, '.egc', 'global');
      fs.mkdirSync(globalDir, { recursive: true });
      const globalDoc = '# Project State\nupdated: 2026-02-01T00:00:00.000Z\n\n## Preferences\n- Conventional commits\n';
      fs.writeFileSync(path.join(globalDir, 'state.md'), globalDoc, 'utf8');
      const text = run(['--scope', 'global'], home);
      assert.strictEqual(text.status, 0, text.stderr);
      assert.strictEqual(text.stdout, globalDoc);
      const json = run(['--scope', 'global', '--json'], home);
      assert.strictEqual(json.status, 0, json.stderr);
      const doc = JSON.parse(json.stdout);
      assert.strictEqual(doc.scope, 'global');
      assert.deepStrictEqual(doc.preferences, ['Conventional commits']);
    } finally {
      cleanup(home);
    }
  }));

  tally(await test('plain text without a trailing newline goes out exactly as stored', () => {
    const home = mktemp('egc-export-nonl-');
    const project = path.join(home, 'projects', 'orbit-tracker');
    fs.mkdirSync(project, { recursive: true });
    try {
      const trimmed = SAMPLE.trimEnd();
      writeFlatState(home, project, trimmed);
      const result = run(['--project', project], home);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(result.stdout, trimmed, 'not a byte added');
    } finally {
      cleanup(home);
    }
  }));

  tally(await test('a state file that is a link is refused: exit 1, nothing printed, the target untouched', () => {
    if (process.platform === 'win32') return;
    const home = mktemp('egc-export-link-');
    const project = path.join(home, 'projects', 'orbit-tracker');
    fs.mkdirSync(project, { recursive: true });
    try {
      const elsewhere = path.join(home, 'elsewhere.md');
      fs.writeFileSync(elsewhere, 'not the memory');
      fs.symlinkSync(elsewhere, path.join(stateDirFor(home), `${projectSlug(project)}.md`));
      const result = run(['--project', project], home);
      assert.strictEqual(result.status, 1, result.stderr);
      assert.strictEqual(result.stdout, '');
      assert.ok(result.stderr.includes('regular file'), result.stderr);
      assert.strictEqual(fs.readFileSync(elsewhere, 'utf8'), 'not the memory');
    } finally {
      cleanup(home);
    }
  }));

  tally(await test('a state file that cannot be read is exit 1, not the missing-key exit', () => {
    if (process.platform === 'win32' || typeof process.getuid !== 'function' || process.getuid() === 0) return;
    const home = mktemp('egc-export-unreadable-');
    const project = path.join(home, 'projects', 'orbit-tracker');
    fs.mkdirSync(project, { recursive: true });
    try {
      const file = path.join(stateDirFor(home), `${projectSlug(project)}.md`);
      fs.writeFileSync(file, SAMPLE);
      fs.chmodSync(file, 0o000);
      try {
        const result = run(['--project', project], home);
        assert.strictEqual(result.status, 1, result.stderr);
        assert.strictEqual(result.stdout, '');
        assert.ok(result.stderr.includes('cannot read'), result.stderr);
      } finally {
        fs.chmodSync(file, 0o600);
      }
    } finally {
      cleanup(home);
    }
  }));

  tally(await test('a key readable by others is refused and left exactly as it was: the export never touches the key', () => {
    if (process.platform === 'win32' || typeof process.getuid !== 'function' || process.getuid() === 0) return;
    const home = mktemp('egc-export-widekey-');
    const project = path.join(home, 'projects', 'orbit-tracker');
    fs.mkdirSync(project, { recursive: true });
    try {
      const keyPath = path.join(home, '.egc', path.basename(stateCrypto.defaultKeyPath()));
      const encrypted = stateCrypto.encryptStateBuffer(SAMPLE, keyPath);
      fs.writeFileSync(path.join(stateDirFor(home), `${projectSlug(project)}.md`), encrypted);
      fs.chmodSync(keyPath, 0o644);
      const before = fs.statSync(keyPath);
      const result = run(['--project', project], home);
      assert.strictEqual(result.status, 1, result.stderr);
      assert.strictEqual(result.stdout, '');
      assert.ok(result.stderr.includes('readable by other users'), result.stderr);
      const after = fs.statSync(keyPath);
      assert.strictEqual(after.mode & 0o777, 0o644, 'the mode was not tightened');
      assert.strictEqual(after.mtimeMs, before.mtimeMs, 'the key was not rewritten');
      fs.chmodSync(keyPath, 0o600);
      const ok = run(['--project', project], home);
      assert.strictEqual(ok.status, 0, ok.stderr);
      assert.strictEqual(ok.stdout, SAMPLE);
    } finally {
      cleanup(home);
    }
  }));

  tally(await test('a state path that cannot be inspected is exit 1, never "no memory"', () => {
    if (process.platform === 'win32' || typeof process.getuid !== 'function' || process.getuid() === 0) return;
    const home = mktemp('egc-export-sealed-');
    const project = path.join(home, 'projects', 'orbit-tracker');
    fs.mkdirSync(project, { recursive: true });
    try {
      const globalDir = path.join(home, '.egc', 'global');
      fs.mkdirSync(globalDir, { recursive: true });
      fs.writeFileSync(path.join(globalDir, 'state.md'), SAMPLE);
      fs.chmodSync(globalDir, 0o000);
      try {
        const result = run(['--scope', 'global'], home);
        assert.strictEqual(result.status, 1, result.stderr);
        assert.strictEqual(result.stdout, '');
        assert.ok(result.stderr.includes('cannot inspect'), result.stderr);
      } finally {
        fs.chmodSync(globalDir, 0o700);
      }
    } finally {
      cleanup(home);
    }
  }));

  tally(await test('bad usage: exit 1 and the usage text', () => {
    const home = mktemp('egc-export-usage-');
    try {
      const result = run(['--nope'], home);
      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes('Usage: egc export'));
      const help = run(['--help'], home);
      assert.strictEqual(help.status, 0);
      assert.ok(help.stdout.includes('Usage: egc export'));
    } finally {
      cleanup(home);
    }
  }));

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
