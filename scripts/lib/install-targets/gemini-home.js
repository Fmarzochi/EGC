const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  UNREADABLE_STATE,
  buildValidationIssue,
  createInstallTargetAdapter,
  createRemappedOperation,
  isForeignPlatformPath,
  normalizeRelativePath,
  readInstallStateOrNull,
  resolveModulesPlan,
} = require('./helpers');
const {
  createGlobalGateGuardHookMergeOperation,
  createGlobalCrusherHookMergeOperation,
  createGlobalBashGuardianHookMergeOperation,
  createGlobalMeshNoticeHookMergeOperation,
} = require('../antigravity-settings-hooks');
const {
  createGateGuardScriptCopyOperations,
  createCrusherScriptCopyOperations,
  createMeshNoticeScriptCopyOperations,
} = require('../claude-settings-hooks');
const { createAntigravityGuardianOperations } = require('../antigravity-guardian-operations');
const { resolveGlobalHooksJsonPath } = require('../antigravity-guardian-hooks');
const { plannedFileContent } = require('../install/copy-transforms');
const { AGY_RULES_SUBDIR, isRuleSource, planAntigravityRuleFiles } = require('../antigravity-rules');

const AGY_SKILLS_SUBDIR = 'config/skills';

// Source paths only the retired Gemini CLI read from this root and that no
// family of the library counts on: Antigravity keeps its hooks in
// config/hooks.json and antigravity-cli/hooks.json, its MCP servers in
// config/mcp_config.json, and reads neither a plugin manifest nor a .agents
// tree here. What an earlier install wrote for them is retired on the next
// apply, file by file and only when byte-identical to what EGC copied
// (helpers.js, planGenericRetirements); a file the person edited stays.
// agents/ and commands/ keep their current spot until each family moves to
// the directory Antigravity reads (config/agents); the same retirement
// collects the old copies then, as it does for the rules/egc tree.
const GEMINI_CLI_ONLY_SOURCE_PREFIXES = new Set(['.agents', 'hooks', 'mcp-configs', '.gemini-plugin']);

function isGeminiCliOnlySource(sourceRelativePath) {
  return GEMINI_CLI_ONLY_SOURCE_PREFIXES.has(normalizeRelativePath(sourceRelativePath).split('/')[0]);
}

function matchesPlannedRule(operation, sourcePath) {
  return destination => {
    try {
      return fs.readFileSync(destination).equals(plannedFileContent(sourcePath, operation.transform));
    } catch {
      return false;
    }
  };
}

function planAntigravityRuleOperations(adapter, moduleId, sourceRelativePath, input, recordedDestinations) {
  const repoRoot = input.repoRoot || '';
  const rulesDir = path.join(adapter.resolveRoot(input), AGY_RULES_SUBDIR);
  return planAntigravityRuleFiles(repoRoot, sourceRelativePath)
    .map(rule => ({
      ...createRemappedOperation(adapter, moduleId, rule.sourceRelativePath, path.join(rulesDir, rule.fileName), { strategy: 'flatten-copy' }),
      transform: rule.transform,
    }))
    .filter(operation => !isPersonOwned(
      operation.destinationPath,
      recordedDestinations,
      matchesPlannedRule(operation, path.join(repoRoot, operation.sourceRelativePath))
    ));
}

