'use strict';

const path = require('node:path');

const {
  createInstallTargetAdapter,
  createRemappedOperation,
  isForeignPlatformPath,
  normalizeRelativePath,
  planFlatSkillOperation,
  resolveModulesPlan,
} = require('./helpers');

// Letta Code (letta-ai/letta-code) reads skills from four scopes --
// confirmed against docs.letta.com/letta-code/skills and
// docs.letta.com/letta-code/cli (read on 2026-10-13): agent-scoped
// (${MEMORY_DIR}/skills/, its own git-backed agent memory, not something an
// installer writes to), project-scoped (.agents/skills/, relative to the
// project directory, a different root from EGC's shared ~/.agents/skills
// home), computer-scoped (~/.letta/skills/, "shared across all agents on
// the machine"), and bundled. This adapter targets the computer-scoped
// root, the one a global `egc install --target letta` can own.
//
// No MCP config file, hook/lifecycle surface, or project-rules file (an
// AGENTS.md equivalent) is documented for the Letta Code CLI itself: its
// own docs tell Letta Code users to use skills instead of MCP, and the CLI
// reference describes no before/after tool-call hook. So this adapter never
// registers an MCP server, wires the Guardian or the Token Crusher, or
// writes a live AGENTS.md the tool would never read. Agents, commands,
// rules and AGENTS.md ship as inert reference copies under egc/library/,
// the same treatment Pi and Droid give families their tool has no native
// concept for.
const LIBRARY_FAMILIES = new Set(['agents', 'commands', 'rules']);
const LIBRARY_ROOT_SEGMENTS = ['egc', 'library'];

function planLettaPath(adapter, moduleId, sourceRelativePath, planningInput, targetRoot) {
  const normalizedPath = normalizeRelativePath(sourceRelativePath);
  const family = normalizedPath.split('/')[0];

  if (LIBRARY_FAMILIES.has(family) || normalizedPath === 'AGENTS.md') {
    return createRemappedOperation(
      adapter,
      moduleId,
      sourceRelativePath,
      path.join(targetRoot, ...LIBRARY_ROOT_SEGMENTS, ...normalizedPath.split('/')),
      { strategy: 'preserve-relative-path' }
    );
  }

  return planFlatSkillOperation(adapter, moduleId, sourceRelativePath, planningInput, targetRoot);
}

// AGENTS.md is deliberately excluded from the isForeignPlatformPath check:
// that shared filter only lets tools which read AGENTS.md as a live rules
// file receive it at all, and Letta Code is not one of them -- but it
// still gets a reference copy here, routed to egc/library/ by
// planLettaPath, the same inert treatment as its agents/commands/rules.
function planLettaOperations(input, adapter) {
  const { modules, planningInput, targetRoot } = resolveModulesPlan(input, adapter);

  return modules.flatMap(module => (Array.isArray(module.paths) ? module.paths : [])
    .filter(sourceRelativePath => (
      normalizeRelativePath(sourceRelativePath) === 'AGENTS.md'
      || !isForeignPlatformPath(sourceRelativePath, adapter.target)
    ))
    .map(sourceRelativePath => planLettaPath(adapter, module.id, sourceRelativePath, planningInput, targetRoot)));
}

module.exports = createInstallTargetAdapter({
  id: 'letta-home',
  target: 'letta',
  kind: 'home',
  rootSegments: ['.letta'],
  installStatePathSegments: ['egc', 'install-state.json'],
  planOperations: planLettaOperations,
});
