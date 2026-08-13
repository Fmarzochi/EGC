'use strict';

/**
 * Tests for the dashboard operations door (Fmarzochi/EGC#1236).
 *
 * Covers the token gate on POST /ops, the CORS restriction to the panel's own
 * origin, a full operation round-trip over HTTP, and the concurrent-access
 * behaviour of the shared ~/.egc/dashboard-token file.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Point HOME at a scratch directory before anything resolves it, so nothing
// this file runs touches the real ~/.egc.
const SANDBOX_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'egc-ops-home-')));
process.env.HOME = SANDBOX_HOME;
process.env.USERPROFILE = SANDBOX_HOME;

const {
  TOKEN_FILE_NAME,
  TOKEN_HEADER,
  createOpsHandler,
  listOpsOperations,
  loadOrCreateOpsToken,
  resolveTokenPath,
} = require('../dashboard/ops');

const { normalizeInstallRequest } = require('../scripts/lib/install/request');
const { getInstallTargetAdapter } = require('../scripts/lib/install-targets/registry');
const operations = require('../scripts/lib/operations/index');

const SERVER_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'dashboard', 'server.js'),
  'utf8'
);

function makeTempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Start a server that answers nothing but /ops, so a request that the handler
 * declines is visible as a 404 rather than silently succeeding.
 */
async function startOpsServer({ token, homeDir, projectRoot }) {
  const server = http.createServer((req, res) => {
    if (handler && handler(req, res)) return;
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"ok":false,"error":"not an ops route"}');
  });

  let handler = null;

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  handler = createOpsHandler({ token, port, homeDir, projectRoot });

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

async function postOps(server, operation, { token, body, origin, method } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token !== undefined) headers[TOKEN_HEADER] = token;
  if (origin !== undefined) headers.Origin = origin;

  const res = await fetch(`${server.origin}/ops/${operation}`, {
    method: method || 'POST',
    headers,
    body: method === 'OPTIONS' ? undefined : JSON.stringify(body || {}),
  });

  let payload;
  try {
    payload = await res.json();
  } catch (_) {
    payload = null;
  }

  return { status: res.status, payload, headers: res.headers };
}

/**
 * An install-state file records absolute paths and two timestamps. Fold both
 * away so two installs into different scratch directories can be compared
 * byte for byte.
 */
function normalizeInstallState(raw, root) {
  const escapedRoot = JSON.stringify(root).slice(1, -1);
  return raw
    .split(escapedRoot).join('<ROOT>')
    .replace(/"installedAt": "[^"]*"/g, '"installedAt": "<TIMESTAMP>"')
    .replace(/"lastValidatedAt": "[^"]*"/g, '"lastValidatedAt": "<TIMESTAMP>"');
}

// ---------------------------------------------------------------------------
// Token gate
// ---------------------------------------------------------------------------

test('/ops without a token returns 401 and never runs the operation', async () => {
  const server = await startOpsServer({ token: 'a'.repeat(64) });
  try {
    const res = await postOps(server, 'doctor');
    assert.equal(res.status, 401);
    assert.equal(res.payload.ok, false);
    assert.match(res.payload.error, /token/i);
  } finally {
    await server.close();
  }
});

test('/ops with the wrong token returns 401', async () => {
  const server = await startOpsServer({ token: 'a'.repeat(64) });
  try {
    const res = await postOps(server, 'doctor', { token: 'b'.repeat(64) });
    assert.equal(res.status, 401);
  } finally {
    await server.close();
  }
});

test('/ops with a token of a different length returns 401 rather than throwing', async () => {
  // crypto.timingSafeEqual throws on a length mismatch; the gate must answer.
  const server = await startOpsServer({ token: 'a'.repeat(64) });
  try {
    const res = await postOps(server, 'doctor', { token: 'short' });
    assert.equal(res.status, 401);
  } finally {
    await server.close();
  }
});

test('/ops with the token returns 200 and the operation result', async () => {
  const token = 'c'.repeat(64);
  const server = await startOpsServer({ token });
  try {
    const res = await postOps(server, 'doctor', { token });
    assert.equal(res.status, 200);
    assert.equal(res.payload.ok, true);
    assert.equal(res.payload.operation, 'doctor');
    assert.ok(res.payload.result.summary, 'doctor result must carry a summary');
    assert.ok(Array.isArray(res.payload.result.results));
  } finally {
    await server.close();
  }
});