// Antigravity shares this home root (~/.gemini) for skill discovery (see
// AGY_SKILLS_SUBDIR above) but reads its own hooks.json at
// ~/.gemini/antigravity-cli/hooks.json, distinct from Gemini CLI's
// ~/.gemini/hooks/hooks.json -- so Gemini CLI's existing GateGuard wiring
// does not automatically cover Antigravity and needs this separate merge.
// scripts/hooks/gateguard-fact-force.js normally also arrives at this
// target via the hooks-runtime module's own scaffold (paths: scripts/hooks,
// scripts/lib) -- but hooks-runtime is only a DEFAULT base module for the
// 'egc' target's legacy profile, not something every install is guaranteed
// to select (a minimal/custom module selection can omit it). Copying the
// script explicitly here, unconditional of module selection, closes that
// gap: cubic-dev-ai review (PR #1052, 2026-07-27) found a minimal install
// could register this hooks.json entry while the script it points at was
// never actually copied anywhere, so every Antigravity Bash/Edit/Write call
// would try to launch a nonexistent file.
function createAntigravityGlobalGateGuardOperations(targetRoot, homeDir, createRemap) {
  const scriptCopyOperations = createGateGuardScriptCopyOperations(createRemap, targetRoot);
  const mergeOperations = ['Edit', 'Write', 'MultiEdit', 'Bash'].map(matcher => (
    createGlobalGateGuardHookMergeOperation(targetRoot, homeDir, matcher)
  ));
  return [...scriptCopyOperations, ...mergeOperations];
}

// Token Crusher: same reasoning as GateGuard above -- copy the standalone
// crusher hook + its deps explicitly (needed for minimal installs that skip
// hooks-runtime), then register it on Bash only (the Crusher compresses
// shell output, it does not touch file writes). Antigravity's PROJECT-level
// registration (.agents/hooks.json, antigravity-project.js) already had this;
// the GLOBAL registration (this file, ~/.gemini/antigravity-cli/hooks.json)
// did not, so a user who only installs the `egc` target (not `antigravity`)
// never got Crusher compression on Antigravity's global-scope Bash calls.
function createAntigravityGlobalCrusherOperations(targetRoot, homeDir, createRemap) {
  const scriptCopyOperations = createCrusherScriptCopyOperations(createRemap, targetRoot);
  return [
    ...scriptCopyOperations,
    createGlobalCrusherHookMergeOperation(targetRoot, homeDir, 'Bash'),
  ];
}

// EGC Guardian: same reasoning as GateGuard above -- copy
// pre-bash-guardian-validate.js (and the helpers it requires,
// BASH_GUARDIAN_HOOK_LIB_SOURCES) explicitly rather than relying on
// hooks-runtime having scaffolded them, then register it on Bash only
// (the Guardian validates shell
// commands, not file writes). cubic-dev-ai review (PR #1052, 2026-07-27)
// first found createGlobalBashGuardianHookMergeOperation was added to
// antigravity-settings-hooks.js but never actually called anywhere, then
// (once wired) found the same missing-script-copy gap GateGuard had.
// Session-mesh wake-signal notice: same reasoning as the three above -- copy
// the standalone mesh-events-inject.js explicitly (it is dependency-free, so
// one copy suffices) and register it on UserPromptSubmit at Antigravity's
// global hooks file, giving every Antigravity session the native
// turn-boundary wake signal even when only the `egc` target is installed.
function createAntigravityGlobalMeshNoticeOperations(targetRoot, homeDir, createRemap) {
  const scriptCopyOperations = createMeshNoticeScriptCopyOperations(createRemap, targetRoot);
  return [
    ...scriptCopyOperations,
    createGlobalMeshNoticeHookMergeOperation(targetRoot, homeDir),
  ];
}

// The entry Antigravity actually runs is the egc-guardian named hook in the
// shared ~/.gemini/config/hooks.json, in Antigravity's own format
// (antigravity-guardian-operations.js); it also copies the Guardian scripts.
// The Claude-format entry in antigravity-cli/hooks.json stays as it was: its
// Bash matcher never matches an Antigravity tool, and its removal goes with
// the other Claude-format entries there.
function createAntigravityGlobalGuardianOperations(targetRoot, homeDir, createRemap) {
  return [
    ...createAntigravityGuardianOperations(createRemap, targetRoot, resolveGlobalHooksJsonPath(homeDir)),
    createGlobalBashGuardianHookMergeOperation(targetRoot, homeDir, 'Bash'),
  ];
}

