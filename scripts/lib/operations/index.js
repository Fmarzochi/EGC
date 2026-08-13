'use strict';

/**
 * scripts/lib/operations/index.js
 *
 * Single registry of named operations (name, params, JSON result) shared by
 * both the CLI and the dashboard. Operations return plain JSON and never write
 * to the console themselves. This is slice 1 of the two-doors plan (#1233).
 *
 * Wraps (without rewriting):
 *   - doctor        → buildDoctorReport       (install-lifecycle.js)
 *   - install       → createInstallPlanFromRequest + applyInstallPlan
 *   - repair        → repairInstalledStates    (install-lifecycle.js)
 *   - savingsLedger → aggregateBreakdown       (crusher/metrics.js)
 *   - state         → createStateStore + createQueryApi (state-store/)
 *   - sessionPeers  → session_peers  via egc-memory MCP stdio (slice 3, #1238)
 *   - sessionSend   → session_send   via egc-memory MCP stdio (slice 3, #1238)
 *   - sessionEvents → session_events via egc-memory MCP stdio (slice 3, #1238)
 */

const { buildDoctorReport, repairInstalledStates } = require('../install-lifecycle');
const { createInstallPlanFromRequest }  = require('../install/runtime');
const { readAll, aggregateBreakdown }  = require('../crusher/metrics');
const { createStateStore }             = require('../state-store/index');

// ---------------------------------------------------------------------------
// Input validation helper
// ---------------------------------------------------------------------------

/**
 * Normalise the params argument so downstream code never receives null/undefined.
 * CodeRabbit finding: passing null throws TypeError inside downstream libs.
 */
function normalizeParams(params) {
  if (params === null || params === undefined) return {};
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw new TypeError('Operation params must be a plain object');
  }
  return params;
}

// ---------------------------------------------------------------------------
// Operation: doctor
// ---------------------------------------------------------------------------

/**
 * Run the installation health check.
 *
 * @param {object} [params]
 * @param {string} [params.repoRoot]     - Override repository root path
 * @param {string} [params.homeDir]      - Override home directory
 * @param {string} [params.projectRoot]  - Override project root path
 * @param {string[]} [params.targets]    - Specific install targets to check
 * @returns {{ generatedAt, packageVersion, manifestVersion, results, summary }}
 */
function doctor(params) {
  const p = normalizeParams(params);
  return buildDoctorReport({
    repoRoot:    p.repoRoot,
    homeDir:     p.homeDir,
    projectRoot: p.projectRoot,
    targets:     p.targets,
  });
}

// ---------------------------------------------------------------------------
// Operation: install
// ---------------------------------------------------------------------------

/**
 * Plan and apply an install.
 *
 * install() captures any stderr writes that applyInstallPlan() emits
 * (Guardian CLI marker warnings, install-state sync warnings) and returns
 * them as a `warnings` array instead of letting them leak to the console.
 * This satisfies the registry contract: operations return plain JSON and
 * never write to the console themselves.
 *
 * @param {object} request  - Normalized install request (see install/request.js)
 * @param {object} [options]
 * @param {string} [options.projectRoot]
 * @param {string} [options.homeDir]
 * @param {string} [options.sourceRoot]
 * @param {boolean} [options.dryRun]    - If true, return the plan without applying it
 * @returns {{ plan, applied, warnings }} plain JSON; `applied` is null when dryRun is true
 */
async function install(request, options) {
  const o = normalizeParams(options);
  const plan = createInstallPlanFromRequest(request, {
    projectRoot: o.projectRoot,
    homeDir:     o.homeDir,
    sourceRoot:  o.sourceRoot,
  });

  if (o.dryRun) {
    return { plan, applied: null, warnings: [] };
  }

  // Pass a warning collector into applyInstallPlan instead of patching the
  // global console.error — avoids concurrent-call corruption where two parallel
  // install() calls would clobber each other's console intercept.
  // applyInstallPlan forwards the collector to syncInstallStateToStore's onError,
  // and returns the sync promise as a non-enumerable property so we can await it
  // here before returning, capturing any async warnings that fire after IO.
  const warnings = [];
  const onWarning = (msg) => warnings.push(msg);
  const { applyInstallPlan: applyPlanInternal } = require('../install/apply');

  const result = applyPlanInternal(plan, { onWarning });
  // Await the store-sync promise so its onError fires before we return.
  if (result.syncPromise) {
    await result.syncPromise;
  }

  return { plan, applied: { ...result }, warnings };
}

