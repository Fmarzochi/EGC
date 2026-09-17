const fs = require('node:fs');
const path = require('node:path');

const {
  createFlatFileOperations,
  createFlatRuleOperations,
  createInstallTargetAdapter,
  createRemappedOperation,
  isForeignPlatformPath,
  normalizeRelativePath,
  planFlatAgentOperations,
  planFlatSkillOperation,
  resolveModulesPlan,
} = require('./helpers');
const { CLAUDE_AGENT_FRONTMATTER_TRANSFORM } = require('../install/copy-transforms');

// Library families with a native home under ~/.claude. Rules are flattened
// like Cursor's (the folder becomes the file name prefix) and keep their
// paths frontmatter, so Claude Code scopes the language rules to matching
// files and loads only rules/common everywhere. rules/zh mirrors
// rules/common in Chinese and would load into every session alongside it,
// so it stays out. Agents go through the frontmatter transform: the
// catalog's tools list becomes the comma-separated string Claude Code
// reads and a model it cannot run is dropped.
const CLAUDE_EXCLUDED_RULE_NAMESPACES = new Set(['zh']);

function toClaudeRuleFileName(fileName, sourceRelativeFile) {
  const normalized = normalizeRelativePath(sourceRelativeFile);
  const namespace = normalized.split('/')[1];
  if (CLAUDE_EXCLUDED_RULE_NAMESPACES.has(namespace) || path.basename(normalized).toLowerCase() === 'readme.md') {
    return null;
  }
  return fileName;
}

function planClaudeRuleOperations(moduleId, sourceRelativePath, planningInput, targetRoot) {
  return createFlatRuleOperations({
    moduleId,
    repoRoot: planningInput.repoRoot,
    sourceRelativePath,
    destinationDir: path.join(targetRoot, 'rules'),
    destinationNameTransform: toClaudeRuleFileName,
  });
}

function planClaudeAgentOperations(adapter, moduleId, sourceRelativePath, planningInput, targetRoot) {
  return planFlatAgentOperations(adapter, moduleId, sourceRelativePath, planningInput, targetRoot, CLAUDE_AGENT_FRONTMATTER_TRANSFORM);
}

// Claude Code turns the files of ~/.claude/commands and the skills into the
// same slash commands, so a command whose name is also a skill of this plan
// would be listed twice. The skill is the richer form (the command only
// points at it), so the command stays out; a plan without that skill keeps
// the command.
function skillDirectoriesUnder(directory, depth) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    return [];
  }
  if (fs.existsSync(path.join(directory, 'SKILL.md'))) {
    return [path.basename(directory)];
  }
  if (depth === 0) {
    return [];
  }
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(entry => skillDirectoriesUnder(path.join(directory, entry.name), depth - 1));
}

function plannedSkillNames(modules, repoRoot) {
  const names = new Set();
  if (!repoRoot) {
    return names;
  }
  for (const module of modules) {
    for (const sourceRelativePath of Array.isArray(module.paths) ? module.paths : []) {
      const normalized = normalizeRelativePath(sourceRelativePath);
      if (normalized !== 'skills' && !normalized.startsWith('skills/')) continue;
      for (const name of skillDirectoriesUnder(path.join(repoRoot, ...normalized.split('/')), 2)) {
        names.add(name);
      }
    }
  }
  return names;
}

function planClaudeCommandOperations(moduleId, sourceRelativePath, planningInput, targetRoot, shadowed) {
  return createFlatFileOperations({
    moduleId,
    repoRoot: planningInput.repoRoot,
    sourceRelativePath,
    destinationDir: path.join(targetRoot, 'commands'),
    destinationNameTransform: fileName => (shadowed.has(path.basename(fileName, '.md')) ? null : fileName),
  });
}

