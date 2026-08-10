'use strict';

/**
 * dashboard/ops.js
 *
 * The panel's door onto the shared operations library (#1235). Every button on
 * the doctor screen posts to POST /ops/<operation> and lands on the exact same
 * registry function the CLI calls, so a panel install and an
 * `egc install --target <x>` write the same install-state file.
 *
 * Auth is local and mandatory from the first route: the server mints a token
 * under ~/.egc/ on startup and injects it into index.html the same way the port
 * is injected, so only a panel this server actually served can drive it. A
 * request without the token gets 401 and never reaches an operation. CORS is
 * pinned to the panel's own origin - the 127.0.0.1 bind stays as it is.
 */

const crypto = require('node:crypto');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const operations = require('../scripts/lib/operations/index');
const { normalizeInstallRequest } = require('../scripts/lib/install/request');
const { listInstallTargetAdapters } = require('../scripts/lib/install-targets/registry');

const TOKEN_FILE_NAME = 'dashboard-token';
const TOKEN_BYTES     = 32;
const TOKEN_HEADER    = 'x-egc-token';
const MAX_BODY_BYTES  = 64 * 1024;
const OPS_PREFIX      = '/ops/';

// The reference repo is wherever this dashboard lives, which for a global
// install is the published npm package - the same default `egc doctor` and
// `egc repair` use when no --repo-root is given.
const REPO_ROOT = path.join(__dirname, '..');

function resolveHomeDir(homeDir) {
  return homeDir || process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function resolveTokenPath(homeDir) {
  return path.join(resolveHomeDir(homeDir), '.egc', TOKEN_FILE_NAME);
}

function readTokenFile(tokenPath) {
  try {
    const raw = fs.readFileSync(tokenPath, 'utf8').trim();
    return /^[0-9a-f]{32,}$/i.test(raw) ? raw : null;
  } catch (_) {
    return null;
  }
}

/**
 * Return the local ops token, creating it on first launch.
 *
 * ~/.egc/dashboard-token is shared across concurrent EGC processes: two
 * dashboards started close together can both observe it as absent. The write
 * uses the 'wx' flag so exactly one of them creates the file and the loser
 * reads back the winner's token instead of overwriting it - overwriting would
 * silently 401 every request from the panel the winner already served.
 * See CONTRIBUTING "Concurrent-Access Regression Tests".
 *
 * @param {object} [options]
 * @param {string} [options.homeDir] - Resolve the token under this home
 * @returns {{ token: string, tokenPath: string }}
 */
function loadOrCreateOpsToken(options = {}) {
  const tokenPath = resolveTokenPath(options.homeDir);
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });

  const existing = readTokenFile(tokenPath);
  if (existing) {
    return { token: existing, tokenPath };
  }

  const candidate = crypto.randomBytes(TOKEN_BYTES).toString('hex');

  try {
    const fd = fs.openSync(tokenPath, 'wx', 0o600);
    try {
      fs.writeSync(fd, `${candidate}\n`);
    } finally {
      fs.closeSync(fd);
    }
    return { token: candidate, tokenPath };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;

    // Lost the race: whoever created the file owns the token.
    const winner = readTokenFile(tokenPath);
    if (winner) {
      return { token: winner, tokenPath };
    }

    // The file exists but holds nothing usable, so no panel can be
    // authenticating against it. Replace it rather than refuse to start.
    fs.writeFileSync(tokenPath, `${candidate}\n`, { mode: 0o600 });
    return { token: candidate, tokenPath };
  }
}