test('an unknown operation returns 404, and only after the token check', async () => {
  const token = 'd'.repeat(64);
  const server = await startOpsServer({ token });
  try {
    assert.equal((await postOps(server, 'rm-rf', { token })).status, 404);
    // No token: the gate answers first, so an unknown name cannot be probed.
    assert.equal((await postOps(server, 'rm-rf')).status, 401);
  } finally {
    await server.close();
  }
});

test('an inherited Object.prototype key is not dispatchable as an operation', async () => {
  // CodeQL "Unvalidated dynamic method call": with an object-literal handler
  // table, OPERATION_HANDLERS['constructor'] is a truthy function, so it
  // passed the not-found check and was invoked - /ops/constructor answered 200
  // and echoed the request body back, and /ops/__defineGetter__ threw out of
  // the handler. Every one of these must be an ordinary 404.
  const token = '6'.repeat(64);
  const server = await startOpsServer({ token });
  const inherited = [
    'constructor',
    'toString',
    'valueOf',
    'hasOwnProperty',
    '__defineGetter__',
    '__proto__',
    'isPrototypeOf',
    'propertyIsEnumerable',
  ];
  try {
    for (const name of inherited) {
      const res = await postOps(server, name, { token, body: { targets: ['probe'] } });
      assert.equal(res.status, 404, `/ops/${name} must be 404, got ${res.status}`);
      assert.equal(res.payload.ok, false);
      assert.equal(
        res.payload.targets,
        undefined,
        `/ops/${name} must not reflect the request body back`
      );
    }
  } finally {
    await server.close();
  }
});

test('listOpsOperations reports only the explicitly registered operations', () => {
  assert.deepEqual(listOpsOperations().sort(), [
    'doctor', 'install', 'repair', 'savingsLedger',
    'sessionEvents', 'sessionPeers', 'sessionSend',
  ].sort());
});

test('every registered operation actually dispatches to something callable', async () => {
  // The other side of the `typeof handler !== 'function'` guard: that check
  // turns a non-function in the table into a 404, so a name that silently
  // stopped being callable would look exactly like a name that was never
  // registered. Asserting each registered name does NOT 404 catches that.
  const token = 'b2'.repeat(32);
  // Scratch home AND project, like every other round-trip test here. Inheriting
  // process.cwd() as the project root is safe only by accident today: runInstall
  // reads ./egc-install.json from it before normalizeInstallRequest can reject
  // an empty body, so the day this repo grows one at its root this test would
  // start installing into the checkout of whoever runs it.
  const homeDir = makeTempDir('egc-ops-dispatch-home-');
  const projectRoot = makeTempDir('egc-ops-dispatch-project-');
  const server = await startOpsServer({ token, homeDir, projectRoot });

  // Materialised once and asserted non-empty, so this cannot pass vacuously if
  // the registry ever came back empty.
  const operations = listOpsOperations();
  assert.ok(operations.length > 0, 'the registry must expose at least one operation');

  try {
    for (const name of operations) {
      const res = await postOps(server, name, { token, body: {} });
      assert.notEqual(
        res.status,
        404,
        `/ops/${name} is registered but did not dispatch (got 404)`
      );
    }
  } finally {
    await server.close();
    removeDir(projectRoot);
    removeDir(homeDir);
  }
});

