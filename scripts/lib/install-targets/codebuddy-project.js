const path = require('node:path');

const {
  createFlatRuleOperations,
  createInstallTargetAdapter,
  createRemappedOperation,
  isForeignPlatformPath,
  normalizeModulesInput,
  planFlatSkillOperation,
} = require('./helpers');
const {
  GATEGUARD_HOOK_MODULE_ID,
  GATEGUARD_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  GATEGUARD_LIB_SOURCE_RELATIVE_PATH,
  resolveGateGuardHookScriptDestination,
  createPreToolUseGateGuardHookMergeOperation,
  createPreToolUseCrusherHookMergeOperation,
  createCrusherScriptCopyOperations,
  createPreToolUseBashGuardianHookMergeOperation,
  createBashGuardianScriptCopyOperations,
} = require('../claude-settings-hooks');

// Unlike antigravity-project.js (whose SUPPORTED_SOURCE_PREFIXES excludes
// 'scripts/**' entirely), CodeBuddy's module path filter only excludes
// foreign-platform paths, so a module selection that explicitly includes
// 'hooks-runtime' (whose paths cover scripts/hooks and scripts/lib) already
// scaffolds gateguard-fact-force.js and utils.js via moduleOperations below.
// Cubic review (EGC-539, PR #1142) caught two real gaps in earlier versions
// of this guard: (1) an `.some()`-based check treated covering EITHER
// scripts/hooks or scripts/lib as proof BOTH GateGuard files were already
// scaffolded, so a module selection covering only one of the two directories
// would skip copying the other file entirely, leaving it missing; (2) even
// after requiring both directories, the guard still worked at the whole-pair
// level (createGateGuardScriptCopyOperations copies both files together),
// so a selection covering only scripts/hooks (not scripts/lib) had no way to
// copy just the missing file without also re-copying the one already
// covered. Each of the two GateGuard files is therefore checked and copied
// independently below: skip a given file's explicit copy only when the
// selected modules cover its own exact path or its whole containing
// directory (which scaffolds recursively); a module pinning some other,
// unrelated file in that directory does not count as covering it.
function isPathCovered(modules, directoryPath, exactFilePath) {
  return modules.some(module => {
    const paths = Array.isArray(module.paths) ? module.paths : [];
    return paths.some(p => p === directoryPath || p === exactFilePath);
  });
}

function createGateGuardScriptCopyOperationsIfMissing(adapter, targetRoot, modules) {
  const remap = (moduleId, sourceRelativePath, destinationPath, options) => (
    createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
  );
  const operations = [];

  if (!isPathCovered(modules, 'scripts/hooks', GATEGUARD_HOOK_SCRIPT_SOURCE_RELATIVE_PATH)) {
    operations.push(remap(
      GATEGUARD_HOOK_MODULE_ID,
      GATEGUARD_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
      resolveGateGuardHookScriptDestination(targetRoot),
      { strategy: 'preserve-relative-path' }
    ));
  }

  if (!isPathCovered(modules, 'scripts/lib', GATEGUARD_LIB_SOURCE_RELATIVE_PATH)) {
    operations.push(remap(
      GATEGUARD_HOOK_MODULE_ID,
      GATEGUARD_LIB_SOURCE_RELATIVE_PATH,
      path.join(targetRoot, 'scripts', 'lib', 'utils.js'),
      { strategy: 'preserve-relative-path' }
    ));
  }

  return operations;
}