function tokensMatch(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which is itself the answer.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function panelOrigins(port) {
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
}

function isPanelOrigin(origin, port) {
  return panelOrigins(port).includes(origin);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let exceeded = false;

    req.on('data', chunk => {
      if (exceeded) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        exceeded = true;
        const error = new Error('Payload too large');
        error.statusCode = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('error', reject);

    req.on('end', () => {
      if (exceeded) return;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (_) {
        const error = new Error('Invalid JSON');
        error.statusCode = 400;
        reject(error);
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        const error = new Error('Request body must be a JSON object');
        error.statusCode = 400;
        reject(error);
        return;
      }
      resolve(parsed);
    });
  });
}

function toStringArray(value) {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.map(entry => String(entry).trim()).filter(Boolean);
}

/**
 * Every install target the panel can offer, flagged with whether the doctor
 * report already found an install-state for it. buildDoctorReport only reports
 * targets that exist on disk, so the not-yet-installed ones - the whole point
 * of an install button on a fresh machine - come from the adapter registry.
 */
function listTargetCatalog(report) {
  const installed = new Set(
    (report?.results || []).map(result => result.adapter?.id).filter(Boolean)
  );

  return listInstallTargetAdapters().map(adapter => ({
    id:        adapter.id,
    target:    adapter.target,
    kind:      adapter.kind,
    installed: installed.has(adapter.id),
  }));
}

function runDoctor(body, context) {
  const report = operations.doctor({
    repoRoot:    REPO_ROOT,
    homeDir:     context.homeDir,
    projectRoot: context.projectRoot,
    targets:     toStringArray(body.targets),
  });
  return { result: report, targets: listTargetCatalog(report) };
}

/**
 * Mirror of scripts/install-apply.js: the same normalized request, planned and
 * applied with the same projectRoot/homeDir. sourceRoot is deliberately left to
 * its default so the plan resolves against the same reference repo the CLI uses
 * - that is what keeps the written install-state byte-identical.
 */
function runInstall(body, context) {
  let request;
  try {
    request = normalizeInstallRequest({
      target:              body.target,
      profileId:           body.profile,
      moduleIds:           toStringArray(body.modules),
      includeComponentIds: toStringArray(body.with),
      excludeComponentIds: toStringArray(body.without),
    });
  } catch (error) {
    error.statusCode = 400;
    throw error;
  }

  return {
    result: operations.install(request, {
      projectRoot: context.projectRoot,
      homeDir:     context.homeDir,
    }),
  };
}

function runRepair(body, context) {
  return {
    result: operations.repair({
      repoRoot:    REPO_ROOT,
      homeDir:     context.homeDir,
      projectRoot: context.projectRoot,
      targets:     toStringArray(body.targets),
      dryRun:      body.dryRun === true,
    }),
  };
}

const OPERATION_HANDLERS = {
  doctor:  runDoctor,
  install: runInstall,
  repair:  runRepair,
};

function listOpsOperations() {
  return Object.keys(OPERATION_HANDLERS);
}

/**
 * Build the /ops request handler.
 *
 * @param {object} options
 * @param {string} options.token   - The token the panel was handed
 * @param {number} options.port    - Port the panel is served from
 * @param {string} [options.homeDir]
 * @param {string} [options.projectRoot]
 * @returns {(req, res) => boolean} true when the request was an /ops request
 *                                  and has been answered
 */
function createOpsHandler(options = {}) {
  const { token, port } = options;
  const context = {
    homeDir:     resolveHomeDir(options.homeDir),
    projectRoot: options.projectRoot || process.cwd(),
  };

  return function handleOps(req, res) {
    const pathname = (req.url || '').split('?')[0];
    if (!pathname.startsWith(OPS_PREFIX)) return false;

    // Restricted to the panel's own origin, unlike the permissive
    // any-loopback-port header the telemetry routes carry.
    const origin = req.headers.origin || '';
    res.setHeader('Access-Control-Allow-Origin', `http://localhost:${port}`);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', `Content-Type, ${TOKEN_HEADER}`);
    res.setHeader('Vary', 'Origin');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'Method not allowed' });
      return true;
    }

    if (origin && !isPanelOrigin(origin, port)) {
      sendJson(res, 403, { ok: false, error: 'Origin not allowed' });
      return true;
    }

    if (!tokensMatch(req.headers[TOKEN_HEADER], token)) {
      sendJson(res, 401, { ok: false, error: 'Missing or invalid EGC dashboard token' });
      return true;
    }

    const operation = pathname.slice(OPS_PREFIX.length);
    const handler = OPERATION_HANDLERS[operation];
    if (!handler) {
      sendJson(res, 404, { ok: false, error: `Unknown operation: ${operation}` });
      return true;
    }

    readJsonBody(req)
      .then(body => {
        const { result, targets } = handler(body, context);
        const payload = { ok: true, operation, result };
        if (targets) payload.targets = targets;
        sendJson(res, 200, payload);
      })
      .catch(error => {
        sendJson(res, error.statusCode || 500, { ok: false, error: error.message });
      });

    return true;
  };
}

module.exports = {
  TOKEN_FILE_NAME,
  TOKEN_HEADER,
  createOpsHandler,
  listOpsOperations,
  loadOrCreateOpsToken,
  resolveTokenPath,
};
