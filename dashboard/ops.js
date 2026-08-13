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
const { findDefaultInstallConfigPath, loadInstallConfig } = require('../scripts/lib/install/config');
const { listInstallProfiles } = require('../scripts/lib/install-manifests');
const { applyCommitPrivacyFilterCli } = require('../scripts/lib/memory-filters');
const { listInstalledPlugins, reinstallAllPlugins } = require('../scripts/lib/plugin-registry');

const TOKEN_FILE_NAME = 'dashboard-token';
const TOKEN_BYTES     = 32;
const TOKEN_HEADER    = 'x-egc-token';
const MAX_BODY_BYTES  = 64 * 1024;
const OPS_PREFIX      = '/ops/';
// Bounded wait for a concurrent creator to finish writing the token file.
const TOKEN_RACE_ATTEMPTS = 10;
const TOKEN_RACE_WAIT_MS  = 5;
// An empty token file younger than this is a live writer; older than it, the
// writer died between creating and writing and nobody is coming back for it.
const TOKEN_STALE_MS = 5000;
// Every token this writes is exactly TOKEN_BYTES hex-encoded. Accepting
// anything shorter would let a truncated write pass as a whole token.
const TOKEN_PATTERN = new RegExp(`^[0-9a-f]{${TOKEN_BYTES * 2}}$`, 'i');

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

// The token is resolved once, at startup, before the server accepts a
// connection, so blocking here delays nothing that is already running.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The token on disk, or null when the file is absent or holds no whole token.
 *
 * Only ENOENT means "absent". A file that exists but cannot be read - root
 * owned after a `sudo egc dashboard`, a restrictive ACL - still holds somebody
 * else's live token, and reporting it as missing would lead to replacing it.
 * Those errors propagate so the caller can degrade instead of overwrite.
 */
function readTokenFile(tokenPath) {
  let raw;
  try {
    raw = fs.readFileSync(tokenPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const token = raw.trim();
  return TOKEN_PATTERN.test(token) ? token : null;
}

// fs.writeSync is not obliged to write the whole buffer in one call, and a
// short write here leaves a truncated token that the next reader would have to
// reject - or, worse, accept.
function writeAllSync(fd, text) {
  const buffer = Buffer.from(text, 'utf8');
  let written = 0;
  while (written < buffer.length) {
    written += fs.writeSync(fd, buffer, written, buffer.length - written);
  }
}

// An empty token file is either a winner between its create and its write, or
// the wreckage of one that died in that window. mtime tells the two apart.
function emptyTokenFileAge(tokenPath) {
  const stat = fs.statSync(tokenPath);
  return stat.size === 0 ? Date.now() - stat.mtimeMs : null;
}

function replaceTokenFile(tokenPath, token) {
  // 'w' hands its mode argument to open(), and POSIX applies that only when
  // O_CREAT actually creates the file. Replacing an existing token file
  // therefore inherits whatever mode it already had, so a world-readable one
  // left by a shell redirect or a restored backup would receive the live
  // token and stay world-readable. Set the permission explicitly.
  const fd = fs.openSync(tokenPath, 'w', 0o600);
  try {
    writeAllSync(fd, `${token}\n`);
    try {
      fs.fchmodSync(fd, 0o600);
    } catch (_) {
      // Windows has no POSIX mode to set; the file is already user-scoped.
    }
  } finally {
    fs.closeSync(fd);
  }
  return token;
}

/**
 * Read the token from disk, or write `candidate` there if nobody has yet.
 *
 * ~/.egc/dashboard-token is shared across concurrent EGC processes: two
 * dashboards started close together can both observe it as absent. The write
 * uses the 'wx' flag so exactly one of them creates the file and the loser
 * reads back the winner's token instead of overwriting it - overwriting would
 * silently 401 every request from the panel the winner already served.
 * See CONTRIBUTING "Concurrent-Access Regression Tests".
 *
 * Throws whatever the filesystem throws; loadOrCreateOpsToken decides what a
 * failure means.
 */
function persistOpsToken(tokenPath, candidate) {
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });

  const existing = readTokenFile(tokenPath);
  if (existing) return existing;

  try {
    const fd = fs.openSync(tokenPath, 'wx', 0o600);
    try {
      writeAllSync(fd, `${candidate}\n`);
    } finally {
      fs.closeSync(fd);
    }
    return candidate;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;

    // Lost the race: whoever created the file owns the token. The file is
    // created before it is written, so a loser that looks in that window sees
    // it empty - that is a winner mid-write, not a corrupt file, and replacing
    // it would hand two live dashboards two different tokens. Give the winner
    // time to finish before concluding the file is unusable.
    for (let attempt = 0; attempt < TOKEN_RACE_ATTEMPTS; attempt += 1) {
      const winner = readTokenFile(tokenPath);
      if (winner) return winner;
      sleepSync(TOKEN_RACE_WAIT_MS);
    }

    // Still nothing usable. An empty file that was touched moments ago is the
    // winner-mid-write case the loop above is for, and racing its pending
    // write is worse than not persisting at all - so leave it and let this
    // process run on a token that lives only in memory. Anything else (an
    // empty file nobody came back to, content that is not a token) is
    // wreckage, and replacing it is what lets the next start be healthy.
    const emptyFor = emptyTokenFileAge(tokenPath);
    if (emptyFor !== null && emptyFor < TOKEN_STALE_MS) {
      throw new Error(
        `${tokenPath} is being written by another EGC process`,
        { cause: error }
      );
    }
    return replaceTokenFile(tokenPath, candidate);
  }
}

