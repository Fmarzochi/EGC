'use strict';
/**
 * Tests for scripts/check-state-leak.js
 *
 * Covers the commit-privacy guard: populated EGC memory in propagation files
 * must be caught in staged blobs (--staged), in the tracked tree (--tree),
 * and --clean must zero the section so the same content passes.
 *
 * Run with: node tests/check-state-leak.test.js
 */
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-state-leak.js');

const POPULATED = [
  '# EGC: Agent Catalog',
  '',
  '<!-- egc:start -->',
  '<!-- egc:state-updated:2026-07-18T05:15:28.038Z -->',
  '## EGC Project Memory',
  '',
  '**Context:** secret local context that must never ship.',
  '',
  '**Active decisions:**',
  '- private decision one',
  '',
  '**Next session:**',
  '- private next step',
  '',
  '## EGC Triggers',
  '<!-- egc:end -->',
  '',
].join('\n');

// Every temporary directory of this file is removed when the process ends.
const TEMP_DIRS = [];
function tempDir(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  TEMP_DIRS.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of TEMP_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

function makeRepo() {
  const dir = tempDir('egc-leak-test-');
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'core.autocrlf', 'false');
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'check-state-leak.js'));
  return { dir, git };
}

function runScript(dir, ...args) {
  return spawnSync('node', [path.join(dir, 'scripts', 'check-state-leak.js'), ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
}

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    return true;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    return false;
  }
}

let passed = 0;
let failed = 0;
const run = (name, fn) => { if (test(name, fn)) passed++; else failed++; };

console.log('\n=== Testing check-state-leak ===\n');

run('staged populated propagation file is blocked', () => {
  const { dir, git } = makeRepo();
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), POPULATED);
  git('add', 'AGENTS.md');
  const res = runScript(dir, '--staged');
  assert.strictEqual(res.status, 1, `expected exit 1, got ${res.status}: ${res.stderr}`);
  assert.ok(res.stderr.includes('AGENTS.md'));
});

run('cleaned file passes staged check and keeps structure', () => {
  const { dir, git } = makeRepo();
  const file = path.join(dir, 'AGENTS.md');
  fs.writeFileSync(file, POPULATED);
  const cleanRes = runScript(dir, '--clean', 'AGENTS.md');
  assert.strictEqual(cleanRes.status, 0, cleanRes.stderr);
  const cleaned = fs.readFileSync(file, 'utf8');
  assert.ok(cleaned.includes('## EGC Project Memory'), 'structure heading survives');
  assert.ok(!cleaned.includes('secret local context'), 'context content removed');
  assert.ok(!cleaned.includes('private decision'), 'decisions removed');
  assert.ok(!cleaned.includes('state-updated'), 'stamp removed');
  git('add', 'AGENTS.md');
  const res = runScript(dir, '--staged');
  assert.strictEqual(res.status, 0, res.stderr);
});

run('tree mode flags committed populated file', () => {
  const { dir, git } = makeRepo();
  fs.writeFileSync(path.join(dir, 'GEMINI.md'), POPULATED);
  git('add', '.');
  git('commit', '-q', '-m', 'seed', '--no-verify');
  const res = runScript(dir, '--tree');
  assert.strictEqual(res.status, 1);
  assert.ok(res.stderr.includes('GEMINI.md'));
});

run('markdown without the managed section is ignored', () => {
  const { dir, git } = makeRepo();
  fs.writeFileSync(path.join(dir, 'README.md'), '# Readme\n\n**Context:** docs example\n');
  git('add', '.');
  const staged = runScript(dir, '--staged');
  assert.strictEqual(staged.status, 0, staged.stderr);
  git('commit', '-q', '-m', 'seed', '--no-verify');
  const tree = runScript(dir, '--tree');
  assert.strictEqual(tree.status, 0, tree.stderr);
});

run('non-markdown staged files are ignored', () => {
  const { dir, git } = makeRepo();
  fs.writeFileSync(path.join(dir, 'propagate.js'), `const s = '<!-- egc:state-updated:x -->';\nconst h = '## EGC Project Memory';\n`);
  git('add', 'propagate.js');
  const res = runScript(dir, '--staged');
  assert.strictEqual(res.status, 0, res.stderr);
});