// The GateGuard/Guardian script copies above are unconditional (needed for
// minimal installs that skip the hooks-runtime module, see the comments on
// those two functions), but a default install DOES select hooks-runtime,
// which independently scaffolds the whole scripts/hooks and scripts/lib
// directories via the generic module-path flow below -- as ONE 'copy-path'
// operation per directory (sourceRelativePath exactly 'scripts/hooks' or
// 'scripts/lib'), not one per file. That directory-level copy already
// includes every file the explicit ones also copy, so without this a
// default install recorded a redundant second copy of the same bytes to
// the same destination for each script (wasteful I/O, duplicate bookkeeping
// in the install state) per cubic-dev-ai review (PR #1052, 2026-07-27).
//
// Deliberately scoped to SOURCE paths under exactly these two directories,
// not a generic "any copy-path nested under any other copy-path" rule: an
// earlier version of this function compared DESTINATION paths across the
// whole operations list, which also caught unrelated --with/skills/rules
// operations that happened to land under a shared parent directory from a
// completely different module and dropped them too (a real regression --
// e.g. a --with-selected skill file nested under a skills/ directory
// operation from another module). Only a source path that is an actual
// descendant of one of these two known, hardcoded directories can ever be
// redundant with them.
const HOOKS_RUNTIME_DIRECTORY_SOURCES = new Set(['scripts/hooks', 'scripts/lib']);

function dedupeCopyOperations(operations) {
  const presentDirectorySources = new Set(
    operations
      .filter(operation => (
        operation.kind === 'copy-path' && HOOKS_RUNTIME_DIRECTORY_SOURCES.has(operation.sourceRelativePath)
      ))
      .map(operation => operation.sourceRelativePath)
  );

  return operations.filter(operation => {
    if (operation.kind !== 'copy-path') return true;
    return ![...presentDirectorySources].some(directorySource => (
      operation.sourceRelativePath !== directorySource
      && operation.sourceRelativePath.startsWith(`${directorySource}/`)
    ));
  });
}

function collectRecordedDestinations(adapter, input) {
  const statePaths = [adapter.getInstallStatePath(input), ...adapter.resolveLegacyInstallStatePaths(input)];
  const destinations = [];
  for (const statePath of statePaths) {
    const state = readInstallStateOrNull(statePath);
    if (state === UNREADABLE_STATE) return null;
    const operations = state && Array.isArray(state.operations) ? state.operations : [];
    destinations.push(...operations.map(operation => path.resolve(String(operation.destinationPath || ''))));
  }
  return destinations;
}

function isSameTree(sourcePath, destinationPath) {
  try {
    const source = fs.lstatSync(sourcePath, { throwIfNoEntry: false });
    const destination = fs.lstatSync(destinationPath, { throwIfNoEntry: false });
    if (!source || !destination) return false;
    if (source.isFile() && destination.isFile()) {
      return fs.readFileSync(sourcePath).equals(fs.readFileSync(destinationPath));
    }
    if (!source.isDirectory() || !destination.isDirectory()) return false;
    const sourceEntries = fs.readdirSync(sourcePath).sort();
    const destinationEntries = fs.readdirSync(destinationPath).sort();
    if (sourceEntries.join('\n') !== destinationEntries.join('\n')) return false;
    return sourceEntries.every(entry => isSameTree(path.join(sourcePath, entry), path.join(destinationPath, entry)));
  } catch {
    return false;
  }
}

function isPersonOwned(destination, recordedDestinations, matchesSource) {
  const stat = fs.lstatSync(destination, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink()) return false;
  const resolved = path.resolve(destination);
  if (recordedDestinations?.some(recorded => recorded === resolved || recorded.startsWith(resolved + path.sep))) {
    return false;
  }
  return !matchesSource(resolved);
}