test('a non-POST method on /ops is rejected', async () => {
  const token = 'e'.repeat(64);
  const server = await startOpsServer({ token });
  try {
    const res = await fetch(`${server.origin}/ops/doctor`, {
      method: 'GET',
      headers: { [TOKEN_HEADER]: token },
    });
    assert.equal(res.status, 405);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

test('/ops rejects a foreign origin even when the token is correct', async () => {
  const token = 'f'.repeat(64);
  const server = await startOpsServer({ token });
  try {
    const res = await postOps(server, 'doctor', { token, origin: 'http://evil.example' });
    assert.equal(res.status, 403);
    assert.match(res.payload.error, /origin/i);
  } finally {
    await server.close();
  }
});

test('/ops accepts the panel\'s own origin and advertises only that origin', async () => {
  const token = '0'.repeat(64);
  const server = await startOpsServer({ token });
  try {
    const res = await postOps(server, 'doctor', {
      token,
      origin: `http://127.0.0.1:${server.port}`,
    });
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get('access-control-allow-origin'),
      `http://localhost:${server.port}`,
      'the ops routes must not echo back an arbitrary loopback origin'
    );
  } finally {
    await server.close();
  }
});

test('/ops answers a preflight without requiring the token', async () => {
  const server = await startOpsServer({ token: '1'.repeat(64) });
  try {
    const res = await fetch(`${server.origin}/ops/doctor`, { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.match(res.headers.get('access-control-allow-headers'), new RegExp(TOKEN_HEADER, 'i'));
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Operation round-trip
// ---------------------------------------------------------------------------

test('installing a target over /ops writes the same install-state as the CLI path', async () => {
  const token = '2'.repeat(64);
  const panelProject = makeTempDir('egc-ops-panel-');
  const cliProject = makeTempDir('egc-ops-cli-');
  const homeDir = makeTempDir('egc-ops-install-home-');
  const server = await startOpsServer({ token, homeDir, projectRoot: panelProject });

  try {
    const res = await postOps(server, 'install', {
      token,
      body: { target: 'cursor', profile: 'minimal' },
    });

    assert.equal(res.status, 200, `install failed: ${JSON.stringify(res.payload)}`);
    assert.equal(res.payload.ok, true);
    assert.ok(res.payload.result.plan, 'the result must carry the plan');
    assert.ok(res.payload.result.applied, 'the result must carry what was applied');

    // The same operation the CLI reaches, with the arguments install-apply.js
    // passes, run against a second scratch project.
    const request = normalizeInstallRequest({ target: 'cursor', profileId: 'minimal' });
    const cli = await operations.install(request, { projectRoot: cliProject, homeDir });

    const panelStatePath = res.payload.result.applied.installStatePath;
    const cliStatePath = cli.applied.installStatePath;
    assert.ok(fs.existsSync(panelStatePath), 'the panel install must write an install-state file');
    assert.ok(fs.existsSync(cliStatePath), 'the CLI install must write an install-state file');

    assert.equal(
      normalizeInstallState(fs.readFileSync(panelStatePath, 'utf8'), panelProject),
      normalizeInstallState(fs.readFileSync(cliStatePath, 'utf8'), cliProject),
      'the panel and the CLI must produce the same install-state modulo paths and timestamps'
    );
  } finally {
    await server.close();
    removeDir(panelProject);
    removeDir(cliProject);
    removeDir(homeDir);
  }
});

test('the panel install matches the real `egc install` CLI, not just the same library call', async () => {
  // The parity check above builds its "CLI side" from normalizeInstallRequest,
  // which is the panel's own path - it cannot catch the panel diverging from
  // what scripts/install-apply.js actually does. Run the CLI for real.
  const token = '7'.repeat(64);
  const panelProject = makeTempDir('egc-ops-panel-cli-');
  const cliProject = makeTempDir('egc-ops-cli-cli-');
  const homeDir = makeTempDir('egc-ops-cli-home-');
  const server = await startOpsServer({ token, homeDir, projectRoot: panelProject });

  try {
    const res = await postOps(server, 'install', {
      token,
      body: { target: 'cursor', profile: 'minimal' },
    });
    assert.equal(res.status, 200, `install failed: ${JSON.stringify(res.payload)}`);

    const cli = spawnSync(
      process.execPath,
      [
        path.join(__dirname, '..', 'scripts', 'install-apply.js'),
        '--target', 'cursor', '--profile', 'minimal', '--json',
      ],
      {
        cwd: cliProject,
        encoding: 'utf8',
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, EGC_INSTALL_DELEGATED: '1' },
      }
    );
    assert.equal(cli.status, 0, `CLI install failed: ${cli.stderr}\n${cli.stdout}`);

    // Ask the adapter where the install-state lands rather than parsing the
    // CLI's stdout: install-apply.js runs regenerateTopologyCache() before it
    // prints, and scripts/runtime/discovery.js logs to stdout when it
    // succeeds, so the JSON is not reliably the only thing on that stream.
    const cliStatePath = getInstallTargetAdapter('cursor').getInstallStatePath({
      repoRoot:    path.join(__dirname, '..'),
      projectRoot: cliProject,
      homeDir,
    });
    const panelStatePath = res.payload.result.applied.installStatePath;

    assert.equal(
      normalizeInstallState(fs.readFileSync(panelStatePath, 'utf8'), panelProject),
      normalizeInstallState(fs.readFileSync(cliStatePath, 'utf8'), cliProject),
      'the panel and `egc install --target cursor --profile minimal` must agree'
    );
  } finally {
    await server.close();
    removeDir(panelProject);
    removeDir(cliProject);
    removeDir(homeDir);
  }
});

test('the panel install honours ./egc-install.json the way the CLI does', async () => {
  // scripts/install-apply.js merges the default config into the request when
  // no --config and no positional languages were given. A panel that ignored
  // it would write a different install-state from the command beside the
  // button in any project that ships one.
  const token = '8'.repeat(64);
  const projectRoot = makeTempDir('egc-ops-config-');
  const homeDir = makeTempDir('egc-ops-config-home-');
  fs.writeFileSync(
    path.join(projectRoot, 'egc-install.json'),
    `${JSON.stringify({ version: 1, target: 'cursor', profile: 'minimal' }, null, 2)}\n`
  );
  const server = await startOpsServer({ token, homeDir, projectRoot });

  try {
    // No target and no profile in the body: everything must come from the file.
    const res = await postOps(server, 'install', { token, body: {} });
    assert.equal(res.status, 200, `install failed: ${JSON.stringify(res.payload)}`);
    assert.equal(res.payload.result.plan.target, 'cursor');
    assert.equal(res.payload.result.plan.profileId, 'minimal');
  } finally {
    await server.close();
    removeDir(projectRoot);
    removeDir(homeDir);
  }
});

test('an unknown target or profile is a 400 with a clear message, not a 500', async () => {
  // The manifests look profiles up on a plain object, so an inherited name
  // reaches "profile.modules is not iterable" rather than the "Unknown install
  // profile" a caller can act on. Both are caught at the route boundary.
  const token = 'a1'.repeat(32);
  const server = await startOpsServer({ token });
  try {
    for (const profile of ['constructor', 'toString', '__proto__', 'not-a-profile']) {
      const res = await postOps(server, 'install', { token, body: { target: 'cursor', profile } });
      assert.equal(res.status, 400, `profile ${profile} must be a 400, got ${res.status}`);
      assert.match(res.payload.error, /Unknown install profile/);
    }
    const badTarget = await postOps(server, 'install', {
      token,
      body: { target: 'nope', profile: 'minimal' },
    });
    assert.equal(badTarget.status, 400);
    assert.match(badTarget.payload.error, /Unknown install target/);

    const badDoctor = await postOps(server, 'doctor', { token, body: { targets: ['nope'] } });
    assert.equal(badDoctor.status, 400);
  } finally {
    await server.close();
  }
});

test('an oversized body is answered with 413, not a dropped connection', async () => {
  // reject() only schedules the handler that writes the response, so
  // destroying the request socket in the same tick would discard the 413
  // before a byte of it went out and the caller would see a network error.
  const token = '9'.repeat(64);
  const server = await startOpsServer({ token });
  try {
    const res = await fetch(`${server.origin}/ops/doctor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: token },
      body: JSON.stringify({ targets: ['x'.repeat(128 * 1024)] }),
    });
    assert.equal(res.status, 413);
    const payload = await res.json();
    assert.equal(payload.ok, false);
    assert.match(payload.error, /too large/i);
  } finally {
    await server.close();
  }
});

test('doctor over /ops reports every install target adapter for the buttons', async () => {
  const token = '3'.repeat(64);
  const server = await startOpsServer({ token });
  try {
    const res = await postOps(server, 'doctor', { token });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.payload.targets), 'doctor must carry the target catalog');
    assert.ok(res.payload.targets.length > 0);
    for (const entry of res.payload.targets) {
      assert.equal(typeof entry.id, 'string');
      assert.equal(typeof entry.target, 'string');
      assert.equal(typeof entry.installed, 'boolean');
    }
  } finally {
    await server.close();
  }
});

test('an install request with no profile or modules is a 400, not a 500', async () => {
  const token = '4'.repeat(64);
  // Isolated for the same reason as the dispatch test: a known target with no
  // profile clears both boundary checks, so runInstall reaches
  // loadDefaultInstallConfig(projectRoot). Against the checkout, an
  // egc-install.json at the repo root would supply the missing profile and turn
  // this into a real install before the assertion could fail.
  const homeDir = makeTempDir('egc-ops-noselection-home-');
  const projectRoot = makeTempDir('egc-ops-noselection-project-');
  const server = await startOpsServer({ token, homeDir, projectRoot });
  try {
    const res = await postOps(server, 'install', { token, body: { target: 'cursor' } });
    assert.equal(res.status, 400);
    assert.equal(res.payload.ok, false);
  } finally {
    await server.close();
    removeDir(projectRoot);
    removeDir(homeDir);
  }
});

test('a malformed body is a 400', async () => {
  const token = '5'.repeat(64);
  const server = await startOpsServer({ token });
  try {
    const res = await fetch(`${server.origin}/ops/doctor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: token },
      body: '{not json',
    });
    assert.equal(res.status, 400);
  } finally {
    await server.close();
  }
});

test('the exposed operations all come from the shared registry', () => {
  const registryNames = operations.listOperations();
  for (const name of listOpsOperations()) {
    assert.ok(
      registryNames.includes(name),
      `/ops/${name} must be backed by an operations-registry entry`
    );
  }
});

// ---------------------------------------------------------------------------
// Token file
// ---------------------------------------------------------------------------

test('loadOrCreateOpsToken creates ~/.egc/<token file> and reuses it', () => {
  const homeDir = makeTempDir('egc-ops-token-');
  try {
    const first = loadOrCreateOpsToken({ homeDir });
    assert.equal(first.tokenPath, path.join(homeDir, '.egc', TOKEN_FILE_NAME));
    assert.match(first.token, /^[0-9a-f]{64}$/);
    assert.ok(fs.existsSync(first.tokenPath));

    const second = loadOrCreateOpsToken({ homeDir });
    assert.equal(second.token, first.token, 'a restart must not invalidate a served panel');
  } finally {
    removeDir(homeDir);
  }
});

test('an unwritable ~/.egc degrades to an in-memory token instead of killing the dashboard', () => {
  // server.js resolves the token at module load, so throwing here would take
  // the whole panel down. ~/.egc is root-owned on the global installs #1231,
  // #1234 and #1239 exist to survive; the doctor screen is not worth that.
  const homeDir = makeTempDir('egc-ops-token-readonly-');
  const origMkdirSync = fs.mkdirSync;
  fs.mkdirSync = () => {
    const error = new Error('EACCES: permission denied');
    error.code = 'EACCES';
    throw error;
  };

  let result;
  try {
    result = loadOrCreateOpsToken({ homeDir });
  } finally {
    fs.mkdirSync = origMkdirSync;
    removeDir(homeDir);
  }

  assert.equal(result.persisted, false, 'the failure must be reported, not hidden');
  assert.match(result.token, /^[0-9a-f]{64}$/, 'the session still gets a usable token');
  assert.match(result.error, /EACCES/);
});

test('a token that could not be persisted still gates /ops normally', async () => {
  const homeDir = makeTempDir('egc-ops-token-readonly-gate-');
  const origMkdirSync = fs.mkdirSync;
  fs.mkdirSync = () => {
    const error = new Error('EACCES: permission denied');
    error.code = 'EACCES';
    throw error;
  };
  let token;
  try {
    token = loadOrCreateOpsToken({ homeDir }).token;
  } finally {
    fs.mkdirSync = origMkdirSync;
  }

  const server = await startOpsServer({ token });
  try {
    assert.equal((await postOps(server, 'doctor')).status, 401);
    assert.equal((await postOps(server, 'doctor', { token })).status, 200);
  } finally {
    await server.close();
    removeDir(homeDir);
  }
});

test('the token file is not world-readable', { skip: process.platform === 'win32' }, () => {
  const homeDir = makeTempDir('egc-ops-token-mode-');
  try {
    const { tokenPath } = loadOrCreateOpsToken({ homeDir });
    assert.equal(fs.statSync(tokenPath).mode & 0o077, 0, 'the token must stay owner-only');
  } finally {
    removeDir(homeDir);
  }
});

test('loadOrCreateOpsToken: concurrent start — the loser waits out a winner that has created but not yet written', () => {
  // The window the retry loop exists for: the winner has done openSync(wx) so
  // the file exists, but has not written the token into it yet. The loser must
  // spin until the token appears rather than take the file's emptiness as
  // permission to replace it.
  const homeDir = makeTempDir('egc-ops-token-midwrite-');
  const tokenPath = resolveTokenPath(homeDir);
  const winnerToken = 'd'.repeat(64);
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, '');

  const origReadFileSync = fs.readFileSync;
  let looks = 0;
  fs.readFileSync = (target, ...rest) => {
    if (target === tokenPath) {
      looks += 1;
      // Empty for the first few looks, then the winner's write lands.
      if (looks >= 4) return `${winnerToken}\n`;
      return '';
    }
    return origReadFileSync(target, ...rest);
  };

  let result;
  try {
    result = loadOrCreateOpsToken({ homeDir });
  } finally {
    fs.readFileSync = origReadFileSync;
    removeDir(homeDir);
  }

  assert.ok(looks >= 4, `the loser must re-read while the file is empty (looked ${looks} times)`);
  assert.equal(result.token, winnerToken, 'the loser must adopt the winner\'s token');
  assert.equal(result.persisted, true);
});

test('loadOrCreateOpsToken: a winner mid-write is never overwritten, even after the retries run out', () => {
  // If the token never appears within the budget, the empty file is still a
  // live writer's. Overwriting it would race a write that is still coming, so
  // this process must degrade to an in-memory token instead.
  const homeDir = makeTempDir('egc-ops-token-stalled-');
  const tokenPath = resolveTokenPath(homeDir);
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, '');

  let result;
  try {
    result = loadOrCreateOpsToken({ homeDir });
    assert.equal(result.persisted, false, 'a stalled winner must not be clobbered');
    assert.match(result.token, /^[0-9a-f]{64}$/, 'this process still gets a usable token');
    assert.equal(
      fs.readFileSync(tokenPath, 'utf8'),
      '',
      'the winner\'s file must be left exactly as it was'
    );
  } finally {
    removeDir(homeDir);
  }
});

test('loadOrCreateOpsToken: an abandoned empty token file is replaced, not honoured forever', () => {
  // The other side of the previous test: nobody is coming back for this one,
  // so refusing to write would leave every future start degraded.
  const homeDir = makeTempDir('egc-ops-token-abandoned-');
  const tokenPath = resolveTokenPath(homeDir);
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, '');
  const longAgo = new Date(Date.now() - 60_000);
  fs.utimesSync(tokenPath, longAgo, longAgo);

  try {
    const result = loadOrCreateOpsToken({ homeDir });
    assert.equal(result.persisted, true);
    assert.equal(fs.readFileSync(tokenPath, 'utf8').trim(), result.token);
  } finally {
    removeDir(homeDir);
  }
});

test('loadOrCreateOpsToken: a truncated token is not accepted as a whole one', () => {
  const homeDir = makeTempDir('egc-ops-token-truncated-');
  const tokenPath = resolveTokenPath(homeDir);
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  // A short write leaves a syntactically plausible prefix behind.
  fs.writeFileSync(tokenPath, `${'a'.repeat(40)}\n`);
  const longAgo = new Date(Date.now() - 60_000);
  fs.utimesSync(tokenPath, longAgo, longAgo);

  try {
    const { token } = loadOrCreateOpsToken({ homeDir });
    assert.notEqual(token, 'a'.repeat(40), 'a 40-character prefix is not a token');
    assert.match(token, /^[0-9a-f]{64}$/);
  } finally {
    removeDir(homeDir);
  }
});

test('loadOrCreateOpsToken: an unreadable token file is not treated as absent', () => {
  // A present-but-unreadable file holds somebody else's live token. Reading it
  // as "missing" would lead straight to replacing it.
  const homeDir = makeTempDir('egc-ops-token-unreadable-');
  const tokenPath = resolveTokenPath(homeDir);
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  const owner = 'e'.repeat(64);
  fs.writeFileSync(tokenPath, `${owner}\n`);

  const origReadFileSync = fs.readFileSync;
  fs.readFileSync = (target, ...rest) => {
    if (target === tokenPath) {
      const error = new Error('EACCES: permission denied');
      error.code = 'EACCES';
      throw error;
    }
    return origReadFileSync(target, ...rest);
  };

  let result;
  try {
    result = loadOrCreateOpsToken({ homeDir });
  } finally {
    fs.readFileSync = origReadFileSync;
  }

  try {
    assert.equal(result.persisted, false, 'an unreadable file must not be replaced');
    assert.match(result.error, /EACCES/);
    assert.equal(
      origReadFileSync(tokenPath, 'utf8').trim(),
      owner,
      'the existing token must survive untouched'
    );
  } finally {
    removeDir(homeDir);
  }
});

test('loadOrCreateOpsToken: replacing a corrupt file does not leave it world-readable', { skip: process.platform === 'win32' }, () => {
  // fs.writeFileSync's mode option is honoured only when open() creates the
  // file, so replacing a pre-existing 0644 file would otherwise write the live
  // token into it and leave the permission alone.
  const homeDir = makeTempDir('egc-ops-token-widemode-');
  const tokenPath = resolveTokenPath(homeDir);
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, 'not-a-token\n');
  fs.chmodSync(tokenPath, 0o644);

  try {
    const { token, persisted } = loadOrCreateOpsToken({ homeDir });
    assert.equal(persisted, true);
    assert.equal(fs.readFileSync(tokenPath, 'utf8').trim(), token);
    assert.equal(
      fs.statSync(tokenPath).mode & 0o077,
      0,
      'the replaced token file must not stay group/world readable'
    );
  } finally {
    removeDir(homeDir);
  }
});