run('packaged-tree mode flags only files the package ships', () => {
  const { dir, git } = makeRepo();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't', version: '0.0.0', files: ['.trae/'] }, null, 2));
  fs.mkdirSync(path.join(dir, '.trae', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.trae', 'rules', 'egc-context.md'), POPULATED);
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), POPULATED);
  git('add', '.');
  git('commit', '-q', '-m', 'seed', '--no-verify');
  const res = runScript(dir, '--packaged-tree');
  assert.strictEqual(res.status, 1, `expected exit 1, got ${res.status}: ${res.stderr}`);
  assert.ok(res.stderr.includes('.trae/rules/egc-context.md'));
  assert.ok(!res.stderr.includes('CLAUDE.md'), 'unpackaged propagation files must not block a publish');
});

run('packaged-tree passes when only unpackaged files are populated', () => {
  const { dir, git } = makeRepo();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't', version: '0.0.0', files: ['.trae/'] }, null, 2));
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), POPULATED);
  git('add', '.');
  git('commit', '-q', '-m', 'seed', '--no-verify');
  const res = runScript(dir, '--packaged-tree');
  assert.strictEqual(res.status, 0, res.stderr);
});

run('a clean packaged tree keeps stdout empty so npm pack --json can parse its output', () => {
  const { dir, git } = makeRepo();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't', version: '0.0.0', files: ['scripts/'] }, null, 2));
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    const res = runScript(dir, '--packaged-tree');
    assert.strictEqual(res.status, 0, res.stderr);
    assert.strictEqual(res.stdout, '', 'status lines must not reach stdout');
    assert.ok(res.stderr.includes('state-leak check: clean'), res.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

run('packaged-tree skips with a notice outside a git checkout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-leak-nogit-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'check-state-leak.js'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't', version: '0.0.0', files: ['.trae/'] }, null, 2));
    const res = runScript(dir, '--packaged-tree');
    assert.strictEqual(res.status, 0, res.stderr);
    assert.ok(res.stderr.includes('skipped (not a git checkout'), res.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

run('packaged-tree flags an untracked populated file inside the packaged set', () => {
  const { dir, git } = makeRepo();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't', version: '0.0.0', files: ['.trae/'] }, null, 2));
  git('add', '.');
  git('commit', '-q', '-m', 'seed', '--no-verify');
  // Written AFTER the commit: npm pack reads the working tree, so a
  // never-committed propagation file ships all the same.
  fs.mkdirSync(path.join(dir, '.trae', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.trae', 'rules', 'egc-context.md'), POPULATED);
  const res = runScript(dir, '--packaged-tree');
  assert.strictEqual(res.status, 1, `untracked packaged file must still be scanned: ${res.stderr}`);
  assert.ok(res.stderr.includes('.trae/rules/egc-context.md'));
});

// ── Smudge side of the filter ──────────────────────────────────────────────
// Git hands the smudge the zeroed blob it is checking out; the block comes
// back from the local state, so a pull, a branch switch or a stash pop never
// leaves the working tree without the memory. Whatever stands in the way
// (no state, a state that cannot be read, a file without the markers) the
// content goes out as it came and the checkout goes on. The committed
// skeleton of these cases is what the clean side makes of a populated
// block, the shape a repository actually carries.
const { getStateDir, detectBranch, branchStateFile } = require('../scripts/lib/branch-state');
const { configureMemoryFilters } = require('../scripts/lib/memory-filters');
const { MAGIC } = require('../scripts/lib/state-crypto');
const { propagateStateContent } = require('../scripts/lib/propagate-state');
const crypto = require('node:crypto');

const BARE_SKELETON = ['# Agents', '', '<!-- egc:start -->', '<!-- egc:end -->', ''].join('\n');
const BARE_LLMS_SKELETON = ['<!-- egc:start -->', '<!-- egc:end -->', ''].join('\n');
const STATE = [
  '# Project State',
  'updated: 2026-09-22T20:00:00.000Z',
  '',
  '## Context',
  'context kept in the local state',
  '',
  '## Active Decisions',
  '- decision kept in the local state',
  '',
  '## Next Session',
  '- next step kept in the local state',
  '',
].join('\n');
const UNREADABLE_STATE = Buffer.concat([Buffer.from(MAGIC), crypto.randomBytes(80)]);

function makeHome() {
  return tempDir('egc-leak-home-');
}

function withHome(home) {
  return { ...process.env, HOME: home, USERPROFILE: home };
}

function stateFileFor(home, dir) {
  const file = branchStateFile(getStateDir(home), dir, detectBranch(dir));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

function smudge(dir, home, relativePath, input) {
  return spawnSync('node', [SCRIPT, '--filter-smudge', relativePath], { cwd: dir, encoding: 'utf8', input, env: withHome(home) });
}

function clean(dir, input) {
  return spawnSync('node', [SCRIPT, '--filter-clean'], { cwd: dir, encoding: 'utf8', input }).stdout;
}

// A repository with a state of its own and AGENTS.md committed as the clean
// side leaves a populated block: exactly what a checkout hands the smudge.
// The directory name is the caller's, so a path with spaces can be tried.
function seedRepo(prefix = 'egc-leak-test-') {
  const dir = tempDir(prefix);
  const home = makeHome();
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: withHome(home) });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(stateFileFor(home, dir), STATE);
  const skeleton = clean(dir, smudge(dir, home, 'AGENTS.md', BARE_SKELETON).stdout);
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), skeleton);
  git('add', 'AGENTS.md');
  git('commit', '-q', '-m', 'seed', '--no-verify');
  return { dir, home, skeleton, git };
}

