'use strict';

const { createInstallTargetAdapter } = require('./helpers');
const { planVibeOperations } = require('../vibe-operations');

// Project-scoped counterpart of vibe-home.js: in a trusted folder Vibe reads
// the same files from ./.vibe/ (skills/, hooks.toml, config.toml), loads the
// project entries before the user ones, and a hook of the same name in both
// files resolves to the project entry. The project AGENTS.md that Vibe reads
// from the working directory up to the trust root is the one the memory
// propagation already keeps at the repository root, so nothing is written
// for it here. planVibeOperations is shared with vibe-home.js in
// ../vibe-operations.js: only the root differs between the two scopes.
module.exports = createInstallTargetAdapter({
  id: 'vibe-project',
  target: 'vibe',
  kind: 'project',
  rootSegments: ['.vibe'],
  installStatePathSegments: ['egc-install-state.json'],
  nativeRootRelativePath: '.vibe',
  planOperations: planVibeOperations,
});