test('loadOrCreateOpsToken: concurrent start — the loser reads back the winner\'s token', () => {
  // Two dashboards started close together can both observe the token file as
  // absent before either writes. Simulate the loser's view: readFileSync sees
  // nothing on the first look, but a winner has already written a real token
  // by the time the loser's own write executes. Overwriting it would 401 every
  // request from the panel the winner already served.
  const homeDir = makeTempDir('egc-ops-token-race-');
  const tokenPath = resolveTokenPath(homeDir);
  try {
    const winner = loadOrCreateOpsToken({ homeDir });

    const origReadFileSync = fs.readFileSync;
    let firstLook = true;
    fs.readFileSync = (target, ...rest) => {
      if (target === tokenPath && firstLook) {
        firstLook = false;
        const error = new Error('ENOENT: no such file or directory');
        error.code = 'ENOENT';
        throw error;
      }
      return origReadFileSync(target, ...rest);
    };

    let loser;
    try {
      loser = loadOrCreateOpsToken({ homeDir });
    } finally {
      fs.readFileSync = origReadFileSync;
    }

    assert.equal(
      loser.token,
      winner.token,
      'the loser must adopt the token that actually won the race on disk'
    );
    assert.equal(
      origReadFileSync(tokenPath, 'utf8').trim(),
      winner.token,
      'the winner\'s token on disk must remain untouched'
    );
  } finally {
    removeDir(homeDir);
  }
});