// CodeBuddy's PreToolUse hooks read from <project>/.codebuddy/settings.json
// using the same {"hooks": {"PreToolUse": [{"matcher", "hooks"}]}} shape
// Claude Code uses (https://www.codebuddy.ai/docs/cli/hooks), and this
// adapter's own targetRoot already resolves to <project>/.codebuddy. The
// generic Claude merge helper is reusable here without modification, but
// 'hooks-runtime' is not a default legacy module for the codebuddy target
// (see LEGACY_COMPAT_BASE_MODULE_IDS_BY_TARGET in install-manifests.js), so
// a module selection that omits it never scaffolds gateguard-fact-force.js
// or utils.js on its own. EGC-539 found the merge operations below were
// registered unconditionally while the script copy was not, so an install
// whose selected modules did not include scripts/hooks/scripts/lib wrote a
// PreToolUse hook pointing at a file that was never copied, breaking every
// Edit/Write/MultiEdit/Bash call with ENOENT. Copy the script and its
// utils.js dependency explicitly here, mirroring the same fix already
// applied to antigravity-project.js and copilot-home.js, but skip the copy
// when the selected modules already scaffold those same two files.
function createHookOperations(adapter, targetRoot, modules) {
  return [
    ...createGateGuardScriptCopyOperationsIfMissing(adapter, targetRoot, modules),
    createPreToolUseGateGuardHookMergeOperation(targetRoot, 'Edit'),
    createPreToolUseGateGuardHookMergeOperation(targetRoot, 'Write'),
    createPreToolUseGateGuardHookMergeOperation(targetRoot, 'MultiEdit'),
    createPreToolUseGateGuardHookMergeOperation(targetRoot, 'Bash'),
    // Token Crusher: CodeBuddy reads the same hooks.json schema as Claude Code,
    // so an updatedInput rewrite applies. Scaffold the standalone crusher hook
    // and its dependency tree explicitly (no content module carries them) and
    // register it on Bash only, where there is shell output to compress.
    ...createCrusherScriptCopyOperations(
      (moduleId, sourceRelativePath, destinationPath, options) => (
        createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
      ),
      targetRoot
    ),
    createPreToolUseCrusherHookMergeOperation(targetRoot, 'Bash'),
    // EGC Guardian: GateGuard above only forces investigation before a risky
    // action; it never checks a Bash command against the Guardian's actual
    // allowlist/denylist. 2026-07-27 audit (EGC-462) found this target had
    // GateGuard + Crusher wired but never the Guardian validator itself.
    ...createBashGuardianScriptCopyOperations(
      (moduleId, sourceRelativePath, destinationPath, options) => (
        createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
      ),
      targetRoot
    ),
    createPreToolUseBashGuardianHookMergeOperation(targetRoot, 'Bash'),
  ];
}

module.exports = createInstallTargetAdapter({
  id: 'codebuddy-project',
  target: 'codebuddy',
  kind: 'project',
  rootSegments: ['.codebuddy'],
  installStatePathSegments: ['egc-install-state.json'],
  nativeRootRelativePath: '.codebuddy',
  planOperations(input, adapter) {
    const modules = normalizeModulesInput(input);
    const {
      repoRoot,
      projectRoot,
      homeDir,
    } = input;
    const planningInput = {
      repoRoot,
      projectRoot,
      homeDir,
    };
    const targetRoot = adapter.resolveRoot(planningInput);

    const moduleOperations = modules.flatMap(module => {
      const paths = Array.isArray(module.paths) ? module.paths : [];
      return paths
        .filter(p => !isForeignPlatformPath(p, adapter.target))
        .flatMap(sourceRelativePath => {
          if (sourceRelativePath === 'rules') {
            return createFlatRuleOperations({
              moduleId: module.id,
              repoRoot,
              sourceRelativePath,
              destinationDir: path.join(targetRoot, 'rules'),
            });
          }

          // CodeBuddy discovers skills at .codebuddy/skills/<name>/ (flat);
          // planFlatSkillOperation strips the leading category segment for
          // skills/** paths and scaffolds everything else as-is.
          return [planFlatSkillOperation(adapter, module.id, sourceRelativePath, planningInput, targetRoot)];
        });
    });

    // Deterministic: every CodeBuddy install registers the GateGuard
    // fact-forcing gate, even when no content modules are selected,
    // mirroring Claude Code's always-on hook registration.
    return [
      ...moduleOperations,
      ...createHookOperations(adapter, targetRoot, modules),
    ];
  },
});