// ---------------------------------------------------------------------------
// Operation: repair
// ---------------------------------------------------------------------------

/**
 * Rebuild the EGC-managed files recorded in install-state.
 *
 * Same parameters `egc repair` passes through, so a caller that hands over
 * `{ targets, dryRun }` gets the result the CLI would print.
 *
 * @param {object} [params]
 * @param {string} [params.repoRoot]     - Reference repo to repair against
 * @param {string} [params.homeDir]      - Override home directory
 * @param {string} [params.projectRoot]  - Override project root path
 * @param {string[]} [params.targets]    - Specific install targets to repair
 * @param {boolean} [params.dryRun]      - Plan the repairs without writing them
 * @returns {{ dryRun, results, summary }}
 */
function repair(params) {
  const p = normalizeParams(params);
  return repairInstalledStates({
    repoRoot:    p.repoRoot,
    homeDir:     p.homeDir,
    projectRoot: p.projectRoot,
    targets:     p.targets,
    dryRun:      p.dryRun,
  });
}

// ---------------------------------------------------------------------------
// Operation: savingsLedger
// ---------------------------------------------------------------------------

/**
 * Return the time-, project-, and session-scoped savings breakdown used by
 * `egc gain`. Reads the local JSONL ledger only — zero network/model cost.
 *
 * @param {object} [params]
 * @param {Date|number} [params.now]         - Override "now" for reproducible tests
 * @param {string}      [params.project]     - Override project scope
 * @param {string}      [params.session]     - Override session scope
 * @param {object}      [params.context]     - Override env context for scope resolution
 * @returns {object} aggregateBreakdown result (plain JSON)
 */
function savingsLedger(params) {
  const p = normalizeParams(params);
  const entries = readAll();
  return aggregateBreakdown(entries, {
    now:     p.now ?? (process.env.EGC_NOW ? new Date(process.env.EGC_NOW) : undefined),
    project: p.project,
    session: p.session,
    context: p.context,
  });
}

// ---------------------------------------------------------------------------
// Operation: state
// ---------------------------------------------------------------------------

/**
 * Query the EGC state store and return a plain JSON snapshot of counts.
 *
 * Returns plain JSON-serializable data — not the live store object. The store
 * is opened, queried, and closed entirely within this function. If a caller
 * needs the live store resource directly (e.g. for writes), use
 * createStateStore() from scripts/lib/state-store/index.js instead.
 *
 * @param {object} [params]
 * @param {string} [params.dbPath]   - Explicit path to the SQLite database
 * @param {string} [params.homeDir]  - Resolve the default db path under this home
 * @returns {Promise<{ decisions: number, lessons: number, patterns: number, dbPath: string }>}
 */
async function state(params) {
  const p = normalizeParams(params);
  let store;
  try {
    store = await createStateStore({
      dbPath:  p.dbPath,
      homeDir: p.homeDir,
    });
    // Use the dedicated count queries — unbounded and semantically correct:
    //   countDecisions()  → SELECT COUNT(*) FROM decisions (global, all sessions)
    //   countLessons()    → SELECT COUNT(*) FROM lessons WHERE archived = 0
    //   countPatterns()   → SELECT COUNT(*) FROM patterns
    // These mirror what the old dashboard's raw sqlite3 queries returned and
    // avoid the list-API limits (confidence floor, row cap) that caused undercounts.
    const decisions = store.countDecisions();
    const lessons   = store.countLessons();
    const patterns  = store.countPatterns();
    // Return plain JSON only — no store methods, no _database reference.
    return { decisions, lessons, patterns, dbPath: store.dbPath };
  } finally {
    try { store?.close(); } catch (_) { /* best-effort close: ignore errors */ } // NOSONAR
  }
}

