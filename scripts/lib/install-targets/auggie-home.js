const { createInstallTargetAdapter } = require('./helpers');
const { planAuggieOperations } = require('../auggie-operations');

// Auggie (Augment Code's terminal agent) reads skills, commands and rules
// natively under ~/.augment, confirmed against docs.augmentcode.com/cli
// (2026-10-09): skills flat at ~/.augment/skills/<name>/SKILL.md (also
// compatible with ~/.claude/skills and ~/.agents/skills, but .augment is
// its own canonical location and the one every other EGC target's shape
// maps onto directly); commands flat at ~/.augment/commands/<name>.md;
// rules recursively under ~/.augment/rules/*.md, always treated as
// always_apply there regardless of frontmatter (the `type` key only
// changes behavior for workspace rules). No hook or plugin API with an
// allow/deny decision is documented -- --startup-script runs once before
// the session, not per tool call -- so the Guardian and the Token Crusher
// stay out of scope here, same as Kiro and Devin Desktop. Agents have no
// native equivalent (its --persona flag selects a built-in persona id, not
// a catalog of markdown files), so they fall through to the default
// scaffold as a plain library folder under .augment/agents/, same as every
// family a target cannot run natively. planAuggieOperations itself is shared
// with auggie-project.js in ../auggie-operations.js -- only the root differs
// between the two scopes.
module.exports = createInstallTargetAdapter({
  id: 'auggie-home',
  target: 'auggie',
  kind: 'home',
  rootSegments: ['.augment'],
  installStatePathSegments: ['egc', 'install-state.json'],
  nativeRootRelativePath: '.augment',
  planOperations: planAuggieOperations,
});
