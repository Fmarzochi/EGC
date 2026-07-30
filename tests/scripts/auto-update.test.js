/**
 * Tests for scripts/auto-update.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  parseArgs,
  deriveRepoRootFromState,
  buildInstallApplyArgs,
  determineInstallCwd,
  runCognitiveBootstrap,
  runAutoUpdate,
} = require('../../scripts/auto-update');
const {
  createInstallState,
  writeInstallState,
} = require('../../scripts/lib/install-state');

const AUTO_UPDATE_SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'auto-update.js');

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

function makeRecord({ repoRoot, homeDir, projectRoot, adapter, request, resolution, operations }) {
  const targetRoot = adapter.kind === 'project'
    ? path.join(projectRoot, `.${adapter.target}`)
    : path.join(homeDir, '.gemini');
  const installStatePath = adapter.kind === 'project'
    ? path.join(targetRoot, 'egc-install-state.json')
    : path.join(targetRoot, 'egc', 'install-state.json');

  const state = createInstallState({
    adapter,
    targetRoot,
    installStatePath,
    request,
    resolution,
    operations,
    source: {
      repoVersion: '1.10.0',
      repoCommit: 'abc123',
      manifestVersion: 1,
    },
  });

  return {
    adapter,
    targetRoot,
    installStatePath,
    exists: true,
    state,
    error: null,
    repoRoot,
  };
}

function ensureFakeRepo(repoRoot) {
  fs.mkdirSync(path.join(repoRoot, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({ name: 'everything-gemini', version: '1.10.0' }, null, 2)
  );
  fs.writeFileSync(path.join(repoRoot, 'scripts', 'install-apply.js'), '#!/usr/bin/env node\n');
}

// Same shape as ensureFakeRepo but with no .git directory, matching an
// npm-installed EGC checkout so performGitUpdate takes the "installed via
// npm" branch instead of shelling out to real git.
function ensureFakeNpmRepo(repoRoot) {
  fs.mkdirSync(path.join(repoRoot, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({ name: 'everything-gemini', version: '1.10.0' }, null, 2)
  );
  fs.writeFileSync(path.join(repoRoot, 'scripts', 'install-apply.js'), '#!/usr/bin/env node\n');
}

function writeGeminiInstallState(projectRoot) {
  const targetRoot = path.join(projectRoot, '.gemini');
  const installStatePath = path.join(targetRoot, 'egc-install-state.json');
  const state = createInstallState({
    adapter: { id: 'gemini-project', target: 'gemini', kind: 'project' },
    targetRoot,
    installStatePath,
    request: {
      profile: null,
      modules: [],
      includeComponents: [],
      excludeComponents: [],
      legacyLanguages: [],
      legacyMode: false,
    },
    resolution: { selectedModules: [], skippedModules: [] },
    operations: [],
    source: {
      repoVersion: '1.0.0',
      repoCommit: 'abc123',
      manifestVersion: 1,
    },
  });
  writeInstallState(installStatePath, state);
  return installStatePath;
}

function runTests() {
  console.log('\n=== Testing auto-update.js ===\n');

  let passed = 0;
  let failed = 0;

  if (test('parseArgs reads repo-root, target, dry-run, and json flags', () => {
    const repoRootDir = createTempDir('auto-update-parseargs-repo-');
    try {
      const parsed = parseArgs([
        'node',
        'scripts/auto-update.js',
        '--target',
        'cursor',
        '--repo-root',
        repoRootDir,
        '--dry-run',
        '--json',
      ]);

      assert.deepStrictEqual(parsed.targets, ['cursor']);
      assert.strictEqual(parsed.repoRoot, repoRootDir);
      assert.strictEqual(parsed.dryRun, true);
      assert.strictEqual(parsed.json, true);
    } finally {
      cleanup(repoRootDir);
    }
  })) passed += 1; else failed += 1;

  if (test('parseArgs rejects unknown arguments', () => {
    assert.throws(
      () => parseArgs(['node', 'scripts/auto-update.js', '--bogus']),
      /Unknown argument: --bogus/
    );
  })) passed += 1; else failed += 1;

  if (test('deriveRepoRootFromState uses sourcePath and sourceRelativePath', () => {
    // Use a sourceRelativePath that does not exist in the running EGC package so
    // the __dirname-based fast path falls through to the absolute-sourcePath fallback.
    const state = {
      operations: [
        {
          sourcePath: path.join('/tmp', 'egc', 'custom-nonexistent-file.js'),
          sourceRelativePath: 'custom-nonexistent-file.js',
        },
      ],
    };

    assert.strictEqual(
      deriveRepoRootFromState(state),
      path.resolve(path.join('/tmp', 'egc'))
    );
  })) passed += 1; else failed += 1;

  if (test('deriveRepoRootFromState fails when source metadata is unavailable', () => {
    assert.throws(
      () => deriveRepoRootFromState({ operations: [{ destinationPath: '/tmp/file' }] }),
      /Unable to infer EGC repo root/
    );
  })) passed += 1; else failed += 1;

  if (test('buildInstallApplyArgs reconstructs legacy installs', () => {
    const record = {
      adapter: { target: 'egc', kind: 'home' },
      state: {
        target: { target: 'egc' },
        request: {
          profile: null,
          modules: [],
          includeComponents: [],
          excludeComponents: [],
          legacyLanguages: ['typescript', 'python'],
          legacyMode: true,
        },
      },
    };

    assert.deepStrictEqual(buildInstallApplyArgs(record), [
      '--target', 'egc',
      'typescript',
      'python',
    ]);
  })) passed += 1; else failed += 1;

  if (test('buildInstallApplyArgs reconstructs manifest installs', () => {
    const record = {
      adapter: { target: 'cursor', kind: 'project' },
      state: {
        target: { target: 'cursor' },
        request: {
          profile: 'developer',
          modules: ['platform-configs'],
          includeComponents: ['component:alpha'],
          excludeComponents: ['component:beta'],
          legacyLanguages: [],
          legacyMode: false,
        },
      },
    };

    assert.deepStrictEqual(buildInstallApplyArgs(record), [
      '--target', 'cursor',
      '--profile', 'developer',
      '--modules', 'platform-configs',
      '--with', 'component:alpha',
      '--without', 'component:beta',
    ]);
  })) passed += 1; else failed += 1;

  if (test('determineInstallCwd uses the project root for project installs', () => {
    const record = {
      adapter: { kind: 'project' },
      state: {
        target: {
          root: path.join('/tmp', 'project', '.cursor'),
        },
      },
    };

    assert.strictEqual(determineInstallCwd(record, '/tmp/egc'), path.join('/tmp', 'project'));
  })) passed += 1; else failed += 1;

  if (test('runAutoUpdate reports when no install-state files are present', () => {
    const result = runAutoUpdate(
      {
        homeDir: '/tmp/home',
        projectRoot: '/tmp/project',
        dryRun: true,
      },
      {
        discoverInstalledStates: () => [],
      }
    );

    assert.strictEqual(result.results.length, 0);
    assert.strictEqual(result.summary.checkedCount, 0);
    assert.strictEqual(result.summary.errorCount, 0);
  })) passed += 1; else failed += 1;

  if (test('runAutoUpdate rejects mixed inferred repo roots', () => {
    const homeDir = createTempDir('auto-update-home-');
    const projectRoot = createTempDir('auto-update-project-');
    const repoOne = createTempDir('auto-update-repo-');
    const repoTwo = createTempDir('auto-update-repo-');

    try {
      ensureFakeRepo(repoOne);
      ensureFakeRepo(repoTwo);

      const records = [
        makeRecord({
          repoRoot: repoOne,
          homeDir,
          projectRoot,
          adapter: { id: 'egc-home', target: 'egc', kind: 'home' },
          request: {
            profile: null,
            modules: [],
            includeComponents: [],
            excludeComponents: [],
            legacyLanguages: ['typescript'],
            legacyMode: true,
          },
          resolution: { selectedModules: ['legacy-egc-rules'], skippedModules: [] },
          operations: [
            {
              kind: 'copy-file',
              moduleId: 'legacy-egc-rules',
              sourcePath: path.join(repoOne, 'rules', 'common', 'coding-style.md'),
              sourceRelativePath: path.join('rules', 'common', 'coding-style.md'),
              destinationPath: path.join(homeDir, '.gemini', 'rules', 'common', 'coding-style.md'),
              strategy: 'preserve-relative-path',
              ownership: 'managed',
              scaffoldOnly: false,
            },
          ],
        }),
        makeRecord({
          repoRoot: repoTwo,
          homeDir,
          projectRoot,
          adapter: { id: 'cursor-project', target: 'cursor', kind: 'project' },
          request: {
            profile: 'core',
            modules: [],
            includeComponents: [],
            excludeComponents: [],
            legacyLanguages: [],
            legacyMode: false,
          },
          resolution: { selectedModules: ['rules-core'], skippedModules: [] },
          operations: [
            {
              kind: 'copy-file',
              moduleId: 'rules-core',
              sourcePath: path.join(repoTwo, '.cursor', 'mcp.json'),
              sourceRelativePath: path.join('.cursor', 'mcp.json'),
              destinationPath: path.join(projectRoot, '.cursor', 'mcp.json'),
              strategy: 'sync-root-children',
              ownership: 'managed',
              scaffoldOnly: false,
            },
          ],
        }),
      ];

      assert.throws(
        () => runAutoUpdate(
          {
            homeDir,
            projectRoot,
            dryRun: true,
          },
          {
            discoverInstalledStates: () => records,
          }
        ),
        /Multiple EGC repo roots detected/
      );
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
      cleanup(repoOne);
      cleanup(repoTwo);
    }
  })) passed += 1; else failed += 1;

  if (test('runAutoUpdate fetches, pulls, and reinstalls using reconstructed args', () => {
    const homeDir = createTempDir('auto-update-home-');
    const projectRoot = createTempDir('auto-update-project-');
    const repoRoot = createTempDir('auto-update-repo-');

    try {
      ensureFakeRepo(repoRoot);

      const records = [
        makeRecord({
          repoRoot,
          homeDir,
          projectRoot,
          adapter: { id: 'cursor-project', target: 'cursor', kind: 'project' },
          request: {
            profile: 'developer',
            modules: [],
            includeComponents: ['component:alpha'],
            excludeComponents: ['component:beta'],
            legacyLanguages: [],
            legacyMode: false,
          },
          resolution: { selectedModules: ['rules-core'], skippedModules: [] },
          operations: [
            {
              kind: 'copy-file',
              moduleId: 'platform-configs',
              sourcePath: path.join(repoRoot, '.cursor', 'mcp.json'),
              sourceRelativePath: path.join('.cursor', 'mcp.json'),
              destinationPath: path.join(projectRoot, '.cursor', 'mcp.json'),
              strategy: 'sync-root-children',
              ownership: 'managed',
              scaffoldOnly: false,
            },
          ],
        }),
      ];

      const commands = [];
      const result = runAutoUpdate(
        {
          homeDir,
          projectRoot,
          dryRun: false,
        },
        {
          discoverInstalledStates: () => records,
          runExternalCommand: (command, args, options) => {
            commands.push({ command, args, options });
            if (command === process.execPath) {
              return {
                stdout: JSON.stringify({
                  dryRun: false,
                  result: {
                    installStatePath: path.join(projectRoot, '.cursor', 'egc-install-state.json'),
                  },
                }),
                stderr: '',
              };
            }

            return { stdout: '', stderr: '' };
          },
        }
      );

      assert.strictEqual(result.summary.checkedCount, 1);
      assert.strictEqual(result.summary.updatedCount, 1);
      assert.deepStrictEqual(commands.map(entry => [entry.command, entry.args[0]]), [
        ['git', 'fetch'],
        ['git', 'pull'],
        [process.execPath, path.join(repoRoot, 'scripts', 'install-apply.js')],
      ]);
      assert.deepStrictEqual(commands[2].args.slice(1), [
        '--target', 'cursor',
        '--profile', 'developer',
        '--with', 'component:alpha',
        '--without', 'component:beta',
        '--json',
      ]);
      assert.strictEqual(commands[2].options.cwd, projectRoot);
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
      cleanup(repoRoot);
    }
  })) passed += 1; else failed += 1;

  if (test('runAutoUpdate also re-runs bootstrap-cognitive.js when the repo has it, so already-configured global protocol files get refreshed', () => {
    const homeDir = createTempDir('auto-update-home-');
    const projectRoot = createTempDir('auto-update-project-');
    const repoRoot = createTempDir('auto-update-repo-');

    try {
      ensureFakeRepo(repoRoot);
      fs.writeFileSync(
        path.join(repoRoot, 'scripts', 'bootstrap-cognitive.js'),
        '#!/usr/bin/env node\nconsole.log("[cognitive] Claude Code: memory protocol upgraded v1 -> v2");\n'
      );

      const records = [
        makeRecord({
          repoRoot,
          homeDir,
          projectRoot,
          adapter: { id: 'egc-home', target: 'egc', kind: 'home' },
          request: {
            profile: null,
            modules: [],
            includeComponents: [],
            excludeComponents: [],
            legacyLanguages: ['typescript'],
            legacyMode: true,
          },
          resolution: { selectedModules: ['legacy-egc-rules'], skippedModules: [] },
          operations: [
            {
              kind: 'copy-file',
              moduleId: 'legacy-egc-rules',
              sourcePath: path.join(repoRoot, 'rules', 'common', 'coding-style.md'),
              sourceRelativePath: path.join('rules', 'common', 'coding-style.md'),
              destinationPath: path.join(homeDir, '.gemini', 'rules', 'common', 'coding-style.md'),
              strategy: 'preserve-relative-path',
              ownership: 'managed',
              scaffoldOnly: false,
            },
          ],
        }),
      ];

      const commands = [];
      const result = runAutoUpdate(
        {
          homeDir,
          projectRoot,
          repoRoot,
          dryRun: false,
        },
        {
          discoverInstalledStates: () => records,
          runExternalCommand: (command, args, options) => {
            commands.push({ command, args, options });
            if (args[0] === path.join(repoRoot, 'scripts', 'bootstrap-cognitive.js')) {
              return { stdout: '[cognitive] Claude Code: memory protocol upgraded v1 -> v2\n', stderr: '' };
            }
            if (command === process.execPath) {
              return { stdout: JSON.stringify({ dryRun: false, result: {} }), stderr: '' };
            }
            return { stdout: '', stderr: '' };
          },
        }
      );

      assert.deepStrictEqual(commands.map(entry => [entry.command, entry.args[0]]), [
        ['git', 'fetch'],
        ['git', 'pull'],
        [process.execPath, path.join(repoRoot, 'scripts', 'bootstrap-cognitive.js')],
        [process.execPath, path.join(repoRoot, 'scripts', 'install-apply.js')],
      ]);
      assert.strictEqual(result.cognitiveBootstrap.status, 'ok');
      assert.ok(result.cognitiveBootstrap.output.includes('upgraded v1 -> v2'));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
      cleanup(repoRoot);
    }
  })) passed += 1; else failed += 1;

  if (test('runAutoUpdate skips bootstrap-cognitive.js when the repo root does not have it (e.g. an npm package that excludes it) and does not run it on dry-run', () => {
    const homeDir = createTempDir('auto-update-home-');
    const projectRoot = createTempDir('auto-update-project-');
    const repoRoot = createTempDir('auto-update-repo-');

    try {
      ensureFakeRepo(repoRoot);

      const records = [
        makeRecord({
          repoRoot,
          homeDir,
          projectRoot,
          adapter: { id: 'egc-home', target: 'egc', kind: 'home' },
          request: {
            profile: null,
            modules: [],
            includeComponents: [],
            excludeComponents: [],
            legacyLanguages: ['typescript'],
            legacyMode: true,
          },
          resolution: { selectedModules: ['legacy-egc-rules'], skippedModules: [] },
          operations: [
            {
              kind: 'copy-file',
              moduleId: 'legacy-egc-rules',
              sourcePath: path.join(repoRoot, 'rules', 'common', 'coding-style.md'),
              sourceRelativePath: path.join('rules', 'common', 'coding-style.md'),
              destinationPath: path.join(homeDir, '.gemini', 'rules', 'common', 'coding-style.md'),
              strategy: 'preserve-relative-path',
              ownership: 'managed',
              scaffoldOnly: false,
            },
          ],
        }),
      ];

      const result = runAutoUpdate(
        {
          homeDir,
          projectRoot,
          repoRoot,
          dryRun: true,
        },
        {
          discoverInstalledStates: () => records,
          runExternalCommand: () => { throw new Error('should not be called on dry-run'); },
        }
      );

      assert.strictEqual(result.cognitiveBootstrap, null);
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
      cleanup(repoRoot);
    }
  })) passed += 1; else failed += 1;

  if (test('deriveRepoRootFromState skips fallback entries missing a relative path or resolving to zero path segments', () => {
    const state = {
      operations: [
        {
          // Present sourcePath but no sourceRelativePath at all: the fallback
          // loop must skip past it instead of dereferencing a missing field.
          sourcePath: path.join('/tmp', 'egc-fallback', 'no-relative-path.js'),
          sourceRelativePath: undefined,
        },
        {
          // Backslashes are not path separators on POSIX, so path.join keeps
          // this out of the __dirname fast path (the joined path never
          // exists), while the fallback loop's split(/[\\/]+/) regex still
          // treats them as separators and collapses this to zero segments.
          sourcePath: path.join('/tmp', 'egc-fallback', 'zero-segments.js'),
          sourceRelativePath: '\\\\',
        },
        {
          sourcePath: path.join('/tmp', 'egc-fallback', 'pkg', 'nested', 'file.js'),
          sourceRelativePath: 'custom-nonexistent-marker.js',
        },
      ],
    };

    assert.strictEqual(
      deriveRepoRootFromState(state),
      path.resolve(path.join('/tmp', 'egc-fallback', 'pkg', 'nested'))
    );
  })) passed += 1; else failed += 1;

  if (test('runAutoUpdate rejects a repo root missing package.json', () => {
    const repoRoot = createTempDir('auto-update-missing-pkg-');
    try {
      assert.throws(
        () => runAutoUpdate(
          { repoRoot },
          { discoverInstalledStates: () => [] }
        ),
        /missing package\.json/
      );
    } finally {
      cleanup(repoRoot);
    }
  })) passed += 1; else failed += 1;

  if (test('runAutoUpdate rejects a repo root missing the install-apply.js script', () => {
    const repoRoot = createTempDir('auto-update-missing-install-apply-');
    try {
      fs.writeFileSync(
        path.join(repoRoot, 'package.json'),
        JSON.stringify({ name: 'x', version: '1.0.0' })
      );

      assert.throws(
        () => runAutoUpdate(
          { repoRoot },
          { discoverInstalledStates: () => [] }
        ),
        /missing install script/
      );
    } finally {
      cleanup(repoRoot);
    }
  })) passed += 1; else failed += 1;

  if (test('runAutoUpdate reports an error result and bails out when no repo root can be resolved', () => {
    const homeDir = createTempDir('auto-update-norepo-home-');
    const projectRoot = createTempDir('auto-update-norepo-project-');

    try {
      const brokenRecord = {
        adapter: { id: 'broken-adapter', target: 'broken', kind: 'home' },
        targetRoot: path.join(homeDir, '.broken'),
        installStatePath: path.join(homeDir, '.broken', 'egc-install-state.json'),
        exists: true,
        state: null,
        error: 'Corrupted install-state JSON',
      };

      const result = runAutoUpdate(
        { homeDir, projectRoot, dryRun: true },
        { discoverInstalledStates: () => [brokenRecord] }
      );

      assert.strictEqual(result.repoRoot, null);
      assert.strictEqual(result.results.length, 1);
      assert.strictEqual(result.results[0].status, 'error');
      assert.strictEqual(result.results[0].error, 'Corrupted install-state JSON');
      assert.strictEqual(result.summary.checkedCount, 1);
      assert.strictEqual(result.summary.updatedCount, 0);
      assert.strictEqual(result.summary.errorCount, 1);
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed += 1; else failed += 1;

  if (test('runCognitiveBootstrap returns an error status when the bootstrap script execution throws', () => {
    const repoRoot = createTempDir('auto-update-cognitive-error-');
    try {
      fs.mkdirSync(path.join(repoRoot, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, 'scripts', 'bootstrap-cognitive.js'), '#!/usr/bin/env node\n');

      const result = runCognitiveBootstrap(repoRoot, process.env, () => {
        throw new Error('bootstrap exploded');
      });

      assert.deepStrictEqual(result, { status: 'error', error: 'bootstrap exploded' });
    } finally {
      cleanup(repoRoot);
    }
  })) passed += 1; else failed += 1;

  if (test('runAutoUpdate rethrows a git pull failure whose message does not mention upstream tracking', () => {
    const homeDir = createTempDir('auto-update-pull-rethrow-home-');
    const projectRoot = createTempDir('auto-update-pull-rethrow-project-');
    const repoRoot = createTempDir('auto-update-pull-rethrow-repo-');

    try {
      ensureFakeRepo(repoRoot);

      const records = [
        makeRecord({
          repoRoot,
          homeDir,
          projectRoot,
          adapter: { id: 'cursor-project', target: 'cursor', kind: 'project' },
          request: {
            profile: 'core',
            modules: [],
            includeComponents: [],
            excludeComponents: [],
            legacyLanguages: [],
            legacyMode: false,
          },
          resolution: { selectedModules: ['rules-core'], skippedModules: [] },
          operations: [
            {
              kind: 'copy-file',
              moduleId: 'rules-core',
              sourcePath: path.join(repoRoot, '.cursor', 'mcp.json'),
              sourceRelativePath: path.join('.cursor', 'mcp.json'),
              destinationPath: path.join(projectRoot, '.cursor', 'mcp.json'),
              strategy: 'sync-root-children',
              ownership: 'managed',
              scaffoldOnly: false,
            },
          ],
        }),
      ];

      assert.throws(
        () => runAutoUpdate(
          { homeDir, projectRoot, repoRoot, dryRun: false },
          {
            discoverInstalledStates: () => records,
            runExternalCommand: (command, args) => {
              if (command === 'git' && args[0] === 'pull') {
                throw new Error('fatal: Not possible to fast-forward, aborting.');
              }
              return { stdout: '', stderr: '' };
            },
          }
        ),
        /Not possible to fast-forward/
      );
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
      cleanup(repoRoot);
    }
  })) passed += 1; else failed += 1;

  if (test('runAutoUpdate uses the real runExternalCommand to fetch and surfaces the friendly upstream error on a real git pull failure', () => {
    const homeDir = createTempDir('auto-update-realgit-home-');
    const projectRoot = createTempDir('auto-update-realgit-project-');
    const repoRoot = createTempDir('auto-update-realgit-repo-');

    try {
      ensureFakeRepo(repoRoot);
      // Replace the placeholder .git dir from ensureFakeRepo with a real,
      // freshly initialized repo that has a commit but no remote/upstream,
      // so the unmocked runExternalCommand really shells out to git.
      fs.rmSync(path.join(repoRoot, '.git'), { recursive: true, force: true });
      spawnSync('git', ['init'], { cwd: repoRoot, encoding: 'utf8' });
      spawnSync('git', ['config', 'user.email', 'egc-test@example.com'], { cwd: repoRoot, encoding: 'utf8' });
      spawnSync('git', ['config', 'user.name', 'EGC Test'], { cwd: repoRoot, encoding: 'utf8' });
      fs.writeFileSync(path.join(repoRoot, 'README.md'), 'placeholder');
      spawnSync('git', ['add', '.'], { cwd: repoRoot, encoding: 'utf8' });
      spawnSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, encoding: 'utf8' });

      const records = [
        makeRecord({
          repoRoot,
          homeDir,
          projectRoot,
          adapter: { id: 'egc-home', target: 'egc', kind: 'home' },
          request: {
            profile: null,
            modules: [],
            includeComponents: [],
            excludeComponents: [],
            legacyLanguages: ['typescript'],
            legacyMode: true,
          },
          resolution: { selectedModules: ['legacy-egc-rules'], skippedModules: [] },
          operations: [
            {
              kind: 'copy-file',
              moduleId: 'legacy-egc-rules',
              sourcePath: path.join(repoRoot, 'rules', 'common', 'coding-style.md'),
              sourceRelativePath: path.join('rules', 'common', 'coding-style.md'),
              destinationPath: path.join(homeDir, '.gemini', 'rules', 'common', 'coding-style.md'),
              strategy: 'preserve-relative-path',
              ownership: 'managed',
              scaffoldOnly: false,
            },
          ],
        }),
      ];

      // No runExternalCommand override: this exercises the real spawnSync-backed
      // implementation, not the mocked one used by the other runAutoUpdate tests.
      assert.throws(
        () => runAutoUpdate(
          { homeDir, projectRoot, repoRoot, dryRun: false },
          { discoverInstalledStates: () => records }
        ),
        /git pull failed: no upstream tracking branch configured/
      );
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
      cleanup(repoRoot);
    }
  })) passed += 1; else failed += 1;

  if (test('runAutoUpdate surfaces a real ENOENT spawn error when git is not resolvable on PATH', () => {
    const homeDir = createTempDir('auto-update-enoent-home-');
    const projectRoot = createTempDir('auto-update-enoent-project-');
    const repoRoot = createTempDir('auto-update-enoent-repo-');
    const emptyPathDir = createTempDir('auto-update-enoent-emptypath-');
    const originalPath = process.env.PATH;

    try {
      ensureFakeRepo(repoRoot);

      const records = [
        makeRecord({
          repoRoot,
          homeDir,
          projectRoot,
          adapter: { id: 'egc-home', target: 'egc', kind: 'home' },
          request: {
            profile: null,
            modules: [],
            includeComponents: [],
            excludeComponents: [],
            legacyLanguages: ['typescript'],
            legacyMode: true,
          },
          resolution: { selectedModules: ['legacy-egc-rules'], skippedModules: [] },
          operations: [
            {
              kind: 'copy-file',
              moduleId: 'legacy-egc-rules',
              sourcePath: path.join(repoRoot, 'rules', 'common', 'coding-style.md'),
              sourceRelativePath: path.join('rules', 'common', 'coding-style.md'),
              destinationPath: path.join(homeDir, '.gemini', 'rules', 'common', 'coding-style.md'),
              strategy: 'preserve-relative-path',
              ownership: 'managed',
              scaffoldOnly: false,
            },
          ],
        }),
      ];

      // Point PATH at an empty directory so the real runExternalCommand's
      // spawnSync('git', ...) call cannot resolve the git executable and
      // surfaces result.error (ENOENT) instead of a status code.
      process.env.PATH = emptyPathDir;

      assert.throws(
        () => runAutoUpdate(
          { homeDir, projectRoot, repoRoot, dryRun: false },
          { discoverInstalledStates: () => records }
        ),
        error => error.code === 'ENOENT'
      );
    } finally {
      process.env.PATH = originalPath;
      cleanup(homeDir);
      cleanup(projectRoot);
      cleanup(repoRoot);
      cleanup(emptyPathDir);
    }
  })) passed += 1; else failed += 1;

  if (test('auto-update.js CLI prints the empty-state message and exits 0 when no install-state files exist', () => {
    const homeDir = createTempDir('auto-update-cli-empty-home-');
    const projectRoot = createTempDir('auto-update-cli-empty-project-');

    try {
      const result = spawnSync(process.execPath, [AUTO_UPDATE_SCRIPT_PATH], {
        cwd: projectRoot,
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
        encoding: 'utf8',
      });

      assert.strictEqual(result.status, 0, result.stderr);
      assert.ok(
        result.stdout.includes('No EGC install-state files found'),
        result.stdout
      );
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed += 1; else failed += 1;

  if (test('auto-update.js CLI dry-run summary lists a planned target with reinstall args', () => {
    const homeDir = createTempDir('auto-update-cli-dryrun-home-');
    const projectRoot = createTempDir('auto-update-cli-dryrun-project-');
    const repoRoot = createTempDir('auto-update-cli-dryrun-repo-');

    try {
      ensureFakeNpmRepo(repoRoot);
      fs.writeFileSync(
        path.join(repoRoot, 'scripts', 'install-apply.js'),
        '#!/usr/bin/env node\nconsole.log(JSON.stringify({ dryRun: true, result: { ok: true } }));\n'
      );
      writeGeminiInstallState(projectRoot);

      const result = spawnSync(process.execPath, [
        AUTO_UPDATE_SCRIPT_PATH,
        '--repo-root', repoRoot,
        '--target', 'gemini',
        '--dry-run',
      ], {
        cwd: projectRoot,
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
        encoding: 'utf8',
      });

      assert.strictEqual(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes('Auto-update dry run:'), result.stdout);
      assert.ok(result.stdout.includes(`Repo root: ${repoRoot}`), result.stdout);
      assert.ok(result.stdout.includes('- gemini-project'), result.stdout);
      assert.ok(result.stdout.includes('Status: PLANNED'), result.stdout);
      assert.ok(result.stdout.includes('Reinstall args:'), result.stdout);
      assert.ok(result.stdout.includes('Summary: checked=1, planned=1, errors=0'), result.stdout);
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
      cleanup(repoRoot);
    }
  })) passed += 1; else failed += 1;

  if (test('auto-update.js CLI full run prints cognitive bootstrap output and an updated summary', () => {
    const homeDir = createTempDir('auto-update-cli-full-home-');
    const projectRoot = createTempDir('auto-update-cli-full-project-');
    const repoRoot = createTempDir('auto-update-cli-full-repo-');

    try {
      ensureFakeNpmRepo(repoRoot);
      fs.writeFileSync(
        path.join(repoRoot, 'scripts', 'install-apply.js'),
        '#!/usr/bin/env node\nconsole.log(JSON.stringify({ dryRun: false, result: { ok: true } }));\n'
      );
      fs.writeFileSync(
        path.join(repoRoot, 'scripts', 'bootstrap-cognitive.js'),
        '#!/usr/bin/env node\nconsole.log("[cognitive] stub bootstrap executed successfully");\n'
      );
      writeGeminiInstallState(projectRoot);

      const result = spawnSync(process.execPath, [
        AUTO_UPDATE_SCRIPT_PATH,
        '--repo-root', repoRoot,
        '--target', 'gemini',
      ], {
        cwd: projectRoot,
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
        encoding: 'utf8',
      });

      assert.strictEqual(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes('EGC is installed via npm'), result.stdout);
      assert.ok(result.stdout.includes('Auto-update summary:'), result.stdout);
      assert.ok(result.stdout.includes('Cognitive protocol bootstrap: OK'), result.stdout);
      assert.ok(
        result.stdout.includes('[cognitive] stub bootstrap executed successfully'),
        result.stdout
      );
      assert.ok(result.stdout.includes('- gemini-project'), result.stdout);
      assert.ok(result.stdout.includes('Status: UPDATED'), result.stdout);
      assert.ok(result.stdout.includes('Summary: checked=1, updated=1, errors=0'), result.stdout);
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
      cleanup(repoRoot);
    }
  })) passed += 1; else failed += 1;

  if (test('auto-update.js CLI prints bootstrap and per-target errors, exiting with a non-zero status', () => {
    const homeDir = createTempDir('auto-update-cli-err-home-');
    const projectRoot = createTempDir('auto-update-cli-err-project-');
    const repoRoot = createTempDir('auto-update-cli-err-repo-');

    try {
      ensureFakeNpmRepo(repoRoot);
      fs.writeFileSync(
        path.join(repoRoot, 'scripts', 'install-apply.js'),
        '#!/usr/bin/env node\nconsole.error("install-apply stub failed intentionally");\nprocess.exit(1);\n'
      );
      fs.writeFileSync(
        path.join(repoRoot, 'scripts', 'bootstrap-cognitive.js'),
        '#!/usr/bin/env node\nconsole.error("bootstrap-cognitive stub failed intentionally");\nprocess.exit(1);\n'
      );
      writeGeminiInstallState(projectRoot);

      const result = spawnSync(process.execPath, [
        AUTO_UPDATE_SCRIPT_PATH,
        '--repo-root', repoRoot,
        '--target', 'gemini',
      ], {
        cwd: projectRoot,
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
        encoding: 'utf8',
      });

      assert.strictEqual(result.status, 1, result.stdout + result.stderr);
      assert.ok(result.stdout.includes('Cognitive protocol bootstrap: ERROR'), result.stdout);
      assert.ok(
        result.stdout.includes('bootstrap-cognitive stub failed intentionally'),
        result.stdout
      );
      assert.ok(result.stdout.includes('Status: ERROR'), result.stdout);
      assert.ok(
        result.stdout.includes('install-apply stub failed intentionally'),
        result.stdout
      );
      assert.ok(result.stdout.includes('Summary: checked=1, updated=0, errors=1'), result.stdout);
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
      cleanup(repoRoot);
    }
  })) passed += 1; else failed += 1;

  if (test('auto-update.js CLI exits 1 and prints an error for unknown arguments', () => {
    const result = spawnSync(process.execPath, [AUTO_UPDATE_SCRIPT_PATH, '--bogus'], {
      encoding: 'utf8',
    });

    assert.strictEqual(result.status, 1);
    assert.ok(result.stderr.includes('Error: Unknown argument: --bogus'), result.stderr);
  })) passed += 1; else failed += 1;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