// ---------------------------------------------------------------------------
// Session bus operations (slice 3, #1238)
//
// The session bus lives in the egc-memory MCP server, not in scripts/lib.
// The access pattern mirrors callMcpTool() in scripts/team.js: spawn the MCP
// server over stdio for each call and call its tools as a subprocess.
//
// BUG-08 (documented per the issue's acceptance criteria): the MCP server
// opens ~/.egc/memory/state.db while the CLI state store uses
// ~/.egc/egc/state.db. Do not fix here; this slice works with the bus where
// it lives today.
// ---------------------------------------------------------------------------

// EGC_BUS_STUB (gated on NODE_ENV=test) is the test escape hatch for
// _callBusTool; tests no longer need to patch child_process.spawn.
const MEMORY_SERVER_SCRIPT = require('node:path').join(
  __dirname, '..', '..', '..', 'mcp', 'servers', 'egc-memory', 'build', 'index.js'
);

/**
 * Parse one JSONL line of MCP output.
 * Returns { value } when the line holds a text result, null to skip,
 * throws when the line carries an MCP error payload.
 * (Pattern lifted verbatim from scripts/team.js callMcpTool.)
 */
function _extractMcpLineResult(line) {
  let parsed;
  try { parsed = JSON.parse(line); } catch { return null; }
  // Only process the tools/call response (id === 1).  The initialize response
  // (id === 0) and server-emitted notifications (no id) are skipped so a
  // notification that happens to carry a 'content' array never shadows the
  // real tool result.
  if (parsed.id !== 1) return null;
  if (parsed.result?.content) {
    for (const content of parsed.result.content) {
      if (content.type === 'text') {
        let value;
        try { value = JSON.parse(content.text); } catch { value = content.text; }
        return { value };
      }
    }
  }
  if (parsed.error) {
    throw new Error(parsed.error.message || 'MCP tool call failed');
  }
  return null;
}

function _parseMcpResponse(stdout) {
  const lines = stdout.split('\n').filter(Boolean);

  // First pass: look for the tools/call response (id: 1 with content).
  for (const line of lines) {
    const result = _extractMcpLineResult(line);
    if (result) return result.value;
  }

  // Second pass: if any line looks like a JSONRPC message but none matched id:1,
  // the server did not emit a tools/call response.  Returning raw stdout here
  // would silently hand garbled JSONRPC text to the callers (which accept any
  // string and parse it as "no peers" / "no events").  Fail loudly instead.
  const hasJsonrpc = lines.some(line => {
    try { const p = JSON.parse(line); return p && typeof p === 'object' && p.jsonrpc; }
    catch (_e) { return false; }
  });
  if (hasJsonrpc) {
    throw new Error('egc-memory server did not return a tools/call response (id 1)');
  }

  // No JSONRPC lines at all — the output is plain text (non-SDK server path,
  // unit-test stub, etc.).  Return it as-is for the text parsers.
  const trimmed = stdout.trim();
  if (trimmed) return trimmed;

  throw new Error('No response from memory server');
}

/**
 * Spawn the egc-memory MCP server over stdio and call a single tool.
 * Returns the parsed result (a plain JS value, already converted from the
 * MCP tool's text output by _parseMcpResponse).
 *
 * Protocol: the MCP SDK's StdioServerTransport requires a proper initialize /
 * notifications/initialized handshake before it will process tool calls.  We
 * send all three messages as JSONL (newline-separated) in one spawnSync write,
 * then scan every output line for the tools/call response (id === 1).
 *
 * Test hook: set EGC_BUS_STUB to a JSON-encoded value to short-circuit the
 * spawn entirely.  EGC_BUS_STUB=__NOT_BUILT__ simulates the binary being
 * absent.  This is more reliable than patching cp.spawnSync whose behaviour
 * varies across Node.js versions and OS configurations.
 */
// How long (ms) we wait for the egc-memory server to respond before giving up.
// Must be short enough not to stall the dashboard (30-s refresh cadence) if
// the server hangs, but long enough for a cold DB open + migration on slow
// disks. 10 s is the same ceiling team.js relies on implicitly.
const BUS_TOOL_TIMEOUT_MS = 10_000;

