const os = require('node:os');
const path = require('node:path');

const {
  buildValidationIssue,
  createInstallTargetAdapter,
  createRemappedOperation,
  isForeignPlatformPath,
  collectRecordedDestinations,
  isPersonOwnedDestination,
  normalizeRelativePath,
  resolveModulesPlan,
} = require('./helpers');
const { CRUSHER_HOOK_MODULE_ID } = require('../claude-settings-hooks');
const { createAntigravityGuardianOperations } = require('../antigravity-guardian-operations');
const { createAntigravityGateGuardOperations, createAntigravityMeshNoticeOperations } = require('../antigravity-hook-operations');
const { resolveGlobalHooksJsonPath } = require('../antigravity-guardian-hooks');
const {
  AGY_RULES_SUBDIR,
  isRuleSource,
  planAntigravityCopyOperations,
  planAntigravityRuleFiles,
} = require('../antigravity-rules');
const { AGY_AGENTS_SUBDIR, isAgentSource, planAntigravityAgentFiles } = require('../antigravity-agents');
const { dropCommandsShadowedBySkills, isCommandSource, planAntigravityCommandFiles } = require('../antigravity-commands');

const AGY_SKILLS_SUBDIR = 'config/skills';

// Source paths only the retired Gemini CLI read from this root and that no
// family of the library counts on: Antigravity keeps its hooks in
// config/hooks.json, its MCP servers in config/mcp_config.json, and reads
// neither a plugin manifest nor a .agents tree here. What an earlier install wrote for them is retired on the next
// apply, file by file and only when byte-identical to what EGC copied
// (helpers.js, planGenericRetirements); a file the person edited stays.
// The same retirement collects the rules/egc tree and the agents/ and
// commands/ copies, now that those families install under config/.
const GEMINI_CLI_ONLY_SOURCE_PREFIXES = new Set(['.agents', 'hooks', 'mcp-configs', '.gemini-plugin']);

function isGeminiCliOnlySource(sourceRelativePath) {
  return GEMINI_CLI_ONLY_SOURCE_PREFIXES.has(normalizeRelativePath(sourceRelativePath).split('/')[0]);
}

function isLibrarySource(sourceRelativePath) {
  return isRuleSource(sourceRelativePath) || isAgentSource(sourceRelativePath) || isCommandSource(sourceRelativePath);
}

function libraryFamily(repoRoot, sourceRelativePath) {
  if (isRuleSource(sourceRelativePath)) {
    return { files: planAntigravityRuleFiles(repoRoot, sourceRelativePath), subdir: AGY_RULES_SUBDIR };
  }
  if (isAgentSource(sourceRelativePath)) {
    return { files: planAntigravityAgentFiles(repoRoot, sourceRelativePath), subdir: AGY_AGENTS_SUBDIR };
  }
  return { files: planAntigravityCommandFiles(repoRoot, sourceRelativePath), subdir: AGY_SKILLS_SUBDIR };
}

function planAntigravityLibraryOperations(adapter, moduleId, sourceRelativePath, input, recordedDestinations) {
  const repoRoot = input.repoRoot || '';
  const family = libraryFamily(repoRoot, sourceRelativePath);
  return planAntigravityCopyOperations({
    adapter,
    moduleId,
    files: family.files,
    destinationDir: path.join(adapter.resolveRoot(input), family.subdir),
    repoRoot,
    recordedDestinations,
  });
}

// The hooks Antigravity runs are the named hooks in the shared
// ~/.gemini/config/hooks.json, in its own format: egc-guardian
// (antigravity-guardian-operations.js), egc-gateguard and egc-mesh-notice
// (antigravity-hook-operations.js). Each comes with the scripts it runs,
// copied explicitly and unconditionally of module selection: hooks-runtime
// is only a DEFAULT base module, a minimal or custom selection can omit it,
// and an entry pointing at a script never copied would make every
// Antigravity call launch a nonexistent file (the gap a review of PR #1052
// found on 2026-07-27). The Claude-format entries once written to
// ~/.gemini/antigravity-cli/hooks.json never fired: their Bash and Edit
// matchers name no Antigravity tool, and Antigravity has no
// UserPromptSubmit. An upgrade retires them, since they left the plan
// (helpers.js, planHookRetirements), and removes the file when nothing else
// is in it. The Token Crusher keeps no hook here: an Antigravity hook
// answers a decision, never a rewritten command, so the `egc run` shim and
// the protocol are its path.
function createAntigravityGlobalHookOperations(targetRoot, homeDir, createRemap) {
  const hooksJsonPath = resolveGlobalHooksJsonPath(homeDir);
  return [
    ...createAntigravityGuardianOperations(createRemap, targetRoot, hooksJsonPath),
    ...createAntigravityGateGuardOperations(createRemap, targetRoot, hooksJsonPath),
    ...createAntigravityMeshNoticeOperations(createRemap, targetRoot, hooksJsonPath),
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
    return isPersonOwnedDestination(destination, sourcePath, recordedDestinations) ? [] : [destination];
  }

  return null;
}

module.exports = createInstallTargetAdapter({
  id: 'egc-home',
  target: 'egc',
  kind: 'home',
  rootSegments: ['.gemini'],
  installStatePathSegments: ['egc', 'install-state.json'],
  // The Token Crusher hook once written to antigravity-cli/hooks.json never
  // fired; an upgrade retires what that module recorded (see
  // createAntigravityGlobalHookOperations).
  retiredModuleIds: [CRUSHER_HOOK_MODULE_ID],
  validateMore(input, adapter) {
    if (collectRecordedDestinations(adapter, input)) return [];
    return [buildValidationIssue(
      'warning',
      'install-state-unreadable',
      `The install state at ${adapter.getInstallStatePath(input)} cannot be read: skills already under ${path.join(adapter.resolveRoot(input), AGY_SKILLS_SUBDIR)}, and rules and agents already under ${path.join(adapter.resolveRoot(input), AGY_RULES_SUBDIR)} and ${path.join(adapter.resolveRoot(input), AGY_AGENTS_SUBDIR)} that differ from EGC's, are treated as yours and left as they are until it can be read again.`
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
          if (isLibrarySource(sourceRelativePath)) {
            return planAntigravityLibraryOperations(adapter, module.id, sourceRelativePath, planningInput, recordedDestinations);
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

    // Deterministic: every egc-home install registers the three named hooks
    // in Antigravity's global hooks.json, even when no content modules are
    // selected.
    return dedupeCopyOperations([
      ...dropCommandsShadowedBySkills(moduleOperations),
      ...createAntigravityGlobalHookOperations(targetRoot, homeDir, remap),
    ]);
  },
});
