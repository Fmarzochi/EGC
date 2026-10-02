/**
 * Tests for scripts/hooks/pre-write-guardian-validate.js via run-with-flags.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const runner = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'run-with-flags.js');
const fakeCli = path.join(__dirname, '..', 'fixtures', 'fake-guardian-cli.js');

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

function runHook(filePath, env = {}, toolInput = null, toolName = 'Write', cwd = null) {
  const rawInput = JSON.stringify({ tool_name: toolName, tool_input: toolInput || { file_path: filePath, content: 'x' }, ...(cwd ? { cwd } : {}) });
  const result = spawnSync('node', [runner, 'pre:write-guardian-validate', 'scripts/hooks/pre-write-guardian-validate.js', 'minimal,standard,strict'], {
    input: rawInput,
    encoding: 'utf8',
    env: {
      ...process.env,
      ECC_HOOK_PROFILE: 'standard',
      EGC_GUARDIAN_CLI: fakeCli,
      ...env
    },
    timeout: 15000,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  return {
    code: Number.isInteger(result.status) ? result.status : 1,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

// S4036: prefer fixed git locations over a PATH lookup, as session-end.js
// does; the bare name is the last resort for layouts like nix or portable Git.
const GIT_BIN = [
  '/usr/bin/git',
  '/usr/local/bin/git',
  '/opt/homebrew/bin/git',
  String.raw`C:\Program Files\Git\cmd\git.exe`,
].find(candidate => fs.existsSync(candidate)) || 'git';

// A throwaway repository with `script` committed as run.sh (or, with null,
// only a README committed), isolated from the machine's git configuration.
function withCommittedScript(script, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-write-head-'));
  try {
    const emptyConfig = path.join(dir, '.gitconfig-empty');
    fs.writeFileSync(emptyConfig, '');
    const env = { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' };
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    const git = (...args) => spawnSync(GIT_BIN, ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { env, encoding: 'utf8' });
    git('init', '-q');
    const file = path.join(repo, 'run.sh');
    const seeded = script === null ? path.join(repo, 'README.md') : file;
    fs.writeFileSync(seeded, script === null ? 'x\n' : script);
    git('add', path.basename(seeded));
    assert.strictEqual(git('commit', '-q', '-m', 'seed').status, 0, 'seed commit');
    return fn(file, repo);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// What is already in the commit at HEAD went through review and is not judged
// again when the file is written; everything else is.
function runCommittedScriptTests(wipe) {
  let passed = 0;
  let failed = 0;
  const tally = ok => { if (ok) passed++; else failed++; };

  tally(test('an edit of a committed script is judged only on what it changes', () => {
    withCommittedScript(`#!/bin/sh\necho start\n${wipe} "$PID_FILE"\n`, file => {
      const result = runHook(file, {}, { file_path: file, old_string: 'echo start', new_string: 'echo begin' }, 'Edit');
      assert.strictEqual(result.code, 0, result.stderr);
    });
  }));

  tally(test('a whole rewrite of a committed script keeps its committed commands, and judges a new one', () => {
    withCommittedScript(`#!/bin/sh\necho start\n${wipe} "$PID_FILE"\n`, file => {
      const same = runHook(file, {}, { file_path: file, content: `#!/bin/sh\necho begin\n${wipe} "$PID_FILE"\n` });
      assert.strictEqual(same.code, 0, same.stderr);
      const added = runHook(file, {}, { file_path: file, content: `#!/bin/sh\necho begin\n${wipe} "$PID_FILE"\n${wipe} /tmp/egc-victim\n` });
      assert.strictEqual(added.code, 2, added.stderr);
    });
  }));

  tally(test('a committed script checked out with CRLF line endings keeps its committed commands', () => {
    withCommittedScript(`#!/bin/sh\necho start\n${wipe} "$PID_FILE"\n`, file => {
      fs.writeFileSync(file, `#!/bin/sh\r\necho start\r\n${wipe} "$PID_FILE"\r\n`);
      const result = runHook(file, {}, { file_path: file, old_string: 'echo start', new_string: 'echo begin' }, 'Edit');
      assert.strictEqual(result.code, 0, result.stderr);
    });
  }));

  tally(test('a carriage return a write puts inside a committed command makes it a new one', () => {
    withCommittedScript(`#!/bin/sh\necho start\n${wipe} "$PID_FILE"\n`, file => {
      const result = runHook(file, {}, { file_path: file, old_string: `${wipe} "$PID_FILE"`, new_string: `${wipe} "$PID\r_FILE"` }, 'Edit');
      assert.strictEqual(result.code, 2, result.stderr);
    });
  }));

  tally(test('a second copy of a committed denied command is judged', () => {
    withCommittedScript(`#!/bin/sh\necho start\n${wipe} "$PID_FILE"\n`, file => {
      const result = runHook(file, {}, { file_path: file, old_string: 'echo start', new_string: `${wipe} "$PID_FILE"` }, 'Edit');
      assert.strictEqual(result.code, 2, result.stderr);
    });
  }));

  tally(test('a denied command that reached the script without a commit is judged', () => {
    withCommittedScript('#!/bin/sh\necho start\n', file => {
      fs.appendFileSync(file, `${wipe} /tmp/egc-victim\n`);
      const result = runHook(file, {}, { file_path: file, old_string: 'echo start', new_string: 'echo begin' }, 'Edit');
      assert.strictEqual(result.code, 2, result.stderr);
    });
  }));

  tally(test('a script the repository never committed is judged whole', () => {
    withCommittedScript(null, (file, repo) => {
      fs.writeFileSync(file, `#!/bin/sh\necho start\n${wipe} /tmp/egc-victim\n`);
      const result = runHook(file, {}, { file_path: file, old_string: 'echo start', new_string: 'echo begin' }, 'Edit', repo);
      assert.strictEqual(result.code, 2, result.stderr);
    });
  }));

  return { passed, failed };
}

function runTests() {
  console.log('\n=== Testing pre-write-guardian-validate ===\n');

  let passed = 0;
  let failed = 0;

  if (test('blocks writes to protected credential paths', () => {
    const result = runHook(path.join(os.homedir(), '.ssh', 'id_rsa'));
    assert.strictEqual(result.code, 2, 'Expected protected write to be blocked');
    assert.ok(result.stderr.includes('protected'), `Expected reason, got: ${result.stderr}`);
  })) passed++; else failed++;

  if (test('blocks writes to key files by pattern', () => {
    const result = runHook('/tmp/deploy.pem');
    assert.strictEqual(result.code, 2, 'Expected key file write to be blocked');
  })) passed++; else failed++;

  if (test('allows writes to normal project paths', () => {
    const result = runHook('/tmp/egc-test-output.txt');
    assert.strictEqual(result.code, 0, `Expected allow, got: ${result.stderr}`);
  })) passed++; else failed++;

  // Harnesses name the write target differently; a protected path must be
  // caught whether it arrives as file_path, path (Gemini CLI) or TargetFile
  // (Antigravity).
  function runHookField(field, filePath) {
    const rawInput = JSON.stringify({ tool_name: 'Write', tool_input: { [field]: filePath, content: 'x' } });
    const result = spawnSync('node', [runner, 'pre:write-guardian-validate', 'scripts/hooks/pre-write-guardian-validate.js', 'minimal,standard,strict'], {
      input: rawInput,
      encoding: 'utf8',
      env: { ...process.env, ECC_HOOK_PROFILE: 'standard', EGC_GUARDIAN_CLI: fakeCli },
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return Number.isInteger(result.status) ? result.status : 1;
  }

  if (test('blocks a protected write arriving via the path field', () => {
    const code = runHookField('path', path.join(os.homedir(), '.ssh', 'id_rsa'));
    assert.strictEqual(code, 2, 'Expected block when the target arrives as path');
  })) passed++; else failed++;

  if (test('blocks a protected write arriving via the TargetFile field', () => {
    const code = runHookField('TargetFile', path.join(os.homedir(), '.aws', 'credentials'));
    assert.strictEqual(code, 2, 'Expected block when the target arrives as TargetFile');
  })) passed++; else failed++;

  if (test('blocks the write when the validator gives no verdict, and says why', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-broken-cli-'));
    try {
      for (const [body, why] of [
        ['process.exit(1);\n', /stopped with exit code 1/],
        ['process.stdout.write("not json");\n', /not JSON/],
        ['process.stdout.write("{}");\n', /not a verdict/],
      ]) {
        const brokenCli = path.join(dir, `cli-${why.source.length}.js`);
        fs.writeFileSync(brokenCli, body);
        const result = runHook(path.join(os.tmpdir(), 'egc-notes.txt'), { EGC_GUARDIAN_CLI: brokenCli });
        assert.strictEqual(result.code, 2, `${body}: ${result.stderr}`);
        assert.match(result.stderr, /could not validate this write/);
        assert.match(result.stderr, why);
      }
      const listCli = path.join(dir, 'cli-list.js');
      fs.writeFileSync(listCli, 'const a = process.argv[2]; process.stdout.write(a === "write" ? JSON.stringify({ allowed: true }) : "[]");\n');
      const script = runHook('/tmp/egc-script.sh', { EGC_GUARDIAN_CLI: listCli }, { file_path: '/tmp/egc-script.sh', content: '#!/bin/bash\necho a\n' });
      assert.strictEqual(script.code, 2, script.stderr);
      assert.match(script.stderr, /not one verdict per command/);
      for (const entry of ['{}', 'null', '{"allowed":"yes"}', '"allowed"', '[]']) {
        const shapeCli = path.join(dir, `cli-shape-${entry.length}-${entry.charCodeAt(1)}.js`);
        fs.writeFileSync(shapeCli, `const a = process.argv[2]; process.stdout.write(a === "write" ? JSON.stringify({ allowed: true }) : ${JSON.stringify(`[${entry}]`)});\n`);
        const shaped = runHook('/tmp/egc-script.sh', { EGC_GUARDIAN_CLI: shapeCli }, { file_path: '/tmp/egc-script.sh', content: '#!/bin/bash\necho a\n' });
        assert.strictEqual(shaped.code, 2, `[${entry}]: ${shaped.stderr}`);
        assert.match(shaped.stderr, /could not validate this write/, `[${entry}]`);
      }
      const batchCrashCli = path.join(dir, 'cli-batch-crash.js');
      fs.writeFileSync(batchCrashCli, 'if (process.argv[2] === "write") process.stdout.write(JSON.stringify({ allowed: true })); else process.exit(3);\n');
      const crashed = runHook('/tmp/egc-script.sh', { EGC_GUARDIAN_CLI: batchCrashCli }, { file_path: '/tmp/egc-script.sh', content: '#!/bin/bash\necho a\n' });
      assert.strictEqual(crashed.code, 2, crashed.stderr);
      assert.match(crashed.stderr, /stopped with exit code 3/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  // Script content (security audit 2026-08-17, H3): judged with the Bash
  // hook's own segmentation and the same validator, through the fake CLI.
  const wipe = ['rm', '-rf'].join(' ');

  if (test('blocks writing a shell script whose line runs a denied command', () => {
    const result = runHook('/tmp/egc-script.sh', {}, { file_path: '/tmp/egc-script.sh', content: `#!/bin/bash\nset -e\necho start\n${wipe} /tmp/egc-victim\n` });
    assert.strictEqual(result.code, 2, result.stderr);
    assert.ok(result.stderr.includes('segment:'), result.stderr);
  })) passed++; else failed++;

  if (test('blocks an Edit that inserts a denied command into an existing script', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-write-hook-'));
    const script = path.join(dir, 'deploy.sh');
    try {
      fs.writeFileSync(script, '#!/bin/bash\necho ok\n');
      const result = runHook(script, {}, { file_path: script, old_string: 'echo ok', new_string: `echo ok && ${wipe} /tmp/egc-victim` }, 'Edit');
      assert.strictEqual(result.code, 2, result.stderr);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('blocks a MultiEdit whose edit targets a second script path', () => {
    const result = runHook('/tmp/notes.md', {}, {
      file_path: '/tmp/notes.md',
      edits: [
        { old_string: 'a', new_string: 'b' },
        { file_path: '/tmp/other.sh', old_string: 'echo ok', new_string: `${wipe} /tmp/egc-victim` },
      ],
    }, 'MultiEdit');
    assert.strictEqual(result.code, 2, result.stderr);
  })) passed++; else failed++;

  if (test('blocks a denied command hidden in a substitution or behind a shell keyword', () => {
    for (const content of [`#!/bin/sh\necho $(${wipe} /tmp/egc-victim)\n`, `#!/bin/sh\nif true; then ${wipe} /tmp/egc-victim; fi\n`, `#!/bin/sh\n(${wipe} /tmp/egc-victim)\n`]) {
      const result = runHook('/tmp/x.sh', {}, { file_path: '/tmp/x.sh', content });
      assert.strictEqual(result.code, 2, `${JSON.stringify(content)}: ${result.stderr}`);
    }
  })) passed++; else failed++;

  if (test('allows a script whose lines are benign, quoted, commented or merely outside the allowlist', () => {
    const content = `#!/usr/bin/env bash\n# ${wipe} / in a comment is not a command\ncargo build --release\necho "a; b | c && ${wipe} /"\nnpm test 2>&1\necho done\n`;
    const result = runHook('/tmp/build.sh', {}, { file_path: '/tmp/build.sh', content });
    assert.strictEqual(result.code, 0, result.stderr);
  })) passed++; else failed++;

  if (test('does not judge non-shell content as commands', () => {
    for (const [file, content] of [['/tmp/notes.md', `${wipe} / is a dangerous command, never run it\n`], ['/tmp/clean.ps1', 'Remove-Item -Recurse -Force C:\\tmp\\x\n'], ['/tmp/tool.py', `import os\nos.system("${wipe} /tmp/x")\n`]]) {
      const result = runHook(file, {}, { file_path: file, content });
      assert.strictEqual(result.code, 0, `${file}: ${result.stderr}`);
    }
  })) passed++; else failed++;

  if (test('resolves a relative Edit target against the hook cwd before judging the resulting script', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-write-cwd-'));
    try {
      fs.writeFileSync(path.join(dir, 'deploy.sh'), `#!/bin/bash\necho start\n${wipe} /tmp/egc-victim\n`);
      const result = runHook('deploy.sh', {}, { file_path: 'deploy.sh', old_string: 'echo start', new_string: 'echo begin' }, 'Edit', dir);
      assert.strictEqual(result.code, 2, JSON.stringify(result));
      assert.ok(result.stderr.includes('runs a denied command'), result.stderr);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('expands a home-relative target against the home directory before judging the resulting script', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-write-home-'));
    const wipe = ['rm', '-rf'].join(' ');
    try {
      fs.writeFileSync(path.join(home, 'deploy.sh'), `#!/bin/bash\necho start\n${wipe} /tmp/egc-victim\n`);
      const env = { HOME: home, USERPROFILE: home };
      const edit = { file_path: '~/deploy.sh', old_string: 'echo start', new_string: 'echo begin' };
      const result = runHook('~/deploy.sh', env, edit, 'Edit', os.tmpdir());
      assert.strictEqual(result.code, 2, JSON.stringify(result));
      assert.ok(result.stderr.includes('runs a denied command'), result.stderr);
      const elsewhere = runHook('~/notes.txt', env, { file_path: '~/notes.txt', content: 'plain notes' }, 'Write', os.tmpdir());
      assert.strictEqual(elsewhere.code, 0, JSON.stringify(elsewhere));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  })) passed++; else failed++;
  if (test('blocks a denied command carried by a function body or a case arm', () => {
    for (const content of [`#!/bin/bash\nfunction f() { ${wipe} /tmp/egc-victim; }\nf\n`, `#!/bin/sh\ncase "$1" in start) ${wipe} /tmp/egc-victim;; esac\n`, `#!/bin/sh\ncase "$1" in start) echo hi;; stop) ${wipe} /tmp/egc-victim;; esac\n`, `#!/bin/bash\ncoproc ${wipe} /tmp/egc-victim\n`, `#!/bin/bash\ncoproc worker { ${wipe} /tmp/egc-victim; }\n`]) {
      const result = runHook('/tmp/egc-carrier.sh', {}, { file_path: '/tmp/egc-carrier.sh', content });
      assert.strictEqual(result.code, 2, `${JSON.stringify(content)}: ${result.stderr}`);
    }
  })) passed++; else failed++;

  const committed = runCommittedScriptTests(wipe);
  passed += committed.passed;
  failed += committed.failed;

  if (test('passes through input without a file path', () => {
    const rawInput = JSON.stringify({ tool_name: 'Write', tool_input: {} });
    const result = spawnSync('node', [runner, 'pre:write-guardian-validate', 'scripts/hooks/pre-write-guardian-validate.js', 'minimal,standard,strict'], {
      input: rawInput,
      encoding: 'utf8',
      env: { ...process.env, ECC_HOOK_PROFILE: 'standard', EGC_GUARDIAN_CLI: fakeCli },
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    assert.strictEqual(result.status, 0, 'Expected pass for missing file path');
    assert.strictEqual(result.stdout, rawInput, 'Expected raw passthrough');
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