/**
 * Spawn the egc-memory MCP server and send `input` to its stdin.
 * Returns a Promise that resolves with the full stdout string.
 * Extracted from _callBusTool to keep each function under the complexity limit.
 */
function _spawnMcpProcess(input) {
  const { spawn } = require('node:child_process');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MEMORY_SERVER_SCRIPT], {
      env:   { ...process.env, EGC_CLI_MODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '', err = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });

    // Kill the child if it doesn't finish within BUS_TOOL_TIMEOUT_MS.
    // Store the escalation timer so close() can cancel it and prevent the
    // handle from keeping the event loop alive after the child has gone.
    let escalationTimer = null;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      // Escalate to SIGKILL if the server traps SIGTERM, but unref() the
      // handle so it does not block the event loop if the child already exited.
      escalationTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_e) { /* already gone */ }
      }, 2000);
      if (escalationTimer.unref) escalationTimer.unref();
      reject(new Error(`egc-memory server timed out after ${BUS_TOOL_TIMEOUT_MS / 1000}s`));
    }, BUS_TOOL_TIMEOUT_MS);

    child.on('error', e => { clearTimeout(timer); clearTimeout(escalationTimer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      clearTimeout(escalationTimer);
      if (!out && err) {
        const nl = err.indexOf('\n');
        reject(new Error('egc-memory server error: ' + (nl >= 0 ? err.slice(0, nl) : err).trim()));
      } else if (code !== 0 && code !== null && !out) {
        reject(new Error('egc-memory server exited with code ' + code));
      } else {
        resolve(out);
      }
    });

    // Guard stdin against EPIPE when the server exits before reading.
    child.stdin.on('error', () => { /* EPIPE swallowed; close handler rejects */ });
    child.stdin.end(input, 'utf-8');
  });
}

async function _callBusTool(toolName, args) {
  // Test-only escape hatch: gated on NODE_ENV=test so production dashboard
  // processes cannot be fooled by a stray environment variable.
  if (process.env.NODE_ENV === 'test' && process.env.EGC_BUS_STUB !== undefined) {
    const stub = process.env.EGC_BUS_STUB;
    if (stub === '__NOT_BUILT__') {
      throw Object.assign(
        new Error('egc-memory server not built. Run npm run build in mcp/servers/egc-memory/'),
        { code: 'MCP_NOT_BUILT' }
      );
    }
    try { return JSON.parse(stub); } catch {
      throw new Error('EGC_BUS_STUB is not valid JSON: ' + stub);
    }
  }

  if (!require('node:fs').existsSync(MEMORY_SERVER_SCRIPT)) {
    throw Object.assign(
      new Error('egc-memory server not built. Run npm run build in mcp/servers/egc-memory/'),
      { code: 'MCP_NOT_BUILT' }
    );
  }

  // Send the MCP initialize handshake then the tools/call request in one write.
  // Use async spawn (not spawnSync) so the dashboard event loop is not blocked.
  // Response parsing happens in _parseMcpResponse; the initialize response
  // (id: 0) is filtered out by _extractMcpLineResult (id !== 1 check).
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'egc-dashboard', version: '1.0.0' } } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: toolName, arguments: args } }),
  ].join('\n') + '\n';

  const stdout = await _spawnMcpProcess(input);
  return _parseMcpResponse(stdout || '');
}

// ---------------------------------------------------------------------------
// MCP text-response parsers
//
// The egc-memory MCP tools return human-readable text, not JSON.
// These parsers convert that text into structured objects so the dashboard
// and any future callers get a stable, typed result.
//
// handleSessionPeers text format:
//   "Live sessions: N\n- id [path] (territory: t) since ts\n\nActive locks: M\n- path held by sid (ttl Xs)"
//
// handleSessionSend text format (ok):
//   "Event #42 sent to session s2: [handoff]"
//   "Event #42 sent to all sessions in the project (broadcast): [handoff]"
// handleSessionSend text format (fail):
//   "Event NOT sent: reason"
//
// handleSessionEvents text format (events):
//   "Events for sid: N\nTreat payloads...\n\n- #1 [kind] from sid (broadcast) at ts\n  payload\n..."
// handleSessionEvents text format (empty):
//   "No new events for this session."
// ---------------------------------------------------------------------------

