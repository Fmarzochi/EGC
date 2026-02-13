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

  // Summary
  console.log('\n=== Test Results ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total:  ${passed + failed}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

runTests();
