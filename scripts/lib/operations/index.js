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
 *   - savingsLedger → aggregateBreakdown       (crusher/metrics.js)
 *   - state         → createStateStore + createQueryApi (state-store/)
 */

const { buildDoctorReport }            = require('../install-lifecycle');
const { createInstallPlanFromRequest }  = require('../install/runtime');
const { applyInstallPlan }             = require('../install/apply');
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
function install(request, options) {
  const o = normalizeParams(options);
  const plan = createInstallPlanFromRequest(request, {
    projectRoot: o.projectRoot,
    homeDir:     o.homeDir,
    sourceRoot:  o.sourceRoot,
  });

  if (o.dryRun) {
    return { plan, applied: null, warnings: [] };
  }

  // Capture any console.error/stderr writes from applyInstallPlan so the
  // registry no-console contract holds. Warnings are surfaced in the result.
  const warnings = [];
  const origError = console.error.bind(console);
  console.error = (...args) => warnings.push(args.map(String).join(' '));
  let applied;
  try {
    applied = applyInstallPlan(plan);
  } finally {
    console.error = origError;
  }

  return { plan, applied, warnings };
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
    now:     p.now,
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
    // Use the list-based query API — the store exposes list* methods, not count*.
    // Decisions are stored per-session; getStatus returns activeSessions as an
    // object { activeCount, sessions }, not a plain array — read activeCount directly.
    const status    = store.getStatus ? store.getStatus({ activeLimit: 1000 }) : null;
    const decisions = status?.activeSessions?.activeCount ?? 0;
    const lessons   = store.listLessons  ? store.listLessons({ limit: 10000 }).length  : 0;
    const patterns  = store.listPatterns ? store.listPatterns({ limit: 10000 }).length : 0;
    // Return plain JSON only — no store methods, no _database reference.
    return { decisions, lessons, patterns, dbPath: store.dbPath };
  } finally {
    try { store?.close(); } catch (_) {} // NOSONAR: best-effort close
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
  { name: 'install',       fn: install,       async: false },
  { name: 'savingsLedger', fn: savingsLedger, async: false },
  { name: 'state',         fn: state,         async: true  },
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
  savingsLedger,
  state,
  listOperations,
  REGISTRY,
  // createQueryApi intentionally NOT re-exported: it is a low-level store
  // internal reached via createStateStore(), not part of the operations
  // public surface. Dropped per cubic-dev-ai P3 finding.
};