function getAGYManagedDestinationPaths(adapter, sourceRelativePath, input, recordedDestinations = []) {
  const normalizedSourcePath = normalizeRelativePath(sourceRelativePath);
  const targetRoot = adapter.resolveRoot(input);

  if (normalizedSourcePath.startsWith('skills/')) {
    // Every Antigravity surface reads global skills from
    // ~/.gemini/config/skills/<skillName>/. Source layout in the repo is
    // `skills/<category>/<skillName>[/<file>]`: strip exactly the leading
    // category segment when present, so the tool never depends on the repo's
    // category taxonomy; leave already-flat paths untouched.
    const parts = normalizedSourcePath.slice('skills/'.length).split('/');
    const flatRemainder = parts.length >= 2 ? parts.slice(1).join('/') : parts.join('/');
    const destination = path.join(targetRoot, AGY_SKILLS_SUBDIR, flatRemainder);
    const sourcePath = input.repoRoot ? path.join(input.repoRoot, normalizedSourcePath) : null;
    const matchesSource = resolved => Boolean(sourcePath) && isSameTree(sourcePath, resolved);
    return isPersonOwned(destination, recordedDestinations, matchesSource) ? [] : [destination];
  }

  return null;
}

module.exports = createInstallTargetAdapter({
  id: 'egc-home',
  target: 'egc',
  kind: 'home',
  rootSegments: ['.gemini'],
  installStatePathSegments: ['egc', 'install-state.json'],
  validateMore(input, adapter) {
    if (collectRecordedDestinations(adapter, input)) return [];
    return [buildValidationIssue(
      'warning',
      'install-state-unreadable',
      `The install state at ${adapter.getInstallStatePath(input)} cannot be read: skills already under ${path.join(adapter.resolveRoot(input), AGY_SKILLS_SUBDIR)} and rules already under ${path.join(adapter.resolveRoot(input), AGY_RULES_SUBDIR)} that differ from EGC's are treated as yours and left as they are until it can be read again.`
    )];
  },
  planOperations(input, adapter) {
    const { modules, planningInput, targetRoot } = resolveModulesPlan(input, adapter);
    const homeDir = input.homeDir || os.homedir();
    const recordedDestinations = collectRecordedDestinations(adapter, input);

    const moduleOperations = modules.flatMap(module => {
      const paths = Array.isArray(module.paths) ? module.paths : [];
      return paths
        .filter(p => !isForeignPlatformPath(p, adapter.target) && !isGeminiCliOnlySource(p))
        .flatMap(sourceRelativePath => {
          if (isRuleSource(sourceRelativePath)) {
            return planAntigravityRuleOperations(adapter, module.id, sourceRelativePath, planningInput, recordedDestinations);
          }
          const managedDestinationPaths = getAGYManagedDestinationPaths(
            adapter,
            sourceRelativePath,
            planningInput,
            recordedDestinations
          );

          if (managedDestinationPaths) {
            return managedDestinationPaths.map(managedDestinationPath => createRemappedOperation(
              adapter,
              module.id,
              sourceRelativePath,
              managedDestinationPath,
              { strategy: 'preserve-relative-path' }
            ));
          }

          return [adapter.createScaffoldOperation(module.id, sourceRelativePath, planningInput)];
        });
    });

    const remap = (moduleId, sourceRelativePath, destinationPath, options) => (
      createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
    );

    // Deterministic: every egc-home install also registers the GateGuard
    // fact-forcing gate for Antigravity's global hooks.json, even when no
    // content modules are selected.
    return dedupeCopyOperations([
      ...moduleOperations,
      ...createAntigravityGlobalGateGuardOperations(targetRoot, homeDir, remap),
      ...createAntigravityGlobalCrusherOperations(targetRoot, homeDir, remap),
      ...createAntigravityGlobalGuardianOperations(targetRoot, homeDir, remap),
      ...createAntigravityGlobalMeshNoticeOperations(targetRoot, homeDir, remap),
    ]);
  },
});
