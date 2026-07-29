const fs = require('node:fs');
const path = require('node:path');
const {
  createFlatRuleOperations,
  createInstallTargetAdapter,
  createRemappedOperation,
  isForeignPlatformPath,
} = require('./helpers');
const {
  createAdapterStdinJsonCopyOperation,
  createBashGuardianScriptCopyOperations,
} = require('../claude-settings-hooks');

// Cline discovers a PreToolUse hook by looking for a file literally named
// `PreToolUse` (Unix, must be executable) or `PreToolUse.ps1` (Windows)
// inside .clinerules/hooks/ -- there is no hooks.json to merge into, so this
// is a plain file copy, not a HOOK_OPERATION_KIND merge like every other
// host. Confirmed against the real cline/cline source (hook-factory.ts),
// not just the docs (2026-07-29): see cline-guardian-adapter.js for why only
// Guardian (block) is possible here, not the Token Crusher.
//
// cline-guardian-adapter.js requires ./pre-bash-guardian-validate and
// ../lib/adapter-stdin-json as normal siblings, so it (and those deps)
// install at the usual .clinerules/scripts/hooks|lib/ location, same as
// every other host. But the file Cline actually discovers by name
// (.clinerules/hooks/PreToolUse[.ps1]) can't live there too -- confirmed
// empirically via a real isolated install (2026-07-29): a standalone copy
// of cline-guardian-adapter.js at hooks/PreToolUse crashes with
// MODULE_NOT_FOUND, since its sibling deps aren't copied alongside it. So
// PreToolUse/PreToolUse.ps1 are instead thin shims that spawn the real,
// properly-sited adapter and pass stdin/stdout/exit code through unchanged.
const CLINE_GUARDIAN_HOOK_MODULE_ID = 'egc-guardian-cline-hook';
const CLINE_GUARDIAN_ADAPTER_SOURCE_RELATIVE_PATH = 'scripts/hooks/cline-guardian-adapter.js';

// Unlike every other host, Cline has no hooks.json to MERGE a new entry
// into -- it looks up exactly one file per hook name, so a user's own
// pre-existing .clinerules/hooks/PreToolUse (unrelated to EGC) would be
// silently overwritten by install and then permanently deleted by
// uninstall, with no way to preserve or restore it (cubic-dev-ai P1
// finding, PR #1087). These markers, taken verbatim from each shim's own
// header comment, let install recognize "this file is already ours" (safe
// to overwrite/reinstall) versus a foreign file (refuse to touch).
const CLINE_HOOK_OWNERSHIP_MARKERS = {
  PreToolUse: 'Installed verbatim as .clinerules/hooks/PreToolUse (Unix, executable).',
  'PreToolUse.ps1': 'Cline (VS Code extension) Guardian hook -- Windows.',
};

function isForeignHookFile(destinationPath, marker) {
  if (!fs.existsSync(destinationPath)) {
    return false;
  }
  try {
    return !fs.readFileSync(destinationPath, 'utf8').includes(marker);
  } catch {
    // Unreadable (permissions, not a regular file, ...): treat as foreign
    // rather than risk clobbering something we can't even inspect.
    return true;
  }
}

function createClineGuardianHookOperations(adapter, targetRoot) {
  const hooksDir = path.join(targetRoot, 'hooks');
  const remap = (moduleId, sourceRelativePath, destinationPath, options) => (
    createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
  );

  const hookFileOperations = [
    ['scripts/hooks/cline-pretooluse-shim.js', path.join(hooksDir, 'PreToolUse'), 'PreToolUse'],
    ['scripts/hooks/cline-guardian-adapter.ps1', path.join(hooksDir, 'PreToolUse.ps1'), 'PreToolUse.ps1'],
  ].flatMap(([sourceRelativePath, destinationPath, hookFileName]) => {
    if (isForeignHookFile(destinationPath, CLINE_HOOK_OWNERSHIP_MARKERS[hookFileName])) {
      console.error(
        `Warning: ${destinationPath} already exists and was not installed by EGC -- ` +
        'leaving it untouched. The EGC Guardian will not be active for Cline in this project ' +
        'until the conflicting file is removed or merged manually.'
      );
      return [];
    }
    return [remap(CLINE_GUARDIAN_HOOK_MODULE_ID, sourceRelativePath, destinationPath, { strategy: 'preserve-relative-path' })];
  });

  return [
    ...createBashGuardianScriptCopyOperations(remap, targetRoot),
    createAdapterStdinJsonCopyOperation(remap, targetRoot),
    remap(
      CLINE_GUARDIAN_HOOK_MODULE_ID,
      CLINE_GUARDIAN_ADAPTER_SOURCE_RELATIVE_PATH,
      path.join(targetRoot, ...CLINE_GUARDIAN_ADAPTER_SOURCE_RELATIVE_PATH.split('/')),
      { strategy: 'preserve-relative-path' }
    ),
    ...hookFileOperations,
  ];
}

module.exports = createInstallTargetAdapter({
  id: 'cline-project',
  target: 'cline',
  kind: 'project',
  rootSegments: ['.clinerules'],
  installStatePathSegments: ['egc-install-state.json'],
  nativeRootRelativePath: '.clinerules',
  planOperations(input, adapter) {
    let modules;
    if (Array.isArray(input.modules)) {
      modules = input.modules;
    } else if (input.module) {
      modules = [input.module];
    } else {
      modules = [];
    }

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
    const guardianHookOperations = createClineGuardianHookOperations(adapter, targetRoot);

    return guardianHookOperations.concat(modules.flatMap(module => {
      const paths = Array.isArray(module.paths) ? module.paths : [];

      return paths
        .filter(sourcePath => !isForeignPlatformPath(sourcePath, adapter.target))
        .flatMap(sourceRelativePath => {
          if (sourceRelativePath === 'rules') {
            return createFlatRuleOperations({
              moduleId: module.id,
              repoRoot,
              sourceRelativePath,
              destinationDir: targetRoot,
            });
          }

          return [
            adapter.createScaffoldOperation(
              module.id,
              sourceRelativePath,
              planningInput
            ),
          ];
        });
    }));
  },
});
