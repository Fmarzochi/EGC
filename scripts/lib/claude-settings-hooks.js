'use strict';

// Manages EGC hook entries inside Claude Code settings.json.
// All merges are additive and idempotent: third-party hooks and unrelated
// settings keys are always preserved, and the EGC entry is identified by the
// installed hook script path so uninstall removes only what EGC added.
// Within the same event and matcher, an entry whose command runs a script
// with the same basename but a different path is treated as a stale copy of
// the EGC hook (left behind when the install location or invocation form
// changed) and is migrated in place instead of duplicated.
//
// The implementation lives in claude-settings-hook-core.js,
// claude-settings-hook-events.js, claude-settings-hook-copy-operations.js,
// claude-settings-compact-hooks.js and claude-settings-hook-handlers.js; this
// file re-exports all of them, so every importer keeps working unchanged.

const core = require('./claude-settings-hook-core');
const events = require('./claude-settings-hook-events');
const copyOperations = require('./claude-settings-hook-copy-operations');
const compactHooks = require('./claude-settings-compact-hooks');
const handlers = require('./claude-settings-hook-handlers');

module.exports = {
  ...core,
  ...events,
  ...copyOperations,
  ...compactHooks,
  ...handlers,
};
