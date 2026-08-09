'use strict';

const { doctorReportOperation } = require('./doctor');
const { installPlanOperation, installApplyOperation } = require('./install');
const { crusherSavingsOperation } = require('./crusher');
const {
  stateStoreQueryOperation,
  queryStateDbStats,
  queryStateMarkdownDecisions,
} = require('./state-store');

const registry = new Map();

function register(name, handler) {
  if (!name || typeof name !== 'string') {
    throw new Error('Operation name must be a non-empty string');
  }
  if (typeof handler !== 'function') {
    throw new Error(`Handler for operation '${name}' must be a function`);
  }
  registry.set(name, handler);
}

function execute(name, params = {}) {
  const handler = registry.get(name);
  if (!handler) {
    throw new Error(`Unknown operation: ${name}`);
  }
  return handler(params);
}

function list() {
  return Array.from(registry.keys()).sort();
}

function has(name) {
  return registry.has(name);
}

function get(name) {
  return registry.get(name);
}

// Register built-in operations
register('doctor.report', doctorReportOperation);
register('install.create_plan', installPlanOperation);
register('install.apply_plan', installApplyOperation);
register('crusher.aggregate_breakdown', crusherSavingsOperation);
register('state_store.query', stateStoreQueryOperation);
register('state_store.db_stats', queryStateDbStats);
register('state_store.markdown_decisions', queryStateMarkdownDecisions);

module.exports = {
  register,
  execute,
  run: execute,
  list,
  has,
  get,
};