console.log('\n=== Testing check-state-leak: smudge ===\n');

run('the smudge puts the memory of the local state back into the zeroed blob', () => {
  const { dir, home, skeleton } = seedRepo();
  const res = smudge(dir, home, 'AGENTS.md', skeleton);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.ok(res.stdout.startsWith('# Agents\n'), 'the content around the block is kept');
  assert.ok(res.stdout.includes('**Context:** context kept in the local state'), res.stdout);
  assert.ok(res.stdout.includes('- decision kept in the local state'), res.stdout);
  assert.ok(res.stdout.includes('- next step kept in the local state'), res.stdout);
  assert.strictEqual((res.stdout.match(/<!-- egc:start -->/g) || []).length, 1, 'one start marker');
  assert.strictEqual((res.stdout.match(/<!-- egc:end -->/g) || []).length, 1, 'one end marker');
  assert.strictEqual(clean(dir, res.stdout), skeleton, 'the clean side takes the smudged file back to the committed blob');
});

run('the smudge leaves the blob as it came when the project has no state', () => {
  const { dir, skeleton } = seedRepo();
  const res = smudge(dir, makeHome(), 'AGENTS.md', skeleton);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(res.stdout, skeleton);
  assert.strictEqual(res.stderr, '');
});

run('the smudge leaves a file without the markers as it came', () => {
  const { dir, home } = seedRepo();
  const res = smudge(dir, home, 'AGENTS.md', '# Plain file\n');
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(res.stdout, '# Plain file\n');
});

run('the smudge leaves the blob as it came when the state cannot be read', () => {
  const { dir, home, skeleton } = seedRepo();
  fs.writeFileSync(stateFileFor(home, dir), UNREADABLE_STATE);
  const res = smudge(dir, home, 'AGENTS.md', skeleton);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(res.stdout, skeleton);
  assert.strictEqual(res.stderr, '');
});

run('the smudge writes the llms.txt shape for llms.txt', () => {
  const { dir, home } = seedRepo();
  const res = smudge(dir, home, 'llms.txt', BARE_LLMS_SKELETON);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes('# EGC Project Memory\n\ncontext kept in the local state'), res.stdout);
  assert.ok(res.stdout.includes('## Next session\n- next step kept in the local state'), res.stdout);
  assert.ok(!res.stdout.includes('**Context:**'), 'llms.txt carries no bold headings');
});