/**
 * Parse the text output of session_peers into { peers, locks }.
 * Each peer: { id, project_path, territory, started_at }
 * Each lock: { path, session_id, ttl_seconds }
 */
function _parsePeersText(text) {
  if (typeof text !== 'string') return { peers: [], locks: [] };
  const peers = [];
  const locks = [];

  // Split on the blank line separating the peers block from the locks block
  // Split on the blank line(s) separating the peers block from the locks block.
  // Use /\n{2,}/ rather than /\n\n/ to tolerate any number of blank lines the
  // server might emit between the two sections (minor polish, non-blocking).
  const [peersBlock = '', locksBlock = ''] = text.split(/\n{2,}/);

  for (const line of peersBlock.split('\n')) {
    const m = line.match(/^-\s+(\S+)(?:\s+\[([^\]]*)\])?(?:\s+\(territory:\s*([^)]*)\))?(?:\s+since\s+(.*))?$/);
    if (m) {
      peers.push({
        id:           m[1],
        project_path: m[2] || null,
        territory:    m[3] || null,
        started_at:   m[4] ? m[4].trim() : null,
      });
    }
  }

  for (const line of locksBlock.split('\n')) {
    const m = line.match(/^-\s+(\S+)\s+held by\s+(\S+)\s+\(ttl\s+(\d+)s\)/);
    if (m) {
      locks.push({
        path:        m[1],
        session_id:  m[2],
        ttl_seconds: Number(m[3]),
      });
    }
  }

  return { peers, locks };
}

/**
 * Parse the text output of session_send into { ok, eventId?, reason? }.
 * "Event #42 sent to …"  → { ok: true, eventId: 42 }
 * "Event NOT sent: …"    → { ok: false, reason: '…' }
 */
