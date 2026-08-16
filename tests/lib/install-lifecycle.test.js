/**
 * Tests for scripts/lib/install-lifecycle.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildDoctorReport,
  discoverInstalledStates,
  normalizeTargets,
  repairInstalledStates,
  uninstallInstalledStates,
} = require('../../scripts/lib/install-lifecycle');
const {
  createInstallState,
  writeInstallState,
} = require('../../scripts/lib/install-state');
const {
  HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  applySessionStartHookToFile,
  createSessionStartHookMergeOperation,
  resolveHookScriptDestination,
  resolveSettingsPath,
} = require('../../scripts/lib/claude-settings-hooks');
const {
  MERGE_YAML_READ_LIST_KIND,
  mergeAiderConfigReadList,
} = require('../../scripts/lib/aider-config-merge');
const {
  MERGE_MARKDOWN_INDEX_KIND,
  mergeSkillIndexEntry,
} = require('../../scripts/lib/warp-agents-merge');
const {
  GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
  PRE_RUN_COMMAND_EVENT,
  applyWindsurfGateGuardHookToFile,
  resolveGuardianAdapterScriptDestination,
  resolveHooksJsonPath,
} = require('../../scripts/lib/windsurf-gateguard-hooks');

const REPO_ROOT = path.join(__dirname, '..', '..');
const CURRENT_PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')
).version;
const CURRENT_MANIFEST_VERSION = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'manifests', 'install-modules.json'), 'utf8')
).version;

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    return true;
  } catch (error) {
    console.log(`  \u2717 ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function writeState(filePath, options) {
  const state = createInstallState(options);
  writeInstallState(filePath, state);
  return state;
}

function createCursorStateOptions(projectRoot, overrides = {}) {
  const targetRoot = overrides.targetRoot || path.join(projectRoot, '.cursor');
  const installStatePath = overrides.installStatePath || path.join(targetRoot, 'egc-install-state.json');

  return {
    adapter: { id: 'cursor-project', target: 'cursor', kind: 'project' },
    targetRoot,
    installStatePath,
    request: {
      profile: null,
      modules: [],
      includeComponents: [],
      excludeComponents: [],
      legacyLanguages: ['typescript'],
      legacyMode: true,
      ...(overrides.request || {}),
    },
    resolution: {
      selectedModules: ['legacy-cursor-install'],
      skippedModules: [],
      ...(overrides.resolution || {}),
    },
    operations: overrides.operations || [],
    source: {
      repoVersion: CURRENT_PACKAGE_VERSION,
      repoCommit: 'abc123',
      manifestVersion: CURRENT_MANIFEST_VERSION,
      ...(overrides.source || {}),
    },
  };
}

function writeCursorState(projectRoot, overrides = {}) {
  const options = createCursorStateOptions(projectRoot, overrides);
  writeState(options.installStatePath, options);
  return {
    targetRoot: options.targetRoot,
    installStatePath: options.installStatePath,
    state: options,
  };
}

function writeClaudeSessionHookState(homeDir, options = {}) {
  const targetRoot = path.join(homeDir, '.claude');
  const installStatePath = path.join(targetRoot, 'egc', 'install-state.json');
  const settingsPath = resolveSettingsPath(targetRoot);
  const hookScriptPath = resolveHookScriptDestination(targetRoot);
  const hookScriptSourcePath = path.join(REPO_ROOT, HOOK_SCRIPT_SOURCE_RELATIVE_PATH);

  fs.mkdirSync(path.dirname(hookScriptPath), { recursive: true });
  fs.copyFileSync(hookScriptSourcePath, hookScriptPath);
  if (options.existingSettings) {
    fs.writeFileSync(settingsPath, JSON.stringify(options.existingSettings, null, 2));
  }
  applySessionStartHookToFile(settingsPath, hookScriptPath);

  writeState(installStatePath, {
    adapter: { id: 'claude-home', target: 'claude', kind: 'home' },
    targetRoot,
    installStatePath,
    request: {
      profile: null,
      modules: [],
      includeComponents: [],
      excludeComponents: [],
      legacyLanguages: [],
      legacyMode: true,
    },
    resolution: {
      selectedModules: [],
      skippedModules: [],
    },
    operations: [
      {
        kind: 'copy-file',
        moduleId: 'claude-session-state-hook',
        sourceRelativePath: HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
        destinationPath: hookScriptPath,
        strategy: 'preserve-relative-path',
        ownership: 'managed',
        scaffoldOnly: false,
      },
      createSessionStartHookMergeOperation(targetRoot),
    ],
    source: {
      repoVersion: CURRENT_PACKAGE_VERSION,
      repoCommit: 'abc123',
      manifestVersion: CURRENT_MANIFEST_VERSION,
    },
  });

  return { targetRoot, installStatePath, settingsPath, hookScriptPath };
}

function writeWindsurfGuardianHookState(homeDir, options = {}) {
  const targetRoot = path.join(homeDir, '.codeium', 'windsurf');
  const installStatePath = path.join(targetRoot, 'egc', 'install-state.json');
  const hooksJsonPath = resolveHooksJsonPath(targetRoot);
  const guardianAdapterScriptPath = resolveGuardianAdapterScriptDestination(targetRoot);
  const guardianAdapterSourcePath = path.join(REPO_ROOT, GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH);

  fs.mkdirSync(path.dirname(guardianAdapterScriptPath), { recursive: true });
  fs.copyFileSync(guardianAdapterSourcePath, guardianAdapterScriptPath);
  if (options.existingHooks) {
    fs.writeFileSync(hooksJsonPath, JSON.stringify(options.existingHooks, null, 2));
  }
  applyWindsurfGateGuardHookToFile(hooksJsonPath, PRE_RUN_COMMAND_EVENT, guardianAdapterScriptPath);

  writeState(installStatePath, {
    adapter: { id: 'windsurf-home', target: 'windsurf', kind: 'home' },
    targetRoot,
    installStatePath,
    request: {
      profile: null,
      modules: [],
      includeComponents: [],
      excludeComponents: [],
      legacyLanguages: [],
      legacyMode: true,
    },
    resolution: {
      selectedModules: [],
      skippedModules: [],
    },
    operations: [
      {
        kind: 'copy-file',
        moduleId: 'egc-bash-guardian-hook',
        sourceRelativePath: GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
        destinationPath: guardianAdapterScriptPath,
        strategy: 'preserve-relative-path',
        ownership: 'managed',
        scaffoldOnly: false,
      },
      {
        kind: 'merge-claude-settings-hooks',
        moduleId: 'egc-bash-guardian-hook',
        sourceRelativePath: GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
        destinationPath: hooksJsonPath,
        strategy: 'merge-claude-settings-hooks',
        ownership: 'managed',
        scaffoldOnly: false,
        hookEvent: PRE_RUN_COMMAND_EVENT,
        hookScriptPath: guardianAdapterScriptPath,
      },
    ],
    source: {
      repoVersion: CURRENT_PACKAGE_VERSION,
      repoCommit: 'abc123',
      manifestVersion: CURRENT_MANIFEST_VERSION,
    },
  });

  return { targetRoot, installStatePath, hooksJsonPath, guardianAdapterScriptPath };
}

function managedOperation(kind, destinationPath, overrides = {}) {
  return {
    kind,
    moduleId: 'test-module',
    sourceRelativePath: 'rules/common/coding-style.md',
    destinationPath,
    strategy: kind,
    ownership: 'managed',
    scaffoldOnly: false,
    ...overrides,
  };
}

function runTests() {
  console.log('\n=== Testing install-lifecycle.js ===\n');

  let passed = 0;
  let failed = 0;

  if (test('normalizes default targets and dedupes adapter aliases', () => {
    const defaultTargets = normalizeTargets();

    assert.ok(defaultTargets.includes('egc'));
    assert.ok(defaultTargets.includes('cursor'));
    assert.ok(defaultTargets.includes('codex'));
    assert.deepStrictEqual(
      normalizeTargets(['cursor-project', 'cursor', 'egc-home', 'egc']),
      ['cursor', 'egc']
    );
  })) passed++; else failed++;

  if (test('discovers installed states for multiple targets in the current context', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const claudeStatePath = path.join(homeDir, '.gemini', 'egc', 'install-state.json');
      const cursorStatePath = path.join(projectRoot, '.cursor', 'egc-install-state.json');

      writeState(claudeStatePath, {
        adapter: { id: 'egc-home', target: 'egc', kind: 'home' },
        targetRoot: path.join(homeDir, '.gemini'),
        installStatePath: claudeStatePath,
        request: {
          profile: null,
          modules: [],
          legacyLanguages: ['typescript'],
          legacyMode: true,
        },
        resolution: {
          selectedModules: ['legacy-egc-rules'],
          skippedModules: [],
        },
        operations: [],
        source: {
          repoVersion: CURRENT_PACKAGE_VERSION,
          repoCommit: 'abc123',
          manifestVersion: CURRENT_MANIFEST_VERSION,
        },
      });

      writeState(cursorStatePath, {
        adapter: { id: 'cursor-project', target: 'cursor', kind: 'project' },
        targetRoot: path.join(projectRoot, '.cursor'),
        installStatePath: cursorStatePath,
        request: {
          profile: 'core',
          modules: [],
          legacyLanguages: [],
          legacyMode: false,
        },
        resolution: {
          selectedModules: ['rules-core', 'platform-configs'],
          skippedModules: [],
        },
        operations: [],
        source: {
          repoVersion: CURRENT_PACKAGE_VERSION,
          repoCommit: 'def456',
          manifestVersion: CURRENT_MANIFEST_VERSION,
        },
      });

      const records = discoverInstalledStates({
        homeDir,
        projectRoot,
        targets: ['egc', 'cursor'],
      });

      assert.strictEqual(records.length, 2);
      assert.strictEqual(records[0].exists, true);
      assert.strictEqual(records[1].exists, true);
      assert.strictEqual(records[0].state.target.id, 'egc-home');
      assert.strictEqual(records[1].state.target.id, 'cursor-project');
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('discovers missing and invalid install-state records', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      let records = discoverInstalledStates({
        homeDir,
        projectRoot,
        targets: ['cursor'],
      });

      assert.strictEqual(records.length, 1);
      assert.strictEqual(records[0].exists, false);
      assert.strictEqual(records[0].state, null);
      assert.strictEqual(records[0].error, null);

      const targetRoot = path.join(projectRoot, '.cursor');
      const statePath = path.join(targetRoot, 'egc-install-state.json');
      fs.mkdirSync(targetRoot, { recursive: true });
      fs.writeFileSync(statePath, '{not-json', 'utf8');

      records = discoverInstalledStates({
        homeDir,
        projectRoot,
        targets: ['cursor'],
      });

      assert.strictEqual(records[0].exists, true);
      assert.strictEqual(records[0].state, null);
      assert.ok(records[0].error.includes('Failed to read install-state'));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('doctor reports missing managed files as an error', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const targetRoot = path.join(projectRoot, '.cursor');
      const statePath = path.join(targetRoot, 'egc-install-state.json');
      fs.mkdirSync(targetRoot, { recursive: true });

      writeState(statePath, {
        adapter: { id: 'cursor-project', target: 'cursor', kind: 'project' },
        targetRoot,
        installStatePath: statePath,
        request: {
          profile: null,
          modules: ['platform-configs'],
          legacyLanguages: [],
          legacyMode: false,
        },
        resolution: {
          selectedModules: ['platform-configs'],
          skippedModules: [],
        },
        operations: [
          {
            kind: 'copy-file',
            moduleId: 'platform-configs',
            sourceRelativePath: '.cursor/hooks.json',
            destinationPath: path.join(targetRoot, 'hooks.json'),
            strategy: 'sync-root-children',
            ownership: 'managed',
            scaffoldOnly: false,
          },
        ],
        source: {
          repoVersion: CURRENT_PACKAGE_VERSION,
          repoCommit: 'abc123',
          manifestVersion: CURRENT_MANIFEST_VERSION,
        },
      });

      const report = buildDoctorReport({
        repoRoot: REPO_ROOT,
        homeDir,
        projectRoot,
        targets: ['cursor'],
      });

      assert.strictEqual(report.results.length, 1);
      assert.strictEqual(report.results[0].status, 'error');
      assert.ok(report.results[0].issues.some(issue => issue.code === 'missing-managed-files'));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('doctor reports target mismatches, missing sources, unverified operations, and version drift', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const actualTargetRoot = path.join(projectRoot, '.cursor');
      const actualStatePath = path.join(actualTargetRoot, 'egc-install-state.json');
      const recordedTargetRoot = path.join(projectRoot, '.old-cursor');
      const recordedStatePath = path.join(recordedTargetRoot, 'state.json');
      const copyDestination = path.join(actualTargetRoot, 'rules', 'missing-source.md');
      const customDestination = path.join(actualTargetRoot, 'custom.txt');

      fs.mkdirSync(path.dirname(copyDestination), { recursive: true });
      fs.writeFileSync(copyDestination, 'managed copy\n');
      fs.writeFileSync(customDestination, 'custom\n');

      writeState(actualStatePath, createCursorStateOptions(projectRoot, {
        targetRoot: recordedTargetRoot,
        installStatePath: recordedStatePath,
        request: {
          profile: 'missing-profile',
          legacyLanguages: [],
          legacyMode: false,
        },
        resolution: {
          selectedModules: [],
          skippedModules: [],
        },
        source: {
          repoVersion: '0.0.1',
          manifestVersion: CURRENT_MANIFEST_VERSION + 100,
        },
        operations: [
          managedOperation('copy-file', copyDestination, {
            sourceRelativePath: 'missing/source.md',
            strategy: 'copy-file',
          }),
          managedOperation('custom-kind', customDestination),
        ],
      }));

      const report = buildDoctorReport({
        repoRoot: REPO_ROOT,
        homeDir,
        projectRoot,
        targets: ['cursor'],
      });
      const codes = report.results[0].issues.map(issue => issue.code);

      assert.strictEqual(report.results[0].status, 'error');
      assert.ok(codes.includes('missing-target-root'));
      assert.ok(codes.includes('target-root-mismatch'));
      assert.ok(codes.includes('install-state-path-mismatch'));
      assert.ok(codes.includes('missing-source-files'));
      assert.ok(codes.includes('unverified-managed-operations'));
      assert.ok(codes.includes('manifest-version-mismatch'));
      assert.ok(codes.includes('repo-version-mismatch'));
      assert.ok(codes.includes('resolution-unavailable'));
      assert.strictEqual(report.summary.checkedCount, 1);
      assert.ok(report.summary.errorCount >= 3);
      assert.ok(report.summary.warningCount >= 4);
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('doctor verifies merge-json operations by content', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const targetRoot = path.join(projectRoot, '.cursor');
      const jsonPath = path.join(targetRoot, 'settings.json');
      fs.mkdirSync(targetRoot, { recursive: true });
      fs.writeFileSync(jsonPath, JSON.stringify({
        keep: true,
        nested: {
          managed: true,
          extra: true,
        },
      }, null, 2));

      writeCursorState(projectRoot, {
        operations: [
          managedOperation('merge-json', jsonPath, {
            mergePayload: {
              nested: {
                managed: true,
              },
            },
          }),
        ],
      });

      const report = buildDoctorReport({
        repoRoot: REPO_ROOT,
        homeDir,
        projectRoot,
        targets: ['cursor'],
      });

      assert.strictEqual(report.results[0].status, 'ok');
      assert.strictEqual(report.results[0].issues.length, 0);
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('doctor classifies remove, unknown-kind, unverified merge-json, and invalid JSON operation health', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const targetRoot = path.join(projectRoot, '.cursor');
      const unknownKindPath = path.join(targetRoot, 'template.txt');
      const missingPayloadJsonPath = path.join(targetRoot, 'missing-payload.json');
      const invalidJsonPath = path.join(targetRoot, 'invalid.json');
      const removedPath = path.join(targetRoot, 'already-removed.txt');
      fs.mkdirSync(targetRoot, { recursive: true });
      fs.writeFileSync(unknownKindPath, 'generated\n');
      fs.writeFileSync(missingPayloadJsonPath, '{"managed":true}\n');
      fs.writeFileSync(invalidJsonPath, '{not-json', 'utf8');

      writeCursorState(projectRoot, {
        operations: [
          managedOperation('remove', removedPath),
          managedOperation('unknown-operation-kind', unknownKindPath),
          managedOperation('merge-json', missingPayloadJsonPath),
          managedOperation('merge-json', invalidJsonPath, {
            mergePayload: { managed: true },
          }),
        ],
      });

      const report = buildDoctorReport({
        repoRoot: REPO_ROOT,
        homeDir,
        projectRoot,
        targets: ['cursor'],
      });
      const codes = report.results[0].issues.map(issue => issue.code);

      assert.strictEqual(report.results[0].status, 'warning');
      assert.ok(codes.includes('unverified-managed-operations'));
      assert.ok(codes.includes('drifted-managed-files'));
      assert.ok(!report.results[0].issues.some(issue => issue.code === 'missing-managed-files'));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('doctor reports invalid install-state files as errors', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const statePath = path.join(projectRoot, '.cursor', 'egc-install-state.json');
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, '{"schemaVersion":"wrong"}\n');

      const report = buildDoctorReport({
        repoRoot: REPO_ROOT,
        homeDir,
        projectRoot,
        targets: ['cursor'],
      });

      assert.strictEqual(report.results[0].status, 'error');
      assert.ok(report.results[0].issues.some(issue => issue.code === 'invalid-install-state'));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('doctor reports a healthy legacy install when managed files are present', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const targetRoot = path.join(homeDir, '.gemini');
      const statePath = path.join(targetRoot, 'egc', 'install-state.json');
      const managedFile = path.join(targetRoot, 'rules', 'common', 'coding-style.md');
      const sourceContent = fs.readFileSync(path.join(REPO_ROOT, 'rules', 'common', 'coding-style.md'), 'utf8');
      fs.mkdirSync(path.dirname(managedFile), { recursive: true });
      fs.writeFileSync(managedFile, sourceContent);

      writeState(statePath, {
        adapter: { id: 'egc-home', target: 'egc', kind: 'home' },
        targetRoot,
        installStatePath: statePath,
        request: {
          profile: null,
          modules: [],
          legacyLanguages: ['typescript'],
          legacyMode: true,
        },
        resolution: {
          selectedModules: ['legacy-egc-rules'],
          skippedModules: [],
        },
        operations: [
          {
            kind: 'copy-file',
            moduleId: 'legacy-egc-rules',
            sourceRelativePath: 'rules/common/coding-style.md',
            destinationPath: managedFile,
            strategy: 'preserve-relative-path',
            ownership: 'managed',
            scaffoldOnly: false,
          },
        ],
        source: {
          repoVersion: CURRENT_PACKAGE_VERSION,
          repoCommit: 'abc123',
          manifestVersion: CURRENT_MANIFEST_VERSION,
        },
      });

      const report = buildDoctorReport({
        repoRoot: REPO_ROOT,
        homeDir,
        projectRoot,
        targets: ['egc'],
      });

      assert.strictEqual(report.results.length, 1);
      assert.strictEqual(report.results[0].status, 'ok');
      assert.strictEqual(report.results[0].issues.length, 0);
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('repair dry-run reports planned copy repairs without writing files', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const targetRoot = path.join(projectRoot, '.cursor');
      const destinationPath = path.join(targetRoot, 'rules', 'coding-style.md');
      writeCursorState(projectRoot, {
        operations: [
          managedOperation('copy-file', destinationPath, {
            sourceRelativePath: 'rules/common/coding-style.md',
            strategy: 'copy-file',
          }),
        ],
      });

      const result = repairInstalledStates({
        repoRoot: REPO_ROOT,
        homeDir,
        projectRoot,
        targets: ['cursor'],
        dryRun: true,
      });

      assert.strictEqual(result.dryRun, true);
      assert.strictEqual(result.results[0].status, 'planned');
      assert.deepStrictEqual(result.results[0].plannedRepairs, [destinationPath]);
      assert.ok(!fs.existsSync(destinationPath));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('repair copies missing managed files from recorded source paths', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const targetRoot = path.join(projectRoot, '.cursor');
      const destinationPath = path.join(targetRoot, 'rules', 'coding-style.md');
      const sourcePath = path.join(REPO_ROOT, 'rules', 'common', 'coding-style.md');
      writeCursorState(projectRoot, {
        operations: [
          managedOperation('copy-file', destinationPath, {
            sourceRelativePath: 'rules/common/coding-style.md',
            strategy: 'copy-file',
          }),
        ],
      });

      const result = repairInstalledStates({
        repoRoot: REPO_ROOT,
        homeDir,
        projectRoot,
        targets: ['cursor'],
      });

      assert.strictEqual(result.results[0].status, 'repaired');
      assert.ok(fs.readFileSync(destinationPath).equals(fs.readFileSync(sourcePath)));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('repair reports invalid states, missing sources, unsupported operations, and no-op refreshes', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const invalidProjectRoot = createTempDir('install-lifecycle-invalid-');
    const missingSourceProjectRoot = createTempDir('install-lifecycle-missing-source-');
    const unsupportedProjectRoot = createTempDir('install-lifecycle-unsupported-');
    const okProjectRoot = createTempDir('install-lifecycle-ok-');

    try {
      const invalidStatePath = path.join(invalidProjectRoot, '.cursor', 'egc-install-state.json');
      fs.mkdirSync(path.dirname(invalidStatePath), { recursive: true });
      fs.writeFileSync(invalidStatePath, '{"schemaVersion":"wrong"}\n');

      let result = repairInstalledStates({
        repoRoot: REPO_ROOT,
        homeDir,
        projectRoot: invalidProjectRoot,
        targets: ['cursor'],
      });
      assert.strictEqual(result.results[0].status, 'error');
      assert.ok(result.results[0].error.includes('Invalid install-state'));

      const missingDestination = path.join(missingSourceProjectRoot, '.cursor', 'rules', 'missing.md');
      fs.mkdirSync(path.dirname(missingDestination), { recursive: true });
      fs.writeFileSync(missingDestination, 'managed\n');
      writeCursorState(missingSourceProjectRoot, {
        operations: [
          managedOperation('copy-file', missingDestination, {
            sourceRelativePath: 'missing/source.md',
            strategy: 'copy-file',
          }),
        ],
      });
      result = repairInstalledStates({
        repoRoot: REPO_ROOT,
        homeDir,
        projectRoot: missingSourceProjectRoot,
        targets: ['cursor'],
      });
      assert.strictEqual(result.results[0].status, 'error');
      assert.ok(result.results[0].error.includes('Missing source file(s)'));

      const unsupportedDestination = path.join(unsupportedProjectRoot, '.cursor', 'custom.txt');
      writeCursorState(unsupportedProjectRoot, {
        operations: [
          managedOperation('custom-kind', unsupportedDestination),
        ],
      });
      result = repairInstalledStates({
        repoRoot: REPO_ROOT,
        homeDir,
        projectRoot: unsupportedProjectRoot,
        targets: ['cursor'],
      });
      assert.strictEqual(result.results[0].status, 'error');
      assert.ok(result.results[0].error.includes('Unsupported repair operation kind'));

      writeCursorState(okProjectRoot, { operations: [] });
      result = repairInstalledStates({
        repoRoot: REPO_ROOT,
        homeDir,
        projectRoot: okProjectRoot,
        targets: ['cursor'],
      });
      assert.strictEqual(result.results[0].status, 'ok');
      assert.strictEqual(result.results[0].stateRefreshed, true);
      assert.strictEqual(result.summary.errorCount, 0);
    } finally {
      cleanup(homeDir);
      cleanup(invalidProjectRoot);
      cleanup(missingSourceProjectRoot);
      cleanup(unsupportedProjectRoot);
      cleanup(okProjectRoot);
    }
  })) passed++; else failed++;

  if (test('repair dry-run reports ok when no managed operations need changes', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      writeCursorState(projectRoot, { operations: [] });

      const result = repairInstalledStates({
        repoRoot: REPO_ROOT,
        homeDir,
        projectRoot,
        targets: ['cursor'],
        dryRun: true,
      });

      assert.strictEqual(result.results[0].status, 'ok');
      assert.strictEqual(result.results[0].stateRefreshed, true);
      assert.deepStrictEqual(result.results[0].plannedRepairs, []);
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('repair surfaces missing source errors from execution when destination is absent', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const destinationPath = path.join(projectRoot, '.cursor', 'rules', 'missing.md');
      writeCursorState(projectRoot, {
        operations: [
          managedOperation('copy-file', destinationPath, {
            sourceRelativePath: 'missing/source.md',
            strategy: 'copy-file',
          }),
        ],
      });

      const result = repairInstalledStates({
        repoRoot: REPO_ROOT,
        homeDir,
        projectRoot,
        targets: ['cursor'],
      });

      assert.strictEqual(result.results[0].status, 'error');
      assert.ok(result.results[0].error.includes('Missing source file for repair'));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('doctor reports drifted managed files as a warning', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const targetRoot = path.join(projectRoot, '.cursor');
      const statePath = path.join(targetRoot, 'egc-install-state.json');
      const sourcePath = path.join(REPO_ROOT, '.cursor', 'hooks.json');
      const destinationPath = path.join(targetRoot, 'hooks.json');
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.writeFileSync(destinationPath, '{"drifted":true}\n');

      writeState(statePath, {
        adapter: { id: 'cursor-project', target: 'cursor', kind: 'project' },
        targetRoot,
        installStatePath: statePath,
        request: {
          profile: null,
          modules: ['platform-configs'],
          legacyLanguages: [],
          legacyMode: false,
        },
        resolution: {
          selectedModules: ['platform-configs'],
          skippedModules: [],
        },
        operations: [
          {
            kind: 'copy-file',
            moduleId: 'platform-configs',
            sourcePath,
            sourceRelativePath: '.cursor/hooks.json',
            destinationPath,
            strategy: 'sync-root-children',
            ownership: 'managed',
            scaffoldOnly: false,
          },
        ],
        source: {
          repoVersion: CURRENT_PACKAGE_VERSION,
          repoCommit: 'abc123',
          manifestVersion: CURRENT_MANIFEST_VERSION,
        },
      });

      const report = buildDoctorReport({
        repoRoot: REPO_ROOT,
        homeDir,
        projectRoot,
        targets: ['cursor'],
      });

      assert.strictEqual(report.results.length, 1);
      assert.strictEqual(report.results[0].status, 'warning');
      assert.ok(report.results[0].issues.some(issue => issue.code === 'drifted-managed-files'));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  // States written before plan-time destination dedupe can hold two copy-file
  // operations for one destination with sources that legitimately differ (the
  // codex target's native tree vs the flattened skill catalog). The three
  // cases below pin the contract: matching either source is healthy, a real
  // mismatch is reported once, and repair converges in a single pass instead
  // of ping-ponging between the two sources.
  function writeSharedDestinationFixture(withDestinationContent) {
    const repoRootFixture = createTempDir('install-lifecycle-sharedsrc-');
    const projectRoot = createTempDir('install-lifecycle-project-');
    fs.writeFileSync(path.join(repoRootFixture, 'package.json'), '{"version":"1.2.3"}\n');
    fs.mkdirSync(path.join(repoRootFixture, 'manifests'), { recursive: true });
    fs.writeFileSync(path.join(repoRootFixture, 'manifests', 'install-modules.json'), '{"version":1,"modules":[]}\n');
    fs.writeFileSync(path.join(repoRootFixture, 'manifests', 'install-profiles.json'), '{"version":1,"profiles":{}}\n');
    fs.mkdirSync(path.join(repoRootFixture, 'native', 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(repoRootFixture, 'native', 'skills', 'demo', 'SKILL.md'), 'native flavor\n');
    fs.mkdirSync(path.join(repoRootFixture, 'catalog', 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(repoRootFixture, 'catalog', 'skills', 'demo', 'SKILL.md'), 'catalog flavor\n');

    const targetRoot = path.join(projectRoot, '.cursor');
    const statePath = path.join(targetRoot, 'egc-install-state.json');
    const destinationPath = path.join(targetRoot, 'skills', 'demo', 'SKILL.md');
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.writeFileSync(destinationPath, withDestinationContent);

    const buildOperation = sourceRelativePath => ({
      kind: 'copy-file',
      moduleId: 'fixture-module',
      sourcePath: path.join(repoRootFixture, sourceRelativePath),
      sourceRelativePath,
      destinationPath,
      strategy: 'preserve-relative-path',
      ownership: 'managed',
      scaffoldOnly: false,
    });

    writeState(statePath, {
      adapter: { id: 'cursor-project', target: 'cursor', kind: 'project' },
      targetRoot,
      installStatePath: statePath,
      request: { profile: null, modules: [], legacyLanguages: [], legacyMode: true },
      resolution: { selectedModules: ['fixture-module'], skippedModules: [] },
      operations: [
        buildOperation('native/skills/demo/SKILL.md'),
        buildOperation('catalog/skills/demo/SKILL.md'),
      ],
      source: { repoVersion: '1.2.3', repoCommit: 'abc123', manifestVersion: 1 },
    });

    return { repoRootFixture, projectRoot, destinationPath };
  }

  if (test('doctor accepts a shared destination when the file matches either recorded source', () => {
    const fixture = writeSharedDestinationFixture('catalog flavor\n');
    const homeDir = createTempDir('install-lifecycle-home-');
    try {
      const report = buildDoctorReport({
        repoRoot: fixture.repoRootFixture,
        homeDir,
        projectRoot: fixture.projectRoot,
        targets: ['cursor'],
      });

      assert.strictEqual(report.results.length, 1);
      assert.ok(!report.results[0].issues.some(issue => issue.code === 'drifted-managed-files'));
    } finally {
      cleanup(fixture.repoRootFixture);
      cleanup(fixture.projectRoot);
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('doctor reports a shared destination once when the file matches no recorded source', () => {
    const fixture = writeSharedDestinationFixture('edited by hand\n');
    const homeDir = createTempDir('install-lifecycle-home-');
    try {
      const report = buildDoctorReport({
        repoRoot: fixture.repoRootFixture,
        homeDir,
        projectRoot: fixture.projectRoot,
        targets: ['cursor'],
      });

      const driftIssue = report.results[0].issues.find(issue => issue.code === 'drifted-managed-files');
      assert.ok(driftIssue);
      assert.deepStrictEqual(driftIssue.paths, [fixture.destinationPath]);
    } finally {
      cleanup(fixture.repoRootFixture);
      cleanup(fixture.projectRoot);
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('repair converges a drifted shared destination in one pass', () => {
    const fixture = writeSharedDestinationFixture('edited by hand\n');
    const homeDir = createTempDir('install-lifecycle-home-');
    try {
      const firstPass = repairInstalledStates({
        repoRoot: fixture.repoRootFixture,
        homeDir,
        projectRoot: fixture.projectRoot,
        targets: ['cursor'],
      });

      assert.deepStrictEqual(firstPass.results[0].repairedPaths, [fixture.destinationPath]);
      assert.strictEqual(fs.readFileSync(fixture.destinationPath, 'utf8'), 'native flavor\n');

      const secondPass = repairInstalledStates({
        repoRoot: fixture.repoRootFixture,
        homeDir,
        projectRoot: fixture.projectRoot,
        targets: ['cursor'],
      });

      assert.strictEqual(secondPass.results[0].repairedPaths.length, 0);
      assert.strictEqual(fs.readFileSync(fixture.destinationPath, 'utf8'), 'native flavor\n');
    } finally {
      cleanup(fixture.repoRootFixture);
      cleanup(fixture.projectRoot);
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('doctor reports manifest resolution drift for non-legacy installs', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const targetRoot = path.join(projectRoot, '.cursor');
      const statePath = path.join(targetRoot, 'egc-install-state.json');
      fs.mkdirSync(targetRoot, { recursive: true });

      writeState(statePath, {
        adapter: { id: 'cursor-project', target: 'cursor', kind: 'project' },
        targetRoot,
        installStatePath: statePath,
        request: {
          profile: 'core',
          modules: [],
          legacyLanguages: [],
          legacyMode: false,
        },
        resolution: {
          selectedModules: ['rules-core'],
          skippedModules: [],
        },
        operations: [],
        source: {
          repoVersion: CURRENT_PACKAGE_VERSION,
          repoCommit: 'abc123',
          manifestVersion: CURRENT_MANIFEST_VERSION,
        },
      });

      const report = buildDoctorReport({
        repoRoot: REPO_ROOT,
        homeDir,
        projectRoot,
        targets: ['cursor'],
      });

      assert.strictEqual(report.results.length, 1);
      assert.strictEqual(report.results[0].status, 'warning');
      assert.ok(report.results[0].issues.some(issue => issue.code === 'resolution-drift'));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('repair reapplies merge-json operations without clobbering unrelated keys', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const targetRoot = path.join(projectRoot, '.cursor');
      const statePath = path.join(targetRoot, 'egc-install-state.json');
      const destinationPath = path.join(targetRoot, 'hooks.json');
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.writeFileSync(destinationPath, JSON.stringify({
        existing: true,
        nested: {
          enabled: false,
        },
      }, null, 2));

      writeState(statePath, {
        adapter: { id: 'cursor-project', target: 'cursor', kind: 'project' },
        targetRoot,
        installStatePath: statePath,
        request: {
          profile: null,
          modules: [],
          legacyLanguages: ['typescript'],
          legacyMode: true,
        },
        resolution: {
          selectedModules: ['legacy-cursor-install'],
          skippedModules: [],
        },
        operations: [
          {
            kind: 'merge-json',
            moduleId: 'platform-configs',
            sourceRelativePath: '.cursor/hooks.json',
            destinationPath,
            strategy: 'merge-json',
            ownership: 'managed',
            scaffoldOnly: false,
            mergePayload: {
              nested: {
                enabled: true,
              },
              managed: 'yes',
            },
          },
        ],
        source: {
          repoVersion: CURRENT_PACKAGE_VERSION,
          repoCommit: 'abc123',
          manifestVersion: CURRENT_MANIFEST_VERSION,
        },
      });

      const result = repairInstalledStates({
        repoRoot: REPO_ROOT,
        homeDir,
        projectRoot,
        targets: ['cursor'],
      });

      assert.strictEqual(result.results[0].status, 'repaired');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(destinationPath, 'utf8')), {
        existing: true,
        nested: {
          enabled: true,
        },
        managed: 'yes',
      });
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('repair re-applies managed remove operations when files reappear', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const targetRoot = path.join(projectRoot, '.cursor');
      const statePath = path.join(targetRoot, 'egc-install-state.json');
      const destinationPath = path.join(targetRoot, 'legacy-note.txt');
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.writeFileSync(destinationPath, 'stale');

      writeState(statePath, {
        adapter: { id: 'cursor-project', target: 'cursor', kind: 'project' },
        targetRoot,
        installStatePath: statePath,
        request: {
          profile: null,
          modules: [],
          legacyLanguages: ['typescript'],
          legacyMode: true,
        },
        resolution: {
          selectedModules: ['legacy-cursor-install'],
          skippedModules: [],
        },
        operations: [
          {
            kind: 'remove',
            moduleId: 'platform-configs',
            sourceRelativePath: '.cursor/legacy-note.txt',
            destinationPath,
            strategy: 'remove',
            ownership: 'managed',
            scaffoldOnly: false,
          },
        ],
        source: {
          repoVersion: CURRENT_PACKAGE_VERSION,
          repoCommit: 'abc123',
          manifestVersion: CURRENT_MANIFEST_VERSION,
        },
      });

      const result = repairInstalledStates({
        repoRoot: REPO_ROOT,
        homeDir,
        projectRoot,
        targets: ['cursor'],
      });

      assert.strictEqual(result.results[0].status, 'repaired');
      assert.ok(!fs.existsSync(destinationPath));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('uninstall restores JSON merged files from recorded previous content', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const targetRoot = path.join(projectRoot, '.cursor');
      const statePath = path.join(targetRoot, 'egc-install-state.json');
      const destinationPath = path.join(targetRoot, 'hooks.json');
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.writeFileSync(destinationPath, JSON.stringify({
        existing: true,
        managed: true,
      }, null, 2));

      writeState(statePath, {
        adapter: { id: 'cursor-project', target: 'cursor', kind: 'project' },
        targetRoot,
        installStatePath: statePath,
        request: {
          profile: null,
          modules: [],
          legacyLanguages: ['typescript'],
          legacyMode: true,
        },
        resolution: {
          selectedModules: ['legacy-cursor-install'],
          skippedModules: [],
        },
        operations: [
          {
            kind: 'merge-json',
            moduleId: 'platform-configs',
            sourceRelativePath: '.cursor/hooks.json',
            destinationPath,
            strategy: 'merge-json',
            ownership: 'managed',
            scaffoldOnly: false,
            mergePayload: {
              managed: true,
            },
            previousContent: JSON.stringify({
              existing: true,
            }, null, 2),
          },
        ],
        source: {
          repoVersion: CURRENT_PACKAGE_VERSION,
          repoCommit: 'abc123',
          manifestVersion: CURRENT_MANIFEST_VERSION,
        },
      });

      const result = uninstallInstalledStates({
        homeDir,
        projectRoot,
        targets: ['cursor'],
      });

      assert.strictEqual(result.results[0].status, 'uninstalled');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(destinationPath, 'utf8')), {
        existing: true,
      });
      assert.ok(!fs.existsSync(statePath));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('uninstall restores files removed during install when previous content is recorded', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const targetRoot = path.join(projectRoot, '.cursor');
      const statePath = path.join(targetRoot, 'egc-install-state.json');
      const destinationPath = path.join(targetRoot, 'legacy-note.txt');
      fs.mkdirSync(targetRoot, { recursive: true });

      writeState(statePath, {
        adapter: { id: 'cursor-project', target: 'cursor', kind: 'project' },
        targetRoot,
        installStatePath: statePath,
        request: {
          profile: null,
          modules: [],
          legacyLanguages: ['typescript'],
          legacyMode: true,
        },
        resolution: {
          selectedModules: ['legacy-cursor-install'],
          skippedModules: [],
        },
        operations: [
          {
            kind: 'remove',
            moduleId: 'platform-configs',
            sourceRelativePath: '.cursor/legacy-note.txt',
            destinationPath,
            strategy: 'remove',
            ownership: 'managed',
            scaffoldOnly: false,
            previousContent: 'restore me\n',
          },
        ],
        source: {
          repoVersion: CURRENT_PACKAGE_VERSION,
          repoCommit: 'abc123',
          manifestVersion: CURRENT_MANIFEST_VERSION,
        },
      });

      const result = uninstallInstalledStates({
        homeDir,
        projectRoot,
        targets: ['cursor'],
      });

      assert.strictEqual(result.results[0].status, 'uninstalled');
      assert.strictEqual(fs.readFileSync(destinationPath, 'utf8'), 'restore me\n');
      assert.ok(!fs.existsSync(statePath));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('uninstall dry-run reports deduped managed removals without deleting files', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const targetRoot = path.join(projectRoot, '.cursor');
      const destinationPath = path.join(targetRoot, 'rules', 'coding-style.md');
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.writeFileSync(destinationPath, 'managed\n');
      const { installStatePath } = writeCursorState(projectRoot, {
        operations: [
          managedOperation('copy-file', destinationPath, { strategy: 'copy-file' }),
          managedOperation('copy-file', destinationPath, { strategy: 'copy-file' }),
        ],
      });

      const result = uninstallInstalledStates({
        homeDir,
        projectRoot,
        targets: ['cursor'],
        dryRun: true,
      });

      assert.strictEqual(result.dryRun, true);
      assert.strictEqual(result.results[0].status, 'planned');
      assert.deepStrictEqual(result.results[0].plannedRemovals, [
        destinationPath,
        installStatePath,
      ]);
      assert.ok(fs.existsSync(destinationPath));
      assert.ok(fs.existsSync(installStatePath));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('uninstall reports invalid install states as errors', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const statePath = path.join(projectRoot, '.cursor', 'egc-install-state.json');
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, '{not-json', 'utf8');

      const result = uninstallInstalledStates({
        homeDir,
        projectRoot,
        targets: ['cursor'],
      });

      assert.strictEqual(result.results[0].status, 'error');
      assert.ok(result.results[0].error.includes('Failed to read install-state'));
      assert.strictEqual(result.summary.errorCount, 1);
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('uninstall removes copied files and cleans empty parent directories', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const targetRoot = path.join(projectRoot, '.cursor');
      const destinationPath = path.join(targetRoot, 'rules', 'nested', 'managed.md');
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.writeFileSync(destinationPath, 'managed\n');
      writeCursorState(projectRoot, {
        operations: [
          managedOperation('copy-file', destinationPath, { strategy: 'copy-file' }),
        ],
      });

      const result = uninstallInstalledStates({
        homeDir,
        projectRoot,
        targets: ['cursor'],
      });

      assert.strictEqual(result.results[0].status, 'uninstalled');
      assert.ok(result.results[0].removedPaths.includes(destinationPath));
      assert.ok(!fs.existsSync(destinationPath));
      assert.ok(!fs.existsSync(path.dirname(destinationPath)));
      assert.ok(fs.existsSync(targetRoot));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('uninstall handles merge-json subset removal and full-file deletion', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const partialProjectRoot = createTempDir('install-lifecycle-partial-');
    const fullProjectRoot = createTempDir('install-lifecycle-full-');

    try {
      let targetRoot = path.join(partialProjectRoot, '.cursor');
      let destinationPath = path.join(targetRoot, 'settings.json');
      fs.mkdirSync(targetRoot, { recursive: true });
      fs.writeFileSync(destinationPath, JSON.stringify({
        keep: true,
        managed: true,
        nested: {
          keep: true,
          remove: true,
        },
        list: ['a', 'b'],
      }, null, 2));
      writeCursorState(partialProjectRoot, {
        operations: [
          managedOperation('merge-json', destinationPath, {
            mergePayload: {
              managed: true,
              nested: { remove: true },
              list: ['a', 'b'],
            },
          }),
        ],
      });

      let result = uninstallInstalledStates({
        homeDir,
        projectRoot: partialProjectRoot,
        targets: ['cursor'],
      });
      assert.strictEqual(result.results[0].status, 'uninstalled');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(destinationPath, 'utf8')), {
        keep: true,
        nested: {
          keep: true,
        },
      });

      targetRoot = path.join(fullProjectRoot, '.cursor');
      destinationPath = path.join(targetRoot, 'settings.json');
      fs.mkdirSync(targetRoot, { recursive: true });
      fs.writeFileSync(destinationPath, JSON.stringify({ managed: true }, null, 2));
      writeCursorState(fullProjectRoot, {
        operations: [
          managedOperation('merge-json', destinationPath, {
            mergePayload: { managed: true },
          }),
        ],
      });

      result = uninstallInstalledStates({
        homeDir,
        projectRoot: fullProjectRoot,
        targets: ['cursor'],
      });
      assert.strictEqual(result.results[0].status, 'uninstalled');
      assert.ok(!fs.existsSync(destinationPath));
    } finally {
      cleanup(homeDir);
      cleanup(partialProjectRoot);
      cleanup(fullProjectRoot);
    }
  })) passed++; else failed++;

  if (test('uninstall handles merge-json edge shapes and absent destinations', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const projects = [
      createTempDir('install-lifecycle-current-primitive-'),
      createTempDir('install-lifecycle-missing-key-'),
      createTempDir('install-lifecycle-nested-delete-'),
      createTempDir('install-lifecycle-array-root-'),
      createTempDir('install-lifecycle-primitive-root-'),
      createTempDir('install-lifecycle-absent-dest-'),
      createTempDir('install-lifecycle-previous-json-'),
    ];

    try {
      const cases = [
        {
          projectRoot: projects[0],
          initial: '"plain"',
          payload: { managed: true },
          expected: 'plain',
        },
        {
          projectRoot: projects[1],
          initial: { keep: true },
          payload: { missing: true },
          expected: { keep: true },
        },
        {
          projectRoot: projects[2],
          initial: { keep: true, nested: { remove: true } },
          payload: { nested: { remove: true } },
          expected: { keep: true },
        },
        {
          projectRoot: projects[3],
          initial: ['a', 'b'],
          payload: ['a', 'b'],
          removed: true,
        },
        {
          projectRoot: projects[4],
          initial: true,
          payload: true,
          removed: true,
        },
        {
          projectRoot: projects[5],
          payload: { managed: true },
          absent: true,
        },
        {
          projectRoot: projects[6],
          initial: { generated: true },
          payload: { generated: true },
          previousJson: { restored: true },
          expected: { restored: true },
        },
      ];

      for (const testCase of cases) {
        const targetRoot = path.join(testCase.projectRoot, '.cursor');
        const destinationPath = path.join(targetRoot, 'settings.json');
        fs.mkdirSync(targetRoot, { recursive: true });
        if (!testCase.absent) {
          fs.writeFileSync(
            destinationPath,
            typeof testCase.initial === 'string'
              ? `${testCase.initial}\n`
              : JSON.stringify(testCase.initial, null, 2)
          );
        }
        writeCursorState(testCase.projectRoot, {
          operations: [
            managedOperation('merge-json', destinationPath, {
              mergePayload: testCase.payload,
              previousJson: testCase.previousJson,
            }),
          ],
        });

        const result = uninstallInstalledStates({
          homeDir,
          projectRoot: testCase.projectRoot,
          targets: ['cursor'],
        });

        assert.strictEqual(result.results[0].status, 'uninstalled');
        if (testCase.removed || testCase.absent) {
          assert.ok(!fs.existsSync(destinationPath));
        } else {
          assert.deepStrictEqual(JSON.parse(fs.readFileSync(destinationPath, 'utf8')), testCase.expected);
        }
      }
    } finally {
      cleanup(homeDir);
      for (const projectRoot of projects) {
        cleanup(projectRoot);
      }
    }
  })) passed++; else failed++;

  if (test('uninstall removes generated copy-file outputs and no-backup remove operations are no-ops', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const targetRoot = path.join(projectRoot, '.cursor');
      const generatedPath = path.join(targetRoot, 'generated', 'plugin.json');
      const removedPath = path.join(targetRoot, 'already-removed.txt');
      fs.mkdirSync(path.dirname(generatedPath), { recursive: true });
      fs.writeFileSync(generatedPath, '{"generated":true}\n');

      writeCursorState(projectRoot, {
        operations: [
          managedOperation('copy-file', generatedPath),
          managedOperation('remove', removedPath),
        ],
      });

      const result = uninstallInstalledStates({
        homeDir,
        projectRoot,
        targets: ['cursor'],
      });

      assert.strictEqual(result.results[0].status, 'uninstalled');
      assert.ok(result.results[0].removedPaths.includes(generatedPath));
      assert.ok(!fs.existsSync(generatedPath));
      assert.ok(!fs.existsSync(path.dirname(generatedPath)));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('uninstall restores previous JSON snapshots for merge-json and remove operations', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const targetRoot = path.join(projectRoot, '.cursor');
      const generatedPath = path.join(targetRoot, 'plugin.json');
      const removedPath = path.join(targetRoot, 'legacy.json');
      fs.mkdirSync(targetRoot, { recursive: true });
      fs.writeFileSync(generatedPath, '{"generated":true}\n');

      writeCursorState(projectRoot, {
        operations: [
          managedOperation('merge-json', generatedPath, {
            previousJson: { existing: true },
          }),
          managedOperation('remove', removedPath, {
            previousJson: { restored: true },
          }),
        ],
      });

      const result = uninstallInstalledStates({
        homeDir,
        projectRoot,
        targets: ['cursor'],
      });

      assert.strictEqual(result.results[0].status, 'uninstalled');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(generatedPath, 'utf8')), {
        existing: true,
      });
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(removedPath, 'utf8')), {
        restored: true,
      });
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('uninstall reports unsupported operations and missing merge payloads as errors', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const unsupportedProjectRoot = createTempDir('install-lifecycle-unsupported-');
    const missingPayloadProjectRoot = createTempDir('install-lifecycle-missing-payload-');

    try {
      let targetRoot = path.join(unsupportedProjectRoot, '.cursor');
      let destinationPath = path.join(targetRoot, 'custom.txt');
      fs.mkdirSync(targetRoot, { recursive: true });
      fs.writeFileSync(destinationPath, 'custom\n');
      writeCursorState(unsupportedProjectRoot, {
        operations: [
          managedOperation('custom-kind', destinationPath),
        ],
      });

      let result = uninstallInstalledStates({
        homeDir,
        projectRoot: unsupportedProjectRoot,
        targets: ['cursor'],
      });
      assert.strictEqual(result.results[0].status, 'error');
      assert.ok(result.results[0].error.includes('Unsupported uninstall operation kind'));

      targetRoot = path.join(missingPayloadProjectRoot, '.cursor');
      destinationPath = path.join(targetRoot, 'settings.json');
      fs.mkdirSync(targetRoot, { recursive: true });
      fs.writeFileSync(destinationPath, '{"managed":true}\n');
      writeCursorState(missingPayloadProjectRoot, {
        operations: [
          managedOperation('merge-json', destinationPath),
        ],
      });

      result = uninstallInstalledStates({
        homeDir,
        projectRoot: missingPayloadProjectRoot,
        targets: ['cursor'],
      });
      assert.strictEqual(result.results[0].status, 'error');
      assert.ok(result.results[0].error.includes('Missing merge payload for uninstall'));
    } finally {
      cleanup(homeDir);
      cleanup(unsupportedProjectRoot);
      cleanup(missingPayloadProjectRoot);
    }
  })) passed++; else failed++;

  if (test('doctor reports a removed Claude SessionStart hook as drift', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const installed = writeClaudeSessionHookState(homeDir);

      let report = buildDoctorReport({
        homeDir,
        projectRoot,
        targets: ['claude'],
      });
      assert.strictEqual(report.results[0].status, 'ok');

      fs.writeFileSync(installed.settingsPath, JSON.stringify({
        hooks: {
          SessionStart: [
            { matcher: 'startup', hooks: [{ type: 'command', command: 'echo third-party' }] },
          ],
        },
      }, null, 2));

      report = buildDoctorReport({
        homeDir,
        projectRoot,
        targets: ['claude'],
      });
      assert.strictEqual(report.results[0].status, 'warning');
      const driftIssue = report.results[0].issues.find(
        issue => issue.code === 'drifted-managed-files'
      );
      assert.ok(driftIssue, 'Should flag the missing hook entry as drift');
      assert.ok(driftIssue.paths.includes(installed.settingsPath));

      fs.rmSync(installed.settingsPath);
      report = buildDoctorReport({
        homeDir,
        projectRoot,
        targets: ['claude'],
      });
      assert.strictEqual(report.results[0].status, 'error');
      assert.ok(report.results[0].issues.some(issue => issue.code === 'missing-managed-files'));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('doctor reports drift when the Aider YAML read-list entry is manually removed (audit EGC-128)', () => {
    const projectRoot = createTempDir('install-lifecycle-project-');
    const targetRoot = path.join(projectRoot, '.aider');
    const installStatePath = path.join(targetRoot, 'egc-install-state.json');
    const configPath = path.join(projectRoot, '.aider.conf.yml');
    const readEntry = 'AGENTS.md';

    try {
      fs.writeFileSync(configPath, mergeAiderConfigReadList(null, readEntry));
      writeState(installStatePath, {
        adapter: { id: 'aider-project', target: 'aider', kind: 'project' },
        targetRoot,
        installStatePath,
        request: { profile: null, modules: [], includeComponents: [], excludeComponents: [], legacyLanguages: [], legacyMode: true },
        resolution: { selectedModules: [], skippedModules: [] },
        operations: [{
          kind: MERGE_YAML_READ_LIST_KIND,
          moduleId: 'agents-md',
          sourceRelativePath: readEntry,
          destinationPath: configPath,
          readEntry,
          strategy: MERGE_YAML_READ_LIST_KIND,
          ownership: 'managed',
          scaffoldOnly: false,
        }],
        source: { repoVersion: CURRENT_PACKAGE_VERSION, repoCommit: 'abc123', manifestVersion: CURRENT_MANIFEST_VERSION },
      });

      let report = buildDoctorReport({ homeDir: os.homedir(), projectRoot, targets: ['aider'] });
      assert.strictEqual(report.results[0].status, 'ok', 'freshly-merged config should report ok');

      // Simulate the user editing the file by hand and dropping the entry.
      fs.writeFileSync(configPath, 'schema_version: 1\n');

      report = buildDoctorReport({ homeDir: os.homedir(), projectRoot, targets: ['aider'] });
      assert.strictEqual(report.results[0].status, 'warning', 'manually-edited config missing the entry should now be flagged, not unverified');
      assert.ok(
        report.results[0].issues.some(issue => issue.code === 'drifted-managed-files'),
        'should report drift instead of silently treating this as unverified'
      );
    } finally {
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('doctor reports drift when the Warp skill-index entry is manually removed (audit EGC-128)', () => {
    const projectRoot = createTempDir('install-lifecycle-project-');
    const targetRoot = path.join(projectRoot, '.warp');
    const installStatePath = path.join(targetRoot, 'egc-install-state.json');
    const agentsPath = path.join(projectRoot, 'AGENTS.md');
    const skillEntry = { name: 'tdd-workflow', description: 'Test-driven development workflow.', relativePath: '.warp/skills/tdd-workflow.md' };

    try {
      fs.writeFileSync(agentsPath, mergeSkillIndexEntry(null, skillEntry));
      writeState(installStatePath, {
        adapter: { id: 'warp-project', target: 'warp', kind: 'project' },
        targetRoot,
        installStatePath,
        request: { profile: null, modules: [], includeComponents: [], excludeComponents: [], legacyLanguages: [], legacyMode: true },
        resolution: { selectedModules: [], skippedModules: [] },
        operations: [{
          kind: MERGE_MARKDOWN_INDEX_KIND,
          moduleId: 'tdd-workflow',
          sourceRelativePath: skillEntry.relativePath,
          destinationPath: agentsPath,
          skillName: skillEntry.name,
          skillDescription: skillEntry.description,
          relativePath: skillEntry.relativePath,
          strategy: MERGE_MARKDOWN_INDEX_KIND,
          ownership: 'managed',
          scaffoldOnly: false,
        }],
        source: { repoVersion: CURRENT_PACKAGE_VERSION, repoCommit: 'abc123', manifestVersion: CURRENT_MANIFEST_VERSION },
      });

      let report = buildDoctorReport({ homeDir: os.homedir(), projectRoot, targets: ['warp'] });
      assert.strictEqual(report.results[0].status, 'ok', 'freshly-merged index should report ok');

      // Simulate the user editing the file by hand and dropping the block.
      fs.writeFileSync(agentsPath, '# AGENTS.md\n');

      report = buildDoctorReport({ homeDir: os.homedir(), projectRoot, targets: ['warp'] });
      assert.strictEqual(report.results[0].status, 'warning', 'manually-edited index missing the entry should now be flagged, not unverified');
      assert.ok(
        report.results[0].issues.some(issue => issue.code === 'drifted-managed-files'),
        'should report drift instead of silently treating this as unverified'
      );
    } finally {
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('repair restores the Claude SessionStart hook without touching third-party hooks', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const installed = writeClaudeSessionHookState(homeDir);
      fs.writeFileSync(installed.settingsPath, JSON.stringify({
        model: 'opus',
        hooks: {
          SessionStart: [
            { matcher: 'startup', hooks: [{ type: 'command', command: 'echo third-party' }] },
          ],
        },
      }, null, 2));

      const result = repairInstalledStates({
        homeDir,
        projectRoot,
        targets: ['claude'],
      });
      assert.strictEqual(result.results[0].status, 'repaired');
      assert.ok(result.results[0].repairedPaths.includes(installed.settingsPath));

      const settings = JSON.parse(fs.readFileSync(installed.settingsPath, 'utf8'));
      assert.strictEqual(settings.model, 'opus');
      assert.strictEqual(settings.hooks.SessionStart.length, 2);
      assert.strictEqual(settings.hooks.SessionStart[0].hooks[0].command, 'echo third-party');
      assert.ok(
        settings.hooks.SessionStart[1].hooks[0].command.includes(installed.hookScriptPath)
      );
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('uninstall removes only the EGC Claude hook and keeps settings.json', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const installed = writeClaudeSessionHookState(homeDir, {
        existingSettings: {
          model: 'opus',
          hooks: {
            SessionStart: [
              { matcher: 'startup', hooks: [{ type: 'command', command: 'echo third-party' }] },
            ],
            PreToolUse: [
              { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo guard' }] },
            ],
          },
        },
      });

      const result = uninstallInstalledStates({
        homeDir,
        projectRoot,
        targets: ['claude'],
      });
      assert.strictEqual(result.results[0].status, 'uninstalled');
      assert.ok(!fs.existsSync(installed.hookScriptPath));
      assert.ok(!fs.existsSync(installed.installStatePath));

      const settings = JSON.parse(fs.readFileSync(installed.settingsPath, 'utf8'));
      assert.strictEqual(settings.model, 'opus');
      assert.deepStrictEqual(settings.hooks.SessionStart, [
        { matcher: 'startup', hooks: [{ type: 'command', command: 'echo third-party' }] },
      ]);
      assert.deepStrictEqual(settings.hooks.PreToolUse, [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo guard' }] },
      ]);
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  // Windsurf's hooks.json is a flat {hooks: {<event>: [...]}} map, not
  // Claude's matcher/group settings.json -- doctor/repair/uninstall had no
  // notion of this at all (cubic-dev-ai review, PR #1052, 2026-07-27):
  // repair injected a bogus SessionStart group into the Windsurf file
  // instead of touching pre_run_command, doctor always reported drift on a
  // healthy install (it checked for that same bogus group), and uninstall
  // left the real hooks.json entry behind pointing at a script the
  // copy-file uninstall step had already deleted.
  if (test('doctor reports a removed Windsurf Guardian hook as drift, not a false positive on a healthy install', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const installed = writeWindsurfGuardianHookState(homeDir);

      let report = buildDoctorReport({ homeDir, projectRoot, targets: ['windsurf'] });
      assert.strictEqual(report.results[0].status, 'ok', 'a freshly-applied hook must not be reported as drift');

      fs.writeFileSync(installed.hooksJsonPath, JSON.stringify({
        hooks: { pre_write_code: [{ command: 'echo third-party' }] },
      }, null, 2));

      report = buildDoctorReport({ homeDir, projectRoot, targets: ['windsurf'] });
      assert.strictEqual(report.results[0].status, 'warning');
      const driftIssue = report.results[0].issues.find(issue => issue.code === 'drifted-managed-files');
      assert.ok(driftIssue, 'Should flag the missing pre_run_command entry as drift');
      assert.ok(driftIssue.paths.includes(installed.hooksJsonPath));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('repair restores the Windsurf Guardian hook on pre_run_command without touching third-party hooks or other events', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const installed = writeWindsurfGuardianHookState(homeDir);
      fs.writeFileSync(installed.hooksJsonPath, JSON.stringify({
        hooks: {
          pre_write_code: [{ command: 'echo third-party' }],
          pre_run_command: [{ command: 'echo third-party' }],
        },
      }, null, 2));

      const result = repairInstalledStates({ homeDir, projectRoot, targets: ['windsurf'] });
      assert.strictEqual(result.results[0].status, 'repaired');
      assert.ok(result.results[0].repairedPaths.includes(installed.hooksJsonPath));

      const hooksConfig = JSON.parse(fs.readFileSync(installed.hooksJsonPath, 'utf8'));
      assert.deepStrictEqual(hooksConfig.hooks.pre_write_code, [{ command: 'echo third-party' }]);
      assert.strictEqual(hooksConfig.hooks.pre_run_command.length, 2);
      assert.strictEqual(hooksConfig.hooks.pre_run_command[0].command, 'echo third-party');
      assert.ok(hooksConfig.hooks.pre_run_command[1].command.includes(installed.guardianAdapterScriptPath));
      assert.strictEqual(hooksConfig.hooks.SessionStart, undefined, 'must never inject a Claude-schema SessionStart group into a Windsurf hooks.json');
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('uninstall removes only the EGC Windsurf Guardian entry and keeps third-party hooks and other events', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const installed = writeWindsurfGuardianHookState(homeDir, {
        existingHooks: {
          hooks: {
            pre_write_code: [{ command: 'echo third-party' }],
          },
        },
      });

      const result = uninstallInstalledStates({ homeDir, projectRoot, targets: ['windsurf'] });
      assert.strictEqual(result.results[0].status, 'uninstalled');
      assert.ok(!fs.existsSync(installed.guardianAdapterScriptPath), 'the adapter script itself must be removed');

      const hooksConfig = JSON.parse(fs.readFileSync(installed.hooksJsonPath, 'utf8'));
      assert.deepStrictEqual(hooksConfig.hooks.pre_write_code, [{ command: 'echo third-party' }]);
      assert.strictEqual(hooksConfig.hooks.pre_run_command, undefined, 'the now-empty event key must be dropped, not left as an entry pointing at a deleted script');
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
