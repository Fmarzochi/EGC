'use strict';

const fs = require('node:fs');
const os = require('node:os');

const { isUnderFolder } = require('../../path-safety');
const { assertValidEntity } = require('../schema');
const { parseJsonColumn, stringifyJson } = require('./shared');

// Where the system keeps temporary files: the directory the process is given,
// and /tmp on the platforms that have it whatever TMPDIR says.
function defaultTemporaryRoots() {
  return process.platform === 'win32' ? [os.tmpdir()] : [os.tmpdir(), '/tmp'];
}

// An install whose folder is gone is not an install any more: a project
// that was deleted, or a temporary home that was cleaned up. The
// install-state file of a target is the source of truth and lives in that
// folder, so a record without it has nothing left to describe.
function isStillThere(installState) {
  return fs.existsSync(installState.targetRoot);
}

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

  const deleteInstallStateStatement = db.prepare(`
    DELETE FROM install_state
    WHERE target_id = @target_id AND target_root = @target_root
  `);

  function listRecordedInstallState() {
    return listInstallStateStatement.all().map(mapInstallStateRow);
  }

  function listInstallState() {
    return listRecordedInstallState().filter(isStillThere);
  }

  // Drops the records of the folders that are gone for good. A folder under
  // a temporary directory never comes back, so its record goes. Anywhere
  // else the folder may be on a drive that is unplugged right now: that
  // record stays, and the list leaves it out until the folder is back.
  function pruneMissingInstallState(options = {}) {
    const temporaryRoots = options.temporaryRoots || defaultTemporaryRoots();
    const gone = listRecordedInstallState().filter(installState => (
      !isStillThere(installState)
      && temporaryRoots.some(root => isUnderFolder(installState.targetRoot, root))
    ));
    for (const installState of gone) {
      deleteInstallStateStatement.run({
        target_id: installState.targetId,
        target_root: installState.targetRoot,
      });
    }
    return gone.length;
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

  return { listInstallState, pruneMissingInstallState, upsertInstallState };
}

module.exports = { mapInstallStateRow, normalizeInstallStateInput, createInstallStateQueries };