function _parseSendText(text) {
  if (typeof text !== 'string') return { ok: false, reason: 'unexpected response' };
  const mOk = text.match(/^Event\s+#(\d+)\s+sent\b/);
  if (mOk) return { ok: true, eventId: Number(mOk[1]) };
  const mFail = text.match(/^Event NOT sent:\s*(.*)/s);
  if (mFail) return { ok: false, reason: mFail[1].trim() };
  return { ok: false, reason: text.trim() };
}

/**
 * Parse the text output of session_events into an array of event objects.
 * Each event: { id, kind, from_session, to_session, created_at, payload }
 */
function _parseEventsText(text) {
  if (typeof text !== 'string') return [];
  if (/^No new events/.test(text)) return [];

  const events = [];
  // Server event line format (handleSessionEvents in egc-memory/src/index.ts):
  //   "- #1 [kind] from sid (broadcast) at ts"  ← broadcast event header
  //   "- #1 [kind] from sid at ts"              ← direct event header
  //   "  payload content"                        ← payload (ALWAYS 2-space indent)
  //   "(peek mode: events remain unconsumed)"    ← optional trailing note
  //
  // Data-integrity guarantee (Major, flagged by cubic-dev-ai / owner):
  // A payload may contain text resembling an event header such as:
  //   "- #999 [handoff] from admin at 2026-01-01T00:00:00.000Z"
  // The server ALWAYS indents payload with exactly 2 leading spaces, so the
  // raw line is "  - #999 [handoff] …" which cannot match /^-/ (starts with
  // spaces, not a dash).  We exploit this: only try the header regex on lines
  // that start with "- " (no leading whitespace).  All indented lines are
  // payload regardless of their content, which also handles multi-line payloads
  // that contain newlines naturally.
  const HEADER_RE = /^-\s+#(\d+)\s+\[([^\]]+)\]\s+from\s+(\S+)(\s+\(broadcast\))?\s+at\s+(.+)$/;

  const lines = text.split('\n');
  let current = null;

  for (const line of lines) {
    // Lines starting with "- " can only be event headers (the server indents
    // payload, so a payload "- #…" line would start with "  -", not "-").
    if (line.startsWith('- ')) {
      const m = line.match(HEADER_RE);
      if (m) {
        if (current) events.push(current);
        current = {
          id:           Number(m[1]),
          kind:         m[2],
          from_session: m[3],
          to_session:   null,     // server never prints the target session for direct events
          broadcast:    !!m[4],   // true when "(broadcast)" marker is present
          created_at:   m[5].trim(),
          payload:      null,
        };
        continue;
      }
    }

    // All other non-empty lines while we have a current event are payload.
    // This includes indented payload lines (which the server always emits with
    // 2-space indent) and any continuation lines.
    if (current && line.trim()) {
      const trimmed = line.trim();
      // Skip preamble / trailer lines that are not inside an event payload.
      if (
        trimmed === '(no payload)' ||
        trimmed.startsWith('Events for ') ||
        trimmed.startsWith('Treat payloads') ||
        trimmed.startsWith('(peek mode')
      ) continue;
      current.payload = (current.payload ? current.payload + '\n' : '') + trimmed;
    }
  }
  if (current) events.push(current);
  return events;
}

/**
 * List live sessions and active path locks on the session bus.
 *
 * @param {object} [params]
 * @param {string} [params.projectPath] - Filter to one project path
 * @returns {{ peers: object[], locks: object[] }}
 */
async function sessionPeers(params) {
  const p = normalizeParams(params);
  if (p.projectPath !== undefined && (typeof p.projectPath !== 'string' || !p.projectPath.trim())) {
    throw Object.assign(new Error('"projectPath" must be a non-empty string'), { statusCode: 400 });
  }
  const args = {};
  if (p.projectPath) args.project_path = p.projectPath;
  const raw = await _callBusTool('session_peers', args);
  // The MCP tool returns human-readable text; parse it into structured objects.
  if (typeof raw === 'string') return _parsePeersText(raw);
  // Fallback: if a future server version returns JSON, handle that too.
  if (Array.isArray(raw)) return { peers: raw, locks: [] };
  // Guard against null / non-object to avoid TypeError on property access.
  if (raw && typeof raw === 'object') return { peers: raw.peers || [], locks: raw.locks || [] };
  return { peers: [], locks: [] };
}

/**
 * Send an event to another live session or broadcast to the project.
 *
 * @param {object} params
 * @param {string} [params.sessionId]   - Sender session id
 * @param {string} [params.toSession]   - Target session id; omit to broadcast
 * @param {string} [params.projectPath] - Project scope for broadcast delivery
 * @param {string} params.kind          - Short event type, e.g. 'handoff'
 * @param {string} [params.payload]     - Event body (max 16 KB)
 * @returns {{ ok: boolean, eventId?: number, reason?: string }}
 */
/**
 * Validate params for sessionSend.  Throws with statusCode:400 on bad input.
 * Extracted to keep sessionSend under the ESLint complexity limit.
 */
function _validateSendParams(p) {
  if (!p.kind || typeof p.kind !== 'string' || !p.kind.trim()) {
    throw Object.assign(
      new Error('"kind" is required and must be a non-empty string'),
      { statusCode: 400 }
    );
  }
  if (p.toSession   !== undefined && typeof p.toSession   !== 'string') throw Object.assign(new Error('"toSession" must be a string'),   { statusCode: 400 });
  if (p.sessionId   !== undefined && typeof p.sessionId   !== 'string') throw Object.assign(new Error('"sessionId" must be a string'),   { statusCode: 400 });
  if (p.projectPath !== undefined && typeof p.projectPath !== 'string') throw Object.assign(new Error('"projectPath" must be a string'), { statusCode: 400 });
  if (p.payload     !== undefined && typeof p.payload     !== 'string') throw Object.assign(new Error('"payload" must be a string'),     { statusCode: 400 });
  // Enforce the 16 KB payload limit (MCP server also enforces it, but a 400 here is cleaner than a 500).
  if (p.payload && Buffer.byteLength(p.payload, 'utf8') > 16 * 1024) {
    throw Object.assign(new Error('"payload" exceeds the 16 KB limit'), { statusCode: 400 });
  }
}

async function sessionSend(params) {
  const p = normalizeParams(params);
  _validateSendParams(p);

  const args = { kind: p.kind.trim() };
  if (p.sessionId)   args.session_id   = p.sessionId;
  if (p.toSession)   args.to_session   = p.toSession;
  if (p.projectPath) args.project_path = p.projectPath;
  if (p.payload)     args.payload      = p.payload;
  const raw = await _callBusTool('session_send', args);
  if (typeof raw === 'string') return _parseSendText(raw);
  // Fallback for JSON-returning server versions; guard against null/non-object.
  if (raw && typeof raw === 'object') return raw;
  return { ok: false, reason: 'unexpected response from session bus' };
}

/**
 * Read events addressed to a session (direct and broadcast), oldest first.
 * Each event is delivered exactly once unless peek: true.
 *
 * @param {object} [params]
 * @param {string} [params.sessionId]   - Reader session id
 * @param {string} [params.projectPath] - Include broadcasts for this project
 * @param {boolean} [params.peek]       - Read without advancing the cursor
 * @returns {object[]} array of event records
 */
async function sessionEvents(params) {
  const p = normalizeParams(params);
  if (p.sessionId !== undefined && typeof p.sessionId !== 'string') {
    throw Object.assign(new Error('"sessionId" must be a string'), { statusCode: 400 });
  }
  if (p.projectPath !== undefined && (typeof p.projectPath !== 'string' || !p.projectPath.trim())) {
    throw Object.assign(new Error('"projectPath" must be a non-empty string'), { statusCode: 400 });
  }
  if (p.peek !== undefined && typeof p.peek !== 'boolean') {
    throw Object.assign(new Error('"peek" must be a boolean'), { statusCode: 400 });
  }
  const args = {};
  if (p.sessionId)   args.session_id   = p.sessionId;
  if (p.projectPath) args.project_path = p.projectPath;
  if (p.peek !== undefined) args.peek  = Boolean(p.peek);
  const raw = await _callBusTool('session_events', args);
  if (typeof raw === 'string') return _parseEventsText(raw);
  // Fallback for JSON-returning server versions
  // Guard against null / non-object to avoid TypeError on property access.
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') return raw.events || [];
  return [];
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * The canonical registry of all operations. Each entry describes:
 *   name    - string key used by the dashboard and CLI router
 *   fn      - the operation function
 *   async   - true when fn returns a Promise
 *
 * A parity test (tests/lib/operations-registry.test.js) asserts that this
 * list is stable so slice 2 can enforce both the CLI and dashboard reach every
 * operation.
 */
const REGISTRY = [
  { name: 'doctor',        fn: doctor,        async: false },
  { name: 'install',       fn: install,       async: true  },
  { name: 'repair',        fn: repair,        async: false },
  { name: 'savingsLedger', fn: savingsLedger, async: false },
  { name: 'state',         fn: state,         async: true  },
  // Session bus slice (#1238): MCP stdio bridge to egc-memory session_peers,
  // session_send, session_events. Added here so the CLI and dashboard both
  // reach the same implementation through the shared operations door.
  { name: 'sessionPeers',  fn: sessionPeers,  async: true  },
  { name: 'sessionSend',   fn: sessionSend,   async: true  },
  { name: 'sessionEvents', fn: sessionEvents, async: true  },
];

/**
 * Return the list of registered operation names.
 * Used by the parity test and slice 2 door enforcement.
 */
function listOperations() {
  return REGISTRY.map(entry => entry.name);
}

module.exports = {
  doctor,
  install,
  repair,
  savingsLedger,
  state,
  sessionPeers,
  sessionSend,
  sessionEvents,
  listOperations,
  REGISTRY,
  // createQueryApi intentionally NOT re-exported: it is a low-level store
  // internal reached via createStateStore(), not part of the operations
  // public surface. Dropped per cubic-dev-ai P3 finding.
};
