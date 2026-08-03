'use strict';

const { assertValidEntity } = require('../schema');
const { parseJsonColumn, stringifyJson } = require('./shared');

function mapInstallStateRow(row) {
  const modules = parseJsonColumn(row.modules, []);
  const operations = parseJsonColumn(row.operations, []);
  const status = row.source_version && row.installed_at ? 'healthy' : 'warning';

  return {
    targetId: row.target_id,
    targetRoot: row.target_root,
    profile: row.profile,
    modules,
    operations,
    installedAt: row.installed_at,
    sourceVersion: row.source_version,
    moduleCount: Array.isArray(modules) ? modules.length : 0,
    operationCount: Array.isArray(operations) ? operations.length : 0,
    status,
  };
}

function normalizeInstallStateInput(installState) {
  return {
    targetId: installState.targetId,
    targetRoot: installState.targetRoot,
    profile: installState.profile ?? null,
    modules: installState.modules === undefined || installState.modules === null
      ? []
      : installState.modules,
    operations: installState.operations === undefined || installState.operations === null
      ? []
      : installState.operations,
    installedAt: installState.installedAt || new Date().toISOString(),
    sourceVersion: installState.sourceVersion ?? null,
  };
}

function createInstallStateQueries(db) {
  const listInstallStateStatement = db.prepare(`
    SELECT *
    FROM install_state
    ORDER BY installed_at DESC, target_id ASC
  `);
  const upsertInstallStateStatement = db.prepare(`
    INSERT INTO install_state (
      target_id,
      target_root,
      profile,
      modules,
      operations,
      installed_at,
      source_version
    ) VALUES (
      @target_id,
      @target_root,
      @profile,
      @modules,
      @operations,
      @installed_at,
      @source_version
    )
    ON CONFLICT(target_id, target_root) DO UPDATE SET
      profile = excluded.profile,
      modules = excluded.modules,
      operations = excluded.operations,
      installed_at = excluded.installed_at,
      source_version = excluded.source_version
  `);

  function listInstallState() {
    return listInstallStateStatement.all().map(mapInstallStateRow);
  }

  function upsertInstallState(installState) {
    const normalized = normalizeInstallStateInput(installState);
    assertValidEntity('installState', normalized);
    upsertInstallStateStatement.run({
      target_id: normalized.targetId,
      target_root: normalized.targetRoot,
      profile: normalized.profile,
      modules: stringifyJson(normalized.modules, 'installState.modules'),
      operations: stringifyJson(normalized.operations, 'installState.operations'),
      installed_at: normalized.installedAt,
      source_version: normalized.sourceVersion,
    });
    return normalized;
  }

  return { listInstallState, upsertInstallState };
}

module.exports = { mapInstallStateRow, normalizeInstallStateInput, createInstallStateQueries };
