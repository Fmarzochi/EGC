'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'ci', 'preflight.js');
const { changedEntries, isLintable, lintInDefaultProject, parseArgs, splitFindings } = require(SCRIPT);

const GIT_BIN = [
  '/usr/bin/git',
  '/usr/local/bin/git',
  '/opt/homebrew/bin/git',
  String.raw`C:\Program Files\Git\cmd\git.exe`,
].find(candidate => fs.existsSync(candidate)) || 'git';

const PLAIN_CONFIG = "module.exports = [{ files: ['**/*.js'], rules: { 'no-unused-vars': 'error', 'no-debugger': 'error' } }];\n";
const TYPED_CONFIG = [
  "const tseslint = require('typescript-eslint');",
  'module.exports = [{',
  "  files: ['**/*.ts'],",
  '  languageOptions: { parser: tseslint.parser, parserOptions: { projectService: true, tsconfigRootDir: __dirname } },',
  "  rules: { 'no-debugger': 'error' },",
  '}];',
  '',
].join('\n');
const PLUGIN_CONFIG = [
  "const globals = require('globals');",
  "module.exports = [{ files: ['**/*.js'], languageOptions: { globals: globals.node }, rules: { 'no-debugger': 'error' } }];",
  '',
].join('\n');
const SKIPPED = Symbol('skipped');

function test(name, fn) {
  try {
    if (fn() === SKIPPED) {
      console.log(`  SKIP ${name}`);
      return SKIPPED;
    }
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-preflight-'));
  const gitConfig = path.join(dir, 'gitconfig');
  fs.writeFileSync(gitConfig, '');
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Preflight Test',
    GIT_AUTHOR_EMAIL: 'preflight@example.com',
    GIT_COMMITTER_NAME: 'Preflight Test',
    GIT_COMMITTER_EMAIL: 'preflight@example.com',
  };
  delete env.EGC_PREFLIGHT_MODULE_PATH;
  delete env.NODE_PATH;
  return { dir, env };
}

