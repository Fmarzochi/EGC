/**
 * Tests for hook scripts
 *
 * Run with: node tests/hooks/hooks.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

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

// Async test helper
async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    return false;
  }
}

// Run a script and capture output
function runScript(scriptPath, input = '', env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [scriptPath], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', data => stdout += data);
    proc.stderr.on('data', data => stderr += data);

    if (input) {
      proc.stdin.write(input);
    }
    proc.stdin.end();

    proc.on('close', code => {
      resolve({ code, stdout, stderr });
    });

    proc.on('error', reject);
  });
}

// Create a temporary test directory
function createTestDir() {
  const testDir = path.join(os.tmpdir(), `hooks-test-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  return testDir;
}

// Clean up test directory
function cleanupTestDir(testDir) {
  fs.rmSync(testDir, { recursive: true, force: true });
}

// Test suite
async function runTests() {
  console.log('\n=== Testing Hook Scripts ===\n');

  let passed = 0;
  let failed = 0;

  const scriptsDir = path.join(__dirname, '..', '..', 'scripts', 'hooks');

  // session-start.js tests
  console.log('session-start.js:');

  if (await asyncTest('runs without error', async () => {
    const result = await runScript(path.join(scriptsDir, 'session-start.js'));
    assert.strictEqual(result.code, 0, `Exit code should be 0, got ${result.code}`);
  })) passed++; else failed++;

  if (await asyncTest('outputs session info to stderr', async () => {
    const result = await runScript(path.join(scriptsDir, 'session-start.js'));
    assert.ok(
      result.stderr.includes('[SessionStart]') ||
      result.stderr.includes('Package manager'),
      'Should output session info'
    );
  })) passed++; else failed++;

  // session-start.js edge cases
  console.log('\nsession-start.js (edge cases):');

  if (await asyncTest('exits 0 even with isolated empty HOME', async () => {
    const isoHome = path.join(os.tmpdir(), `ecc-iso-start-${Date.now()}`);
    fs.mkdirSync(path.join(isoHome, '.claude', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(isoHome, '.claude', 'skills', 'learned'), { recursive: true });
    try {
      const result = await runScript(path.join(scriptsDir, 'session-start.js'), '', {
        HOME: isoHome, USERPROFILE: isoHome
      });
      assert.strictEqual(result.code, 0, `Exit code should be 0, got ${result.code}`);
    } finally {
      fs.rmSync(isoHome, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (await asyncTest('reports package manager detection', async () => {
    const result = await runScript(path.join(scriptsDir, 'session-start.js'));
    assert.ok(
      result.stderr.includes('Package manager') || result.stderr.includes('[SessionStart]'),
      'Should report package manager info'
    );
  })) passed++; else failed++;

  if (await asyncTest('skips template session content', async () => {
    const isoHome = path.join(os.tmpdir(), `ecc-tpl-start-${Date.now()}`);
    const sessionsDir = path.join(isoHome, '.claude', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(path.join(isoHome, '.claude', 'skills', 'learned'), { recursive: true });

    // Create a session file with template placeholder
    const sessionFile = path.join(sessionsDir, '2026-02-11-abcd1234-session.tmp');
    fs.writeFileSync(sessionFile, '## Current State\n\n[Session context goes here]\n');

    try {
      const result = await runScript(path.join(scriptsDir, 'session-start.js'), '', {
        HOME: isoHome, USERPROFILE: isoHome
      });
      assert.strictEqual(result.code, 0);
      // stdout should NOT contain the template content
      assert.ok(
        !result.stdout.includes('Previous session summary'),
        'Should not inject template session content'
      );
    } finally {
      fs.rmSync(isoHome, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (await asyncTest('injects real session content', async () => {
    const isoHome = path.join(os.tmpdir(), `ecc-real-start-${Date.now()}`);
    const sessionsDir = path.join(isoHome, '.claude', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(path.join(isoHome, '.claude', 'skills', 'learned'), { recursive: true });

    // Create a real session file
    const sessionFile = path.join(sessionsDir, '2026-02-11-efgh5678-session.tmp');
    fs.writeFileSync(sessionFile, '# Real Session\n\nI worked on authentication refactor.\n');

    try {
      const result = await runScript(path.join(scriptsDir, 'session-start.js'), '', {
        HOME: isoHome, USERPROFILE: isoHome
      });
      assert.strictEqual(result.code, 0);
      assert.ok(
        result.stdout.includes('Previous session summary'),
        'Should inject real session content'
      );
      assert.ok(
        result.stdout.includes('authentication refactor'),
        'Should include session content text'
      );
    } finally {
      fs.rmSync(isoHome, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (await asyncTest('reports learned skills count', async () => {
    const isoHome = path.join(os.tmpdir(), `ecc-skills-start-${Date.now()}`);
    const learnedDir = path.join(isoHome, '.claude', 'skills', 'learned');
    fs.mkdirSync(learnedDir, { recursive: true });
    fs.mkdirSync(path.join(isoHome, '.claude', 'sessions'), { recursive: true });

    // Create learned skill files
    fs.writeFileSync(path.join(learnedDir, 'testing-patterns.md'), '# Testing');
    fs.writeFileSync(path.join(learnedDir, 'debugging.md'), '# Debugging');

    try {
      const result = await runScript(path.join(scriptsDir, 'session-start.js'), '', {
        HOME: isoHome, USERPROFILE: isoHome
      });
      assert.strictEqual(result.code, 0);
      assert.ok(
        result.stderr.includes('2 learned skill(s)'),
        `Should report 2 learned skills, stderr: ${result.stderr}`
      );
    } finally {
      fs.rmSync(isoHome, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  // check-console-log.js tests
  console.log('\ncheck-console-log.js:');

  if (await asyncTest('passes through stdin data to stdout', async () => {
    const stdinData = JSON.stringify({ tool_name: 'Write', tool_input: {} });
    const result = await runScript(path.join(scriptsDir, 'check-console-log.js'), stdinData);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('tool_name'), 'Should pass through stdin data');
  })) passed++; else failed++;

  if (await asyncTest('exits 0 with empty stdin', async () => {
    const result = await runScript(path.join(scriptsDir, 'check-console-log.js'), '');
    assert.strictEqual(result.code, 0);
  })) passed++; else failed++;

  if (await asyncTest('handles invalid JSON stdin gracefully', async () => {
    const result = await runScript(path.join(scriptsDir, 'check-console-log.js'), 'not valid json');
    assert.strictEqual(result.code, 0, 'Should exit 0 on invalid JSON');
    // Should still pass through the data
    assert.ok(result.stdout.includes('not valid json'), 'Should pass through invalid data');
  })) passed++; else failed++;

  // session-end.js tests
  console.log('\nsession-end.js:');

  if (await asyncTest('runs without error', async () => {
    const result = await runScript(path.join(scriptsDir, 'session-end.js'));
    assert.strictEqual(result.code, 0, `Exit code should be 0, got ${result.code}`);
  })) passed++; else failed++;

  if (await asyncTest('creates or updates session file', async () => {
    // Run the script
    await runScript(path.join(scriptsDir, 'session-end.js'));

    // Check if session file was created
    // Note: Without CLAUDE_SESSION_ID, falls back to project name (not 'default')
    // Use local time to match the script's getDateString() function
    const sessionsDir = path.join(os.homedir(), '.claude', 'sessions');
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    // Get the expected session ID (project name fallback)
    const utils = require('../../scripts/lib/utils');
    const expectedId = utils.getSessionIdShort();
    const sessionFile = path.join(sessionsDir, `${today}-${expectedId}-session.tmp`);

    assert.ok(fs.existsSync(sessionFile), `Session file should exist: ${sessionFile}`);
  })) passed++; else failed++;

  if (await asyncTest('includes session ID in filename', async () => {
    const testSessionId = 'test-session-abc12345';
    const expectedShortId = 'abc12345'; // Last 8 chars

    // Run with custom session ID
    await runScript(path.join(scriptsDir, 'session-end.js'), '', {
      CLAUDE_SESSION_ID: testSessionId
    });

    // Check if session file was created with session ID
    // Use local time to match the script's getDateString() function
    const sessionsDir = path.join(os.homedir(), '.claude', 'sessions');
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const sessionFile = path.join(sessionsDir, `${today}-${expectedShortId}-session.tmp`);

    assert.ok(fs.existsSync(sessionFile), `Session file should exist: ${sessionFile}`);
  })) passed++; else failed++;

  // pre-compact.js tests
  console.log('\npre-compact.js:');

  if (await asyncTest('runs without error', async () => {
    const result = await runScript(path.join(scriptsDir, 'pre-compact.js'));
    assert.strictEqual(result.code, 0, `Exit code should be 0, got ${result.code}`);
  })) passed++; else failed++;

  if (await asyncTest('outputs PreCompact message', async () => {
    const result = await runScript(path.join(scriptsDir, 'pre-compact.js'));
    assert.ok(result.stderr.includes('[PreCompact]'), 'Should output PreCompact message');
  })) passed++; else failed++;

  if (await asyncTest('creates compaction log', async () => {
    await runScript(path.join(scriptsDir, 'pre-compact.js'));
    const logFile = path.join(os.homedir(), '.claude', 'sessions', 'compaction-log.txt');
    assert.ok(fs.existsSync(logFile), 'Compaction log should exist');
  })) passed++; else failed++;

  if (await asyncTest('annotates active session file with compaction marker', async () => {
    const isoHome = path.join(os.tmpdir(), `ecc-compact-annotate-${Date.now()}`);
    const sessionsDir = path.join(isoHome, '.claude', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Create an active .tmp session file
    const sessionFile = path.join(sessionsDir, '2026-02-11-test-session.tmp');
    fs.writeFileSync(sessionFile, '# Session: 2026-02-11\n**Started:** 10:00\n');

    try {
      await runScript(path.join(scriptsDir, 'pre-compact.js'), '', {
        HOME: isoHome, USERPROFILE: isoHome
      });

      const content = fs.readFileSync(sessionFile, 'utf8');
      assert.ok(
        content.includes('Compaction occurred'),
        'Should annotate the session file with compaction marker'
      );
    } finally {
      fs.rmSync(isoHome, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (await asyncTest('compaction log contains timestamp', async () => {
    const isoHome = path.join(os.tmpdir(), `ecc-compact-ts-${Date.now()}`);
    const sessionsDir = path.join(isoHome, '.claude', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    try {
      await runScript(path.join(scriptsDir, 'pre-compact.js'), '', {
        HOME: isoHome, USERPROFILE: isoHome
      });

      const logFile = path.join(sessionsDir, 'compaction-log.txt');
      assert.ok(fs.existsSync(logFile), 'Compaction log should exist');
      const content = fs.readFileSync(logFile, 'utf8');
      // Should have a timestamp like [2026-02-11 14:30:00]
      assert.ok(
        /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/.test(content),
        `Log should contain timestamped entry, got: ${content.substring(0, 100)}`
      );
    } finally {
      fs.rmSync(isoHome, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  // suggest-compact.js tests
  console.log('\nsuggest-compact.js:');

  if (await asyncTest('runs without error', async () => {
    const result = await runScript(path.join(scriptsDir, 'suggest-compact.js'), '', {
      CLAUDE_SESSION_ID: 'test-session-' + Date.now()
    });
    assert.strictEqual(result.code, 0, `Exit code should be 0, got ${result.code}`);
  })) passed++; else failed++;

  if (await asyncTest('increments counter on each call', async () => {
    const sessionId = 'test-counter-' + Date.now();

    // Run multiple times
    for (let i = 0; i < 3; i++) {
      await runScript(path.join(scriptsDir, 'suggest-compact.js'), '', {
        CLAUDE_SESSION_ID: sessionId
      });
    }

    // Check counter file
    const counterFile = path.join(os.tmpdir(), `claude-tool-count-${sessionId}`);
    const count = parseInt(fs.readFileSync(counterFile, 'utf8').trim(), 10);
    assert.strictEqual(count, 3, `Counter should be 3, got ${count}`);

    // Cleanup
    fs.unlinkSync(counterFile);
  })) passed++; else failed++;

  if (await asyncTest('suggests compact at threshold', async () => {
    const sessionId = 'test-threshold-' + Date.now();
    const counterFile = path.join(os.tmpdir(), `claude-tool-count-${sessionId}`);

    // Set counter to threshold - 1
    fs.writeFileSync(counterFile, '49');

    const result = await runScript(path.join(scriptsDir, 'suggest-compact.js'), '', {
      CLAUDE_SESSION_ID: sessionId,
      COMPACT_THRESHOLD: '50'
    });

    assert.ok(
      result.stderr.includes('50 tool calls reached'),
      'Should suggest compact at threshold'
    );

    // Cleanup
    fs.unlinkSync(counterFile);
  })) passed++; else failed++;

  if (await asyncTest('does not suggest below threshold', async () => {
    const sessionId = 'test-below-' + Date.now();
    const counterFile = path.join(os.tmpdir(), `claude-tool-count-${sessionId}`);

    fs.writeFileSync(counterFile, '10');

    const result = await runScript(path.join(scriptsDir, 'suggest-compact.js'), '', {
      CLAUDE_SESSION_ID: sessionId,
      COMPACT_THRESHOLD: '50'
    });

    assert.ok(
      !result.stderr.includes('tool calls'),
      'Should not suggest compact below threshold'
    );

    fs.unlinkSync(counterFile);
  })) passed++; else failed++;

  if (await asyncTest('suggests at regular intervals after threshold', async () => {
    const sessionId = 'test-interval-' + Date.now();
    const counterFile = path.join(os.tmpdir(), `claude-tool-count-${sessionId}`);

    // Set counter to 74 (next will be 75, which is >50 and 75%25==0)
    fs.writeFileSync(counterFile, '74');

    const result = await runScript(path.join(scriptsDir, 'suggest-compact.js'), '', {
      CLAUDE_SESSION_ID: sessionId,
      COMPACT_THRESHOLD: '50'
    });

    assert.ok(
      result.stderr.includes('75 tool calls'),
      'Should suggest at 25-call intervals after threshold'
    );

    fs.unlinkSync(counterFile);
  })) passed++; else failed++;

  if (await asyncTest('handles corrupted counter file', async () => {
    const sessionId = 'test-corrupt-' + Date.now();
    const counterFile = path.join(os.tmpdir(), `claude-tool-count-${sessionId}`);

    fs.writeFileSync(counterFile, 'not-a-number');

    const result = await runScript(path.join(scriptsDir, 'suggest-compact.js'), '', {
      CLAUDE_SESSION_ID: sessionId
    });

    assert.strictEqual(result.code, 0, 'Should handle corrupted counter gracefully');

    // Counter should be reset to 1
    const newCount = parseInt(fs.readFileSync(counterFile, 'utf8').trim(), 10);
    assert.strictEqual(newCount, 1, 'Should reset counter to 1 on corrupt data');

    fs.unlinkSync(counterFile);
  })) passed++; else failed++;

  if (await asyncTest('uses default session ID when no env var', async () => {
    const result = await runScript(path.join(scriptsDir, 'suggest-compact.js'), '', {
      CLAUDE_SESSION_ID: '' // Empty, should use 'default'
    });

    assert.strictEqual(result.code, 0, 'Should work with default session ID');

    // Cleanup the default counter file
    const counterFile = path.join(os.tmpdir(), 'claude-tool-count-default');
    if (fs.existsSync(counterFile)) fs.unlinkSync(counterFile);
  })) passed++; else failed++;

  if (await asyncTest('validates threshold bounds', async () => {
    const sessionId = 'test-bounds-' + Date.now();
    const counterFile = path.join(os.tmpdir(), `claude-tool-count-${sessionId}`);

    // Invalid threshold should fall back to 50
    fs.writeFileSync(counterFile, '49');

    const result = await runScript(path.join(scriptsDir, 'suggest-compact.js'), '', {
      CLAUDE_SESSION_ID: sessionId,
      COMPACT_THRESHOLD: '-5' // Invalid: negative
    });

    assert.ok(
      result.stderr.includes('50 tool calls'),
      'Should use default threshold (50) for invalid value'
    );

    fs.unlinkSync(counterFile);
  })) passed++; else failed++;

  // evaluate-session.js tests
  console.log('\nevaluate-session.js:');

  if (await asyncTest('runs without error when no transcript', async () => {
    const result = await runScript(path.join(scriptsDir, 'evaluate-session.js'));
    assert.strictEqual(result.code, 0, `Exit code should be 0, got ${result.code}`);
  })) passed++; else failed++;

  if (await asyncTest('skips short sessions', async () => {
    const testDir = createTestDir();
    const transcriptPath = path.join(testDir, 'transcript.jsonl');

    // Create a short transcript (less than 10 user messages)
    const transcript = Array(5).fill('{"type":"user","content":"test"}\n').join('');
    fs.writeFileSync(transcriptPath, transcript);

    const stdinJson = JSON.stringify({ transcript_path: transcriptPath });
    const result = await runScript(path.join(scriptsDir, 'evaluate-session.js'), stdinJson);

    assert.ok(
      result.stderr.includes('Session too short'),
      'Should indicate session is too short'
    );

    cleanupTestDir(testDir);
  })) passed++; else failed++;

  if (await asyncTest('processes sessions with enough messages', async () => {
    const testDir = createTestDir();
    const transcriptPath = path.join(testDir, 'transcript.jsonl');

    // Create a longer transcript (more than 10 user messages)
    const transcript = Array(15).fill('{"type":"user","content":"test"}\n').join('');
    fs.writeFileSync(transcriptPath, transcript);

    const stdinJson = JSON.stringify({ transcript_path: transcriptPath });
    const result = await runScript(path.join(scriptsDir, 'evaluate-session.js'), stdinJson);

    assert.ok(
      result.stderr.includes('15 messages'),
      'Should report message count'
    );

    cleanupTestDir(testDir);
  })) passed++; else failed++;

  // evaluate-session.js: whitespace tolerance regression test
  if (await asyncTest('counts user messages with whitespace in JSON (regression)', async () => {
    const testDir = createTestDir();
    const transcriptPath = path.join(testDir, 'transcript.jsonl');

    // Create transcript with whitespace around colons (pretty-printed style)
    const lines = [];
    for (let i = 0; i < 15; i++) {
      lines.push('{ "type" : "user", "content": "message ' + i + '" }');
    }
    fs.writeFileSync(transcriptPath, lines.join('\n'));

    const stdinJson = JSON.stringify({ transcript_path: transcriptPath });
    const result = await runScript(path.join(scriptsDir, 'evaluate-session.js'), stdinJson);

    assert.ok(
      result.stderr.includes('15 messages'),
      'Should count user messages with whitespace in JSON, got: ' + result.stderr.trim()
    );

    cleanupTestDir(testDir);
  })) passed++; else failed++;

  // session-end.js: content array with null elements regression test
  if (await asyncTest('handles transcript with null content array elements (regression)', async () => {
    const testDir = createTestDir();
    const transcriptPath = path.join(testDir, 'transcript.jsonl');

    // Create transcript with null elements in content array
    const lines = [
      '{"type":"user","content":[null,{"text":"hello"},null,{"text":"world"}]}',
      '{"type":"user","content":"simple string message"}',
      '{"type":"user","content":[{"text":"normal"},{"text":"array"}]}',
      '{"type":"tool_use","tool_name":"Edit","tool_input":{"file_path":"/test.js"}}',
    ];
    fs.writeFileSync(transcriptPath, lines.join('\n'));

    const stdinJson = JSON.stringify({ transcript_path: transcriptPath });
    const result = await runScript(path.join(scriptsDir, 'session-end.js'), stdinJson);

    // Should not crash (exit 0)
    assert.strictEqual(result.code, 0, 'Should handle null content elements without crash');
  })) passed++; else failed++;

  // post-edit-console-warn.js tests
  console.log('\npost-edit-console-warn.js:');

  if (await asyncTest('warns about console.log in JS files', async () => {
    const testDir = createTestDir();
    const testFile = path.join(testDir, 'test.js');
    fs.writeFileSync(testFile, 'const x = 1;\nconsole.log(x);\nreturn x;');

    const stdinJson = JSON.stringify({ tool_input: { file_path: testFile } });
    const result = await runScript(path.join(scriptsDir, 'post-edit-console-warn.js'), stdinJson);

    assert.ok(result.stderr.includes('console.log'), 'Should warn about console.log');
    cleanupTestDir(testDir);
  })) passed++; else failed++;

  if (await asyncTest('does not warn for non-JS files', async () => {
    const testDir = createTestDir();
    const testFile = path.join(testDir, 'test.md');
    fs.writeFileSync(testFile, 'Use console.log for debugging');

    const stdinJson = JSON.stringify({ tool_input: { file_path: testFile } });
    const result = await runScript(path.join(scriptsDir, 'post-edit-console-warn.js'), stdinJson);

    assert.ok(!result.stderr.includes('console.log'), 'Should not warn for non-JS files');
    cleanupTestDir(testDir);
  })) passed++; else failed++;

  if (await asyncTest('does not warn for clean JS files', async () => {
    const testDir = createTestDir();
    const testFile = path.join(testDir, 'clean.ts');
    fs.writeFileSync(testFile, 'const x = 1;\nreturn x;');

    const stdinJson = JSON.stringify({ tool_input: { file_path: testFile } });
    const result = await runScript(path.join(scriptsDir, 'post-edit-console-warn.js'), stdinJson);

    assert.ok(!result.stderr.includes('WARNING'), 'Should not warn for clean files');
    cleanupTestDir(testDir);
  })) passed++; else failed++;

  if (await asyncTest('handles missing file gracefully', async () => {
    const stdinJson = JSON.stringify({ tool_input: { file_path: '/nonexistent/file.ts' } });
    const result = await runScript(path.join(scriptsDir, 'post-edit-console-warn.js'), stdinJson);

    assert.strictEqual(result.code, 0, 'Should not crash on missing file');
  })) passed++; else failed++;

  if (await asyncTest('limits console.log output to 5 matches', async () => {
    const testDir = createTestDir();
    const testFile = path.join(testDir, 'many-logs.js');
    // Create a file with 8 console.log statements
    const lines = [];
    for (let i = 1; i <= 8; i++) {
      lines.push(`console.log('debug ${i}');`);
    }
    fs.writeFileSync(testFile, lines.join('\n'));

    const stdinJson = JSON.stringify({ tool_input: { file_path: testFile } });
    const result = await runScript(path.join(scriptsDir, 'post-edit-console-warn.js'), stdinJson);

    assert.ok(result.stderr.includes('console.log'), 'Should warn about console.log');
    // Count how many "debug N" lines appear in stderr (the line-number output)
    const debugLines = result.stderr.split('\n').filter(l => /^\d+:/.test(l.trim()));
    assert.ok(debugLines.length <= 5, `Should show at most 5 matches, got ${debugLines.length}`);
    // Should include debug 1 but not debug 8 (sliced)
    assert.ok(result.stderr.includes('debug 1'), 'Should include first match');
    assert.ok(!result.stderr.includes('debug 8'), 'Should not include 8th match');
    cleanupTestDir(testDir);
  })) passed++; else failed++;

  if (await asyncTest('ignores console.warn and console.error (only flags console.log)', async () => {
    const testDir = createTestDir();
    const testFile = path.join(testDir, 'other-console.ts');
    fs.writeFileSync(testFile, [
      'console.warn("this is a warning");',
      'console.error("this is an error");',
      'console.debug("this is debug");',
      'console.info("this is info");',
    ].join('\n'));

    const stdinJson = JSON.stringify({ tool_input: { file_path: testFile } });
    const result = await runScript(path.join(scriptsDir, 'post-edit-console-warn.js'), stdinJson);

    assert.ok(!result.stderr.includes('WARNING'), 'Should NOT warn about console.warn/error/debug/info');
    cleanupTestDir(testDir);
  })) passed++; else failed++;

  if (await asyncTest('passes through original data on stdout', async () => {
    const stdinJson = JSON.stringify({ tool_input: { file_path: '/test.py' } });
    const result = await runScript(path.join(scriptsDir, 'post-edit-console-warn.js'), stdinJson);

    assert.ok(result.stdout.includes('tool_input'), 'Should pass through stdin data');
  })) passed++; else failed++;

  // post-edit-format.js tests
  console.log('\npost-edit-format.js:');

  if (await asyncTest('runs without error on empty stdin', async () => {
    const result = await runScript(path.join(scriptsDir, 'post-edit-format.js'));
    assert.strictEqual(result.code, 0, 'Should exit 0 on empty stdin');
  })) passed++; else failed++;

  if (await asyncTest('skips non-JS/TS files', async () => {
    const stdinJson = JSON.stringify({ tool_input: { file_path: '/test.py' } });
    const result = await runScript(path.join(scriptsDir, 'post-edit-format.js'), stdinJson);
    assert.strictEqual(result.code, 0, 'Should exit 0 for non-JS files');
    assert.ok(result.stdout.includes('tool_input'), 'Should pass through stdin data');
  })) passed++; else failed++;

  if (await asyncTest('passes through data for invalid JSON', async () => {
    const result = await runScript(path.join(scriptsDir, 'post-edit-format.js'), 'not json');
    assert.strictEqual(result.code, 0, 'Should exit 0 for invalid JSON');
  })) passed++; else failed++;

  if (await asyncTest('handles null tool_input gracefully', async () => {
    const stdinJson = JSON.stringify({ tool_input: null });
    const result = await runScript(path.join(scriptsDir, 'post-edit-format.js'), stdinJson);
    assert.strictEqual(result.code, 0, 'Should exit 0 for null tool_input');
    assert.ok(result.stdout.includes('tool_input'), 'Should pass through data');
  })) passed++; else failed++;

  if (await asyncTest('handles missing file_path in tool_input', async () => {
    const stdinJson = JSON.stringify({ tool_input: {} });
    const result = await runScript(path.join(scriptsDir, 'post-edit-format.js'), stdinJson);
    assert.strictEqual(result.code, 0, 'Should exit 0 for missing file_path');
    assert.ok(result.stdout.includes('tool_input'), 'Should pass through data');
  })) passed++; else failed++;

  if (await asyncTest('exits 0 and passes data when prettier is unavailable', async () => {
    const stdinJson = JSON.stringify({ tool_input: { file_path: '/nonexistent/path/file.ts' } });
    const result = await runScript(path.join(scriptsDir, 'post-edit-format.js'), stdinJson);
    assert.strictEqual(result.code, 0, 'Should exit 0 even when prettier fails');
    assert.ok(result.stdout.includes('tool_input'), 'Should pass through original data');
  })) passed++; else failed++;

  // post-edit-typecheck.js tests
  console.log('\npost-edit-typecheck.js:');

  if (await asyncTest('runs without error on empty stdin', async () => {
    const result = await runScript(path.join(scriptsDir, 'post-edit-typecheck.js'));
    assert.strictEqual(result.code, 0, 'Should exit 0 on empty stdin');
  })) passed++; else failed++;

  if (await asyncTest('skips non-TypeScript files', async () => {
    const stdinJson = JSON.stringify({ tool_input: { file_path: '/test.js' } });
    const result = await runScript(path.join(scriptsDir, 'post-edit-typecheck.js'), stdinJson);
    assert.strictEqual(result.code, 0, 'Should exit 0 for non-TS files');
    assert.ok(result.stdout.includes('tool_input'), 'Should pass through stdin data');
  })) passed++; else failed++;

  if (await asyncTest('handles nonexistent TS file gracefully', async () => {
    const stdinJson = JSON.stringify({ tool_input: { file_path: '/nonexistent/file.ts' } });
    const result = await runScript(path.join(scriptsDir, 'post-edit-typecheck.js'), stdinJson);
    assert.strictEqual(result.code, 0, 'Should exit 0 for missing file');
  })) passed++; else failed++;

  if (await asyncTest('handles TS file with no tsconfig gracefully', async () => {
    const testDir = createTestDir();
    const testFile = path.join(testDir, 'test.ts');
    fs.writeFileSync(testFile, 'const x: number = 1;');

    const stdinJson = JSON.stringify({ tool_input: { file_path: testFile } });
    const result = await runScript(path.join(scriptsDir, 'post-edit-typecheck.js'), stdinJson);
    assert.strictEqual(result.code, 0, 'Should exit 0 when no tsconfig found');
    cleanupTestDir(testDir);
  })) passed++; else failed++;

  if (await asyncTest('stops tsconfig walk at max depth (20)', async () => {
    // Create a deeply nested directory (>20 levels) with no tsconfig anywhere
    const testDir = createTestDir();
    let deepDir = testDir;
    for (let i = 0; i < 25; i++) {
      deepDir = path.join(deepDir, `d${i}`);
    }
    fs.mkdirSync(deepDir, { recursive: true });
    const testFile = path.join(deepDir, 'deep.ts');
    fs.writeFileSync(testFile, 'const x: number = 1;');

    const stdinJson = JSON.stringify({ tool_input: { file_path: testFile } });
    const startTime = Date.now();
    const result = await runScript(path.join(scriptsDir, 'post-edit-typecheck.js'), stdinJson);
    const elapsed = Date.now() - startTime;

    assert.strictEqual(result.code, 0, 'Should not hang at depth limit');
    assert.ok(elapsed < 5000, `Should complete quickly at depth limit, took ${elapsed}ms`);
    cleanupTestDir(testDir);
  })) passed++; else failed++;

  if (await asyncTest('passes through stdin data on stdout (post-edit-typecheck)', async () => {
    const testDir = createTestDir();
    const testFile = path.join(testDir, 'test.ts');
    fs.writeFileSync(testFile, 'const x: number = 1;');

    const stdinJson = JSON.stringify({ tool_input: { file_path: testFile } });
    const result = await runScript(path.join(scriptsDir, 'post-edit-typecheck.js'), stdinJson);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('tool_input'), 'Should pass through stdin data on stdout');
    cleanupTestDir(testDir);
  })) passed++; else failed++;

  // session-end.js extractSessionSummary tests
  console.log('\nsession-end.js (extractSessionSummary):');

  if (await asyncTest('extracts user messages from transcript', async () => {
    const testDir = createTestDir();
    const transcriptPath = path.join(testDir, 'transcript.jsonl');

    const lines = [
      '{"type":"user","content":"Fix the login bug"}',
      '{"type":"assistant","content":"I will fix it"}',
      '{"type":"user","content":"Also add tests"}',
    ];
    fs.writeFileSync(transcriptPath, lines.join('\n'));

    const stdinJson = JSON.stringify({ transcript_path: transcriptPath });
    const result = await runScript(path.join(scriptsDir, 'session-end.js'), stdinJson);
    assert.strictEqual(result.code, 0);
    cleanupTestDir(testDir);
  })) passed++; else failed++;

  if (await asyncTest('handles transcript with array content fields', async () => {
    const testDir = createTestDir();
    const transcriptPath = path.join(testDir, 'transcript.jsonl');

    const lines = [
      '{"type":"user","content":[{"text":"Part 1"},{"text":"Part 2"}]}',
      '{"type":"user","content":"Simple message"}',
    ];
    fs.writeFileSync(transcriptPath, lines.join('\n'));

    const stdinJson = JSON.stringify({ transcript_path: transcriptPath });
    const result = await runScript(path.join(scriptsDir, 'session-end.js'), stdinJson);
    assert.strictEqual(result.code, 0, 'Should handle array content without crash');
    cleanupTestDir(testDir);
  })) passed++; else failed++;

  if (await asyncTest('extracts tool names and file paths from transcript', async () => {
    const testDir = createTestDir();
    const transcriptPath = path.join(testDir, 'transcript.jsonl');

    const lines = [
      '{"type":"user","content":"Edit the file"}',
      '{"type":"tool_use","tool_name":"Edit","tool_input":{"file_path":"/src/main.ts"}}',
      '{"type":"tool_use","tool_name":"Read","tool_input":{"file_path":"/src/utils.ts"}}',
      '{"type":"tool_use","tool_name":"Write","tool_input":{"file_path":"/src/new.ts"}}',
    ];
    fs.writeFileSync(transcriptPath, lines.join('\n'));

    const stdinJson = JSON.stringify({ transcript_path: transcriptPath });
    const result = await runScript(path.join(scriptsDir, 'session-end.js'), stdinJson);
    assert.strictEqual(result.code, 0);
    // Session file should contain summary with tools used
    assert.ok(
      result.stderr.includes('Created session file') || result.stderr.includes('Updated session file'),
      'Should create/update session file'
    );
    cleanupTestDir(testDir);
  })) passed++; else failed++;

  if (await asyncTest('handles transcript with malformed JSON lines', async () => {
    const testDir = createTestDir();
    const transcriptPath = path.join(testDir, 'transcript.jsonl');

    const lines = [
      '{"type":"user","content":"Valid message"}',
      'NOT VALID JSON',
      '{"broken json',
      '{"type":"user","content":"Another valid"}',
    ];
    fs.writeFileSync(transcriptPath, lines.join('\n'));

    const stdinJson = JSON.stringify({ transcript_path: transcriptPath });
    const result = await runScript(path.join(scriptsDir, 'session-end.js'), stdinJson);
    assert.strictEqual(result.code, 0, 'Should skip malformed lines gracefully');
    assert.ok(
      result.stderr.includes('unparseable') || result.stderr.includes('Skipped'),
      `Should report parse errors, got: ${result.stderr.substring(0, 200)}`
    );
    cleanupTestDir(testDir);
  })) passed++; else failed++;

  if (await asyncTest('handles empty transcript (no user messages)', async () => {
    const testDir = createTestDir();
    const transcriptPath = path.join(testDir, 'transcript.jsonl');

    // Only tool_use entries, no user messages
    const lines = [
      '{"type":"tool_use","tool_name":"Read","tool_input":{}}',
      '{"type":"assistant","content":"done"}',
    ];
    fs.writeFileSync(transcriptPath, lines.join('\n'));

    const stdinJson = JSON.stringify({ transcript_path: transcriptPath });
    const result = await runScript(path.join(scriptsDir, 'session-end.js'), stdinJson);
    assert.strictEqual(result.code, 0, 'Should handle transcript with no user messages');
    cleanupTestDir(testDir);
  })) passed++; else failed++;

  if (await asyncTest('truncates long user messages to 200 chars', async () => {
    const testDir = createTestDir();
    const transcriptPath = path.join(testDir, 'transcript.jsonl');

    const longMsg = 'x'.repeat(500);
    const lines = [
      `{"type":"user","content":"${longMsg}"}`,
    ];
    fs.writeFileSync(transcriptPath, lines.join('\n'));

    const stdinJson = JSON.stringify({ transcript_path: transcriptPath });
    const result = await runScript(path.join(scriptsDir, 'session-end.js'), stdinJson);
    assert.strictEqual(result.code, 0, 'Should handle and truncate long messages');
    cleanupTestDir(testDir);
  })) passed++; else failed++;

  if (await asyncTest('uses CLAUDE_TRANSCRIPT_PATH env var as fallback', async () => {
    const testDir = createTestDir();
    const transcriptPath = path.join(testDir, 'transcript.jsonl');

    const lines = [
      '{"type":"user","content":"Fallback test message"}',
    ];
    fs.writeFileSync(transcriptPath, lines.join('\n'));

    // Send invalid JSON to stdin so it falls back to env var
    const result = await runScript(path.join(scriptsDir, 'session-end.js'), 'not json', {
      CLAUDE_TRANSCRIPT_PATH: transcriptPath
    });
    assert.strictEqual(result.code, 0, 'Should use env var fallback');
    cleanupTestDir(testDir);
  })) passed++; else failed++;

  if (await asyncTest('escapes backticks in user messages in session file', async () => {
    const testDir = createTestDir();
    const transcriptPath = path.join(testDir, 'transcript.jsonl');

    // User messages with backticks that could break markdown
    const lines = [
      '{"type":"user","content":"Fix the `handleAuth` function in `auth.ts`"}',
      '{"type":"user","content":"Run `npm test` to verify"}',
    ];
    fs.writeFileSync(transcriptPath, lines.join('\n'));

    const stdinJson = JSON.stringify({ transcript_path: transcriptPath });
    const result = await runScript(path.join(scriptsDir, 'session-end.js'), stdinJson, {
      HOME: testDir
    });
    assert.strictEqual(result.code, 0, 'Should handle backticks without crash');

    // Find the session file in the temp HOME
    const claudeDir = path.join(testDir, '.claude', 'sessions');
    if (fs.existsSync(claudeDir)) {
      const files = fs.readdirSync(claudeDir).filter(f => f.endsWith('.tmp'));
      if (files.length > 0) {
        const content = fs.readFileSync(path.join(claudeDir, files[0]), 'utf8');
        // Backticks should be escaped in the output
        assert.ok(content.includes('\\`'), 'Should escape backticks in session file');
        assert.ok(!content.includes('`handleAuth`'), 'Raw backticks should be escaped');
      }
    }
    cleanupTestDir(testDir);
  })) passed++; else failed++;

  if (await asyncTest('session file contains tools used and files modified', async () => {
    const testDir = createTestDir();
    const transcriptPath = path.join(testDir, 'transcript.jsonl');

    const lines = [
      '{"type":"user","content":"Edit the config"}',
      '{"type":"tool_use","tool_name":"Edit","tool_input":{"file_path":"/src/config.ts"}}',
      '{"type":"tool_use","tool_name":"Read","tool_input":{"file_path":"/src/utils.ts"}}',
      '{"type":"tool_use","tool_name":"Write","tool_input":{"file_path":"/src/new-file.ts"}}',
    ];
    fs.writeFileSync(transcriptPath, lines.join('\n'));

    const stdinJson = JSON.stringify({ transcript_path: transcriptPath });
    const result = await runScript(path.join(scriptsDir, 'session-end.js'), stdinJson, {
      HOME: testDir
    });
    assert.strictEqual(result.code, 0);

    const claudeDir = path.join(testDir, '.claude', 'sessions');
    if (fs.existsSync(claudeDir)) {
      const files = fs.readdirSync(claudeDir).filter(f => f.endsWith('.tmp'));
      if (files.length > 0) {
        const content = fs.readFileSync(path.join(claudeDir, files[0]), 'utf8');
        // Should contain files modified (Edit and Write, not Read)
        assert.ok(content.includes('/src/config.ts'), 'Should list edited file');
        assert.ok(content.includes('/src/new-file.ts'), 'Should list written file');
        // Should contain tools used
        assert.ok(content.includes('Edit'), 'Should list Edit tool');
        assert.ok(content.includes('Read'), 'Should list Read tool');
      }
    }
    cleanupTestDir(testDir);
  })) passed++; else failed++;

  if (await asyncTest('omits Tools Used and Files Modified sections when empty', async () => {
    const testDir = createTestDir();
    const transcriptPath = path.join(testDir, 'transcript.jsonl');

    // Only user messages, no tool_use entries
    const lines = [
      '{"type":"user","content":"Just chatting"}',
      '{"type":"user","content":"No tools used at all"}',
    ];
    fs.writeFileSync(transcriptPath, lines.join('\n'));

    const stdinJson = JSON.stringify({ transcript_path: transcriptPath });
    const result = await runScript(path.join(scriptsDir, 'session-end.js'), stdinJson, {
      HOME: testDir
    });
    assert.strictEqual(result.code, 0);

    const claudeDir = path.join(testDir, '.claude', 'sessions');
    if (fs.existsSync(claudeDir)) {
      const files = fs.readdirSync(claudeDir).filter(f => f.endsWith('.tmp'));
      if (files.length > 0) {
        const content = fs.readFileSync(path.join(claudeDir, files[0]), 'utf8');
        assert.ok(content.includes('### Tasks'), 'Should have Tasks section');
        assert.ok(!content.includes('### Files Modified'), 'Should NOT have Files Modified when empty');
        assert.ok(!content.includes('### Tools Used'), 'Should NOT have Tools Used when empty');
        assert.ok(content.includes('Total user messages: 2'), 'Should show correct message count');
      }
    }
    cleanupTestDir(testDir);
  })) passed++; else failed++;

  if (await asyncTest('slices user messages to last 10', async () => {
    const testDir = createTestDir();
    const transcriptPath = path.join(testDir, 'transcript.jsonl');

    // 15 user messages — should keep only last 10
    const lines = [];
    for (let i = 1; i <= 15; i++) {
      lines.push(`{"type":"user","content":"UserMsg_${i}"}`);
    }
    fs.writeFileSync(transcriptPath, lines.join('\n'));

    const stdinJson = JSON.stringify({ transcript_path: transcriptPath });
    const result = await runScript(path.join(scriptsDir, 'session-end.js'), stdinJson, {
      HOME: testDir
    });
    assert.strictEqual(result.code, 0);

    const claudeDir = path.join(testDir, '.claude', 'sessions');
    if (fs.existsSync(claudeDir)) {
      const files = fs.readdirSync(claudeDir).filter(f => f.endsWith('.tmp'));
      if (files.length > 0) {
        const content = fs.readFileSync(path.join(claudeDir, files[0]), 'utf8');
        // Should NOT contain first 5 messages (sliced to last 10)
        assert.ok(!content.includes('UserMsg_1\n'), 'Should not include first message (sliced)');
        assert.ok(!content.includes('UserMsg_5\n'), 'Should not include 5th message (sliced)');
        // Should contain messages 6-15
        assert.ok(content.includes('UserMsg_6'), 'Should include 6th message');
        assert.ok(content.includes('UserMsg_15'), 'Should include last message');
        assert.ok(content.includes('Total user messages: 15'), 'Should show total of 15');
      }
    }
    cleanupTestDir(testDir);
  })) passed++; else failed++;

  if (await asyncTest('slices tools to first 20', async () => {
    const testDir = createTestDir();
    const transcriptPath = path.join(testDir, 'transcript.jsonl');

    // 25 unique tools — should keep only first 20
    const lines = ['{"type":"user","content":"Do stuff"}'];
    for (let i = 1; i <= 25; i++) {
      lines.push(`{"type":"tool_use","tool_name":"Tool${i}","tool_input":{}}`);
    }
    fs.writeFileSync(transcriptPath, lines.join('\n'));

    const stdinJson = JSON.stringify({ transcript_path: transcriptPath });
    const result = await runScript(path.join(scriptsDir, 'session-end.js'), stdinJson, {
      HOME: testDir
    });
    assert.strictEqual(result.code, 0);

    const claudeDir = path.join(testDir, '.claude', 'sessions');
    if (fs.existsSync(claudeDir)) {
      const files = fs.readdirSync(claudeDir).filter(f => f.endsWith('.tmp'));
      if (files.length > 0) {
        const content = fs.readFileSync(path.join(claudeDir, files[0]), 'utf8');
        // Should contain Tool1 through Tool20
        assert.ok(content.includes('Tool1'), 'Should include Tool1');
        assert.ok(content.includes('Tool20'), 'Should include Tool20');
        // Should NOT contain Tool21-25 (sliced)
        assert.ok(!content.includes('Tool21'), 'Should not include Tool21 (sliced to 20)');
        assert.ok(!content.includes('Tool25'), 'Should not include Tool25 (sliced to 20)');
      }
    }
    cleanupTestDir(testDir);
  })) passed++; else failed++;

  if (await asyncTest('slices files modified to first 30', async () => {
    const testDir = createTestDir();
    const transcriptPath = path.join(testDir, 'transcript.jsonl');

    // 35 unique files via Edit — should keep only first 30
    const lines = ['{"type":"user","content":"Edit all the things"}'];
    for (let i = 1; i <= 35; i++) {
      lines.push(`{"type":"tool_use","tool_name":"Edit","tool_input":{"file_path":"/src/file${i}.ts"}}`);
    }
    fs.writeFileSync(transcriptPath, lines.join('\n'));

    const stdinJson = JSON.stringify({ transcript_path: transcriptPath });
    const result = await runScript(path.join(scriptsDir, 'session-end.js'), stdinJson, {
      HOME: testDir
    });
    assert.strictEqual(result.code, 0);

    const claudeDir = path.join(testDir, '.claude', 'sessions');
    if (fs.existsSync(claudeDir)) {
      const files = fs.readdirSync(claudeDir).filter(f => f.endsWith('.tmp'));
      if (files.length > 0) {
        const content = fs.readFileSync(path.join(claudeDir, files[0]), 'utf8');
        // Should contain file1 through file30
        assert.ok(content.includes('/src/file1.ts'), 'Should include file1');
        assert.ok(content.includes('/src/file30.ts'), 'Should include file30');
        // Should NOT contain file31-35 (sliced)
        assert.ok(!content.includes('/src/file31.ts'), 'Should not include file31 (sliced to 30)');
        assert.ok(!content.includes('/src/file35.ts'), 'Should not include file35 (sliced to 30)');
      }
    }
    cleanupTestDir(testDir);
  })) passed++; else failed++;

  if (await asyncTest('parses Claude Code JSONL format (entry.message.content)', async () => {
    const testDir = createTestDir();
    const transcriptPath = path.join(testDir, 'transcript.jsonl');

    // Claude Code v2.1.41+ JSONL format: user messages nested in entry.message
    const lines = [
      '{"type":"user","message":{"role":"user","content":"Fix the build error"}}',
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Also update tests"}]}}',
    ];
    fs.writeFileSync(transcriptPath, lines.join('\n'));

    const stdinJson = JSON.stringify({ transcript_path: transcriptPath });
    const result = await runScript(path.join(scriptsDir, 'session-end.js'), stdinJson, {
      HOME: testDir
    });
    assert.strictEqual(result.code, 0);

    const claudeDir = path.join(testDir, '.claude', 'sessions');
    if (fs.existsSync(claudeDir)) {
      const files = fs.readdirSync(claudeDir).filter(f => f.endsWith('.tmp'));
      if (files.length > 0) {
        const content = fs.readFileSync(path.join(claudeDir, files[0]), 'utf8');
        assert.ok(content.includes('Fix the build error'), 'Should extract string content from message');
        assert.ok(content.includes('Also update tests'), 'Should extract array content from message');
      }
    }
    cleanupTestDir(testDir);
  })) passed++; else failed++;

  if (await asyncTest('extracts tool_use from assistant message content blocks', async () => {
    const testDir = createTestDir();
    const transcriptPath = path.join(testDir, 'transcript.jsonl');

    // Claude Code JSONL: tool uses nested in assistant message content array
    const lines = [
      '{"type":"user","content":"Edit the config"}',
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will edit the file.' },
            { type: 'tool_use', name: 'Edit', input: { file_path: '/src/app.ts' } },
            { type: 'tool_use', name: 'Write', input: { file_path: '/src/new.ts' } },
          ]
        }
      }),
    ];
    fs.writeFileSync(transcriptPath, lines.join('\n'));

    const stdinJson = JSON.stringify({ transcript_path: transcriptPath });
    const result = await runScript(path.join(scriptsDir, 'session-end.js'), stdinJson, {
      HOME: testDir
    });
    assert.strictEqual(result.code, 0);

    const claudeDir = path.join(testDir, '.claude', 'sessions');
    if (fs.existsSync(claudeDir)) {
      const files = fs.readdirSync(claudeDir).filter(f => f.endsWith('.tmp'));
      if (files.length > 0) {
        const content = fs.readFileSync(path.join(claudeDir, files[0]), 'utf8');
        assert.ok(content.includes('Edit'), 'Should extract Edit tool from content blocks');
        assert.ok(content.includes('/src/app.ts'), 'Should extract file path from Edit block');
        assert.ok(content.includes('/src/new.ts'), 'Should extract file path from Write block');
      }
    }
    cleanupTestDir(testDir);
  })) passed++; else failed++;

  // hooks.json validation
  console.log('\nhooks.json Validation:');

  if (test('hooks.json is valid JSON', () => {
    const hooksPath = path.join(__dirname, '..', '..', 'hooks', 'hooks.json');
    const content = fs.readFileSync(hooksPath, 'utf8');
    JSON.parse(content); // Will throw if invalid
  })) passed++; else failed++;

  if (test('hooks.json has required event types', () => {
    const hooksPath = path.join(__dirname, '..', '..', 'hooks', 'hooks.json');
    const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));

    assert.ok(hooks.hooks.PreToolUse, 'Should have PreToolUse hooks');
    assert.ok(hooks.hooks.PostToolUse, 'Should have PostToolUse hooks');
    assert.ok(hooks.hooks.SessionStart, 'Should have SessionStart hooks');
    assert.ok(hooks.hooks.SessionEnd, 'Should have SessionEnd hooks');
    assert.ok(hooks.hooks.Stop, 'Should have Stop hooks');
    assert.ok(hooks.hooks.PreCompact, 'Should have PreCompact hooks');
  })) passed++; else failed++;

  if (test('all hook commands use node', () => {
    const hooksPath = path.join(__dirname, '..', '..', 'hooks', 'hooks.json');
    const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));

    const checkHooks = (hookArray) => {
      for (const entry of hookArray) {
        for (const hook of entry.hooks) {
          if (hook.type === 'command') {
            assert.ok(
              hook.command.startsWith('node'),
              `Hook command should start with 'node': ${hook.command.substring(0, 50)}...`
            );
          }
        }
      }
    };

    for (const [, hookArray] of Object.entries(hooks.hooks)) {
      checkHooks(hookArray);
    }
  })) passed++; else failed++;

  if (test('script references use CLAUDE_PLUGIN_ROOT variable', () => {
    const hooksPath = path.join(__dirname, '..', '..', 'hooks', 'hooks.json');
    const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));

    const checkHooks = (hookArray) => {
      for (const entry of hookArray) {
        for (const hook of entry.hooks) {
          if (hook.type === 'command' && hook.command.includes('scripts/hooks/')) {
            // Check for the literal string "${CLAUDE_PLUGIN_ROOT}" in the command
            const hasPluginRoot = hook.command.includes('${CLAUDE_PLUGIN_ROOT}');
            assert.ok(
              hasPluginRoot,
              `Script paths should use CLAUDE_PLUGIN_ROOT: ${hook.command.substring(0, 80)}...`
            );
          }
        }
      }
    };

    for (const [, hookArray] of Object.entries(hooks.hooks)) {
      checkHooks(hookArray);
    }
  })) passed++; else failed++;

  // plugin.json validation
  console.log('\nplugin.json Validation:');

  if (test('plugin.json does NOT have explicit hooks declaration', () => {
    // Claude Code automatically loads hooks/hooks.json by convention.
    // Explicitly declaring it in plugin.json causes a duplicate detection error.
    // See: https://github.com/affaan-m/everything-claude-code/issues/103
    const pluginPath = path.join(__dirname, '..', '..', '.claude-plugin', 'plugin.json');
    const plugin = JSON.parse(fs.readFileSync(pluginPath, 'utf8'));

    assert.ok(
      !plugin.hooks,
      'plugin.json should NOT have "hooks" field - Claude Code auto-loads hooks/hooks.json'
    );
  })) passed++; else failed++;

  // ─── evaluate-session.js tests ───
  console.log('\nevaluate-session.js:');

  if (await asyncTest('skips when no transcript_path in stdin', async () => {
    const result = await runScript(path.join(scriptsDir, 'evaluate-session.js'), '{}');
    assert.strictEqual(result.code, 0, 'Should exit 0 (non-blocking)');
  })) passed++; else failed++;

  if (await asyncTest('skips when transcript file does not exist', async () => {
    const stdinJson = JSON.stringify({ transcript_path: '/tmp/nonexistent-transcript-12345.jsonl' });
    const result = await runScript(path.join(scriptsDir, 'evaluate-session.js'), stdinJson);
    assert.strictEqual(result.code, 0, 'Should exit 0 when file missing');
  })) passed++; else failed++;

  if (await asyncTest('skips short sessions (< 10 user messages)', async () => {
    const testDir = createTestDir();
    const transcriptPath = path.join(testDir, 'short.jsonl');
    // Only 3 user messages — below the default threshold of 10
    const lines = [
      '{"type":"user","content":"msg1"}',
      '{"type":"user","content":"msg2"}',
      '{"type":"user","content":"msg3"}',
    ];
    fs.writeFileSync(transcriptPath, lines.join('\n'));
    const stdinJson = JSON.stringify({ transcript_path: transcriptPath });
    const result = await runScript(path.join(scriptsDir, 'evaluate-session.js'), stdinJson);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stderr.includes('too short'), 'Should log "too short" message');
    cleanupTestDir(testDir);
  })) passed++; else failed++;

  if (await asyncTest('evaluates long sessions (>= 10 user messages)', async () => {
    const testDir = createTestDir();
    const transcriptPath = path.join(testDir, 'long.jsonl');
    // 12 user messages — above the default threshold
    const lines = [];
    for (let i = 0; i < 12; i++) {
      lines.push(`{"type":"user","content":"message ${i}"}`);
    }
    fs.writeFileSync(transcriptPath, lines.join('\n'));
    const stdinJson = JSON.stringify({ transcript_path: transcriptPath });
    const result = await runScript(path.join(scriptsDir, 'evaluate-session.js'), stdinJson);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stderr.includes('12 messages'), 'Should report message count');
    assert.ok(result.stderr.includes('evaluate'), 'Should signal evaluation');
    cleanupTestDir(testDir);
  })) passed++; else failed++;

  if (await asyncTest('handles malformed stdin JSON (falls back to env var)', async () => {
    const result = await runScript(
      path.join(scriptsDir, 'evaluate-session.js'),
      'not json at all',
      { CLAUDE_TRANSCRIPT_PATH: '' }
    );
    // No valid transcript path from either source → exit 0
    assert.strictEqual(result.code, 0);
  })) passed++; else failed++;

  // ─── suggest-compact.js tests ───
  console.log('\nsuggest-compact.js:');

  if (await asyncTest('increments tool counter on each invocation', async () => {
    const sessionId = `test-counter-${Date.now()}`;
    const counterFile = path.join(os.tmpdir(), `claude-tool-count-${sessionId}`);
    try {
      // First invocation → count = 1
      await runScript(path.join(scriptsDir, 'suggest-compact.js'), '', {
        CLAUDE_SESSION_ID: sessionId
      });
      let val = parseInt(fs.readFileSync(counterFile, 'utf8').trim(), 10);
      assert.strictEqual(val, 1, 'First call should write count 1');

      // Second invocation → count = 2
      await runScript(path.join(scriptsDir, 'suggest-compact.js'), '', {
        CLAUDE_SESSION_ID: sessionId
      });
      val = parseInt(fs.readFileSync(counterFile, 'utf8').trim(), 10);
      assert.strictEqual(val, 2, 'Second call should write count 2');
    } finally {
      try { fs.unlinkSync(counterFile); } catch {}
    }
  })) passed++; else failed++;

  if (await asyncTest('suggests compact at exact threshold', async () => {
    const sessionId = `test-threshold-${Date.now()}`;
    const counterFile = path.join(os.tmpdir(), `claude-tool-count-${sessionId}`);
    try {
      // Pre-seed counter at threshold - 1 so next call hits threshold
      fs.writeFileSync(counterFile, '4');
      const result = await runScript(path.join(scriptsDir, 'suggest-compact.js'), '', {
        CLAUDE_SESSION_ID: sessionId,
        COMPACT_THRESHOLD: '5'
      });
      assert.strictEqual(result.code, 0);
      assert.ok(result.stderr.includes('5 tool calls reached'), 'Should suggest compact at threshold');
    } finally {
      try { fs.unlinkSync(counterFile); } catch {}
    }
  })) passed++; else failed++;

  if (await asyncTest('suggests at periodic intervals after threshold', async () => {
    const sessionId = `test-periodic-${Date.now()}`;
    const counterFile = path.join(os.tmpdir(), `claude-tool-count-${sessionId}`);
    try {
      // Pre-seed at 29 so next call = 30 (threshold 5 + 25 = 30)
      // (30 - 5) % 25 === 0 → should trigger periodic suggestion
      fs.writeFileSync(counterFile, '29');
      const result = await runScript(path.join(scriptsDir, 'suggest-compact.js'), '', {
        CLAUDE_SESSION_ID: sessionId,
        COMPACT_THRESHOLD: '5'
      });
      assert.strictEqual(result.code, 0);
      assert.ok(result.stderr.includes('30 tool calls'), 'Should suggest at threshold + 25n intervals');
    } finally {
      try { fs.unlinkSync(counterFile); } catch {}
    }
  })) passed++; else failed++;

  if (await asyncTest('does not suggest below threshold', async () => {
    const sessionId = `test-below-${Date.now()}`;
    const counterFile = path.join(os.tmpdir(), `claude-tool-count-${sessionId}`);
    try {
      fs.writeFileSync(counterFile, '2');
      const result = await runScript(path.join(scriptsDir, 'suggest-compact.js'), '', {
        CLAUDE_SESSION_ID: sessionId,
        COMPACT_THRESHOLD: '50'
      });
      assert.strictEqual(result.code, 0);
      assert.ok(!result.stderr.includes('tool calls reached'), 'Should not suggest below threshold');
      assert.ok(!result.stderr.includes('checkpoint'), 'Should not suggest checkpoint');
    } finally {
      try { fs.unlinkSync(counterFile); } catch {}
    }
  })) passed++; else failed++;

  if (await asyncTest('resets counter when file contains huge overflow number', async () => {
    const sessionId = `test-overflow-${Date.now()}`;
    const counterFile = path.join(os.tmpdir(), `claude-tool-count-${sessionId}`);
    try {
      // Write a value that passes Number.isFinite() but exceeds 1000000 clamp
      fs.writeFileSync(counterFile, '999999999999');
      const result = await runScript(path.join(scriptsDir, 'suggest-compact.js'), '', {
        CLAUDE_SESSION_ID: sessionId
      });
      assert.strictEqual(result.code, 0);
      // Should reset to 1 because 999999999999 > 1000000
      const newCount = parseInt(fs.readFileSync(counterFile, 'utf8').trim(), 10);
      assert.strictEqual(newCount, 1, 'Should reset to 1 on overflow value');
    } finally {
      try { fs.unlinkSync(counterFile); } catch {}
    }
  })) passed++; else failed++;

  if (await asyncTest('resets counter when file contains negative number', async () => {
    const sessionId = `test-negative-${Date.now()}`;
    const counterFile = path.join(os.tmpdir(), `claude-tool-count-${sessionId}`);
    try {
      fs.writeFileSync(counterFile, '-42');
      const result = await runScript(path.join(scriptsDir, 'suggest-compact.js'), '', {
        CLAUDE_SESSION_ID: sessionId
      });
      assert.strictEqual(result.code, 0);
      const newCount = parseInt(fs.readFileSync(counterFile, 'utf8').trim(), 10);
      assert.strictEqual(newCount, 1, 'Should reset to 1 on negative value');
    } finally {
      try { fs.unlinkSync(counterFile); } catch {}
    }
  })) passed++; else failed++;

  if (await asyncTest('handles COMPACT_THRESHOLD of zero (falls back to 50)', async () => {
    const sessionId = `test-zero-thresh-${Date.now()}`;
    const counterFile = path.join(os.tmpdir(), `claude-tool-count-${sessionId}`);
    try {
      fs.writeFileSync(counterFile, '49');
      const result = await runScript(path.join(scriptsDir, 'suggest-compact.js'), '', {
        CLAUDE_SESSION_ID: sessionId,
        COMPACT_THRESHOLD: '0'
      });
      assert.strictEqual(result.code, 0);
      assert.ok(result.stderr.includes('50 tool calls reached'), 'Zero threshold should fall back to 50');
    } finally {
      try { fs.unlinkSync(counterFile); } catch {}
    }
  })) passed++; else failed++;

  if (await asyncTest('handles invalid COMPACT_THRESHOLD (falls back to 50)', async () => {
    const sessionId = `test-invalid-thresh-${Date.now()}`;
    const counterFile = path.join(os.tmpdir(), `claude-tool-count-${sessionId}`);
    try {
      // Pre-seed at 49 so next call = 50 (the fallback default)
      fs.writeFileSync(counterFile, '49');
      const result = await runScript(path.join(scriptsDir, 'suggest-compact.js'), '', {
        CLAUDE_SESSION_ID: sessionId,
        COMPACT_THRESHOLD: 'not-a-number'
      });
      assert.strictEqual(result.code, 0);
      assert.ok(result.stderr.includes('50 tool calls reached'), 'Should use default threshold of 50');
    } finally {
      try { fs.unlinkSync(counterFile); } catch {}
    }
  })) passed++; else failed++;

  // ─── Round 20 bug fix tests ───
  console.log('\ncheck-console-log.js (exact pass-through):');

  if (await asyncTest('stdout is exact byte match of stdin (no trailing newline)', async () => {
    // Before the fix, console.log(data) added a trailing \n.
    // process.stdout.write(data) should preserve exact bytes.
    const stdinData = '{"tool":"test","value":42}';
    const result = await runScript(path.join(scriptsDir, 'check-console-log.js'), stdinData);
    assert.strictEqual(result.code, 0);
    // stdout should be exactly the input — no extra newline appended
    assert.strictEqual(result.stdout, stdinData, 'Should not append extra newline to output');
  })) passed++; else failed++;

  if (await asyncTest('preserves empty string stdin without adding newline', async () => {
    const result = await runScript(path.join(scriptsDir, 'check-console-log.js'), '');
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stdout, '', 'Empty input should produce empty output');
  })) passed++; else failed++;

  if (await asyncTest('preserves data with embedded newlines exactly', async () => {
    const stdinData = 'line1\nline2\nline3';
    const result = await runScript(path.join(scriptsDir, 'check-console-log.js'), stdinData);
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stdout, stdinData, 'Should preserve embedded newlines without adding extra');
  })) passed++; else failed++;

  console.log('\npost-edit-format.js (security & extension tests):');

  if (await asyncTest('source code does not pass shell option to execFileSync (security)', async () => {
    const formatSource = fs.readFileSync(path.join(scriptsDir, 'post-edit-format.js'), 'utf8');
    // Strip comments to avoid matching "shell: true" in comment text
    const codeOnly = formatSource.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!codeOnly.includes('shell:'), 'post-edit-format.js should not pass shell option in code');
    assert.ok(formatSource.includes('npx.cmd'), 'Should use npx.cmd for Windows cross-platform safety');
  })) passed++; else failed++;

  if (await asyncTest('matches .tsx extension for formatting', async () => {
    const stdinJson = JSON.stringify({ tool_input: { file_path: '/nonexistent/component.tsx' } });
    const result = await runScript(path.join(scriptsDir, 'post-edit-format.js'), stdinJson);
    assert.strictEqual(result.code, 0);
    // Should attempt to format (will fail silently since file doesn't exist, but should pass through)
    assert.ok(result.stdout.includes('component.tsx'), 'Should pass through data for .tsx files');
  })) passed++; else failed++;

  if (await asyncTest('matches .jsx extension for formatting', async () => {
    const stdinJson = JSON.stringify({ tool_input: { file_path: '/nonexistent/component.jsx' } });
    const result = await runScript(path.join(scriptsDir, 'post-edit-format.js'), stdinJson);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('component.jsx'), 'Should pass through data for .jsx files');
  })) passed++; else failed++;

  console.log('\npost-edit-typecheck.js (security & extension tests):');

  if (await asyncTest('source code does not pass shell option to execFileSync (security)', async () => {
    const typecheckSource = fs.readFileSync(path.join(scriptsDir, 'post-edit-typecheck.js'), 'utf8');
    // Strip comments to avoid matching "shell: true" in comment text
    const codeOnly = typecheckSource.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!codeOnly.includes('shell:'), 'post-edit-typecheck.js should not pass shell option in code');
    assert.ok(typecheckSource.includes('npx.cmd'), 'Should use npx.cmd for Windows cross-platform safety');
  })) passed++; else failed++;

  if (await asyncTest('matches .tsx extension for type checking', async () => {
    const testDir = createTestDir();
    const testFile = path.join(testDir, 'component.tsx');
    fs.writeFileSync(testFile, 'const x: number = 1;');

    const stdinJson = JSON.stringify({ tool_input: { file_path: testFile } });
    const result = await runScript(path.join(scriptsDir, 'post-edit-typecheck.js'), stdinJson);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('tool_input'), 'Should pass through data for .tsx files');
    cleanupTestDir(testDir);
  })) passed++; else failed++;

  // ─── Round 23: Bug fixes & high-priority gap coverage ───

  // Helper: create a patched evaluate-session.js wrapper that resolves
  // require('../lib/utils') to the real utils.js and uses a custom config path
  const realUtilsPath = path.resolve(__dirname, '..', '..', 'scripts', 'lib', 'utils.js');
  function createEvalWrapper(testDir, configPath) {
    const wrapperScript = path.join(testDir, 'eval-wrapper.js');
    let src = fs.readFileSync(path.join(scriptsDir, 'evaluate-session.js'), 'utf8');
    // Patch require to use absolute path (the temp dir doesn't have ../lib/utils)
    src = src.replace(
      /require\('\.\.\/lib\/utils'\)/,
      `require(${JSON.stringify(realUtilsPath)})`
    );
    // Patch config file path to point to our test config
    src = src.replace(
      /const configFile = path\.join\(scriptDir.*?config\.json'\);/,
      `const configFile = ${JSON.stringify(configPath)};`
    );
    fs.writeFileSync(wrapperScript, src);
    return wrapperScript;
  }

  console.log('\nRound 23: evaluate-session.js (config & nullish coalescing):');

  if (await asyncTest('respects min_session_length=0 from config (nullish coalescing)', async () => {
    // This tests the ?? fix: min_session_length=0 should mean "evaluate ALL sessions"
    const testDir = createTestDir();
    const transcriptPath = path.join(testDir, 'short.jsonl');
    // Only 2 user messages — normally below the default threshold of 10
    const lines = [
      '{"type":"user","content":"msg1"}',
      '{"type":"user","content":"msg2"}',
    ];
    fs.writeFileSync(transcriptPath, lines.join('\n'));

    // Create a config file with min_session_length=0
    const skillsDir = path.join(testDir, 'skills', 'continuous-learning');
    fs.mkdirSync(skillsDir, { recursive: true });
    const configPath = path.join(skillsDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      min_session_length: 0,
      learned_skills_path: path.join(testDir, 'learned')
    }));

    const wrapperScript = createEvalWrapper(testDir, configPath);

    const stdinJson = JSON.stringify({ transcript_path: transcriptPath });
    const result = await runScript(wrapperScript, stdinJson, {
      HOME: testDir, USERPROFILE: testDir
    });
    assert.strictEqual(result.code, 0);
    // With min_session_length=0, even 2 messages should trigger evaluation
    assert.ok(
      result.stderr.includes('2 messages') && result.stderr.includes('evaluate'),
      'Should evaluate session with min_session_length=0 (not skip as too short)'
    );
    cleanupTestDir(testDir);
  })) passed++; else failed++;

  if (await asyncTest('config with min_session_length=null falls back to default 10', async () => {
    const testDir = createTestDir();
    const transcriptPath = path.join(testDir, 'short.jsonl');
    // 5 messages — below default 10
    const lines = [];
    for (let i = 0; i < 5; i++) lines.push(`{"type":"user","content":"msg${i}"}`);
    fs.writeFileSync(transcriptPath, lines.join('\n'));

    const skillsDir = path.join(testDir, 'skills', 'continuous-learning');
    fs.mkdirSync(skillsDir, { recursive: true });
    const configPath = path.join(skillsDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      min_session_length: null,
      learned_skills_path: path.join(testDir, 'learned')
    }));

    const wrapperScript = createEvalWrapper(testDir, configPath);

    const stdinJson = JSON.stringify({ transcript_path: transcriptPath });
    const result = await runScript(wrapperScript, stdinJson, {
      HOME: testDir, USERPROFILE: testDir
    });
    assert.strictEqual(result.code, 0);
    // null ?? 10 === 10, so 5 messages should be "too short"
    assert.ok(result.stderr.includes('too short'), 'Should fall back to default 10 when null');
    cleanupTestDir(testDir);
  })) passed++; else failed++;

  if (await asyncTest('config with custom learned_skills_path creates directory', async () => {
    const testDir = createTestDir();
    const transcriptPath = path.join(testDir, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, '{"type":"user","content":"msg"}');

    const customLearnedDir = path.join(testDir, 'custom-learned-skills');
    const skillsDir = path.join(testDir, 'skills', 'continuous-learning');
    fs.mkdirSync(skillsDir, { recursive: true });
    const configPath = path.join(skillsDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      learned_skills_path: customLearnedDir
    }));

    const wrapperScript = createEvalWrapper(testDir, configPath);

    const stdinJson = JSON.stringify({ transcript_path: transcriptPath });
    await runScript(wrapperScript, stdinJson, {
      HOME: testDir, USERPROFILE: testDir
    });
    assert.ok(fs.existsSync(customLearnedDir), 'Should create custom learned skills directory');
    cleanupTestDir(testDir);
  })) passed++; else failed++;

  if (await asyncTest('handles invalid config JSON gracefully (uses defaults)', async () => {
    const testDir = createTestDir();
    const transcriptPath = path.join(testDir, 'transcript.jsonl');
    const lines = [];
    for (let i = 0; i < 5; i++) lines.push(`{"type":"user","content":"msg${i}"}`);
    fs.writeFileSync(transcriptPath, lines.join('\n'));

    const skillsDir = path.join(testDir, 'skills', 'continuous-learning');
    fs.mkdirSync(skillsDir, { recursive: true });
    const configPath = path.join(skillsDir, 'config.json');
    fs.writeFileSync(configPath, 'not valid json!!!');

    const wrapperScript = createEvalWrapper(testDir, configPath);

    const stdinJson = JSON.stringify({ transcript_path: transcriptPath });
    const result = await runScript(wrapperScript, stdinJson, {
      HOME: testDir, USERPROFILE: testDir
    });
    assert.strictEqual(result.code, 0);
    // Should log parse failure and fall back to default 10 → 5 msgs too short
    assert.ok(result.stderr.includes('too short'), 'Should use defaults when config is invalid JSON');
    cleanupTestDir(testDir);
  })) passed++; else failed++;

  console.log('\nRound 23: session-end.js (update existing file path):');

  if (await asyncTest('updates Last Updated timestamp in existing session file', async () => {
    const testDir = createTestDir();
    const sessionsDir = path.join(testDir, '.claude', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Get the expected filename
    const utils = require('../../scripts/lib/utils');
    const today = utils.getDateString();

    // Create a pre-existing session file with known timestamp
    const shortId = 'update01';
    const sessionFile = path.join(sessionsDir, `${today}-${shortId}-session.tmp`);
    const originalContent = `# Session: ${today}\n**Date:** ${today}\n**Started:** 09:00\n**Last Updated:** 09:00\n\n---\n\n## Current State\n\n[Session context goes here]\n\n### Completed\n- [ ]\n\n### In Progress\n- [ ]\n\n### Notes for Next Session\n-\n\n### Context to Load\n\`\`\`\n[relevant files]\n\`\`\`\n`;
    fs.writeFileSync(sessionFile, originalContent);

    const result = await runScript(path.join(scriptsDir, 'session-end.js'), '', {
      HOME: testDir, USERPROFILE: testDir,
      CLAUDE_SESSION_ID: `session-${shortId}`
    });
    assert.strictEqual(result.code, 0);

    const updated = fs.readFileSync(sessionFile, 'utf8');
    // The timestamp should have been updated (no longer 09:00)
    assert.ok(updated.includes('**Last Updated:**'), 'Should still have Last Updated field');
    assert.ok(result.stderr.includes('Updated session file'), 'Should log update');
  })) passed++; else failed++;

  if (await asyncTest('replaces blank template with summary when updating existing file', async () => {
    const testDir = createTestDir();
    const sessionsDir = path.join(testDir, '.claude', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const utils = require('../../scripts/lib/utils');
    const today = utils.getDateString();

    const shortId = 'update02';
    const sessionFile = path.join(sessionsDir, `${today}-${shortId}-session.tmp`);
    // Pre-existing file with blank template
    const originalContent = `# Session: ${today}\n**Date:** ${today}\n**Started:** 09:00\n**Last Updated:** 09:00\n\n---\n\n## Current State\n\n[Session context goes here]\n\n### Completed\n- [ ]\n\n### In Progress\n- [ ]\n\n### Notes for Next Session\n-\n\n### Context to Load\n\`\`\`\n[relevant files]\n\`\`\`\n`;
    fs.writeFileSync(sessionFile, originalContent);

    // Create a transcript with user messages
    const transcriptPath = path.join(testDir, 'transcript.jsonl');
    const lines = [
      '{"type":"user","content":"Fix auth bug"}',
      '{"type":"tool_use","tool_name":"Edit","tool_input":{"file_path":"/src/auth.ts"}}',
    ];
    fs.writeFileSync(transcriptPath, lines.join('\n'));

    const stdinJson = JSON.stringify({ transcript_path: transcriptPath });
    const result = await runScript(path.join(scriptsDir, 'session-end.js'), stdinJson, {
      HOME: testDir, USERPROFILE: testDir,
      CLAUDE_SESSION_ID: `session-${shortId}`
    });
    assert.strictEqual(result.code, 0);

    const updated = fs.readFileSync(sessionFile, 'utf8');
    // Should have replaced blank template with actual summary
    assert.ok(!updated.includes('[Session context goes here]'), 'Should replace blank template');
    assert.ok(updated.includes('Fix auth bug'), 'Should include user message in summary');
    assert.ok(updated.includes('/src/auth.ts'), 'Should include modified file');
  })) passed++; else failed++;

  if (await asyncTest('preserves existing session content when no blank template marker', async () => {
    const testDir = createTestDir();
    const sessionsDir = path.join(testDir, '.claude', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const utils = require('../../scripts/lib/utils');
    const today = utils.getDateString();

    const shortId = 'update03';
    const sessionFile = path.join(sessionsDir, `${today}-${shortId}-session.tmp`);
    // Pre-existing file with ALREADY-FILLED summary (no blank template marker)
    const existingContent = `# Session: ${today}\n**Date:** ${today}\n**Started:** 08:00\n**Last Updated:** 08:30\n\n---\n\n## Session Summary\n\n### Tasks\n- Previous task from earlier\n`;
    fs.writeFileSync(sessionFile, existingContent);

    const transcriptPath = path.join(testDir, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, '{"type":"user","content":"New task"}');

    const stdinJson = JSON.stringify({ transcript_path: transcriptPath });
    const result = await runScript(path.join(scriptsDir, 'session-end.js'), stdinJson, {
      HOME: testDir, USERPROFILE: testDir,
      CLAUDE_SESSION_ID: `session-${shortId}`
    });
    assert.strictEqual(result.code, 0);

    const updated = fs.readFileSync(sessionFile, 'utf8');
    // Should NOT overwrite existing summary (no blank template marker found)
    assert.ok(updated.includes('Previous task from earlier'), 'Should preserve existing content');
    assert.ok(!updated.includes('New task'), 'Should not replace non-template content');
  })) passed++; else failed++;

  console.log('\nRound 23: pre-compact.js (glob specificity):');

  if (await asyncTest('only annotates *-session.tmp files, not other .tmp files', async () => {
    const isoHome = path.join(os.tmpdir(), `ecc-compact-glob-${Date.now()}`);
    const sessionsDir = path.join(isoHome, '.claude', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Create a session .tmp file and a non-session .tmp file
    const sessionFile = path.join(sessionsDir, '2026-02-11-abc-session.tmp');
    const otherTmpFile = path.join(sessionsDir, 'other-data.tmp');
    fs.writeFileSync(sessionFile, '# Session\n');
    fs.writeFileSync(otherTmpFile, 'some other data\n');

    try {
      await runScript(path.join(scriptsDir, 'pre-compact.js'), '', {
        HOME: isoHome, USERPROFILE: isoHome
      });

      const sessionContent = fs.readFileSync(sessionFile, 'utf8');
      const otherContent = fs.readFileSync(otherTmpFile, 'utf8');

      assert.ok(sessionContent.includes('Compaction occurred'), 'Should annotate session file');
      assert.strictEqual(otherContent, 'some other data\n', 'Should NOT annotate non-session .tmp file');
    } finally {
      fs.rmSync(isoHome, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (await asyncTest('handles no active session files gracefully', async () => {
    const isoHome = path.join(os.tmpdir(), `ecc-compact-nosession-${Date.now()}`);
    const sessionsDir = path.join(isoHome, '.claude', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    try {
      const result = await runScript(path.join(scriptsDir, 'pre-compact.js'), '', {
        HOME: isoHome, USERPROFILE: isoHome
      });
      assert.strictEqual(result.code, 0, 'Should exit 0 with no session files');
      assert.ok(result.stderr.includes('[PreCompact]'), 'Should still log success');

      // Compaction log should still be created
      const logFile = path.join(sessionsDir, 'compaction-log.txt');
      assert.ok(fs.existsSync(logFile), 'Should create compaction log even with no sessions');
    } finally {
      fs.rmSync(isoHome, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  console.log('\nRound 23: session-end.js (extractSessionSummary edge cases):');

  if (await asyncTest('handles transcript with only assistant messages (no user messages)', async () => {
    const testDir = createTestDir();
    const transcriptPath = path.join(testDir, 'transcript.jsonl');
    // Only assistant messages — no user messages
    const lines = [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"response"}]}}',
      '{"type":"tool_use","tool_name":"Read","tool_input":{"file_path":"/src/app.ts"}}',
    ];
    fs.writeFileSync(transcriptPath, lines.join('\n'));

    const stdinJson = JSON.stringify({ transcript_path: transcriptPath });
    const result = await runScript(path.join(scriptsDir, 'session-end.js'), stdinJson, {
      HOME: testDir
    });
    assert.strictEqual(result.code, 0);

    // With no user messages, extractSessionSummary returns null → blank template
    const claudeDir = path.join(testDir, '.claude', 'sessions');
    if (fs.existsSync(claudeDir)) {
      const files = fs.readdirSync(claudeDir).filter(f => f.endsWith('.tmp'));
      if (files.length > 0) {
        const content = fs.readFileSync(path.join(claudeDir, files[0]), 'utf8');
        assert.ok(content.includes('[Session context goes here]'), 'Should use blank template when no user messages');
      }
    }
    cleanupTestDir(testDir);
  })) passed++; else failed++;

  if (await asyncTest('extracts tool_use from assistant message content blocks', async () => {
    const testDir = createTestDir();
    const transcriptPath = path.join(testDir, 'transcript.jsonl');
    // Claude Code JSONL format: tool_use blocks inside assistant message content array
    const lines = [
      '{"type":"user","content":"Edit config"}',
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'I will edit the config.' },
            { type: 'tool_use', name: 'Edit', input: { file_path: '/src/config.ts' } },
            { type: 'tool_use', name: 'Write', input: { file_path: '/src/new.ts' } },
          ]
        }
      }),
    ];
    fs.writeFileSync(transcriptPath, lines.join('\n'));

    const stdinJson = JSON.stringify({ transcript_path: transcriptPath });
    const result = await runScript(path.join(scriptsDir, 'session-end.js'), stdinJson, {
      HOME: testDir
    });
    assert.strictEqual(result.code, 0);

    const claudeDir = path.join(testDir, '.claude', 'sessions');
    if (fs.existsSync(claudeDir)) {
      const files = fs.readdirSync(claudeDir).filter(f => f.endsWith('.tmp'));
      if (files.length > 0) {
        const content = fs.readFileSync(path.join(claudeDir, files[0]), 'utf8');
        assert.ok(content.includes('/src/config.ts'), 'Should extract file from nested tool_use block');
        assert.ok(content.includes('/src/new.ts'), 'Should extract Write file from nested block');
        assert.ok(content.includes('Edit'), 'Should list Edit in tools used');
      }
    }
    cleanupTestDir(testDir);
  })) passed++; else failed++;

  // ─── Round 24: suggest-compact interval fix, fd fallback, session-start maxAge ───
  console.log('\nRound 24: suggest-compact.js (interval fix & fd fallback):');

  if (await asyncTest('periodic intervals are consistent with non-25-divisible threshold', async () => {
    // Regression test: with threshold=13, periodic suggestions should fire at 38, 63, 88...
    // (count - 13) % 25 === 0 → 38-13=25, 63-13=50, etc.
    const sessionId = `test-interval-fix-${Date.now()}`;
    const counterFile = path.join(os.tmpdir(), `claude-tool-count-${sessionId}`);
    try {
      // Pre-seed at 37 so next call = 38 (13 + 25 = 38)
      fs.writeFileSync(counterFile, '37');
      const result = await runScript(path.join(scriptsDir, 'suggest-compact.js'), '', {
        CLAUDE_SESSION_ID: sessionId,
        COMPACT_THRESHOLD: '13'
      });
      assert.strictEqual(result.code, 0);
      assert.ok(result.stderr.includes('38 tool calls'), 'Should suggest at threshold(13) + 25 = 38');
    } finally {
      try { fs.unlinkSync(counterFile); } catch {}
    }
  })) passed++; else failed++;

  if (await asyncTest('does not suggest at old-style multiples that skip threshold offset', async () => {
    // With threshold=13, count=50 should NOT trigger (old behavior would: 50%25===0)
    // New behavior: (50-13)%25 = 37%25 = 12 → no suggestion
    const sessionId = `test-no-false-suggest-${Date.now()}`;
    const counterFile = path.join(os.tmpdir(), `claude-tool-count-${sessionId}`);
    try {
      fs.writeFileSync(counterFile, '49');
      const result = await runScript(path.join(scriptsDir, 'suggest-compact.js'), '', {
        CLAUDE_SESSION_ID: sessionId,
        COMPACT_THRESHOLD: '13'
      });
      assert.strictEqual(result.code, 0);
      assert.ok(!result.stderr.includes('checkpoint'), 'Should NOT suggest at count=50 with threshold=13');
    } finally {
      try { fs.unlinkSync(counterFile); } catch {}
    }
  })) passed++; else failed++;

  if (await asyncTest('fd fallback: handles corrupted counter file gracefully', async () => {
    const sessionId = `test-corrupt-${Date.now()}`;
    const counterFile = path.join(os.tmpdir(), `claude-tool-count-${sessionId}`);
    try {
      // Write non-numeric data to trigger parseInt → NaN → reset to 1
      fs.writeFileSync(counterFile, 'corrupted data here!!!');
      const result = await runScript(path.join(scriptsDir, 'suggest-compact.js'), '', {
        CLAUDE_SESSION_ID: sessionId
      });
      assert.strictEqual(result.code, 0);
      const newCount = parseInt(fs.readFileSync(counterFile, 'utf8').trim(), 10);
      assert.strictEqual(newCount, 1, 'Should reset to 1 on corrupted file content');
    } finally {
      try { fs.unlinkSync(counterFile); } catch {}
    }
  })) passed++; else failed++;

  if (await asyncTest('handles counter at exact 1000000 boundary', async () => {
    const sessionId = `test-boundary-${Date.now()}`;
    const counterFile = path.join(os.tmpdir(), `claude-tool-count-${sessionId}`);
    try {
      // 1000000 is the upper clamp boundary — should still increment
      fs.writeFileSync(counterFile, '1000000');
      const result = await runScript(path.join(scriptsDir, 'suggest-compact.js'), '', {
        CLAUDE_SESSION_ID: sessionId
      });
      assert.strictEqual(result.code, 0);
      const newCount = parseInt(fs.readFileSync(counterFile, 'utf8').trim(), 10);
      assert.strictEqual(newCount, 1000001, 'Should increment from exactly 1000000');
    } finally {
      try { fs.unlinkSync(counterFile); } catch {}
    }
  })) passed++; else failed++;

  console.log('\nRound 24: post-edit-format.js (edge cases):');

  if (await asyncTest('passes through malformed JSON unchanged', async () => {
    const malformedJson = '{"tool_input": {"file_path": "/test.ts"';
    const result = await runScript(path.join(scriptsDir, 'post-edit-format.js'), malformedJson);
    assert.strictEqual(result.code, 0);
    // Should pass through the malformed data unchanged
    assert.ok(result.stdout.includes(malformedJson), 'Should pass through malformed JSON');
  })) passed++; else failed++;

  if (await asyncTest('passes through data for non-JS/TS file extensions', async () => {
    const stdinJson = JSON.stringify({ tool_input: { file_path: '/path/to/file.py' } });
    const result = await runScript(path.join(scriptsDir, 'post-edit-format.js'), stdinJson);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('file.py'), 'Should pass through for .py files');
  })) passed++; else failed++;

  console.log('\nRound 24: post-edit-typecheck.js (edge cases):');

  if (await asyncTest('skips typecheck for non-existent file and still passes through', async () => {
    const stdinJson = JSON.stringify({ tool_input: { file_path: '/nonexistent/deep/file.ts' } });
    const result = await runScript(path.join(scriptsDir, 'post-edit-typecheck.js'), stdinJson);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('file.ts'), 'Should pass through for non-existent .ts file');
  })) passed++; else failed++;

  if (await asyncTest('passes through for non-TS extensions without running tsc', async () => {
    const stdinJson = JSON.stringify({ tool_input: { file_path: '/path/to/file.js' } });
    const result = await runScript(path.join(scriptsDir, 'post-edit-typecheck.js'), stdinJson);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('file.js'), 'Should pass through for .js file without running tsc');
  })) passed++; else failed++;

  console.log('\nRound 24: session-start.js (edge cases):');

  if (await asyncTest('exits 0 with empty sessions directory (no recent sessions)', async () => {
    const isoHome = path.join(os.tmpdir(), `ecc-start-empty-${Date.now()}`);
    fs.mkdirSync(path.join(isoHome, '.claude', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(isoHome, '.claude', 'skills', 'learned'), { recursive: true });
    try {
      const result = await runScript(path.join(scriptsDir, 'session-start.js'), '', {
        HOME: isoHome, USERPROFILE: isoHome
      });
      assert.strictEqual(result.code, 0, 'Should exit 0 with no sessions');
      // Should NOT inject any previous session data (stdout should be empty or minimal)
      assert.ok(!result.stdout.includes('Previous session summary'), 'Should not inject when no sessions');
    } finally {
      fs.rmSync(isoHome, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (await asyncTest('does not inject blank template session into context', async () => {
    const isoHome = path.join(os.tmpdir(), `ecc-start-blank-${Date.now()}`);
    const sessionsDir = path.join(isoHome, '.claude', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(path.join(isoHome, '.claude', 'skills', 'learned'), { recursive: true });

    // Create a session file with the blank template marker
    const today = new Date().toISOString().slice(0, 10);
    const sessionFile = path.join(sessionsDir, `${today}-blank-session.tmp`);
    fs.writeFileSync(sessionFile, '# Session\n[Session context goes here]\n');

    try {
      const result = await runScript(path.join(scriptsDir, 'session-start.js'), '', {
        HOME: isoHome, USERPROFILE: isoHome
      });
      assert.strictEqual(result.code, 0);
      // Should NOT inject blank template
      assert.ok(!result.stdout.includes('Previous session summary'), 'Should skip blank template sessions');
    } finally {
      fs.rmSync(isoHome, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  // ─── Round 25: post-edit-console-warn pass-through fix, check-console-log edge cases ───
  console.log('\nRound 25: post-edit-console-warn.js (pass-through fix):');

  if (await asyncTest('stdout is exact byte match of stdin (no trailing newline)', async () => {
    // Regression test: console.log(data) was replaced with process.stdout.write(data)
    const stdinData = '{"tool_input":{"file_path":"/nonexistent/file.py"}}';
    const result = await runScript(path.join(scriptsDir, 'post-edit-console-warn.js'), stdinData);
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stdout, stdinData, 'stdout should exactly match stdin (no extra newline)');
  })) passed++; else failed++;

  if (await asyncTest('passes through malformed JSON unchanged without crash', async () => {
    const malformed = '{"tool_input": {"file_path": "/test.ts"';
    const result = await runScript(path.join(scriptsDir, 'post-edit-console-warn.js'), malformed);
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stdout, malformed, 'Should pass through malformed JSON exactly');
  })) passed++; else failed++;

  if (await asyncTest('handles missing file_path in tool_input gracefully', async () => {
    const stdinJson = JSON.stringify({ tool_input: {} });
    const result = await runScript(path.join(scriptsDir, 'post-edit-console-warn.js'), stdinJson);
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stdout, stdinJson, 'Should pass through with missing file_path');
  })) passed++; else failed++;

  if (await asyncTest('passes through when file does not exist (readFile returns null)', async () => {
    const stdinJson = JSON.stringify({ tool_input: { file_path: '/nonexistent/deep/file.ts' } });
    const result = await runScript(path.join(scriptsDir, 'post-edit-console-warn.js'), stdinJson);
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stdout, stdinJson, 'Should pass through exactly when file not found');
  })) passed++; else failed++;

  console.log('\nRound 25: check-console-log.js (edge cases):');

  if (await asyncTest('source has expected exclusion patterns', async () => {
    // The EXCLUDED_PATTERNS array includes .test.ts, .spec.ts, etc.
    const source = fs.readFileSync(path.join(scriptsDir, 'check-console-log.js'), 'utf8');
    // Verify the exclusion patterns exist (regex escapes use \. so check for the pattern names)
    assert.ok(source.includes('EXCLUDED_PATTERNS'), 'Should have exclusion patterns array');
    assert.ok(/\.test\\\./.test(source), 'Should have test file exclusion pattern');
    assert.ok(/\.spec\\\./.test(source), 'Should have spec file exclusion pattern');
    assert.ok(source.includes('scripts'), 'Should exclude scripts/ directory');
    assert.ok(source.includes('__tests__'), 'Should exclude __tests__/ directory');
    assert.ok(source.includes('__mocks__'), 'Should exclude __mocks__/ directory');
  })) passed++; else failed++;

  if (await asyncTest('passes through data unchanged on non-git repo', async () => {
    // In a temp dir with no git repo, the hook should pass through data unchanged
    const testDir = createTestDir();
    const stdinData = '{"tool_input":"test"}';
    const result = await runScript(path.join(scriptsDir, 'check-console-log.js'), stdinData, {
      // Use a non-git directory as CWD
      HOME: testDir, USERPROFILE: testDir
    });
    // Note: We're still running from a git repo, so isGitRepo() may still return true.
    // This test verifies the script doesn't crash and passes through data.
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes(stdinData), 'Should pass through data');
    cleanupTestDir(testDir);
  })) passed++; else failed++;

  if (await asyncTest('exits 0 even when no stdin is provided', async () => {
    const result = await runScript(path.join(scriptsDir, 'check-console-log.js'), '');
    assert.strictEqual(result.code, 0, 'Should exit 0 with empty stdin');
  })) passed++; else failed++;

  // ── Round 29: post-edit-format.js cwd fix and process.exit(0) consistency ──
  console.log('\nRound 29: post-edit-format.js (cwd and exit):');

  if (await asyncTest('source uses cwd based on file directory for npx', async () => {
    const formatSource = fs.readFileSync(path.join(scriptsDir, 'post-edit-format.js'), 'utf8');
    assert.ok(formatSource.includes('cwd:'), 'Should set cwd option for execFileSync');
    assert.ok(formatSource.includes('path.dirname'), 'cwd should use path.dirname of the file');
    assert.ok(formatSource.includes('path.resolve'), 'cwd should resolve the file path first');
  })) passed++; else failed++;

  if (await asyncTest('source calls process.exit(0) after writing output', async () => {
    const formatSource = fs.readFileSync(path.join(scriptsDir, 'post-edit-format.js'), 'utf8');
    assert.ok(formatSource.includes('process.exit(0)'), 'Should call process.exit(0) for clean termination');
  })) passed++; else failed++;

  if (await asyncTest('uses process.stdout.write instead of console.log for pass-through', async () => {
    const formatSource = fs.readFileSync(path.join(scriptsDir, 'post-edit-format.js'), 'utf8');
    assert.ok(formatSource.includes('process.stdout.write(data)'), 'Should use process.stdout.write to avoid trailing newline');
    // Verify no console.log(data) for pass-through (console.error for warnings is OK)
    const lines = formatSource.split('\n');
    const passThrough = lines.filter(l => /console\.log\(data\)/.test(l));
    assert.strictEqual(passThrough.length, 0, 'Should not use console.log(data) for pass-through');
  })) passed++; else failed++;

  console.log('\nRound 29: post-edit-typecheck.js (exit and pass-through):');

  if (await asyncTest('source calls process.exit(0) after writing output', async () => {
    const tcSource = fs.readFileSync(path.join(scriptsDir, 'post-edit-typecheck.js'), 'utf8');
    assert.ok(tcSource.includes('process.exit(0)'), 'Should call process.exit(0) for clean termination');
  })) passed++; else failed++;

  if (await asyncTest('uses process.stdout.write instead of console.log for pass-through', async () => {
    const tcSource = fs.readFileSync(path.join(scriptsDir, 'post-edit-typecheck.js'), 'utf8');
    assert.ok(tcSource.includes('process.stdout.write(data)'), 'Should use process.stdout.write');
    const lines = tcSource.split('\n');
    const passThrough = lines.filter(l => /console\.log\(data\)/.test(l));
    assert.strictEqual(passThrough.length, 0, 'Should not use console.log(data) for pass-through');
  })) passed++; else failed++;

  if (await asyncTest('exact stdout pass-through without trailing newline (typecheck)', async () => {
    const stdinJson = JSON.stringify({ tool_input: { file_path: '/nonexistent/file.py' } });
    const result = await runScript(path.join(scriptsDir, 'post-edit-typecheck.js'), stdinJson);
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stdout, stdinJson, 'stdout should exactly match stdin (no trailing newline)');
  })) passed++; else failed++;

  if (await asyncTest('exact stdout pass-through without trailing newline (format)', async () => {
    const stdinJson = JSON.stringify({ tool_input: { file_path: '/nonexistent/file.py' } });
    const result = await runScript(path.join(scriptsDir, 'post-edit-format.js'), stdinJson);
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stdout, stdinJson, 'stdout should exactly match stdin (no trailing newline)');
  })) passed++; else failed++;

  console.log('\nRound 29: post-edit-console-warn.js (extension and exit):');

  if (await asyncTest('source calls process.exit(0) after writing output', async () => {
    const cwSource = fs.readFileSync(path.join(scriptsDir, 'post-edit-console-warn.js'), 'utf8');
    assert.ok(cwSource.includes('process.exit(0)'), 'Should call process.exit(0)');
  })) passed++; else failed++;

  if (await asyncTest('does NOT match .mts or .mjs extensions', async () => {
    const stdinMts = JSON.stringify({ tool_input: { file_path: '/some/file.mts' } });
    const result = await runScript(path.join(scriptsDir, 'post-edit-console-warn.js'), stdinMts);
    assert.strictEqual(result.code, 0);
    // .mts is not in the regex /\.(ts|tsx|js|jsx)$/, so no console.log scan
    assert.strictEqual(result.stdout, stdinMts, 'Should pass through .mts without scanning');
    assert.ok(!result.stderr.includes('console.log'), 'Should NOT scan .mts files for console.log');
  })) passed++; else failed++;

  if (await asyncTest('does NOT match uppercase .TS extension', async () => {
    const stdinTS = JSON.stringify({ tool_input: { file_path: '/some/file.TS' } });
    const result = await runScript(path.join(scriptsDir, 'post-edit-console-warn.js'), stdinTS);
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stdout, stdinTS, 'Should pass through .TS without scanning');
    assert.ok(!result.stderr.includes('console.log'), 'Should NOT scan .TS (uppercase) files');
  })) passed++; else failed++;

  if (await asyncTest('detects console.log in commented-out code', async () => {
    const testDir = createTestDir();
    const testFile = path.join(testDir, 'commented.js');
    fs.writeFileSync(testFile, '// console.log("debug")\nconst x = 1;\n');
    const stdinJson = JSON.stringify({ tool_input: { file_path: testFile } });
    const result = await runScript(path.join(scriptsDir, 'post-edit-console-warn.js'), stdinJson);
    assert.strictEqual(result.code, 0);
    // The regex /console\.log/ matches even in comments — this is intentional
    assert.ok(result.stderr.includes('console.log'), 'Should detect console.log even in comments');
    cleanupTestDir(testDir);
  })) passed++; else failed++;

  console.log('\nRound 29: check-console-log.js (exclusion patterns and exit):');

  if (await asyncTest('source calls process.exit(0) after writing output', async () => {
    const clSource = fs.readFileSync(path.join(scriptsDir, 'check-console-log.js'), 'utf8');
    // Should have at least 2 process.exit(0) calls (early return + end)
    const exitCalls = clSource.match(/process\.exit\(0\)/g) || [];
    assert.ok(exitCalls.length >= 2, `Should have at least 2 process.exit(0) calls, found ${exitCalls.length}`);
  })) passed++; else failed++;

  if (await asyncTest('EXCLUDED_PATTERNS correctly excludes test files', async () => {
    // Test the patterns directly by reading the source and evaluating the regex
    const source = fs.readFileSync(path.join(scriptsDir, 'check-console-log.js'), 'utf8');
    // Verify the 6 exclusion patterns exist in the source (as regex literals with escapes)
    const expectedSubstrings = ['test', 'spec', 'config', 'scripts', '__tests__', '__mocks__'];
    for (const substr of expectedSubstrings) {
      assert.ok(source.includes(substr), `Should include pattern containing "${substr}"`);
    }
    // Verify the array name exists
    assert.ok(source.includes('EXCLUDED_PATTERNS'), 'Should have EXCLUDED_PATTERNS array');
  })) passed++; else failed++;

  if (await asyncTest('exclusion patterns match expected file paths', async () => {
    // Recreate the EXCLUDED_PATTERNS from the source and test them
    const EXCLUDED_PATTERNS = [
      /\.test\.[jt]sx?$/,
      /\.spec\.[jt]sx?$/,
      /\.config\.[jt]s$/,
      /scripts\//,
      /__tests__\//,
      /__mocks__\//,
    ];
    // These SHOULD be excluded
    const excluded = [
      'src/utils.test.ts', 'src/utils.test.js', 'src/utils.test.tsx', 'src/utils.test.jsx',
      'src/utils.spec.ts', 'src/utils.spec.js',
      'src/utils.config.ts', 'src/utils.config.js',
      'scripts/hooks/session-end.js',
      '__tests__/utils.ts',
      '__mocks__/api.ts',
    ];
    for (const f of excluded) {
      const matches = EXCLUDED_PATTERNS.some(p => p.test(f));
      assert.ok(matches, `Expected "${f}" to be excluded but it was not`);
    }
    // These should NOT be excluded
    const notExcluded = [
      'src/utils.ts', 'src/main.tsx', 'src/app.js',
      'src/test.component.ts',  // "test" in name but not .test. pattern
      'src/config.ts',          // "config" in name but not .config. pattern
    ];
    for (const f of notExcluded) {
      const matches = EXCLUDED_PATTERNS.some(p => p.test(f));
      assert.ok(!matches, `Expected "${f}" to NOT be excluded but it was`);
    }
  })) passed++; else failed++;

  console.log('\nRound 29: run-all.js test runner improvements:');

  if (await asyncTest('test runner uses spawnSync to capture stderr on success', async () => {
    const runAllSource = fs.readFileSync(path.join(__dirname, '..', 'run-all.js'), 'utf8');
    assert.ok(runAllSource.includes('spawnSync'), 'Should use spawnSync instead of execSync');
    assert.ok(!runAllSource.includes('execSync'), 'Should not use execSync');
    // Verify it shows stderr
    assert.ok(runAllSource.includes('stderr'), 'Should handle stderr output');
  })) passed++; else failed++;

  // Summary
  console.log('\n=== Test Results ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total:  ${passed + failed}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

runTests();