function planClaudeModuleOperations(adapter, moduleId, sourceRelativePath, planningInput, targetRoot, shadowed) {
  const normalized = normalizeRelativePath(sourceRelativePath);
  if (normalized === 'rules') {
    return planClaudeRuleOperations(moduleId, sourceRelativePath, planningInput, targetRoot);
  }
  if (normalized === 'agents' || normalized.startsWith('agents/')) {
    return planClaudeAgentOperations(adapter, moduleId, sourceRelativePath, planningInput, targetRoot);
  }
  if (normalized === 'commands') {
    return planClaudeCommandOperations(moduleId, sourceRelativePath, planningInput, targetRoot, shadowed);
  }
  if (normalized.startsWith('commands/') && shadowed.has(path.basename(normalized, '.md'))) {
    return [];
  }
  return [planFlatSkillOperation(adapter, moduleId, sourceRelativePath, planningInput, targetRoot)];
}

const CLAUDE_EXCLUDED_SOURCE_PREFIXES = [
  'mcp-configs',
  'scripts/auto-update.js',
  'scripts/setup-package-manager.js',
];

function isClaudeExcludedPath(sourceRelativePath) {
  const normalized = normalizeRelativePath(sourceRelativePath);
  return CLAUDE_EXCLUDED_SOURCE_PREFIXES.some(
    prefix => normalized === prefix || normalized.startsWith(`${prefix}/`)
  );
}
const {
  HOOK_MODULE_ID,
  HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  STOP_HOOK_MODULE_ID,
  STOP_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  createSessionStartHookMergeOperation,
  createStopHookMergeOperation,
  createUserPromptSubmitHookMergeOperation,
  createUserPromptSubmitRouterHookMergeOperation,
  createPreToolUseBashDispatcherHookMergeOperation,
  createPreToolUseWriteValidatorHookMergeOperation,
  createPreToolUseScrubberHookMergeOperation,
  createScrubberScriptCopyOperations,
  createPreToolUseGateGuardHookMergeOperation,
  createPreCompactHookMergeOperation,
  createPostCompactHookMergeOperation,
  createEgcMemorySaveScriptCopyOperations,
  resolveHookScriptDestination,
  resolveStopHookScriptDestination,
} = require('../claude-settings-hooks');

const HOOK_LIB_SOURCES = [
  'scripts/lib/session-start-adapter.js',
  'scripts/lib/dashboard-token.js',
  // Flattens next to the adapter; its require falls back from
  // ./crusher/session-marker to ./session-marker for exactly this layout.
  'scripts/lib/crusher/session-marker.js',
  'scripts/lib/session-context-loader.js',
  'scripts/lib/branch-state.js',
  'scripts/lib/global-state.js',
  'scripts/lib/project-detect.js',
  'scripts/lib/propagate-state.js',
  'scripts/lib/state-crypto.js',
  // propagate-state.js's commit-privacy guard shells out to this script as
  // the git clean-filter command -- it must land next to propagate-state.js
  // (both flatten to the same libDestDir below), or the filter config points
  // at a path that never existed on this machine (cubic review, audit EGC-547).
  'scripts/check-state-leak.js',
];

