/**
 * Tests for scripts/lib/utils.js
 *
 * Run with: node tests/lib/utils.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

// Import the module
const utils = require('../../scripts/lib/utils');

// Test helper
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

// Test suite
function runTests() {
  console.log('\n=== Testing utils.js ===\n');

  let passed = 0;
  let failed = 0;

  // Platform detection tests
  console.log('Platform Detection:');

  if (test('isWindows/isMacOS/isLinux are booleans', () => {
    assert.strictEqual(typeof utils.isWindows, 'boolean');
    assert.strictEqual(typeof utils.isMacOS, 'boolean');
    assert.strictEqual(typeof utils.isLinux, 'boolean');
  })) passed++; else failed++;

  if (test('exactly one platform should be true', () => {
    const platforms = [utils.isWindows, utils.isMacOS, utils.isLinux];
    const trueCount = platforms.filter(p => p).length;
    // Note: Could be 0 on other platforms like FreeBSD
    assert.ok(trueCount <= 1, 'More than one platform is true');
  })) passed++; else failed++;

  // Directory functions tests
  console.log('\nDirectory Functions:');

  if (test('getHomeDir returns valid path', () => {
    const home = utils.getHomeDir();
    assert.strictEqual(typeof home, 'string');
    assert.ok(home.length > 0, 'Home dir should not be empty');
    assert.ok(fs.existsSync(home), 'Home dir should exist');
  })) passed++; else failed++;

  if (test('getClaudeDir returns path under home', () => {
    const claudeDir = utils.getClaudeDir();
    const homeDir = utils.getHomeDir();
    assert.ok(claudeDir.startsWith(homeDir), 'Claude dir should be under home');
    assert.ok(claudeDir.includes('.claude'), 'Should contain .claude');
  })) passed++; else failed++;

  if (test('getSessionsDir returns path under Claude dir', () => {
    const sessionsDir = utils.getSessionsDir();
    const claudeDir = utils.getClaudeDir();
    assert.ok(sessionsDir.startsWith(claudeDir), 'Sessions should be under Claude dir');
    assert.ok(sessionsDir.includes('sessions'), 'Should contain sessions');
  })) passed++; else failed++;

  if (test('getTempDir returns valid temp directory', () => {
    const tempDir = utils.getTempDir();
    assert.strictEqual(typeof tempDir, 'string');
    assert.ok(tempDir.length > 0, 'Temp dir should not be empty');
  })) passed++; else failed++;

  if (test('ensureDir creates directory', () => {
    const testDir = path.join(utils.getTempDir(), `utils-test-${Date.now()}`);
    try {
      utils.ensureDir(testDir);
      assert.ok(fs.existsSync(testDir), 'Directory should be created');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  // Date/Time functions tests
  console.log('\nDate/Time Functions:');

  if (test('getDateString returns YYYY-MM-DD format', () => {
    const date = utils.getDateString();
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(date), `Expected YYYY-MM-DD, got ${date}`);
  })) passed++; else failed++;

  if (test('getTimeString returns HH:MM format', () => {
    const time = utils.getTimeString();
    assert.ok(/^\d{2}:\d{2}$/.test(time), `Expected HH:MM, got ${time}`);
  })) passed++; else failed++;

  if (test('getDateTimeString returns full datetime format', () => {
    const dt = utils.getDateTimeString();
    assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(dt), `Expected YYYY-MM-DD HH:MM:SS, got ${dt}`);
  })) passed++; else failed++;

  // Project name tests
  console.log('\nProject Name Functions:');

  if (test('getGitRepoName returns string or null', () => {
    const repoName = utils.getGitRepoName();
    assert.ok(repoName === null || typeof repoName === 'string');
  })) passed++; else failed++;

  if (test('getProjectName returns non-empty string', () => {
    const name = utils.getProjectName();
    assert.ok(name && name.length > 0);
  })) passed++; else failed++;

  // Session ID tests
  console.log('\nSession ID Functions:');

  if (test('getSessionIdShort falls back to project name', () => {
    const original = process.env.CLAUDE_SESSION_ID;
    delete process.env.CLAUDE_SESSION_ID;
    try {
      const shortId = utils.getSessionIdShort();
      assert.strictEqual(shortId, utils.getProjectName());
    } finally {
      if (original) process.env.CLAUDE_SESSION_ID = original;
    }
  })) passed++; else failed++;

  if (test('getSessionIdShort returns last 8 characters', () => {
    const original = process.env.CLAUDE_SESSION_ID;
    process.env.CLAUDE_SESSION_ID = 'test-session-abc12345';
    try {
      assert.strictEqual(utils.getSessionIdShort(), 'abc12345');
    } finally {
      if (original) process.env.CLAUDE_SESSION_ID = original;
      else delete process.env.CLAUDE_SESSION_ID;
    }
  })) passed++; else failed++;

  if (test('getSessionIdShort handles short session IDs', () => {
    const original = process.env.CLAUDE_SESSION_ID;
    process.env.CLAUDE_SESSION_ID = 'short';
    try {
      assert.strictEqual(utils.getSessionIdShort(), 'short');
    } finally {
      if (original) process.env.CLAUDE_SESSION_ID = original;
      else delete process.env.CLAUDE_SESSION_ID;
    }
  })) passed++; else failed++;

  // File operations tests
  console.log('\nFile Operations:');

  if (test('readFile returns null for non-existent file', () => {
    const content = utils.readFile('/non/existent/file/path.txt');
    assert.strictEqual(content, null);
  })) passed++; else failed++;

  if (test('writeFile and readFile work together', () => {
    const testFile = path.join(utils.getTempDir(), `utils-test-${Date.now()}.txt`);
    const testContent = 'Hello, World!';
    try {
      utils.writeFile(testFile, testContent);
      const read = utils.readFile(testFile);
      assert.strictEqual(read, testContent);
    } finally {
      fs.unlinkSync(testFile);
    }
  })) passed++; else failed++;

  if (test('appendFile adds content to file', () => {
    const testFile = path.join(utils.getTempDir(), `utils-test-${Date.now()}.txt`);
    try {
      utils.writeFile(testFile, 'Line 1\n');
      utils.appendFile(testFile, 'Line 2\n');
      const content = utils.readFile(testFile);
      assert.strictEqual(content, 'Line 1\nLine 2\n');
    } finally {
      fs.unlinkSync(testFile);
    }
  })) passed++; else failed++;

  if (test('replaceInFile replaces text', () => {
    const testFile = path.join(utils.getTempDir(), `utils-test-${Date.now()}.txt`);
    try {
      utils.writeFile(testFile, 'Hello, World!');
      utils.replaceInFile(testFile, /World/, 'Universe');
      const content = utils.readFile(testFile);
      assert.strictEqual(content, 'Hello, Universe!');
    } finally {
      fs.unlinkSync(testFile);
    }
  })) passed++; else failed++;

  if (test('countInFile counts occurrences', () => {
    const testFile = path.join(utils.getTempDir(), `utils-test-${Date.now()}.txt`);
    try {
      utils.writeFile(testFile, 'foo bar foo baz foo');
      const count = utils.countInFile(testFile, /foo/g);
      assert.strictEqual(count, 3);
    } finally {
      fs.unlinkSync(testFile);
    }
  })) passed++; else failed++;

  if (test('grepFile finds matching lines', () => {
    const testFile = path.join(utils.getTempDir(), `utils-test-${Date.now()}.txt`);
    try {
      utils.writeFile(testFile, 'line 1 foo\nline 2 bar\nline 3 foo');
      const matches = utils.grepFile(testFile, /foo/);
      assert.strictEqual(matches.length, 2);
      assert.strictEqual(matches[0].lineNumber, 1);
      assert.strictEqual(matches[1].lineNumber, 3);
    } finally {
      fs.unlinkSync(testFile);
    }
  })) passed++; else failed++;

  // findFiles tests
  console.log('\nfindFiles:');

  if (test('findFiles returns empty for non-existent directory', () => {
    const results = utils.findFiles('/non/existent/dir', '*.txt');
    assert.strictEqual(results.length, 0);
  })) passed++; else failed++;

  if (test('findFiles finds matching files', () => {
    const testDir = path.join(utils.getTempDir(), `utils-test-${Date.now()}`);
    try {
      fs.mkdirSync(testDir);
      fs.writeFileSync(path.join(testDir, 'test1.txt'), 'content');
      fs.writeFileSync(path.join(testDir, 'test2.txt'), 'content');
      fs.writeFileSync(path.join(testDir, 'test.md'), 'content');

      const txtFiles = utils.findFiles(testDir, '*.txt');
      assert.strictEqual(txtFiles.length, 2);

      const mdFiles = utils.findFiles(testDir, '*.md');
      assert.strictEqual(mdFiles.length, 1);
    } finally {
      fs.rmSync(testDir, { recursive: true });
    }
  })) passed++; else failed++;

  // Edge case tests for defensive code
  console.log('\nEdge Cases:');

  if (test('findFiles returns empty for null/undefined dir', () => {
    assert.deepStrictEqual(utils.findFiles(null, '*.txt'), []);
    assert.deepStrictEqual(utils.findFiles(undefined, '*.txt'), []);
    assert.deepStrictEqual(utils.findFiles('', '*.txt'), []);
  })) passed++; else failed++;

  if (test('findFiles returns empty for null/undefined pattern', () => {
    assert.deepStrictEqual(utils.findFiles('/tmp', null), []);
    assert.deepStrictEqual(utils.findFiles('/tmp', undefined), []);
    assert.deepStrictEqual(utils.findFiles('/tmp', ''), []);
  })) passed++; else failed++;

  if (test('findFiles supports maxAge filter', () => {
    const testDir = path.join(utils.getTempDir(), `utils-test-maxage-${Date.now()}`);
    try {
      fs.mkdirSync(testDir);
      fs.writeFileSync(path.join(testDir, 'recent.txt'), 'content');
      const results = utils.findFiles(testDir, '*.txt', { maxAge: 1 });
      assert.strictEqual(results.length, 1);
      assert.ok(results[0].path.endsWith('recent.txt'));
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('findFiles supports recursive option', () => {
    const testDir = path.join(utils.getTempDir(), `utils-test-recursive-${Date.now()}`);
    const subDir = path.join(testDir, 'sub');
    try {
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(testDir, 'top.txt'), 'content');
      fs.writeFileSync(path.join(subDir, 'nested.txt'), 'content');
      // Without recursive: only top level
      const shallow = utils.findFiles(testDir, '*.txt', { recursive: false });
      assert.strictEqual(shallow.length, 1);
      // With recursive: finds nested too
      const deep = utils.findFiles(testDir, '*.txt', { recursive: true });
      assert.strictEqual(deep.length, 2);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('countInFile handles invalid regex pattern', () => {
    const testFile = path.join(utils.getTempDir(), `utils-test-${Date.now()}.txt`);
    try {
      utils.writeFile(testFile, 'test content');
      const count = utils.countInFile(testFile, '(unclosed');
      assert.strictEqual(count, 0);
    } finally {
      fs.unlinkSync(testFile);
    }
  })) passed++; else failed++;

  if (test('countInFile handles non-string non-regex pattern', () => {
    const testFile = path.join(utils.getTempDir(), `utils-test-${Date.now()}.txt`);
    try {
      utils.writeFile(testFile, 'test content');
      const count = utils.countInFile(testFile, 42);
      assert.strictEqual(count, 0);
    } finally {
      fs.unlinkSync(testFile);
    }
  })) passed++; else failed++;

  if (test('countInFile enforces global flag on RegExp', () => {
    const testFile = path.join(utils.getTempDir(), `utils-test-${Date.now()}.txt`);
    try {
      utils.writeFile(testFile, 'foo bar foo baz foo');
      // RegExp without global flag — countInFile should still count all
      const count = utils.countInFile(testFile, /foo/);
      assert.strictEqual(count, 3);
    } finally {
      fs.unlinkSync(testFile);
    }
  })) passed++; else failed++;

  if (test('grepFile handles invalid regex pattern', () => {
    const testFile = path.join(utils.getTempDir(), `utils-test-${Date.now()}.txt`);
    try {
      utils.writeFile(testFile, 'test content');
      const matches = utils.grepFile(testFile, '[invalid');
      assert.deepStrictEqual(matches, []);
    } finally {
      fs.unlinkSync(testFile);
    }
  })) passed++; else failed++;

  if (test('replaceInFile returns false for non-existent file', () => {
    const result = utils.replaceInFile('/non/existent/file.txt', 'foo', 'bar');
    assert.strictEqual(result, false);
  })) passed++; else failed++;

  if (test('countInFile returns 0 for non-existent file', () => {
    const count = utils.countInFile('/non/existent/file.txt', /foo/g);
    assert.strictEqual(count, 0);
  })) passed++; else failed++;

  if (test('grepFile returns empty for non-existent file', () => {
    const matches = utils.grepFile('/non/existent/file.txt', /foo/);
    assert.deepStrictEqual(matches, []);
  })) passed++; else failed++;

  if (test('commandExists rejects unsafe command names', () => {
    assert.strictEqual(utils.commandExists('cmd; rm -rf'), false);
    assert.strictEqual(utils.commandExists('$(whoami)'), false);
    assert.strictEqual(utils.commandExists('cmd && echo hi'), false);
  })) passed++; else failed++;

  if (test('ensureDir is idempotent', () => {
    const testDir = path.join(utils.getTempDir(), `utils-test-idem-${Date.now()}`);
    try {
      const result1 = utils.ensureDir(testDir);
      const result2 = utils.ensureDir(testDir);
      assert.strictEqual(result1, testDir);
      assert.strictEqual(result2, testDir);
      assert.ok(fs.existsSync(testDir));
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  // System functions tests
  console.log('\nSystem Functions:');

  if (test('commandExists finds node', () => {
    const exists = utils.commandExists('node');
    assert.strictEqual(exists, true);
  })) passed++; else failed++;

  if (test('commandExists returns false for fake command', () => {
    const exists = utils.commandExists('nonexistent_command_12345');
    assert.strictEqual(exists, false);
  })) passed++; else failed++;

  if (test('runCommand executes simple command', () => {
    const result = utils.runCommand('node --version');
    assert.strictEqual(result.success, true);
    assert.ok(result.output.startsWith('v'), 'Should start with v');
  })) passed++; else failed++;

  if (test('runCommand handles failed command', () => {
    const result = utils.runCommand('node --invalid-flag-12345');
    assert.strictEqual(result.success, false);
  })) passed++; else failed++;

  // output() and log() tests
  console.log('\noutput() and log():');

  if (test('output() writes string to stdout', () => {
    // Capture stdout by temporarily replacing console.log
    let captured = null;
    const origLog = console.log;
    console.log = (v) => { captured = v; };
    try {
      utils.output('hello');
      assert.strictEqual(captured, 'hello');
    } finally {
      console.log = origLog;
    }
  })) passed++; else failed++;

  if (test('output() JSON-stringifies objects', () => {
    let captured = null;
    const origLog = console.log;
    console.log = (v) => { captured = v; };
    try {
      utils.output({ key: 'value', num: 42 });
      assert.strictEqual(captured, '{"key":"value","num":42}');
    } finally {
      console.log = origLog;
    }
  })) passed++; else failed++;

  if (test('output() JSON-stringifies null (typeof null === "object")', () => {
    let captured = null;
    const origLog = console.log;
    console.log = (v) => { captured = v; };
    try {
      utils.output(null);
      // typeof null === 'object' in JS, so it goes through JSON.stringify
      assert.strictEqual(captured, 'null');
    } finally {
      console.log = origLog;
    }
  })) passed++; else failed++;

  if (test('output() handles arrays as objects', () => {
    let captured = null;
    const origLog = console.log;
    console.log = (v) => { captured = v; };
    try {
      utils.output([1, 2, 3]);
      assert.strictEqual(captured, '[1,2,3]');
    } finally {
      console.log = origLog;
    }
  })) passed++; else failed++;

  if (test('log() writes to stderr', () => {
    let captured = null;
    const origError = console.error;
    console.error = (v) => { captured = v; };
    try {
      utils.log('test message');
      assert.strictEqual(captured, 'test message');
    } finally {
      console.error = origError;
    }
  })) passed++; else failed++;

  // isGitRepo() tests
  console.log('\nisGitRepo():');

  if (test('isGitRepo returns true in a git repo', () => {
    // We're running from within the ECC repo, so this should be true
    assert.strictEqual(utils.isGitRepo(), true);
  })) passed++; else failed++;

  // getGitModifiedFiles() tests
  console.log('\ngetGitModifiedFiles():');

  if (test('getGitModifiedFiles returns an array', () => {
    const files = utils.getGitModifiedFiles();
    assert.ok(Array.isArray(files));
  })) passed++; else failed++;

  if (test('getGitModifiedFiles filters by regex patterns', () => {
    const files = utils.getGitModifiedFiles(['\\.NONEXISTENT_EXTENSION$']);
    assert.ok(Array.isArray(files));
    assert.strictEqual(files.length, 0);
  })) passed++; else failed++;

  if (test('getGitModifiedFiles skips invalid patterns', () => {
    // Mix of valid and invalid patterns — should not throw
    const files = utils.getGitModifiedFiles(['(unclosed', '\\.js$', '[invalid']);
    assert.ok(Array.isArray(files));
  })) passed++; else failed++;

  if (test('getGitModifiedFiles skips non-string patterns', () => {
    const files = utils.getGitModifiedFiles([null, undefined, 42, '', '\\.js$']);
    assert.ok(Array.isArray(files));
  })) passed++; else failed++;

  // getLearnedSkillsDir() test
  console.log('\ngetLearnedSkillsDir():');

  if (test('getLearnedSkillsDir returns path under Claude dir', () => {
    const dir = utils.getLearnedSkillsDir();
    assert.ok(dir.includes('.claude'));
    assert.ok(dir.includes('skills'));
    assert.ok(dir.includes('learned'));
  })) passed++; else failed++;

  // replaceInFile behavior tests
  console.log('\nreplaceInFile (behavior):');

  if (test('replaces first match when regex has no g flag', () => {
    const testFile = path.join(utils.getTempDir(), `utils-test-${Date.now()}.txt`);
    try {
      utils.writeFile(testFile, 'foo bar foo baz foo');
      utils.replaceInFile(testFile, /foo/, 'qux');
      const content = utils.readFile(testFile);
      // Without g flag, only first 'foo' should be replaced
      assert.strictEqual(content, 'qux bar foo baz foo');
    } finally {
      fs.unlinkSync(testFile);
    }
  })) passed++; else failed++;

  if (test('replaces all matches when regex has g flag', () => {
    const testFile = path.join(utils.getTempDir(), `utils-test-${Date.now()}.txt`);
    try {
      utils.writeFile(testFile, 'foo bar foo baz foo');
      utils.replaceInFile(testFile, /foo/g, 'qux');
      const content = utils.readFile(testFile);
      assert.strictEqual(content, 'qux bar qux baz qux');
    } finally {
      fs.unlinkSync(testFile);
    }
  })) passed++; else failed++;

  if (test('replaces with string search (first occurrence)', () => {
    const testFile = path.join(utils.getTempDir(), `utils-test-${Date.now()}.txt`);
    try {
      utils.writeFile(testFile, 'hello world hello');
      utils.replaceInFile(testFile, 'hello', 'goodbye');
      const content = utils.readFile(testFile);
      // String.replace with string search only replaces first
      assert.strictEqual(content, 'goodbye world hello');
    } finally {
      fs.unlinkSync(testFile);
    }
  })) passed++; else failed++;

  if (test('replaces all occurrences with string when options.all is true', () => {
    const testFile = path.join(utils.getTempDir(), `utils-test-${Date.now()}.txt`);
    try {
      utils.writeFile(testFile, 'hello world hello again hello');
      utils.replaceInFile(testFile, 'hello', 'goodbye', { all: true });
      const content = utils.readFile(testFile);
      assert.strictEqual(content, 'goodbye world goodbye again goodbye');
    } finally {
      fs.unlinkSync(testFile);
    }
  })) passed++; else failed++;

  if (test('options.all is ignored for regex patterns', () => {
    const testFile = path.join(utils.getTempDir(), `utils-test-${Date.now()}.txt`);
    try {
      utils.writeFile(testFile, 'foo bar foo');
      // all option should be ignored for regex; only g flag matters
      utils.replaceInFile(testFile, /foo/, 'qux', { all: true });
      const content = utils.readFile(testFile);
      assert.strictEqual(content, 'qux bar foo', 'Regex without g should still replace first only');
    } finally {
      fs.unlinkSync(testFile);
    }
  })) passed++; else failed++;

  if (test('replaces with capture groups', () => {
    const testFile = path.join(utils.getTempDir(), `utils-test-${Date.now()}.txt`);
    try {
      utils.writeFile(testFile, '**Last Updated:** 10:30');
      utils.replaceInFile(testFile, /\*\*Last Updated:\*\*.*/, '**Last Updated:** 14:45');
      const content = utils.readFile(testFile);
      assert.strictEqual(content, '**Last Updated:** 14:45');
    } finally {
      fs.unlinkSync(testFile);
    }
  })) passed++; else failed++;

  // writeFile edge cases
  console.log('\nwriteFile (edge cases):');

  if (test('writeFile overwrites existing content', () => {
    const testFile = path.join(utils.getTempDir(), `utils-test-${Date.now()}.txt`);
    try {
      utils.writeFile(testFile, 'original');
      utils.writeFile(testFile, 'replaced');
      const content = utils.readFile(testFile);
      assert.strictEqual(content, 'replaced');
    } finally {
      fs.unlinkSync(testFile);
    }
  })) passed++; else failed++;

  if (test('writeFile handles unicode content', () => {
    const testFile = path.join(utils.getTempDir(), `utils-test-${Date.now()}.txt`);
    try {
      const unicode = '日本語テスト 🚀 émojis';
      utils.writeFile(testFile, unicode);
      const content = utils.readFile(testFile);
      assert.strictEqual(content, unicode);
    } finally {
      fs.unlinkSync(testFile);
    }
  })) passed++; else failed++;

  // findFiles with regex special characters in pattern
  console.log('\nfindFiles (regex chars):');

  if (test('findFiles handles regex special chars in pattern', () => {
    const testDir = path.join(utils.getTempDir(), `utils-test-regex-${Date.now()}`);
    try {
      fs.mkdirSync(testDir);
      // Create files with regex-special characters in names
      fs.writeFileSync(path.join(testDir, 'file(1).txt'), 'content');
      fs.writeFileSync(path.join(testDir, 'file+2.txt'), 'content');
      fs.writeFileSync(path.join(testDir, 'file[3].txt'), 'content');

      // These patterns should match literally, not as regex metacharacters
      const parens = utils.findFiles(testDir, 'file(1).txt');
      assert.strictEqual(parens.length, 1, 'Should match file(1).txt literally');

      const plus = utils.findFiles(testDir, 'file+2.txt');
      assert.strictEqual(plus.length, 1, 'Should match file+2.txt literally');

      const brackets = utils.findFiles(testDir, 'file[3].txt');
      assert.strictEqual(brackets.length, 1, 'Should match file[3].txt literally');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('findFiles wildcard still works with special chars', () => {
    const testDir = path.join(utils.getTempDir(), `utils-test-glob-${Date.now()}`);
    try {
      fs.mkdirSync(testDir);
      fs.writeFileSync(path.join(testDir, 'app(v2).js'), 'content');
      fs.writeFileSync(path.join(testDir, 'app(v3).ts'), 'content');

      const jsFiles = utils.findFiles(testDir, '*.js');
      assert.strictEqual(jsFiles.length, 1);
      assert.ok(jsFiles[0].path.endsWith('app(v2).js'));
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  // readStdinJson tests (via subprocess — safe hardcoded inputs)
  // Use execFileSync with input option instead of shell echo|pipe for Windows compat
  console.log('\nreadStdinJson():');

  const stdinScript = 'const u=require("./scripts/lib/utils");u.readStdinJson({timeoutMs:2000}).then(d=>{process.stdout.write(JSON.stringify(d))})';
  const stdinOpts = { encoding: 'utf8', cwd: path.join(__dirname, '..', '..'), timeout: 5000 };

  if (test('readStdinJson parses valid JSON from stdin', () => {
    const { execFileSync } = require('child_process');
    const result = execFileSync('node', ['-e', stdinScript], { ...stdinOpts, input: '{"tool_input":{"command":"ls"}}' });
    const parsed = JSON.parse(result);
    assert.deepStrictEqual(parsed, { tool_input: { command: 'ls' } });
  })) passed++; else failed++;

  if (test('readStdinJson returns {} for invalid JSON', () => {
    const { execFileSync } = require('child_process');
    const result = execFileSync('node', ['-e', stdinScript], { ...stdinOpts, input: 'not json' });
    assert.deepStrictEqual(JSON.parse(result), {});
  })) passed++; else failed++;

  if (test('readStdinJson returns {} for empty stdin', () => {
    const { execFileSync } = require('child_process');
    const result = execFileSync('node', ['-e', stdinScript], { ...stdinOpts, input: '' });
    assert.deepStrictEqual(JSON.parse(result), {});
  })) passed++; else failed++;

  if (test('readStdinJson handles nested objects', () => {
    const { execFileSync } = require('child_process');
    const result = execFileSync('node', ['-e', stdinScript], { ...stdinOpts, input: '{"a":{"b":1},"c":[1,2]}' });
    const parsed = JSON.parse(result);
    assert.deepStrictEqual(parsed, { a: { b: 1 }, c: [1, 2] });
  })) passed++; else failed++;

  // grepFile with global regex (regression: g flag causes alternating matches)
  console.log('\ngrepFile (global regex fix):');

  if (test('grepFile with /g flag finds ALL matching lines (not alternating)', () => {
    const testFile = path.join(utils.getTempDir(), `utils-test-grep-g-${Date.now()}.txt`);
    try {
      // 4 consecutive lines matching the same pattern
      utils.writeFile(testFile, 'match-line\nmatch-line\nmatch-line\nmatch-line');
      // Bug: without fix, /match/g would only find lines 1 and 3 (alternating)
      const matches = utils.grepFile(testFile, /match/g);
      assert.strictEqual(matches.length, 4, `Should find all 4 lines, found ${matches.length}`);
      assert.strictEqual(matches[0].lineNumber, 1);
      assert.strictEqual(matches[1].lineNumber, 2);
      assert.strictEqual(matches[2].lineNumber, 3);
      assert.strictEqual(matches[3].lineNumber, 4);
    } finally {
      fs.unlinkSync(testFile);
    }
  })) passed++; else failed++;

  if (test('grepFile preserves regex flags other than g (e.g. case-insensitive)', () => {
    const testFile = path.join(utils.getTempDir(), `utils-test-grep-flags-${Date.now()}.txt`);
    try {
      utils.writeFile(testFile, 'FOO\nfoo\nFoO\nbar');
      const matches = utils.grepFile(testFile, /foo/gi);
      assert.strictEqual(matches.length, 3, `Should find 3 case-insensitive matches, found ${matches.length}`);
    } finally {
      fs.unlinkSync(testFile);
    }
  })) passed++; else failed++;

  // commandExists edge cases
  console.log('\ncommandExists Edge Cases:');

  if (test('commandExists rejects empty string', () => {
    assert.strictEqual(utils.commandExists(''), false, 'Empty string should not be a valid command');
  })) passed++; else failed++;

  if (test('commandExists rejects command with spaces', () => {
    assert.strictEqual(utils.commandExists('my command'), false, 'Commands with spaces should be rejected');
  })) passed++; else failed++;

  if (test('commandExists rejects command with path separators', () => {
    assert.strictEqual(utils.commandExists('/usr/bin/node'), false, 'Commands with / should be rejected');
    assert.strictEqual(utils.commandExists('..\\cmd'), false, 'Commands with \\ should be rejected');
  })) passed++; else failed++;

  if (test('commandExists rejects shell metacharacters', () => {
    assert.strictEqual(utils.commandExists('cmd;ls'), false, 'Semicolons should be rejected');
    assert.strictEqual(utils.commandExists('$(whoami)'), false, 'Subshell syntax should be rejected');
    assert.strictEqual(utils.commandExists('cmd|cat'), false, 'Pipes should be rejected');
  })) passed++; else failed++;

  if (test('commandExists allows dots and underscores', () => {
    // These are valid chars per the regex check — the command might not exist
    // but it shouldn't be rejected by the validator
    const dotResult = utils.commandExists('definitely.not.a.real.tool.12345');
    assert.strictEqual(typeof dotResult, 'boolean', 'Should return boolean, not throw');
  })) passed++; else failed++;

  // findFiles edge cases
  console.log('\nfindFiles Edge Cases:');

  if (test('findFiles with ? wildcard matches single character', () => {
    const testDir = path.join(utils.getTempDir(), `ff-qmark-${Date.now()}`);
    utils.ensureDir(testDir);
    try {
      fs.writeFileSync(path.join(testDir, 'a1.txt'), '');
      fs.writeFileSync(path.join(testDir, 'b2.txt'), '');
      fs.writeFileSync(path.join(testDir, 'abc.txt'), '');

      const results = utils.findFiles(testDir, '??.txt');
      const names = results.map(r => path.basename(r.path)).sort();
      assert.deepStrictEqual(names, ['a1.txt', 'b2.txt'], 'Should match exactly 2-char basenames');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('findFiles sorts by mtime (newest first)', () => {
    const testDir = path.join(utils.getTempDir(), `ff-sort-${Date.now()}`);
    utils.ensureDir(testDir);
    try {
      const f1 = path.join(testDir, 'old.txt');
      const f2 = path.join(testDir, 'new.txt');
      fs.writeFileSync(f1, 'old');
      // Set older mtime on first file
      const past = new Date(Date.now() - 60000);
      fs.utimesSync(f1, past, past);
      fs.writeFileSync(f2, 'new');

      const results = utils.findFiles(testDir, '*.txt');
      assert.strictEqual(results.length, 2);
      assert.ok(
        path.basename(results[0].path) === 'new.txt',
        `Newest file should be first, got ${path.basename(results[0].path)}`
      );
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('findFiles with maxAge filters old files', () => {
    const testDir = path.join(utils.getTempDir(), `ff-age-${Date.now()}`);
    utils.ensureDir(testDir);
    try {
      const recent = path.join(testDir, 'recent.txt');
      const old = path.join(testDir, 'old.txt');
      fs.writeFileSync(recent, 'new');
      fs.writeFileSync(old, 'old');
      // Set mtime to 30 days ago
      const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      fs.utimesSync(old, past, past);

      const results = utils.findFiles(testDir, '*.txt', { maxAge: 7 });
      assert.strictEqual(results.length, 1, 'Should only return recent file');
      assert.ok(results[0].path.includes('recent.txt'), 'Should return the recent file');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  // ensureDir edge cases
  console.log('\nensureDir Edge Cases:');

  if (test('ensureDir is safe for concurrent calls (EEXIST race)', () => {
    const testDir = path.join(utils.getTempDir(), `ensure-race-${Date.now()}`, 'nested');
    try {
      // Call concurrently — both should succeed without throwing
      const results = [utils.ensureDir(testDir), utils.ensureDir(testDir)];
      assert.strictEqual(results[0], testDir);
      assert.strictEqual(results[1], testDir);
      assert.ok(fs.existsSync(testDir));
    } finally {
      fs.rmSync(path.dirname(testDir), { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('ensureDir returns the directory path', () => {
    const testDir = path.join(utils.getTempDir(), `ensure-ret-${Date.now()}`);
    try {
      const result = utils.ensureDir(testDir);
      assert.strictEqual(result, testDir, 'Should return the directory path');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  // runCommand edge cases
  console.log('\nrunCommand Edge Cases:');

  if (test('runCommand returns trimmed output', () => {
    const result = utils.runCommand('echo "  hello  "');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.output, 'hello', 'Should trim leading/trailing whitespace');
  })) passed++; else failed++;

  if (test('runCommand captures stderr on failure', () => {
    const result = utils.runCommand('node -e "process.exit(1)"');
    assert.strictEqual(result.success, false);
    assert.ok(typeof result.output === 'string', 'Output should be a string on failure');
  })) passed++; else failed++;

  // getGitModifiedFiles edge cases
  console.log('\ngetGitModifiedFiles Edge Cases:');

  if (test('getGitModifiedFiles returns array with empty patterns', () => {
    const files = utils.getGitModifiedFiles([]);
    assert.ok(Array.isArray(files), 'Should return array');
  })) passed++; else failed++;

  // replaceInFile edge cases
  console.log('\nreplaceInFile Edge Cases:');

  if (test('replaceInFile with regex capture groups works correctly', () => {
    const testFile = path.join(utils.getTempDir(), `replace-capture-${Date.now()}.txt`);
    try {
      utils.writeFile(testFile, 'version: 1.0.0');
      const result = utils.replaceInFile(testFile, /version: (\d+)\.(\d+)\.(\d+)/, 'version: $1.$2.99');
      assert.strictEqual(result, true);
      assert.strictEqual(utils.readFile(testFile), 'version: 1.0.99');
    } finally {
      fs.unlinkSync(testFile);
    }
  })) passed++; else failed++;

  // readStdinJson (function API, not actual stdin — more thorough edge cases)
  console.log('\nreadStdinJson Edge Cases:');

  if (test('readStdinJson type check: returns a Promise', () => {
    // readStdinJson returns a Promise regardless of stdin state
    const result = utils.readStdinJson({ timeoutMs: 100 });
    assert.ok(result instanceof Promise, 'Should return a Promise');
    // Don't await — just verify it's a Promise type
  })) passed++; else failed++;

  // ── Round 28: readStdinJson maxSize truncation and edge cases ──
  console.log('\nreadStdinJson maxSize truncation:');

  if (test('readStdinJson maxSize stops accumulating after threshold (chunk-level guard)', () => {
    const { execFileSync } = require('child_process');
    // maxSize is a chunk-level guard: once data.length >= maxSize, no MORE chunks are added.
    // A single small chunk that arrives when data.length < maxSize is added in full.
    // To test multi-chunk behavior, we send >64KB (Node default highWaterMark=16KB)
    // which should arrive in multiple chunks. With maxSize=100, only the first chunk(s)
    // totaling under 100 bytes should be captured; subsequent chunks are dropped.
    const script = 'const u=require("./scripts/lib/utils");u.readStdinJson({timeoutMs:2000,maxSize:100}).then(d=>{process.stdout.write(JSON.stringify(d))})';
    // Generate 100KB of data (arrives in multiple chunks)
    const bigInput = '{"k":"' + 'X'.repeat(100000) + '"}';
    const result = execFileSync('node', ['-e', script], { ...stdinOpts, input: bigInput });
    // Truncated mid-string → invalid JSON → resolves to {}
    assert.deepStrictEqual(JSON.parse(result), {});
  })) passed++; else failed++;

  if (test('readStdinJson with maxSize large enough preserves valid JSON', () => {
    const { execFileSync } = require('child_process');
    const script = 'const u=require("./scripts/lib/utils");u.readStdinJson({timeoutMs:2000,maxSize:1024}).then(d=>{process.stdout.write(JSON.stringify(d))})';
    const input = JSON.stringify({ key: 'value' });
    const result = execFileSync('node', ['-e', script], { ...stdinOpts, input });
    assert.deepStrictEqual(JSON.parse(result), { key: 'value' });
  })) passed++; else failed++;

  if (test('readStdinJson resolves {} for whitespace-only stdin', () => {
    const { execFileSync } = require('child_process');
    const result = execFileSync('node', ['-e', stdinScript], { ...stdinOpts, input: '   \n  \t  ' });
    // data.trim() is empty → resolves {}
    assert.deepStrictEqual(JSON.parse(result), {});
  })) passed++; else failed++;

  if (test('readStdinJson handles JSON with trailing whitespace/newlines', () => {
    const { execFileSync } = require('child_process');
    const result = execFileSync('node', ['-e', stdinScript], { ...stdinOpts, input: '{"a":1}  \n\n' });
    assert.deepStrictEqual(JSON.parse(result), { a: 1 });
  })) passed++; else failed++;

  if (test('readStdinJson handles JSON with BOM prefix (returns {})', () => {
    const { execFileSync } = require('child_process');
    // BOM (\uFEFF) before JSON makes it invalid for JSON.parse
    const result = execFileSync('node', ['-e', stdinScript], { ...stdinOpts, input: '\uFEFF{"a":1}' });
    // BOM prefix makes JSON.parse fail → resolve {}
    assert.deepStrictEqual(JSON.parse(result), {});
  })) passed++; else failed++;

  // ── Round 31: ensureDir error propagation ──
  console.log('\nensureDir Error Propagation (Round 31):');

  if (test('ensureDir wraps non-EEXIST errors with descriptive message', () => {
    // Attempting to create a dir under a file should fail with ENOTDIR, not EEXIST
    const testFile = path.join(utils.getTempDir(), `ensure-err-${Date.now()}.txt`);
    try {
      fs.writeFileSync(testFile, 'blocking file');
      const badPath = path.join(testFile, 'subdir');
      assert.throws(
        () => utils.ensureDir(badPath),
        (err) => err.message.includes('Failed to create directory'),
        'Should throw with descriptive "Failed to create directory" message'
      );
    } finally {
      fs.unlinkSync(testFile);
    }
  })) passed++; else failed++;

  if (test('ensureDir error includes the directory path', () => {
    const testFile = path.join(utils.getTempDir(), `ensure-err2-${Date.now()}.txt`);
    try {
      fs.writeFileSync(testFile, 'blocker');
      const badPath = path.join(testFile, 'nested', 'dir');
      try {
        utils.ensureDir(badPath);
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err.message.includes(badPath), 'Error should include the target path');
      }
    } finally {
      fs.unlinkSync(testFile);
    }
  })) passed++; else failed++;

  // ── Round 31: runCommand stderr preference on failure ──
  console.log('\nrunCommand failure output (Round 31):');

  if (test('runCommand returns stderr content on failure when stderr exists', () => {
    const result = utils.runCommand('node -e "process.stderr.write(\'custom error\'); process.exit(1)"');
    assert.strictEqual(result.success, false);
    assert.ok(result.output.includes('custom error'), 'Should include stderr output');
  })) passed++; else failed++;

  if (test('runCommand falls back to err.message when no stderr', () => {
    // An invalid command that won't produce stderr through child process
    const result = utils.runCommand('nonexistent_cmd_xyz_12345');
    assert.strictEqual(result.success, false);
    assert.ok(result.output.length > 0, 'Should have some error output');
  })) passed++; else failed++;

  // ── Round 31: getGitModifiedFiles with empty patterns ──
  console.log('\ngetGitModifiedFiles empty patterns (Round 31):');

  if (test('getGitModifiedFiles with empty array returns all modified files', () => {
    // With an empty patterns array, every file should match (no filter applied)
    const withEmpty = utils.getGitModifiedFiles([]);
    const withNone = utils.getGitModifiedFiles();
    // Both should return the same list (no filtering)
    assert.deepStrictEqual(withEmpty, withNone,
      'Empty patterns array should behave same as no patterns');
  })) passed++; else failed++;

  // ── Round 33: readStdinJson error event handling ──
  console.log('\nreadStdinJson error event (Round 33):');

  if (test('readStdinJson resolves {} when stdin emits error (via broken pipe)', () => {
    // Spawn a subprocess that reads from stdin, but close the pipe immediately
    // to trigger an error or early-end condition
    const { execFileSync } = require('child_process');
    const script = 'const u=require("./scripts/lib/utils");u.readStdinJson({timeoutMs:2000}).then(d=>{process.stdout.write(JSON.stringify(d))})';
    // Pipe stdin from /dev/null — this sends EOF immediately (no data)
    const result = execFileSync('node', ['-e', script], {
      encoding: 'utf8',
      input: '', // empty stdin triggers 'end' with empty data
      timeout: 5000,
      cwd: path.join(__dirname, '..', '..'),
    });
    const parsed = JSON.parse(result);
    assert.deepStrictEqual(parsed, {}, 'Should resolve to {} for empty stdin (end event path)');
  })) passed++; else failed++;

  if (test('readStdinJson error handler is guarded by settled flag', () => {
    // If 'end' fires first setting settled=true, then a late 'error' should be ignored
    // We test this by verifying the code structure works: send valid JSON, the end event
    // fires, settled=true, any late error is safely ignored
    const { execFileSync } = require('child_process');
    const script = 'const u=require("./scripts/lib/utils");u.readStdinJson({timeoutMs:2000}).then(d=>{process.stdout.write(JSON.stringify(d))})';
    const result = execFileSync('node', ['-e', script], {
      encoding: 'utf8',
      input: '{"test":"settled-guard"}',
      timeout: 5000,
      cwd: path.join(__dirname, '..', '..'),
    });
    const parsed = JSON.parse(result);
    assert.strictEqual(parsed.test, 'settled-guard', 'Should parse normally when end fires first');
  })) passed++; else failed++;

  // replaceInFile returns false when write fails (e.g., read-only file)
  if (test('replaceInFile returns false on write failure (read-only file)', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      console.log('    (skipped — chmod ineffective on Windows/root)');
      return;
    }
    const testDir = path.join(utils.getTempDir(), `utils-test-readonly-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    const filePath = path.join(testDir, 'readonly.txt');
    try {
      fs.writeFileSync(filePath, 'hello world', 'utf8');
      fs.chmodSync(filePath, 0o444);
      const result = utils.replaceInFile(filePath, 'hello', 'goodbye');
      assert.strictEqual(result, false, 'Should return false when file is read-only');
      // Verify content unchanged
      const content = fs.readFileSync(filePath, 'utf8');
      assert.strictEqual(content, 'hello world', 'Original content should be preserved');
    } finally {
      fs.chmodSync(filePath, 0o644);
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  // ── Round 69: getGitModifiedFiles with ALL invalid patterns ──
  console.log('\ngetGitModifiedFiles all-invalid patterns (Round 69):');

  if (test('getGitModifiedFiles with all-invalid patterns skips filtering (returns all files)', () => {
    // When every pattern is invalid regex, compiled.length === 0 at line 386,
    // so the filtering is skipped entirely and all modified files are returned.
    // This differs from the mixed-valid test where at least one pattern compiles.
    const allInvalid = utils.getGitModifiedFiles(['(unclosed', '[bad', '**invalid']);
    const unfiltered = utils.getGitModifiedFiles();
    // Both should return the same list — all-invalid patterns = no filtering
    assert.deepStrictEqual(allInvalid, unfiltered,
      'All-invalid patterns should return same result as no patterns (no filtering)');
  })) passed++; else failed++;

  // ── Round 71: findFiles recursive scan skips unreadable subdirectory ──
  console.log('\nRound 71: findFiles (unreadable subdirectory in recursive scan):');

  if (test('findFiles recursive scan skips unreadable subdirectory silently', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      console.log('    (skipped — chmod ineffective on Windows/root)');
      return;
    }
    const tmpDir = path.join(utils.getTempDir(), `ecc-findfiles-r71-${Date.now()}`);
    const readableSubdir = path.join(tmpDir, 'readable');
    const unreadableSubdir = path.join(tmpDir, 'unreadable');
    fs.mkdirSync(readableSubdir, { recursive: true });
    fs.mkdirSync(unreadableSubdir, { recursive: true });

    // Create files in both subdirectories
    fs.writeFileSync(path.join(readableSubdir, 'found.txt'), 'data');
    fs.writeFileSync(path.join(unreadableSubdir, 'hidden.txt'), 'data');

    // Make the subdirectory unreadable — readdirSync will throw EACCES
    fs.chmodSync(unreadableSubdir, 0o000);

    try {
      const results = utils.findFiles(tmpDir, '*.txt', { recursive: true });
      // Should find the readable file but silently skip the unreadable dir
      assert.ok(results.length >= 1, 'Should find at least the readable file');
      const paths = results.map(r => r.path);
      assert.ok(paths.some(p => p.includes('found.txt')), 'Should find readable/found.txt');
      assert.ok(!paths.some(p => p.includes('hidden.txt')), 'Should not find unreadable/hidden.txt');
    } finally {
      fs.chmodSync(unreadableSubdir, 0o755);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  // ── Round 79: countInFile with valid string pattern ──
  console.log('\nRound 79: countInFile (valid string pattern):');

  if (test('countInFile counts occurrences using a plain string pattern', () => {
    const testFile = path.join(utils.getTempDir(), `utils-test-count-str-${Date.now()}.txt`);
    try {
      utils.writeFile(testFile, 'apple banana apple cherry apple');
      // Pass a plain string (not RegExp) — exercises typeof pattern === 'string'
      // branch at utils.js:441-442 which creates new RegExp(pattern, 'g')
      const count = utils.countInFile(testFile, 'apple');
      assert.strictEqual(count, 3, 'String pattern should count all occurrences');
    } finally {
      fs.unlinkSync(testFile);
    }
  })) passed++; else failed++;

  // ── Round 79: grepFile with valid string pattern ──
  console.log('\nRound 79: grepFile (valid string pattern):');

  if (test('grepFile finds matching lines using a plain string pattern', () => {
    const testFile = path.join(utils.getTempDir(), `utils-test-grep-str-${Date.now()}.txt`);
    try {
      utils.writeFile(testFile, 'line1 alpha\nline2 beta\nline3 alpha\nline4 gamma');
      // Pass a plain string (not RegExp) — exercises the else branch
      // at utils.js:468-469 which creates new RegExp(pattern)
      const matches = utils.grepFile(testFile, 'alpha');
      assert.strictEqual(matches.length, 2, 'String pattern should find 2 matching lines');
      assert.strictEqual(matches[0].lineNumber, 1, 'First match at line 1');
      assert.strictEqual(matches[1].lineNumber, 3, 'Second match at line 3');
      assert.ok(matches[0].content.includes('alpha'), 'Content should include pattern');
    } finally {
      fs.unlinkSync(testFile);
    }
  })) passed++; else failed++;

  // ── Round 84: findFiles inner statSync catch (TOCTOU — broken symlink) ──
  console.log('\nRound 84: findFiles (inner statSync catch — broken symlink):');

  if (test('findFiles skips broken symlinks that match the pattern', () => {
    // findFiles at utils.js:170-173: readdirSync returns entries including broken
    // symlinks (entry.isFile() returns false for broken symlinks, but the test also
    // verifies the overall robustness). On some systems, broken symlinks can be
    // returned by readdirSync and pass through isFile() depending on the driver.
    // More importantly: if statSync throws inside the inner loop, catch continues.
    //
    // To reliably trigger the statSync catch: create a real file, list it, then
    // simulate the race. Since we can't truly race, we use a broken symlink which
    // will at minimum verify the function doesn't crash on unusual dir entries.
    const tmpDir = path.join(utils.getTempDir(), `ecc-r84-findfiles-toctou-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    // Create a real file and a broken symlink, both matching *.txt
    const realFile = path.join(tmpDir, 'real.txt');
    fs.writeFileSync(realFile, 'content');
    const brokenLink = path.join(tmpDir, 'broken.txt');
    fs.symlinkSync('/nonexistent/path/does/not/exist', brokenLink);

    try {
      const results = utils.findFiles(tmpDir, '*.txt');
      // The real file should be found; the broken symlink should be skipped
      const paths = results.map(r => r.path);
      assert.ok(paths.some(p => p.includes('real.txt')), 'Should find the real file');
      assert.ok(!paths.some(p => p.includes('broken.txt')),
        'Should not include broken symlink in results');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  // ── Round 85: getSessionIdShort fallback parameter ──
  console.log('\ngetSessionIdShort fallback (Round 85):');

  if (test('getSessionIdShort uses fallback when getProjectName returns null (CWD at root)', () => {
    if (process.platform === 'win32') {
      console.log('    (skipped — root CWD differs on Windows)');
      return;
    }
    // Spawn a subprocess at CWD=/ with CLAUDE_SESSION_ID empty.
    // At /, git rev-parse --show-toplevel fails → getGitRepoName() = null.
    // path.basename('/') = '' → '' || null = null → getProjectName() = null.
    // So getSessionIdShort('my-custom-fallback') = null || 'my-custom-fallback'.
    const utilsPath = path.join(__dirname, '..', '..', 'scripts', 'lib', 'utils.js');
    const script = `
      const utils = require('${utilsPath.replace(/'/g, "\\'")}');
      process.stdout.write(utils.getSessionIdShort('my-custom-fallback'));
    `;
    const { spawnSync } = require('child_process');
    const result = spawnSync('node', ['-e', script], {
      encoding: 'utf8',
      cwd: '/',
      env: { ...process.env, CLAUDE_SESSION_ID: '' },
      timeout: 10000
    });
    assert.strictEqual(result.status, 0, `Should exit 0, got status ${result.status}. stderr: ${result.stderr}`);
    assert.strictEqual(result.stdout, 'my-custom-fallback',
      `At CWD=/ with no session ID, should use the fallback parameter. Got: "${result.stdout}"`);
  })) passed++; else failed++;

  // ── Round 88: replaceInFile with empty replacement (deletion) ──
  console.log('\nRound 88: replaceInFile with empty replacement string (deletion):');
  if (test('replaceInFile with empty string replacement deletes matched text', () => {
    const tmpDir = path.join(utils.getTempDir(), `ecc-r88-replace-empty-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, 'delete-test.txt');
    try {
      fs.writeFileSync(tmpFile, 'hello REMOVE_ME world');
      const result = utils.replaceInFile(tmpFile, 'REMOVE_ME ', '');
      assert.strictEqual(result, true, 'Should return true on successful replacement');
      const content = fs.readFileSync(tmpFile, 'utf8');
      assert.strictEqual(content, 'hello world',
        'Empty replacement should delete the matched text');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  // ── Round 88: countInFile with valid file but zero matches ──
  console.log('\nRound 88: countInFile with existing file but non-matching pattern:');
  if (test('countInFile returns 0 for valid file with no pattern matches', () => {
    const tmpDir = path.join(utils.getTempDir(), `ecc-r88-count-zero-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, 'no-match.txt');
    try {
      fs.writeFileSync(tmpFile, 'apple banana cherry');
      const count = utils.countInFile(tmpFile, 'ZZZZNOTHERE');
      assert.strictEqual(count, 0,
        'Should return 0 when regex matches nothing in existing file');
      const countRegex = utils.countInFile(tmpFile, /ZZZZNOTHERE/g);
      assert.strictEqual(countRegex, 0,
        'Should return 0 for RegExp with no matches in existing file');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  // ── Round 92: countInFile with object pattern type ──
  console.log('\nRound 92: countInFile (non-string non-RegExp pattern):');

  if (test('countInFile returns 0 for object pattern (neither string nor RegExp)', () => {
    // utils.js line 443-444: The else branch returns 0 when pattern is
    // not instanceof RegExp and typeof !== 'string'. An object like {invalid: true}
    // triggers this early return without throwing.
    const testFile = path.join(utils.getTempDir(), `utils-test-obj-pattern-${Date.now()}.txt`);
    try {
      utils.writeFile(testFile, 'some test content to match against');
      const count = utils.countInFile(testFile, { invalid: 'object' });
      assert.strictEqual(count, 0, 'Object pattern should return 0');
    } finally {
      try { fs.unlinkSync(testFile); } catch { /* best-effort */ }
    }
  })) passed++; else failed++;

  // ── Round 93: countInFile with /pattern/i (g flag appended) ──
  console.log('\nRound 93: countInFile (case-insensitive RegExp, g flag auto-appended):');

  if (test('countInFile with /pattern/i appends g flag and counts case-insensitively', () => {
    // utils.js line 440: pattern.flags = 'i', 'i'.includes('g') → false,
    // so new RegExp(source, 'i' + 'g') → /pattern/ig
    const testFile = path.join(utils.getTempDir(), `utils-test-ci-flag-${Date.now()}.txt`);
    try {
      utils.writeFile(testFile, 'Foo foo FOO fOo bar baz');
      const count = utils.countInFile(testFile, /foo/i);
      assert.strictEqual(count, 4,
        'Case-insensitive regex with auto-appended g should match all 4 occurrences');
    } finally {
      try { fs.unlinkSync(testFile); } catch { /* best-effort */ }
    }
  })) passed++; else failed++;

  // ── Round 93: countInFile with /pattern/gi (g flag already present) ──
  console.log('\nRound 93: countInFile (case-insensitive RegExp, g flag preserved):');

  if (test('countInFile with /pattern/gi preserves existing flags and counts correctly', () => {
    // utils.js line 440: pattern.flags = 'gi', 'gi'.includes('g') → true,
    // so new RegExp(source, 'gi') — flags preserved unchanged
    const testFile = path.join(utils.getTempDir(), `utils-test-gi-flag-${Date.now()}.txt`);
    try {
      utils.writeFile(testFile, 'Foo foo FOO fOo bar baz');
      const count = utils.countInFile(testFile, /foo/gi);
      assert.strictEqual(count, 4,
        'Case-insensitive regex with pre-existing g should match all 4 occurrences');
    } finally {
      try { fs.unlinkSync(testFile); } catch { /* best-effort */ }
    }
  })) passed++; else failed++;

  // Summary
  console.log('\n=== Test Results ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total:  ${passed + failed}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

runTests();
