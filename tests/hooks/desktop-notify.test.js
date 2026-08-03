/**
 * Tests for scripts/hooks/desktop-notify.js
 *
 * desktop-notify.js fingerprints the host OS (macOS via process.platform,
 * WSL via reading /proc/version at module load) and shells out to
 * osascript (macOS) or PowerShell/BurntToast (WSL) to show a native
 * notification. Both paths build a script/command string that embeds
 * untrusted text (the last assistant message) inside a quoted literal, so
 * the escaping in notifyMacOS()/notifyWindows() is a real injection
 * boundary even though spawnSync() itself never goes through a shell.
 *
 * Neither run() export nor its OS-fingerprinting is exercised by any
 * existing test file (EGC-539). run() and log() are the only functions the
 * module exports or imports, so the OS-specific branches below are driven
 * by controlled module-load conditions rather than by calling private
 * helpers directly:
 *   - process.platform is faked with Object.defineProperty (configurable
 *     on Node) before a cache-cleared re-require, which is what isMacOS
 *     captures at require time in both desktop-notify.js and lib/utils.js.
 *   - fs.readFileSync is monkeypatched to fake /proc/version content
 *     ONLY for that exact path (all other calls delegate to the real
 *     implementation, since Node's own module loader also calls
 *     readFileSync while we re-require the module).
 *   - child_process.spawnSync is monkeypatched to capture the exact
 *     script/command string that would have been handed to
 *     osascript/PowerShell, instead of actually invoking them (neither
 *     binary exists on the Linux CI host this runs on).
 * All monkeypatches are restored in try/finally so they cannot leak into
 * other test files run in the same process.
 *
 * Run with: node tests/hooks/desktop-notify.test.js
 */

const assert = require('assert');
const path = require('path');
const cp = require('child_process');
const fs = require('fs');

const desktopNotifyPath = require.resolve(path.join('..', '..', 'scripts', 'hooks', 'desktop-notify.js'));
// lib/utils.js also captures isMacOS/isWindows/isLinux as module-load-time
// constants from process.platform. desktop-notify.js imports isMacOS from
// there, so any test that fakes process.platform must evict THIS cache
// entry too (both when entering and when leaving the fake), or a later
// test would keep reusing the previous test's stale, already-evaluated
// isMacOS value instead of re-deriving it from the real platform.
const utilsPath = require.resolve(path.join('..', '..', 'scripts', 'lib', 'utils.js'));

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

function resetModuleCaches() {
  delete require.cache[desktopNotifyPath];
  delete require.cache[utilsPath];
}

function withFakePlatform(platform, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  resetModuleCaches();
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
    resetModuleCaches();
  }
}

function withFakeWSL(fn) {
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function patchedReadFileSync(filePath, ...rest) {
    if (filePath === '/proc/version') {
      return 'Linux version 5.15.0-microsoft-standard-WSL2 (Microsoft@Microsoft.com)';
    }
    return originalReadFileSync.call(fs, filePath, ...rest);
  };
  resetModuleCaches();
  try {
    return fn();
  } finally {
    fs.readFileSync = originalReadFileSync;
    resetModuleCaches();
  }
}

function withFakeSpawnSync(handler, fn) {
  const original = cp.spawnSync;
  const calls = [];
  cp.spawnSync = (...args) => {
    calls.push(args);
    return handler(...args);
  };
  try {
    return fn(calls);
  } finally {
    cp.spawnSync = original;
  }
}

/** Counts literal double-quote (U+0022) characters -- proof AppleScript
 * string boundaries were not smuggled through unescaped. */