run('a checkout through the configured filter brings the memory back and the file reads as unmodified', () => {
  const { dir, git } = seedRepo();
  const plan = configureMemoryFilters({ projectDir: dir, scriptPath: SCRIPT, dryRun: false });
  assert.strictEqual(plan.configured, true, JSON.stringify(plan));
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agents\n');
  git('checkout', '--', 'AGENTS.md');
  const restored = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.ok(restored.includes('**Context:** context kept in the local state'), restored);
  assert.ok(restored.startsWith('# Agents\n'), restored);
  assert.strictEqual(git('status', '--porcelain', '--', 'AGENTS.md'), '', 'the smudged file is the committed blob to git');
  // A stash round trip: the clean side stores the zeroed blob and the
  // smudge side brings the memory back with it.
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), `${restored}\nA local note.\n`);
  git('stash', '-q');
  assert.ok(!fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8').includes('A local note.'), 'the stash took the change');
  git('stash', 'pop', '-q');
  const popped = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.ok(popped.includes('A local note.'), popped);
  assert.ok(popped.includes('**Context:** context kept in the local state'), popped);
});

run('a checkout goes on when the smudge cannot rebuild the block', () => {
  const { dir, home, skeleton, git } = seedRepo();
  configureMemoryFilters({ projectDir: dir, scriptPath: SCRIPT, dryRun: false });
  fs.writeFileSync(stateFileFor(home, dir), UNREADABLE_STATE);
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agents\n');
  assert.doesNotThrow(() => git('checkout', '--', 'AGENTS.md'), 'the checkout must not fail on the filter');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), skeleton);
});

run('the filter runs from a repository whose path carries spaces', () => {
  const { dir, git } = seedRepo('egc leak test ');
  assert.ok(dir.includes(' '), dir);
  configureMemoryFilters({ projectDir: dir, scriptPath: SCRIPT, dryRun: false });
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agents\n');
  git('checkout', '--', 'AGENTS.md');
  const restored = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.ok(restored.includes('**Context:** context kept in the local state'), restored);
  assert.strictEqual(git('status', '--porcelain', '--', 'AGENTS.md'), '');
});

run('the text of a marker in the memory never travels inside the block', () => {
  const { dir, home, skeleton } = seedRepo();
  fs.writeFileSync(stateFileFor(home, dir), STATE.replace('- decision kept in the local state', '- a decision that quotes <!-- egc:end --> in its text'));
  const res = smudge(dir, home, 'AGENTS.md', skeleton);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes('- a decision that quotes  in its text'), res.stdout);
  assert.strictEqual((res.stdout.match(/<!-- egc:end -->/g) || []).length, 1, 'one end marker');
  assert.strictEqual(clean(dir, res.stdout), skeleton, 'the clean side takes it back to the committed blob');
});

run('a linked worktree gets the block of its own branch', () => {
  const { dir, home, git } = seedRepo();
  configureMemoryFilters({ projectDir: dir, scriptPath: SCRIPT, dryRun: false });
  const worktree = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
  TEMP_DIRS.push(worktree);
  git('worktree', 'add', '-q', '-b', 'other', worktree);
  const gitWt = (...args) => execFileSync('git', args, { cwd: worktree, encoding: 'utf8', env: withHome(home) });
  assert.strictEqual(detectBranch(worktree), 'other');
  fs.writeFileSync(stateFileFor(home, worktree), STATE.replace('context kept in the local state', 'context of the other branch'));
  fs.writeFileSync(path.join(worktree, 'AGENTS.md'), '# Agents\n');
  gitWt('checkout', '--', 'AGENTS.md');
  const restored = fs.readFileSync(path.join(worktree, 'AGENTS.md'), 'utf8');
  assert.ok(restored.includes('**Context:** context of the other branch'), restored);
  assert.strictEqual(gitWt('status', '--porcelain', '--', 'AGENTS.md'), '');
});

