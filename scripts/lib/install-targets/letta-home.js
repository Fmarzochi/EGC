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
// No MCP config file or project-rules file (an AGENTS.md equivalent) is
// documented for the Letta Code CLI itself: its own docs tell Letta Code
// users to use skills instead of MCP. So this adapter never registers an MCP
// server or writes a live AGENTS.md the tool would never read. Agents,
// commands, rules and AGENTS.md ship as inert reference copies under
// egc/library/, the same treatment Pi and Droid give families their tool has
// no native concept for.
//
// Letta Code does read hooks, in the Claude Code format, from
// ~/.letta/settings.json ([Letta hooks](https://docs.letta.com/letta-code/hooks),
// read on 2026-11-28: SessionStart and Stop among the events, event_type and
// working_directory on stdin, simple hooks without a matcher). The two
// session hooks go there: SessionStart pulls the Team Brain when the team
// asks for it and answers the project memory in the shapes the Claude readers
// take (Letta documents no reading of that output), Stop pushes what changed.
// The Guardian and the Token Crusher are not wired yet.
const LIBRARY_FAMILIES = new Set(['agents', 'commands', 'rules']);
const LIBRARY_ROOT_SEGMENTS = ['egc', 'library'];
const LETTA_SESSION_START_SOURCE_RELATIVE_PATH = 'scripts/hooks/letta-session-start.js';

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
  const { createHostSessionHookOperations } = require('../claude-settings-hooks');

  const moduleOperations = modules.flatMap(module => (Array.isArray(module.paths) ? module.paths : [])
    .filter(sourceRelativePath => (
      normalizeRelativePath(sourceRelativePath) === 'AGENTS.md'
      || !isForeignPlatformPath(sourceRelativePath, adapter.target)
    ))
    .map(sourceRelativePath => planLettaPath(adapter, module.id, sourceRelativePath, planningInput, targetRoot)));
  return [
    ...moduleOperations,
    ...createHostSessionHookOperations({
      createRemappedOperation: (moduleId, sourceRelativePath, destinationPath, options) => (
        createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
      ),
      targetRoot,
      hooksFilePath: path.join(targetRoot, 'settings.json'),
      sessionStartSourceRelativePath: LETTA_SESSION_START_SOURCE_RELATIVE_PATH,
      plannedDestinations: new Set(moduleOperations.map(operation => operation.destinationPath)),
    }),
  ];
}

module.exports = createInstallTargetAdapter({
  id: 'letta-home',
  target: 'letta',
  kind: 'home',
  rootSegments: ['.letta'],
  installStatePathSegments: ['egc', 'install-state.json'],
  planOperations: planLettaOperations,
});
