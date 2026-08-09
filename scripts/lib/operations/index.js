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

const { buildDoctorReport }          = require('../install-lifecycle');
const { createInstallPlanFromRequest } = require('../install/runtime');
const { applyInstallPlan }            = require('../install/apply');
const { readAll, aggregateBreakdown } = require('../crusher/metrics');
const { createStateStore }            = require('../state-store/index');
const { createQueryApi } = require('../state-store/queries');

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
function doctor(params = {}) {
  return buildDoctorReport({
    repoRoot:    params.repoRoot,
    homeDir:     params.homeDir,
    projectRoot: params.projectRoot,
    targets:     params.targets,
  });
}

// ---------------------------------------------------------------------------
// Operation: install
// ---------------------------------------------------------------------------

/**
 * Plan and apply an install.
 *
 * @param {object} request  - Normalized install request (see install/request.js)
 * @param {object} [options]
 * @param {string} [options.projectRoot]
 * @param {string} [options.homeDir]
 * @param {string} [options.sourceRoot]
 * @param {boolean} [options.dryRun]    - If true, return the plan without applying it
 * @returns {{ plan, applied }} plain JSON; `applied` is null when dryRun is true
 */
function install(request, options = {}) {
  const plan = createInstallPlanFromRequest(request, {
    projectRoot: options.projectRoot,
    homeDir:     options.homeDir,
    sourceRoot:  options.sourceRoot,
  });

  if (options.dryRun) {
    return { plan, applied: null };
  }

  const applied = applyInstallPlan(plan);
  return { plan, applied };
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
 * @returns {object} aggregateBreakdown result
 */
function savingsLedger(params = {}) {
  const entries = readAll();
  return aggregateBreakdown(entries, {
    now:     params.now,
    project: params.project,
    session: params.session,
    context: params.context,
  });
}

// ---------------------------------------------------------------------------
// Operation: state
// ---------------------------------------------------------------------------

/**
 * Open the EGC state store and return it.
 * The caller is responsible for closing the store via store.close().
 *
 * @param {object} [params]
 * @param {string} [params.dbPath]   - Explicit path to the SQLite database
 * @param {string} [params.homeDir]  - Resolve the default db path under this home
 * @returns {Promise<object>} createStateStore result (includes queryApi methods)
 */
async function state(params = {}) {
  return createStateStore({
    dbPath:  params.dbPath,
    homeDir: params.homeDir,
  });
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
  createQueryApi,
  listOperations,
  REGISTRY,
};
