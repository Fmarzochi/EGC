'use strict';

// Session-mesh wake-signal notice for Kiro, shared between kiro-home.js and
// kiro-project.js exactly like kiro-guardian-operations.js: both roots plan
// the identical copy-plus-document pair, differing only in targetRoot. The
// hook panel (.kiro/hooks/*.json) runs a UserPromptSubmit command whose
// stdout becomes agent context, so the shared script ships under the
// adapter root and a wholly EGC-owned document points at it with
// --format=text. See kiro-mesh-hooks.js for the evidence trail.

const {
  createMeshNoticeScriptCopyOperations,
  createKiroMeshHookFileOperation,
  resolveMeshNoticeHookScriptDestination,
} = require('./claude-settings-hooks');

function createKiroMeshNoticeOperations(adapter, targetRoot, createRemappedOperation) {
  const remap = (moduleId, sourceRelativePath, destinationPath, options) => (
    createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
  );

  return [
    ...createMeshNoticeScriptCopyOperations(remap, targetRoot),
    createKiroMeshHookFileOperation(targetRoot, resolveMeshNoticeHookScriptDestination(targetRoot)),
  ];
}

module.exports = { createKiroMeshNoticeOperations };