function createSessionStateHookOperations(adapter, targetRoot, includeScrubberCopy) {
  const libDestDir = path.join(targetRoot, 'egc', 'lib');
  const libOperations = HOOK_LIB_SOURCES.map(src =>
    createRemappedOperation(
      adapter,
      HOOK_MODULE_ID,
      src,
      path.join(libDestDir, path.basename(src)),
      { strategy: 'preserve-relative-path' }
    )
  );

  return [
    createRemappedOperation(
      adapter,
      HOOK_MODULE_ID,
      HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
      resolveHookScriptDestination(targetRoot),
      { strategy: 'preserve-relative-path' }
    ),
    ...libOperations,
    createSessionStartHookMergeOperation(targetRoot),
    createRemappedOperation(
      adapter,
      STOP_HOOK_MODULE_ID,
      STOP_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
      resolveStopHookScriptDestination(targetRoot),
      { strategy: 'preserve-relative-path' }
    ),
    createStopHookMergeOperation(targetRoot),
    // PreCompact -> egc-memory-save.js (guaranteed snapshot save + prompts
    // update_state), PostCompact -> reuses claude-session-start.js (same
    // proven state-load-and-print logic SessionStart already uses, already
    // copied above via HOOK_SCRIPT_SOURCE_RELATIVE_PATH/libOperations).
    // Closes EGC-495 (no mechanism previously re-injected state after a
    // context compaction). Like SessionStart/Stop above, egc-memory-save.js
    // and its lib dependencies are copied unconditionally here rather than
    // left to an optional module, so a minimal install never registers a
    // PreCompact hook pointing at a script that was never copied to disk.
    ...createEgcMemorySaveScriptCopyOperations(
      (moduleId, sourceRelativePath, destinationPath, options) =>
        createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options),
      targetRoot
    ),
    createPreCompactHookMergeOperation(targetRoot),
    createPostCompactHookMergeOperation(targetRoot),
    createUserPromptSubmitHookMergeOperation(targetRoot),
    createUserPromptSubmitRouterHookMergeOperation(targetRoot),
    createPreToolUseBashDispatcherHookMergeOperation(targetRoot),
    createPreToolUseWriteValidatorHookMergeOperation(targetRoot, 'Edit'),
    createPreToolUseWriteValidatorHookMergeOperation(targetRoot, 'Write'),
    createPreToolUseWriteValidatorHookMergeOperation(targetRoot, 'MultiEdit'),
    // EGC Scrubber: clean invisible-Unicode and long-dash marks from written
    // content before it hits disk, alongside the write validator above. Copy the
    // hook and its scrubber-lib deps only when the hooks-runtime module is NOT
    // present (that module already ships scripts/hooks + scripts/lib), so a
    // minimal install still gets a working hook and no destination ever has two
    // owners. Then register it for Edit/Write/MultiEdit.
    ...(includeScrubberCopy
      ? createScrubberScriptCopyOperations(
        (moduleId, sourceRelativePath, destinationPath, options) =>
          createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options),
        targetRoot
      )
      : []),
    createPreToolUseScrubberHookMergeOperation(targetRoot, 'Edit'),
    createPreToolUseScrubberHookMergeOperation(targetRoot, 'Write'),
    createPreToolUseScrubberHookMergeOperation(targetRoot, 'MultiEdit'),
    // GateGuard fact-forcing gate: Bash already gets this via
    // bash-hook-dispatcher.js above. Edit/Write/MultiEdit only had the
    // protected-path validator until now, so register GateGuard on them
    // too (in addition to, not instead of, the write validator).
    createPreToolUseGateGuardHookMergeOperation(targetRoot, 'Edit'),
    createPreToolUseGateGuardHookMergeOperation(targetRoot, 'Write'),
    createPreToolUseGateGuardHookMergeOperation(targetRoot, 'MultiEdit'),
  ];
}

module.exports = createInstallTargetAdapter({
  id: 'claude-home',
  target: 'claude',
  kind: 'home',
  rootSegments: ['.claude'],
  installStatePathSegments: ['egc', 'install-state.json'],
  nativeRootRelativePath: '.claude',
  planOperations(input, adapter) {
    const { modules, planningInput, targetRoot } = resolveModulesPlan(input, adapter);
    const shadowed = plannedSkillNames(modules, planningInput.repoRoot);

    const moduleOperations = modules.flatMap(module => {
      const paths = Array.isArray(module.paths) ? module.paths : [];
      return paths
        .filter(p => !isForeignPlatformPath(p, adapter.target) && !isClaudeExcludedPath(p))
        .flatMap(sourceRelativePath => planClaudeModuleOperations(adapter, module.id, sourceRelativePath, planningInput, targetRoot, shadowed));
    });

    // Deterministic memory loading: every Claude Code install registers the
    // SessionStart state hook, even when no content modules are selected.
    // hooks-runtime ships scripts/hooks + scripts/lib itself, so only copy the
    // Scrubber files explicitly when that module is not part of this install.
    const hasHooksRuntime = modules.some(module => module.id === 'hooks-runtime');
    return [
      ...moduleOperations,
      ...createSessionStateHookOperations(adapter, targetRoot, !hasHooksRuntime),
    ];
  },
});