run('a branch switch keeps a block in the rewritten file, and the next propagation makes it the branch\'s own', () => {
  const { dir, home, skeleton, git } = seedRepo();
  configureMemoryFilters({ projectDir: dir, scriptPath: SCRIPT, dryRun: false });
  git('switch', '-q', '-c', 'other');
  fs.writeFileSync(stateFileFor(home, dir), STATE.replace('context kept in the local state', 'context of the other branch'));
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), `${skeleton}\nA line the other branch adds.\n`);
  git('add', 'AGENTS.md');
  git('commit', '-q', '-m', 'other', '--no-verify');
  git('switch', '-q', '-');
  const back = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.ok(!back.includes('A line the other branch adds.'), back);
  assert.ok(back.includes('**Context:** context'), 'a block is in the file after the switch');
  assert.ok(!back.includes('egc:state-updated'), back);
  assert.strictEqual(git('status', '--porcelain', '--', 'AGENTS.md'), '');
  propagateStateContent(dir, STATE);
  assert.ok(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8').includes('**Context:** context kept in the local state'));
  git('switch', '-q', 'other');
  const forth = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.ok(forth.includes('A line the other branch adds.'), forth);
  assert.ok(forth.includes('**Context:** context'), forth);
});

const LLMS_POPULATED = [
  '<!-- egc:start -->',
  '<!-- egc:state-updated:2026-07-18T05:15:28.038Z -->',
  '# EGC Project Memory',
  '',
  'secret local context that must never ship.',
  '',
  '## Next session',
  '- private next step',
  '',
  '## EGC Natural Language Interface',
  '<!-- egc:end -->',
  '',
].join('\n');

run('llms.txt: the clean side zeroes the plain shape and keeps the heading and the triggers', () => {
  const { dir, git } = makeRepo();
  const file = path.join(dir, 'llms.txt');
  fs.writeFileSync(file, LLMS_POPULATED);
  const cleanRes = runScript(dir, '--clean', 'llms.txt');
  assert.strictEqual(cleanRes.status, 0, cleanRes.stderr);
  const cleaned = fs.readFileSync(file, 'utf8');
  assert.ok(cleaned.includes('# EGC Project Memory'), cleaned);
  assert.ok(cleaned.includes('## EGC Natural Language Interface'), cleaned);
  assert.ok(!cleaned.includes('secret local context'), cleaned);
  assert.ok(!cleaned.includes('private next step'), cleaned);
  assert.ok(!cleaned.includes('## Next session'), cleaned);
  assert.ok(!cleaned.includes('state-updated'), cleaned);
  git('add', 'llms.txt');
  assert.strictEqual(runScript(dir, '--staged').status, 0);
});

run('llms.txt: a staged populated file is blocked', () => {
  const { dir, git } = makeRepo();
  fs.writeFileSync(path.join(dir, 'llms.txt'), LLMS_POPULATED);
  git('add', 'llms.txt');
  const res = runScript(dir, '--staged');
  assert.strictEqual(res.status, 1, res.stderr);
  assert.ok(res.stderr.includes('llms.txt'), res.stderr);
});

run('the clean of a smudged context file gives the committed skeleton back, triggers dropped', () => {
  const { dir, home } = seedRepo('egc-leak-round-');
  const smudged = smudge(dir, home, 'AGENTS.md', BARE_SKELETON).stdout;
  assert.ok(smudged.includes('## EGC Natural Language Interface'), 'the smudge writes the triggers into the block');
  const skeleton = clean(dir, smudged);
  assert.ok(!skeleton.includes('Natural Language Interface'), skeleton);
  assert.ok(skeleton.includes('## EGC Project Memory') && skeleton.includes('_Machine-generated'), skeleton);
  assert.strictEqual(clean(dir, smudge(dir, home, 'AGENTS.md', skeleton).stdout), skeleton);
});

run('the clean side keeps bytes that are not UTF-8 as they came, outside the block', () => {
  const input = Buffer.from('# A\n\xff\xfe tail\n<!-- egc:start -->\n## EGC Project Memory\n**Context:** secret\n<!-- egc:end -->\n', 'latin1');
  const out = spawnSync('node', [SCRIPT, '--filter-clean'], { input }).stdout;
  assert.ok(out.subarray(0, 12).equals(input.subarray(0, 12)), out.toString('latin1'));
  assert.ok(!out.toString('latin1').includes('secret'), out.toString('latin1'));
});

run('the smudge leaves bytes that are not UTF-8 untouched', () => {
  const { dir, home } = seedRepo();
  const bytes = Buffer.from([0xff, 0xfe, 0x41, 0x0a]);
  const res = spawnSync('node', [SCRIPT, '--filter-smudge', 'AGENTS.md'], { cwd: dir, input: bytes, env: withHome(home) });
  assert.strictEqual(res.status, 0, String(res.stderr));
  assert.ok(res.stdout.equals(bytes), 'bytes must go out as they came');
});

