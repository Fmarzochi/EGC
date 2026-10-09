const { createInstallTargetAdapter } = require('./helpers');
const { planAuggieOperations } = require('../auggie-operations');

// Project-scoped counterpart of auggie-home.js: Auggie reads the same three
// families from the workspace root instead of the home directory (.augment/
// skills, commands and rules), confirmed against the same docs. Workspace
// rules additionally support a `type` frontmatter key (always_apply or
// agent_requested), which EGC's source rule files do not set, so they load
// as always_apply here too -- no transform needed. No hook/plugin surface
// here either (see auggie-home.js), so the Guardian and the Token Crusher
// stay out of scope for this target. planAuggieOperations itself is shared
// with auggie-home.js in ../auggie-operations.js -- only the root differs
// between the two scopes.
module.exports = createInstallTargetAdapter({
  id: 'auggie-project',
  target: 'auggie',
  kind: 'project',
  rootSegments: ['.augment'],
  installStatePathSegments: ['egc-install-state.json'],
  nativeRootRelativePath: '.augment',
  planOperations: planAuggieOperations,
});