/**
 * Return the local ops token, creating it on first launch.
 *
 * A token that cannot be written is not a reason to take the dashboard down:
 * ~/.egc is root-owned on the global installs EGC#1231/#1234/#1239 exist to
 * survive, and this runs at module load in server.js, so throwing here would
 * kill the whole panel over a feature it does not need to render. The session
 * falls back to a token that lives only in memory - /ops still works for the
 * panel this process serves, and only survival across a restart is lost.
 *
 * @param {object} [options]
 * @param {string} [options.homeDir] - Resolve the token under this home
 * @returns {{ token: string, tokenPath: string, persisted: boolean, error?: string }}
 */
function loadOrCreateOpsToken(options = {}) {
  const tokenPath = resolveTokenPath(options.homeDir);
  const candidate = crypto.randomBytes(TOKEN_BYTES).toString('hex');

  try {
    return { token: persistOpsToken(tokenPath, candidate), tokenPath, persisted: true };
  } catch (error) {
    return { token: candidate, tokenPath, persisted: false, error: error.message };
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
        // Stop reading, but do NOT destroy the socket here: reject() only
        // schedules the .catch that writes the 413, so destroying now would
        // tear the connection down before a single byte of it went out and
        // the caller would see a network error instead of the reason. Node
        // closes the socket itself once the response ends with the request
        // body unread.
        req.pause();
        reject(error);
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

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

/**
 * Check target and profile names against the registries before any library
 * sees them. Two reasons. A name that is not a target is a bad request, and
 * without this it surfaces as a 500 carrying an internal message. And the
 * manifests look profiles up on a plain object, so an inherited name like
 * `constructor` reaches `profile.modules is not iterable` instead of the
 * "Unknown install profile" this returns - the same shape of hole the
 * operation dispatch had, closed here at the edge of the new HTTP surface.
 */
function assertKnownTargets(targets) {
  if (targets.length === 0) return targets;
  const known = new Set(listInstallTargetAdapters().flatMap(a => [a.id, a.target]));
  for (const target of targets) {
    if (!known.has(target)) throw badRequest(`Unknown install target: ${target}`);
  }
  return targets;
}

function assertKnownProfile(profileId) {
  if (profileId === undefined || profileId === null || profileId === '') return profileId;
  if (typeof profileId !== 'string') throw badRequest('profile must be a string');
  const known = listInstallProfiles().map(profile => profile.id);
  if (!known.includes(profileId)) {
    throw badRequest(`Unknown install profile: ${profileId}`);
  }
  return profileId;
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
    targets:     assertKnownTargets(toStringArray(body.targets)),
  });
  return { result: report, targets: listTargetCatalog(report) };
}

/**
 * `egc install` merges ./egc-install.json into the request whenever no --config
 * and no positional languages were given (scripts/install-apply.js
 * resolveInstallConfig). The panel passes neither, so the same default applies
 * to it - without this, a project holding an egc-install.json would get a
 * different install-state from the button than from the command beside it.
 */
function loadDefaultInstallConfig(projectRoot) {
  const configPath = findDefaultInstallConfigPath({ cwd: projectRoot });
  return configPath ? loadInstallConfig(configPath, { cwd: projectRoot }) : null;
}

/**
 * The git filter that keeps the README's "memory never gets committed" promise.
 * `egc install` sets it up after applying (scripts/install-apply.js
 * configureCommitPrivacyFilterBestEffort) and, as the name says, never lets a
 * failure here fail the install.
 */
function configureCommitPrivacyBestEffort(projectRoot) {
  const messages = [];
  try {
    applyCommitPrivacyFilterCli({
      projectDir: projectRoot,
      scriptPath: path.join(REPO_ROOT, 'scripts', 'check-state-leak.js'),
      log:        message => messages.push(String(message)),
    });
    return { ok: true, messages };
  } catch (error) {
    return { ok: false, messages, error: error.message };
  }
}

/**
 * Mirror of scripts/install-apply.js: the same normalized request - default
 * install config included - planned and applied with the same projectRoot and
 * homeDir, then the same commit-privacy filter setup. sourceRoot is
 * deliberately left to its default so the plan resolves against the same
 * reference repo the CLI uses; that is what keeps the install-state identical.
 */