run('the smudge goes out without an update stamp, so the next propagation replaces the block', () => {
  const { dir, home, skeleton } = seedRepo();
  const smudged = smudge(dir, home, 'AGENTS.md', skeleton).stdout;
  assert.ok(!smudged.includes('egc:state-updated'), smudged);
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), smudged);
  propagateStateContent(dir, STATE.replace('context kept in the local state', 'context written by the next propagation'));
  const after = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.ok(after.includes('**Context:** context written by the next propagation'), after);
});

run('a checkout goes on when the smudge script is gone', () => {
  const { dir, skeleton, git } = seedRepo();
  const scriptCopy = path.join(tempDir('egc-leak-script-'), 'check-state-leak.js');
  fs.copyFileSync(SCRIPT, scriptCopy);
  configureMemoryFilters({ projectDir: dir, scriptPath: scriptCopy, dryRun: false });
  fs.rmSync(scriptCopy);
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agents\n');
  assert.doesNotThrow(() => git('checkout', '--', 'AGENTS.md'), 'the checkout must not fail on a missing script');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), skeleton);
});

if (process.platform !== 'win32') {
  run('the smudge leaves the blob as it came when the state is a link', () => {
    const { dir, home, skeleton } = seedRepo();
    const stateFile = stateFileFor(home, dir);
    const target = path.join(path.dirname(stateFile), 'elsewhere.md');
    fs.renameSync(stateFile, target);
    fs.symlinkSync(target, stateFile);
    const res = smudge(dir, home, 'AGENTS.md', skeleton);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.strictEqual(res.stdout, skeleton);
  });
}

run('the clean side reads a file with CRLF line breaks and keeps them', () => {
  const { dir } = makeRepo();
  const crlf = POPULATED.replaceAll('\n', '\r\n');
  const out = clean(dir, crlf);
  assert.ok(!out.includes('state-updated'), out);
  assert.ok(!out.includes('secret local context'), out);
  assert.ok(!out.includes('private decision'), out);
  assert.ok(out.includes('## EGC Project Memory\r\n'), 'the heading keeps its CRLF');
  assert.ok(!/(^|[^\r])\n/.test(out), 'no bare LF is introduced');
});

run('a checkout under autocrlf brings the block back with the file\'s line breaks', () => {
  const { dir, git } = seedRepo();
  configureMemoryFilters({ projectDir: dir, scriptPath: SCRIPT, dryRun: false });
  git('config', 'core.autocrlf', 'true');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agents\n');
  git('checkout', '--', 'AGENTS.md');
  const restored = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.ok(restored.includes('**Context:** context kept in the local state'), restored);
  assert.ok(restored.includes('\r\n'), 'the checkout wrote CRLF');
  assert.ok(!/(^|[^\r])\n/.test(restored), 'every line break of the file is CRLF, the block included');
  assert.strictEqual(git('status', '--porcelain', '--', 'AGENTS.md'), '');
});

run('llms.txt: a context paragraph that ends the block leaves both markers in place', () => {
  const { dir } = makeRepo();
  const shape = ['<!-- egc:start -->', '# EGC Project Memory', '', 'secret local context that must never ship.', '<!-- egc:end -->', ''].join('\n');
  const out = clean(dir, shape);
  assert.ok(!out.includes('secret local context'), out);
  assert.ok(out.includes('<!-- egc:start -->') && out.includes('<!-- egc:end -->'), 'both markers stay');
  assert.ok(out.includes('# EGC Project Memory'), out);
});

run('llms.txt: a heading right after the context paragraph stays', () => {
  const { dir } = makeRepo();
  const shape = ['<!-- egc:start -->', '# EGC Project Memory', '', 'secret local context that must never ship.', '## EGC Natural Language Interface', 'Detect user intent.', '<!-- egc:end -->', ''].join('\n');
  const out = clean(dir, shape);
  assert.ok(!out.includes('secret local context'), out);
  assert.ok(out.includes('## EGC Natural Language Interface\nDetect user intent.'), 'the heading and what follows it stay');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
