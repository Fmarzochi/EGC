'use strict';

/**
 * Best-effort sync of a completed install into the SQLite state-store's
 * install_state table, which `egc status` reads to report install health.
 * The JSON install-state file (written separately by the caller via
 * writeInstallState) remains the actual source of truth for
 * doctor/repair/auto-update -- this call must never block or fail a real
 * install, so every error is swallowed after an optional onError callback.
 */
function syncInstallStateToStore(state, options = {}) {
  return (async () => {
    const { createStateStore } = require('./state-store');
    let store = null;
    try {
      store = await createStateStore({ homeDir: options.homeDir, dbPath: options.dbPath });
      store.upsertInstallState({
        targetId: state.target.id,
        targetRoot: state.target.root,
        profile: state.request.profile,
        modules: state.resolution.selectedModules,
        operations: state.operations,
        installedAt: state.installedAt,
        sourceVersion: state.source.repoVersion,
      });
      await store.flush();
    } finally {
      if (store) {
        store.close();
      }
    }
  })().catch(error => {
    if (options.onError) {
      options.onError(error);
    }
  });
}

module.exports = { syncInstallStateToStore };