// ---------------------------------------------------------------------------
// Server wiring
// ---------------------------------------------------------------------------

test('server.js mints the token before serving and hands it to the panel', () => {
  // Whitespace-tolerant on purpose: these assert that the wiring exists, not
  // how it is formatted, so a Prettier run cannot fail them.
  assert.match(
    SERVER_SOURCE,
    /loadOrCreateOpsToken\s*\(/,
    'the token must be created at startup, not on first request'
  );
  assert.match(
    SERVER_SOURCE,
    /window\.__EGC_OPS_TOKEN\s*=/,
    'the token must be injected into index.html the way the port is'
  );
  // The /ops dispatch has to come before the permissive any-loopback-port CORS
  // header is set, so position is the thing worth asserting, not the spelling.
  const opsAt  = SERVER_SOURCE.search(/handleOps\s*\(\s*req\s*,\s*res\s*\)/);
  const corsAt = SERVER_SOURCE.search(/Access-Control-Allow-Origin/);
  assert.ok(opsAt !== -1, 'server.js must dispatch /ops');
  assert.ok(corsAt !== -1, 'server.js must still set the telemetry CORS header');
  assert.ok(
    opsAt < corsAt,
    '/ops must be answered before the permissive loopback CORS headers are set'
  );
});

process.on('exit', () => removeDir(SANDBOX_HOME));