function git(sandbox, cwd, args) {
  const result = spawnSync(GIT_BIN, args, { cwd, env: sandbox.env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function write(root, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(root, relativePath), content);
  }
}

function commit(sandbox, root, message) {
  git(sandbox, root, ['add', '-A']);
  git(sandbox, root, ['commit', '-q', '-m', message]);
}

function makeRepo(sandbox, name, baseFiles) {
  const root = path.join(sandbox.dir, name);
  fs.mkdirSync(root);
  git(sandbox, root, ['init', '-q', '-b', 'main']);
  write(root, { '.gitignore': 'node_modules\n', ...baseFiles });
  commit(sandbox, root, 'base');
  git(sandbox, root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  git(sandbox, root, ['checkout', '-q', '-b', 'feature']);
  return root;
}

function preflight(sandbox, cwd) {
  const result = spawnSync(process.execPath, [SCRIPT], { cwd, env: sandbox.env, encoding: 'utf8', timeout: 120000 });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function withSandbox(fn) {
  const sandbox = makeSandbox();
  try {
    return fn(sandbox);
  } finally {
    fs.rmSync(sandbox.dir, { recursive: true, force: true });
  }
}

function linkNodeModules(root) {
  const nodeModules = path.resolve(path.dirname(require.resolve('globals/package.json')), '..');
  fs.symlinkSync(nodeModules, path.join(root, 'node_modules'), 'junction');
}

function canResolve(request) {
  try {
    require.resolve(request);
    return true;
  } catch {
    return false;
  }
}

console.log('\n=== Testing scripts/ci/preflight.js ===\n');

const results = [
  test('a finding the branch adds fails the run and names the file, line and rule', () => withSandbox(sandbox => {
    const root = makeRepo(sandbox, 'repo', {
      'eslint.config.js': PLAIN_CONFIG,
      'lib/a.js': "'use strict';\nmodule.exports = function a() {\n  return 1;\n};\n",
    });
    write(root, { 'lib/a.js': "'use strict';\nmodule.exports = function a() {\n  const unused = 2;\n  return 1;\n};\n" });
    commit(sandbox, root, 'add a violation');
    const { status, output } = preflight(sandbox, root);
    assert.strictEqual(status, 1, output);
    assert.match(output, /^lib\/a\.js:3 no-unused-vars /m, output);
  })),

  test('a branch that only touches a file with findings at the base passes and lists them as informational', () => withSandbox(sandbox => {
    const root = makeRepo(sandbox, 'repo', {
      'eslint.config.js': PLAIN_CONFIG,
      'lib/a.js': "'use strict';\nmodule.exports = function a() {\n  debugger;\n  return 1;\n};\n",
    });
    write(root, { 'lib/a.js': "'use strict';\n\nmodule.exports = function a() {\n  debugger;\n  return 2;\n};\n" });
    commit(sandbox, root, 'touch the file');
    const { status, output } = preflight(sandbox, root);
    assert.strictEqual(status, 0, output);
    assert.match(output, /Findings already at the merge base \(informational\):\nlib\/a\.js:4 no-debugger /, output);
    assert.doesNotMatch(output, /Findings this branch adds/, output);
  })),

  test('a file the branch adds is analyzed, committed or not yet tracked', () => withSandbox(sandbox => {
    const root = makeRepo(sandbox, 'repo', { 'eslint.config.js': PLAIN_CONFIG });
    write(root, { 'lib/new.js': "'use strict';\ndebugger;\n" });
    commit(sandbox, root, 'add a file');
    write(root, { 'lib/untracked.js': "'use strict';\nconst unused = 1;\n" });
    const { status, output } = preflight(sandbox, root);
    assert.strictEqual(status, 1, output);
    assert.match(output, /^lib\/new\.js:2 no-debugger /m, output);
    assert.match(output, /^lib\/untracked\.js:2 no-unused-vars /m, output);
  })),

  test('a worktree without node_modules lints with the plugins of the main checkout', () => withSandbox(sandbox => {
    const main = makeRepo(sandbox, 'main', { 'eslint.config.js': PLUGIN_CONFIG });
    linkNodeModules(main);
    git(sandbox, main, ['checkout', '-q', 'main']);
    const worktree = path.join(sandbox.dir, 'worktree');
    git(sandbox, main, ['worktree', 'add', '-q', worktree, 'feature']);
    write(worktree, { 'lib/b.js': "'use strict';\ndebugger;\n" });
    commit(sandbox, worktree, 'add a file in the worktree');
    assert.ok(!fs.existsSync(path.join(worktree, 'node_modules')), 'the worktree has no node_modules of its own');
    const { status, output } = preflight(sandbox, worktree);
    assert.strictEqual(status, 1, output);
    assert.match(output, /^lib\/b\.js:2 no-debugger /m, output);
  })),

  test('a typed config with projectService reads a file the branch adds that no tsconfig includes', () => withSandbox(sandbox => {
    if (!canResolve('typescript')) return SKIPPED;
    const root = makeRepo(sandbox, 'repo', {
      'eslint.config.js': TYPED_CONFIG,
      'tsconfig.json': '{ "compilerOptions": { "strict": true, "noEmit": true }, "include": ["src/a.ts"] }\n',
      'src/a.ts': 'export const a = 1;\n',
    });
    linkNodeModules(root);
    write(root, { 'src/b.ts': 'export function b(): void {\n  debugger;\n}\n' });
    commit(sandbox, root, 'add a typed file');
    const { status, output } = preflight(sandbox, root);
    assert.strictEqual(status, 1, output);
    assert.match(output, /^src\/b\.ts:2 no-debugger /m, output);
    assert.doesNotMatch(output, /parse-error/, output);
    return undefined;
  })),

  test('a resolvable eslint-plugin-sonarjs adds its recommended rules, and the output names that mode', () => withSandbox(sandbox => {
    const root = makeRepo(sandbox, 'repo', { 'eslint.config.js': "module.exports = [{ files: ['**/*.js'], rules: {} }];\n" });
    write(root, {
      'node_modules/eslint-plugin-sonarjs/package.json': '{ "name": "eslint-plugin-sonarjs", "main": "index.js" }\n',
      'node_modules/eslint-plugin-sonarjs/index.js': "module.exports = { configs: { recommended: { rules: { 'no-debugger': 'error' } } } };\n",
      'lib/a.js': "'use strict';\ndebugger;\n",
    });
    commit(sandbox, root, 'add a file');
    const { status, output } = preflight(sandbox, root);
    assert.strictEqual(status, 1, output);
    assert.match(output, /rules: eslint\.config\.js \+ eslint-plugin-sonarjs recommended/, output);
    assert.match(output, /^lib\/a\.js:2 no-debugger /m, output);
  })),

  test('without a merge base it exits 2 and says to fetch origin', () => withSandbox(sandbox => {
    const root = makeRepo(sandbox, 'repo', { 'eslint.config.js': PLAIN_CONFIG });
    git(sandbox, root, ['update-ref', '-d', 'refs/remotes/origin/main']);
    const { status, output } = preflight(sandbox, root);
    assert.strictEqual(status, 2, output);
    assert.match(output, /preflight: no merge base with origin\/main; run git fetch origin first/, output);
  })),

  test('--base picks the ref to compare against, and an unknown argument is refused with the usage', () => {
    assert.deepStrictEqual(parseArgs([]), { base: 'origin/main', defaultProject: null });
    assert.strictEqual(parseArgs(['--base', 'origin/release']).base, 'origin/release');
    assert.throws(() => parseArgs(['--nope']), /unknown argument --nope\. Usage: npm run preflight/);
    assert.throws(() => parseArgs(['--base']), /unknown argument --base/);
  }),

  test('a default-project relint that cannot run gives the first result back instead of failing', () => withSandbox(sandbox => {
    assert.strictEqual(lintInDefaultProject(sandbox.dir, 'src/b.ts'), null);
  })),

  test('findings match by rule and message counts, not by line', () => {
    const base = [{ ruleId: 'complexity', message: 'too complex', line: 10 }];
    const head = [
      { ruleId: 'complexity', message: 'too complex', line: 14 },
      { ruleId: 'complexity', message: 'too complex', line: 30 },
    ];
    const { added, existing } = splitFindings(head, base);
    assert.deepStrictEqual(existing.map(message => message.line), [14]);
    assert.deepStrictEqual(added.map(message => message.line), [30]);
  }),

  test('the changed-file list keeps added, copied, modified and renamed files, skipping build/ and dist/', () => {
    const entries = changedEntries(['A', 'new.js', 'M', 'mod.ts', 'R090', 'old.js', 'renamed.js', 'C075', 'src.js', 'copy.cjs', ''].join('\0'));
    assert.deepStrictEqual(entries, [
      { path: 'new.js', basePath: null },
      { path: 'mod.ts', basePath: 'mod.ts' },
      { path: 'renamed.js', basePath: 'old.js' },
      { path: 'copy.cjs', basePath: null },
    ]);
    assert.ok(isLintable('scripts/a.mjs'));
    assert.ok(!isLintable('mcp/servers/egc-guardian/build/index.js'));
    assert.ok(!isLintable('pkg/dist/index.js'));
    assert.ok(!isLintable('README.md'));
  }),
];

const skipped = results.filter(result => result === SKIPPED).length;
const passed = results.filter(result => result === true).length;
const failed = results.length - passed - skipped;
console.log(`\nResults: Passed: ${passed}, Failed: ${failed}, Skipped: ${skipped}`);
process.exitCode = failed > 0 ? 1 : 0;
