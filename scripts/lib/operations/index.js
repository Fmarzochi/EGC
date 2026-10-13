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

const fs = require('node:fs');

const { buildDoctorReport, repairInstalledStates } = require('../install-lifecycle');
const { createInstallPlanFromRequest }  = require('../install/runtime');
const { readAll, aggregateBreakdown }  = require('../crusher/metrics');
const { createStateStore }             = require('../state-store/index');
const { resolveMemoryStorePath }       = require('../state-store/path');
const { openCompatDatabase }           = require('../state-store/sqlite-compat');
const { normalizeParams } = require('./params');
const { sessionEvents, sessionPeers, sessionSend } = require('./session-bus');
const { _extractMcpLineResult } = require('./mcp-bridge');

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

const MEMORY_COUNTS = Object.freeze({
  decisions: 'SELECT COUNT(*) AS total FROM decisions',
  lessons: 'SELECT COUNT(*) AS total FROM lessons WHERE archived = 0',
});

async function readMemoryCounts(memoryDbPath) {
  const db = await openCompatDatabase(memoryDbPath, 'egc-operations', { reader: true });
  try {
    const rows = await db.all("SELECT name FROM sqlite_master WHERE type = 'table'");
    const tables = new Set(rows.map(row => row.name));
    // A store that predates a migration has no such table yet: that is 0.
    const count = async ([table, sql]) => [table, tables.has(table) ? Number((await db.get(sql)).total) : 0];
    return Object.fromEntries(await Promise.all(Object.entries(MEMORY_COUNTS).map(count)));
  } finally {
    await db.close();
  }
}

// Counts the memory server's decisions and active lessons without creating
// or changing its store. A store that cannot be read (in use on a machine
// with the portable engine only, damaged, not readable) keeps both numbers
// at 0 and says why in memoryDbError, so the other numbers still reach the
// caller.
async function countMemoryStore(memoryDbPath) {
  if (!fs.existsSync(memoryDbPath)) return { decisions: 0, lessons: 0 };
  try {
    return await readMemoryCounts(memoryDbPath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { decisions: 0, lessons: 0, failure: { memoryDbError: reason.split('\n')[0] } };
  }
}

/**
 * Query the EGC stores and return a plain JSON snapshot of counts.
 *
 * Returns plain JSON-serializable data — not the live store object. The stores
 * are opened, queried, and closed entirely within this function. If a caller
 * needs the live store resource directly (e.g. for writes), use
 * createStateStore() from scripts/lib/state-store/index.js instead.
 *
 * @param {object} [params]
 * @param {string} [params.dbPath]   - Explicit path to the CLI event store
 * @param {string} [params.homeDir]  - Resolve both default store paths under this home
 * @returns {Promise<{ decisions: number, lessons: number, patterns: number, dbPath: string, memoryDbPath: string, memoryDbError?: string }>}
 */
async function state(params) {
  const p = normalizeParams(params);
  let store;
  try {
    store = await createStateStore({
      dbPath:  p.dbPath,
      homeDir: p.homeDir,
    });
    // Each number is counted where it is written. Patterns live in the CLI
    // event store, where the memory server's detect_patterns writes them.
    // Decisions and lessons live in the memory server's own store, where
    // store_decision and lesson_save write; the tables of the same name in
    // the CLI event store have no production writer and always counted 0.
    const patterns = store.countPatterns();
    const memoryDbPath = resolveMemoryStorePath({ homeDir: p.homeDir });
    const memory = await countMemoryStore(memoryDbPath);
    // Return plain JSON only — no store methods, no _database reference.
    return { decisions: memory.decisions, lessons: memory.lessons, patterns, dbPath: store.dbPath, memoryDbPath, ...memory.failure };
  } finally {
    try { store?.close(); } catch (_) { /* best-effort close: ignore errors */ } // NOSONAR
  }
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
  // _extractMcpLineResult is exported test-only: EGC_BUS_STUB short-circuits
  // _callBusTool above the raw MCP JSON-RPC line level, so the isError check
  // (#1797) is otherwise unreachable from a test.
  _extractMcpLineResult,
};
