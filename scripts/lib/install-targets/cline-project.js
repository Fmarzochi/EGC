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

function createClineGuardianHookOperations(adapter, targetRoot) {
  const hooksDir = path.join(targetRoot, 'hooks');
  const remap = (moduleId, sourceRelativePath, destinationPath, options) => (
    createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
  );

  return [
    ...createBashGuardianScriptCopyOperations(remap, targetRoot),
    createAdapterStdinJsonCopyOperation(remap, targetRoot),
    remap(
      CLINE_GUARDIAN_HOOK_MODULE_ID,
      CLINE_GUARDIAN_ADAPTER_SOURCE_RELATIVE_PATH,
      path.join(targetRoot, ...CLINE_GUARDIAN_ADAPTER_SOURCE_RELATIVE_PATH.split('/')),
      { strategy: 'preserve-relative-path' }
    ),
    remap(
      CLINE_GUARDIAN_HOOK_MODULE_ID,
      'scripts/hooks/cline-pretooluse-shim.js',
      path.join(hooksDir, 'PreToolUse'),
      { strategy: 'preserve-relative-path' }
    ),
    remap(
      CLINE_GUARDIAN_HOOK_MODULE_ID,
      'scripts/hooks/cline-guardian-adapter.ps1',
      path.join(hooksDir, 'PreToolUse.ps1'),
      { strategy: 'preserve-relative-path' }
    ),
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
