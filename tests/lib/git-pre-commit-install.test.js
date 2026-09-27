/**
 * The git pre-commit hook both installers put in a clone of this repository
 * (scripts/lib/git-pre-commit-install.js): written once, appended to a hook
 * someone already has, never twice, and runnable by the bash Git for Windows
 * brings (LF line endings, no byte order mark).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installPreCommitHook } = require('../../scripts/lib/git-pre-commit-install');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function withRepo(fn, { git = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-pre-commit-'));
  try {
    if (git) fs.mkdirSync(path.join(root, '.git'));
    fn(root, path.join(root, '.git', 'hooks', 'pre-commit'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const CALL = 'bash "$ROOT/scripts/hooks/git-pre-commit.sh"';

function runTests() {
  console.log('\n=== Testing the git pre-commit hook the installers put in place ===\n');
  let passed = 0;
  let failed = 0;
  const record = ok => (ok ? passed++ : failed++);

  record(test('a clone without a hook gets one that runs the strip script, as bash reads it', () => {
    withRepo((root, hook) => {
      assert.strictEqual(installPreCommitHook(root), 'installed');
      const text = fs.readFileSync(hook, 'utf8');
      assert.ok(text.startsWith('#!/usr/bin/env bash\n'), text);
      assert.ok(text.includes('ROOT="$(git rev-parse --show-toplevel)"\n'), text);
      assert.ok(text.includes(CALL), text);
      assert.ok(!text.includes('\r'), 'LF line endings only');
      assert.notStrictEqual(fs.readFileSync(hook)[0], 0xef, 'no byte order mark');
      if (process.platform !== 'win32') assert.ok(fs.statSync(hook).mode & 0o100, 'executable');
    });
  }));

  record(test('a hook someone already has keeps its lines and gets the call appended', () => {
    withRepo((root, hook) => {
      fs.mkdirSync(path.dirname(hook), { recursive: true });
      fs.writeFileSync(hook, '#!/bin/sh\necho mine\n');
      assert.strictEqual(installPreCommitHook(root), 'updated');
      const text = fs.readFileSync(hook, 'utf8');
      assert.ok(text.startsWith('#!/bin/sh\necho mine\n'), text);
      assert.ok(text.includes(CALL), text);
    });
  }));

  record(test('a hook that already runs it is left as it is', () => {
    withRepo((root, hook) => {
      installPreCommitHook(root);
      const before = fs.readFileSync(hook, 'utf8');
      assert.strictEqual(installPreCommitHook(root), 'present');
      assert.strictEqual(fs.readFileSync(hook, 'utf8'), before);
    });
  }));

  record(test('outside a clone (a published install, or .git as a worktree file) nothing is written', () => {
    withRepo((root) => {
      assert.strictEqual(installPreCommitHook(root), 'skipped');
      assert.ok(!fs.existsSync(path.join(root, '.git')));
    }, { git: false });
    withRepo((root) => {
      fs.rmSync(path.join(root, '.git'), { recursive: true });
      fs.writeFileSync(path.join(root, '.git'), 'gitdir: /elsewhere\n');
      assert.strictEqual(installPreCommitHook(root), 'skipped');
    });
  }));

  const scripts = path.join(__dirname, '..', '..', 'scripts');
  const ps1 = fs.readFileSync(path.join(scripts, 'install.ps1'), 'utf8');
  const sh = fs.readFileSync(path.join(scripts, 'install.sh'), 'utf8');

  record(test('both installers put the hook in a clone through this helper, outside a dry run', () => {
    const ps1Call = ps1.indexOf('"git-pre-commit-install.js"))) $RootDir');
    assert.ok(ps1Call > ps1.indexOf('if (-not $DryRun) {\n    # MCP auto-registration'), 'install.ps1 must install the hook inside the non-dry-run block');
    assert.ok(/if \[\[ "\$DRY_RUN" = false \]\]; then\n\s*node "\$ROOT_DIR\/scripts\/lib\/git-pre-commit-install\.js" "\$ROOT_DIR"/.test(sh),
      'install.sh must install the hook through the same helper, outside a dry run');
  }));

  record(test('neither installer runs inline code to read the Node version', () => {
    for (const [label, source] of [['install.ps1', ps1], ['install.sh', sh]]) {
      assert.ok(!/\bnode\s+(?:-e|--eval|-p|--print)\b/.test(source), `${label} must not run node -e`);
      assert.ok(/node --version/.test(source), `${label} must read the version from node --version`);
    }
  }));

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