async function runInstall(body, context) {
  let request;
  try {
    assertKnownProfile(body.profile);
    if (body.target) assertKnownTargets([String(body.target)]);
    request = normalizeInstallRequest({
      target:              body.target,
      profileId:           body.profile,
      moduleIds:           toStringArray(body.modules),
      includeComponentIds: toStringArray(body.with),
      excludeComponentIds: toStringArray(body.without),
      config:              loadDefaultInstallConfig(context.projectRoot),
    });
  } catch (error) {
    error.statusCode = 400;
    throw error;
  }

  // install() awaits the install-state store sync internally, so warnings that
  // only surface after that IO land in result.warnings rather than nowhere.
  const result = await operations.install(request, {
    projectRoot: context.projectRoot,
    homeDir:     context.homeDir,
  });

  return {
    result: {
      ...result,
      commitPrivacy: configureCommitPrivacyBestEffort(context.projectRoot),
    },
  };
}

/**
 * `egc repair` repairs install-state and then reinstalls every plugin in the
 * lock file (scripts/repair.js executePluginRepairs), skipping both on a dry
 * run and when nothing is installed. The command printed beside the Repair
 * button does that, so the button does too.
 */
function reinstallPluginsBestEffort() {
  try {
    if (listInstalledPlugins().length === 0) return [];
    return reinstallAllPlugins();
  } catch (error) {
    return [{ name: '(plugins)', success: false, errors: [error.message] }];
  }
}

function runRepair(body, context) {
  const dryRun = body.dryRun === true;
  const result = operations.repair({
    repoRoot:    REPO_ROOT,
    homeDir:     context.homeDir,
    projectRoot: context.projectRoot,
    targets:     assertKnownTargets(toStringArray(body.targets)),
    dryRun,
  });

  const pluginRepairs = dryRun ? [] : reinstallPluginsBestEffort();
  return { result: pluginRepairs.length > 0 ? { ...result, pluginRepairs } : result };
}

function runSavingsLedger(body) {
  const report = operations.savingsLedger(body);
  return { result: report };
}

// ---------------------------------------------------------------------------
// Session Bus handlers (slice 3, #1238)
//
// Bridge the panel to the egc-memory session bus via the shared operations
// library. The actual MCP stdio call lives in scripts/lib/operations/index.js
// so the CLI can reach the same code path through its own door.
//
// BUG-08 dependency (documented per acceptance criteria): the egc-memory MCP
// server opens ~/.egc/memory/state.db while the CLI state store uses
// ~/.egc/egc/state.db. The bus operates on a separate SQLite file from the
// one operations.state() reads. Do not fix here; this slice works with the
// bus as it exists today.
// ---------------------------------------------------------------------------

async function runSessionPeers(body) {
  const result = await operations.sessionPeers({
    projectPath: body.projectPath || undefined,
  });
  return { result };
}

async function runSessionSend(body) {
  const result = await operations.sessionSend({
    sessionId:   body.sessionId   || undefined,
    toSession:   body.toSession   || undefined,
    projectPath: body.projectPath || undefined,
    kind:        body.kind,
    payload:     body.payload     || undefined,
  });
  return { result };
}

async function runSessionEvents(body) {
  const result = await operations.sessionEvents({
    sessionId:   body.sessionId   || undefined,
    projectPath: body.projectPath || undefined,
    peek:        body.peek !== undefined ? Boolean(body.peek) : undefined,
  });
  return { result };
}

// A Map, not an object literal: the operation name comes straight off the
// request path, and an object literal would resolve inherited keys too.
// `OPERATION_HANDLERS['constructor']` is a truthy function, so it would sail
// past the not-found check and be invoked - answering 200 for /ops/constructor,
// or throwing out of the handler for /ops/__defineGetter__. A Map lookup only
// ever sees keys that were explicitly put in it.
const OPERATION_HANDLERS = new Map([
  ['doctor',        runDoctor],
  ['install',       runInstall],
  ['repair',        runRepair],
  ['savingsLedger', runSavingsLedger],
  // Session bus (slice 3, #1238)
  ['sessionPeers',  runSessionPeers],
  ['sessionSend',   runSessionSend],
  ['sessionEvents', runSessionEvents],
]);

function listOpsOperations() {
  return [...OPERATION_HANDLERS.keys()];
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
    // typeof, not just truthiness: the operation name comes off the request
    // path, and this is the guard that has to hold before it selects what gets
    // called. A Map already keeps inherited keys out of reach, so this is
    // belt-and-braces against a non-function ever being registered in the
    // table by mistake - and it is the sanitizer CodeQL's
    // js/unvalidated-dynamic-method-call recognises, which a truthiness check
    // alone is not.
    const handler = OPERATION_HANDLERS.get(operation);
    if (typeof handler !== 'function') {
      sendJson(res, 404, { ok: false, error: `Unknown operation: ${operation}` });
      return true;
    }

    readJsonBody(req)
      // Handlers may be sync or async - install() is async since #1235, because
      // it awaits the install-state store sync so late warnings are captured.
      // Resolving the handler's return here keeps both kinds working, instead
      // of serialising a Promise into the response body.
      .then(body => handler(body, context))
      .then(({ result, targets }) => {
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
