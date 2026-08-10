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
    const cli = operations.install(request, { projectRoot: cliProject, homeDir });

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
  const server = await startOpsServer({ token });
  try {
    const res = await postOps(server, 'install', { token, body: { target: 'cursor' } });
    assert.equal(res.status, 400);
    assert.equal(res.payload.ok, false);
  } finally {
    await server.close();
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

test('the token file is not world-readable', { skip: process.platform === 'win32' }, () => {
  const homeDir = makeTempDir('egc-ops-token-mode-');
  try {
    const { tokenPath } = loadOrCreateOpsToken({ homeDir });
    assert.equal(fs.statSync(tokenPath).mode & 0o077, 0, 'the token must stay owner-only');
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
  assert.match(
    SERVER_SOURCE,
    /loadOrCreateOpsToken\(\)/,
    'the token must be created at startup, not on first request'
  );
  assert.match(
    SERVER_SOURCE,
    /window\.__EGC_OPS_TOKEN=/,
    'the token must be injected into index.html the way the port is'
  );
  assert.match(
    SERVER_SOURCE,
    /if \(handleOps\(req, res\)\) return;/,
    '/ops must be answered before the permissive loopback CORS headers are set'
  );
});

process.on('exit', () => removeDir(SANDBOX_HOME));