function countDoubleQuotes(str) {
  return (str.match(/"/g) || []).length;
}

function runTests() {
  console.log('\n=== Testing desktop-notify.js ===\n');

  let passed = 0;
  let failed = 0;

  console.log('OS detection - macOS:');

  if (test('process.platform === darwin makes lib/utils.isMacOS (and desktop-notify\'s copy) true', () => {
    withFakePlatform('darwin', () => {
      const utils = require(utilsPath);
      assert.strictEqual(utils.isMacOS, true);
    });
  })) passed++; else failed++;

  if (test('on macOS, run() invokes osascript exactly once via spawnSync', () => {
    withFakePlatform('darwin', () => {
      withFakeSpawnSync(() => ({ status: 0, error: null }), (calls) => {
        const { run } = require(desktopNotifyPath);
        const raw = JSON.stringify({ last_assistant_message: 'All tests passed' });
        const out = run(raw);
        assert.strictEqual(out, raw, 'run() always returns raw unchanged');
        assert.strictEqual(calls.length, 1, `Expected exactly one spawnSync call, got ${calls.length}`);
        const [cmd, args] = calls[0];
        assert.strictEqual(cmd, 'osascript');
        assert.deepStrictEqual(args.slice(0, 1), ['-e']);
      });
    });
  })) passed++; else failed++;

  console.log('\nOS detection - WSL:');

  if (test('a /proc/version containing "microsoft" makes desktop-notify treat the host as WSL', () => {
    withFakeWSL(() => {
      withFakeSpawnSync(() => ({ status: 1, error: null }), (calls) => {
        // Every PowerShell candidate probe fails: run() should log a tip
        // and never attempt notifyWindows(), proving isWSL flipped true
        // (on a non-WSL host with the real /proc/version this branch is
        // never entered at all, so zero calls would also be zero on a
        // non-WSL fs.readFileSync, which is exactly what the "plain Linux"
        // test below asserts by contrast).
        const { run } = require(desktopNotifyPath);
        const raw = JSON.stringify({ last_assistant_message: 'ok' });
        run(raw);
        assert.ok(calls.length >= 1, 'Expected at least one PowerShell candidate probe via spawnSync');
        for (const [, probeArgs] of calls) {
          assert.deepStrictEqual(probeArgs, ['-Command', 'exit 0']);
        }
      });
    });
  })) passed++; else failed++;

  if (test('on WSL with a resolvable PowerShell, run() sends a BurntToast command via spawnSync', () => {
    withFakeWSL(() => {
      withFakeSpawnSync((execPath, args) => {
        if (args[1] === 'exit 0') {
          return execPath === 'pwsh.exe' ? { status: 0 } : { status: 1 };
        }
        return { status: 0 };
      }, (calls) => {
        const { run } = require(desktopNotifyPath);
        const raw = JSON.stringify({ last_assistant_message: 'Build succeeded' });
        run(raw);
        const notifyCall = calls.find(([, args]) => args[0] === '-Command' && args[1] !== 'exit 0');
        assert.ok(notifyCall, `Expected a BurntToast notify call, got calls: ${JSON.stringify(calls)}`);
        const [execPath, args] = notifyCall;
        assert.strictEqual(execPath, 'pwsh.exe');
        assert.ok(args[1].includes('BurntToastNotification'));
        assert.ok(args[1].includes('Build succeeded'));
      });
    });
  })) passed++; else failed++;

  console.log('\nHappy path - plain Linux (non-WSL, non-macOS):');

  if (test('on a plain Linux host, run() never calls spawnSync and returns raw unchanged', () => {
    // No platform/fs faking: this repo's CI runs on plain Linux (see
    // tests/hooks/detect-project-worktree.test.js's win32 skip guard for
    // the same host assumption elsewhere in this suite), so isMacOS and
    // isWSL are both naturally false here already.
    resetModuleCaches();
    withFakeSpawnSync(() => ({ status: 0 }), (calls) => {
      const { run } = require(desktopNotifyPath);
      const raw = JSON.stringify({ last_assistant_message: 'Nothing to notify' });
      const out = run(raw);
      assert.strictEqual(out, raw);
      assert.strictEqual(calls.length, 0, `Expected no subprocess spawned on plain Linux, got: ${JSON.stringify(calls)}`);
    });
  })) passed++; else failed++;

  console.log('\nDangerous input escaping - macOS (AppleScript injection):');

  if (test('a double-quote-breakout payload is fully neutralized before reaching osascript', () => {
    withFakePlatform('darwin', () => {
      withFakeSpawnSync(() => ({ status: 0 }), (calls) => {
        const { run } = require(desktopNotifyPath);
        // Classic AppleScript command-injection shape: close the string
        // literal early with an unescaped quote, then chain a `do shell
        // script` call. If notifyMacOS() failed to escape this, the
        // resulting -e script would contain a syntactically valid
        // "foo" & (do shell script "...") & "bar" expression.
        const payload = 'foo" & (do shell script "touch /tmp/pwned") & "bar';
        const raw = JSON.stringify({ last_assistant_message: payload });
        run(raw);
        assert.strictEqual(calls.length, 1);
        const script = calls[0][1][1];
        assert.strictEqual(countDoubleQuotes(script), 4, `Expected exactly 4 literal double quotes (title+body wrappers only), got ${countDoubleQuotes(script)} in: ${script}`);
        assert.ok(script.includes('\u201C'), 'Expected curly quotes substituted in for the payload\'s double quotes');
        assert.ok(!script.includes('foo" &'), 'The payload must not be able to close the AppleScript string literal early');
      });
    });
  })) passed++; else failed++;

  if (test('backslashes are stripped (AppleScript has no backslash-escape support)', () => {
    withFakePlatform('darwin', () => {
      withFakeSpawnSync(() => ({ status: 0 }), (calls) => {
        const { run } = require(desktopNotifyPath);
        const raw = JSON.stringify({ last_assistant_message: 'C:\\Users\\evil\\payload.exe' });
        run(raw);
        const script = calls[0][1][1];
        assert.ok(!script.includes('\\'), `Expected all backslashes stripped, got: ${script}`);
      });
    });
  })) passed++; else failed++;

  if (test('shell metacharacters (; & ` $()) survive verbatim but cannot execute (spawnSync never invokes a shell)', () => {
    withFakePlatform('darwin', () => {
      withFakeSpawnSync(() => ({ status: 0 }), (calls) => {
        const { run } = require(desktopNotifyPath);
        const payload = 'done; rm -rf ~ && `id` $(whoami)';
        const raw = JSON.stringify({ last_assistant_message: payload });
        run(raw);
        const [cmd, args, opts] = calls[0];
        assert.strictEqual(cmd, 'osascript');
        assert.ok(!opts || opts.shell !== true, 'spawnSync must not be invoked with shell:true');
        assert.ok(args[1].includes('rm -rf'), 'The literal text is embedded as inert AppleScript string content, not stripped');
      });
    });
  })) passed++; else failed++;

  console.log('\nDangerous input escaping - WSL (PowerShell injection):');

  if (test('a single-quote-breakout payload is doubled before reaching PowerShell', () => {
    withFakeWSL(() => {
      withFakeSpawnSync((execPath, args) => {
        if (args[1] === 'exit 0') return execPath === 'pwsh.exe' ? { status: 0 } : { status: 1 };
        return { status: 0 };
      }, (calls) => {
        const { run } = require(desktopNotifyPath);
        // PowerShell single-quoted string injection shape: close the
        // literal early, then chain a destructive cmdlet.
        const payload = "it's done'; Remove-Item C:\\ -Recurse -Force #";
        const raw = JSON.stringify({ last_assistant_message: payload });
        run(raw);
        const notifyCall = calls.find(([, args2]) => args2[0] === '-Command' && args2[1] !== 'exit 0');
        assert.ok(notifyCall, 'Expected a BurntToast notify call');
        const command = notifyCall[1][1];
        // Every single quote from the payload must appear doubled ('') --
        // a lone, unescaped ' would let the payload terminate the
        // PowerShell string literal early.
        const bodyMatch = command.match(/New-BurntToastNotification -Text '[^']*(?:''[^']*)*', '([^']*(?:''[^']*)*)'/);
        assert.ok(bodyMatch, `Expected to locate the escaped body argument in: ${command}`);
        const rawBody = bodyMatch[1];
        assert.ok(rawBody.includes("it''s done''; Remove-Item"), `Expected doubled single quotes, got: ${rawBody}`);
      });
    });
  })) passed++; else failed++;

  console.log('\nextractSummary behavior (observed indirectly via the escaped notification body):');

  if (test('uses the first non-empty line, trimmed, skipping leading blank lines', () => {
    withFakePlatform('darwin', () => {
      withFakeSpawnSync(() => ({ status: 0 }), (calls) => {
        const { run } = require(desktopNotifyPath);
        const raw = JSON.stringify({ last_assistant_message: '\n\n   First real line here   \nSecond line ignored' });
        run(raw);
        const script = calls[0][1][1];
        assert.ok(script.includes('First real line here'), `Expected trimmed first line in: ${script}`);
        assert.ok(!script.includes('Second line ignored'), `Did not expect the second line in: ${script}`);
      });
    });
  })) passed++; else failed++;

  if (test('truncates a first line longer than 100 chars and appends an ellipsis', () => {
    withFakePlatform('darwin', () => {
      withFakeSpawnSync(() => ({ status: 0 }), (calls) => {
        const { run } = require(desktopNotifyPath);
        const longLine = 'x'.repeat(150);
        const raw = JSON.stringify({ last_assistant_message: longLine });
        run(raw);
        const script = calls[0][1][1];
        assert.ok(script.includes(`${'x'.repeat(100)}...`), `Expected a 100-char truncation plus ellipsis in: ${script}`);
        assert.ok(!script.includes('x'.repeat(101)), 'Body must not contain the untruncated 101st x');
      });
    });
  })) passed++; else failed++;

  if (test('falls back to "Done" when last_assistant_message is missing or not a string', () => {
    withFakePlatform('darwin', () => {
      withFakeSpawnSync(() => ({ status: 0 }), (calls) => {
        const { run } = require(desktopNotifyPath);
        run(JSON.stringify({}));
        const script = calls[0][1][1];
        assert.ok(script.includes('Done'), `Expected the "Done" fallback in: ${script}`);
      });
    });
  })) passed++; else failed++;

  console.log('\nError handling:');

  if (test('malformed JSON on stdin is caught and raw is still returned unchanged', () => {
    resetModuleCaches();
    const { run } = require(desktopNotifyPath);
    const raw = '{not valid json';
    const out = run(raw);
    assert.strictEqual(out, raw);
  })) passed++; else failed++;

  if (test('empty stdin does not throw and returns the empty string unchanged', () => {
    resetModuleCaches();
    const { run } = require(desktopNotifyPath);
    const out = run('');
    assert.strictEqual(out, '');
  })) passed++; else failed++;

  console.log('\nStandalone entrypoint (require.main === module stdin path):');

  if (test('runs standalone via node and echoes stdin back to stdout', () => {
    const { spawnSync } = require('child_process');
    const raw = JSON.stringify({ last_assistant_message: 'Standalone run' });
    const result = spawnSync('node', [desktopNotifyPath], {
      input: raw,
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert.strictEqual(result.status, 0, `Expected clean exit, got status ${result.status}, stderr: ${result.stderr}`);
    assert.strictEqual(result.stdout, raw, 'Expected raw stdin echoed back to stdout');
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
