const fs = require('node:fs');
const path = require('node:path');

const {
  createInstallTargetAdapter,
  createRemappedOperation,
  isForeignPlatformPath,
  normalizeRelativePath,
  resolveModulesPlan,
} = require('./helpers');
const {
  BASH_GUARDIAN_HOOK_MODULE_ID,
  createBashGuardianScriptCopyOperations,
  createCrusherScriptCopyOperations,
  createWriteValidatorScriptCopyOperation,
} = require('../claude-settings-hooks');

// OpenCode plugins run in-process, unlike hosts that spawn hooks.json
// commands. Guardian and Crusher can run directly, while session restoration
// crosses a fail-open Node child-process boundary through the OpenCode adapter
// below. The adapter and Claude hook both consume the same host-neutral core.
const PLUGIN_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/opencode-egc-plugin.js';
const SESSION_CONTEXT_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/opencode-session-start.js';
const OPENCODE_SESSION_CONTEXT_MODULE_ID = 'opencode-session-context-hook';

// The .opencode folder of the repository is the source of the egc-universal
// npm package: a TypeScript plugin, custom tools, build output, package
// files and a complete opencode.json. OpenCode's config directory is not a
// place for a package. OpenCode imports every {tool,tools}/*.{js,ts} and
// {plugin,plugins}/*.{ts,js} file it finds there at start, so the TypeScript
// sources fail to load and every prompt dies with them (#1396); a
// package.json there makes OpenCode's own dependency install fail; and the
// shipped opencode.json replaces the person's global config on every
// install. Only the markdown OpenCode reads (commands) or that stays inert
// (instructions, prompts) is planned from that folder; the real plugin is
// scripts/hooks/opencode-egc-plugin.js, planned below.
const OPENCODE_PACKAGE_ROOT = '.opencode';
const OPENCODE_PACKAGE_SHIPPED_DIRS = ['commands', 'instructions', 'prompts'];
// Written by an earlier install and never planned again; opencode.json is
// left in place because it is the person's global config now, with whatever
// they and the MCP registration put in it since.
const OPENCODE_PACKAGE_KEPT_FILES = new Set(['opencode.json']);

function isOpenCodePackagePath(normalizedPath) {
  return normalizedPath === OPENCODE_PACKAGE_ROOT || normalizedPath.startsWith(`${OPENCODE_PACKAGE_ROOT}/`);
}

// The relative path inside the package for a source path under .opencode.
function packageRelativePath(normalizedPath) {
  return normalizedPath === OPENCODE_PACKAGE_ROOT ? '' : normalizedPath.slice(OPENCODE_PACKAGE_ROOT.length + 1);
}

function isShippedPackagePath(packagePath) {
  return OPENCODE_PACKAGE_SHIPPED_DIRS.some(dir => packagePath === dir || packagePath.startsWith(`${dir}/`));
}

// A shipped directory, or one file inside it, has to be a real entry whose
// real path stays inside the repository: a link planted there would
// otherwise be followed into whatever it points at when the operation is
// materialised.
function isRealEntryInside(entryPath, repoRoot) {
  try {
    const packageRoot = path.join(repoRoot, OPENCODE_PACKAGE_ROOT);
    // No link anywhere between the package root and the entry: a linked
    // shipped directory must not be entered through a file named inside it.
    for (let probe = entryPath; probe !== packageRoot && probe.startsWith(packageRoot + path.sep); probe = path.dirname(probe)) {
      if (fs.lstatSync(probe).isSymbolicLink()) return false;
    }
    const stat = fs.statSync(entryPath);
    if (!stat.isDirectory() && !stat.isFile()) return false;
    const real = fs.realpathSync.native(entryPath);
    const root = fs.realpathSync.native(repoRoot);
    return real === root || real.startsWith(root + path.sep);
  } catch {
    return false;
  }
}

// The operations for a module path under .opencode: the shipped directories
// that exist, each landing under the config directory by its own name, and
// nothing else from the package.
function createOpenCodePackageOperations(adapter, moduleId, sourceRelativePath, planningInput, targetRoot) {
  const normalizedPath = normalizeRelativePath(sourceRelativePath);
  const packagePath = packageRelativePath(normalizedPath);
  const repoRoot = planningInput.repoRoot || process.cwd();
  const candidates = packagePath === ''
    ? OPENCODE_PACKAGE_SHIPPED_DIRS
    : (isShippedPackagePath(packagePath) ? [packagePath] : []);
  return candidates
    .filter(candidate => isRealEntryInside(path.join(repoRoot, OPENCODE_PACKAGE_ROOT, ...candidate.split('/')), repoRoot))
    .map(candidate => createRemappedOperation(
      adapter,
      moduleId,
      `${OPENCODE_PACKAGE_ROOT}/${candidate}`,
      path.join(targetRoot, ...candidate.split('/')),
      { strategy: 'preserve-relative-path' }
    ));
}

// Files an earlier install wrote into the config directory from the package
// and that are not planned any more: read from the install-state the
// previous run left, so only what EGC itself wrote is ever retired. A
// missing or unreadable state means nothing to retire.
function planOpenCodePackageRetirements(adapter, planningInput) {
  const { readInstallState } = require('../install-state');
  const installStatePath = adapter.getInstallStatePath(planningInput);
  const targetRoot = adapter.resolveRoot(planningInput);
  const repoRoot = planningInput.repoRoot || process.cwd();
  let previous;
  try {
    previous = readInstallState(installStatePath);
  } catch {
    return [];
  }
  const retirements = [];
  const seen = new Set();
  for (const operation of Array.isArray(previous.operations) ? previous.operations : []) {
    const source = normalizeRelativePath(String(operation.sourceRelativePath || ''));
    if (!isOpenCodePackagePath(source) || source === OPENCODE_PACKAGE_ROOT) continue;
    const packagePath = packageRelativePath(source);
    if (isShippedPackagePath(packagePath) || OPENCODE_PACKAGE_KEPT_FILES.has(packagePath)) continue;
    const destinationPath = String(operation.destinationPath || '');
    const resolved = path.resolve(destinationPath);
    if (!resolved.startsWith(path.resolve(targetRoot) + path.sep) || seen.has(resolved)) continue;
    seen.add(resolved);
    retirements.push({
      destinationPath: resolved,
      sourceRelativePath: source,
      // The file EGC copied there, for the apply to compare against: a file
      // the person replaced since is theirs and stays.
      sourcePath: path.join(repoRoot, ...source.split('/')),
      reason: 'egc-universal package file, not part of the OpenCode config directory',
    });
  }
  return retirements;
}

// Keep this dependency set aligned with claude-home.js's SessionStart hook.
// The shared loader treats every helper as optional, but normal installations
// should preserve branch-aware, encrypted, global, propagated, and stack-aware
// restoration on both hosts.
const SESSION_CONTEXT_LIB_SOURCES = [
  'scripts/lib/session-start-adapter.js',
  'scripts/lib/dashboard-token.js',
  'scripts/lib/session-context-loader.js',
  'scripts/lib/branch-state.js',
  'scripts/lib/global-state.js',
  'scripts/lib/project-detect.js',
  'scripts/lib/propagate-state.js',
  'scripts/lib/state-crypto.js',
  // propagate-state.js's commit-privacy guard shells out to this script as
  // the git clean-filter command -- must be present (this target preserves
  // the scripts/ prefix, so it lands one level up from propagate-state.js,
  // exactly where the runtime falls back to looking), or the filter config
  // points at a path that never existed on this machine (cubic review,
  // audit EGC-547).
  'scripts/check-state-leak.js',
];

function resolvePluginScriptDestination(targetRoot) {
  return path.join(targetRoot, 'plugins', 'opencode-egc-plugin.js');
}

function createOpenCodeSessionContextOperations(remap, targetRoot) {
  return [
    remap(
      OPENCODE_SESSION_CONTEXT_MODULE_ID,
      SESSION_CONTEXT_SCRIPT_SOURCE_RELATIVE_PATH,
      path.join(targetRoot, 'scripts', 'hooks', 'opencode-session-start.js'),
      { strategy: 'preserve-relative-path' }
    ),
    ...SESSION_CONTEXT_LIB_SOURCES.map(sourceRelativePath => remap(
      OPENCODE_SESSION_CONTEXT_MODULE_ID,
      sourceRelativePath,
      path.join(targetRoot, ...sourceRelativePath.split('/')),
      { strategy: 'preserve-relative-path' }
    )),
  ];
}

function createOpenCodePluginOperations(adapter, targetRoot) {
  const remap = (moduleId, sourceRelativePath, destinationPath, options) => (
    createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
  );

  const pluginCopyOperation = createRemappedOperation(
    adapter,
    BASH_GUARDIAN_HOOK_MODULE_ID,
    PLUGIN_SCRIPT_SOURCE_RELATIVE_PATH,
    resolvePluginScriptDestination(targetRoot),
    { strategy: 'preserve-relative-path' }
  );

  return [
    ...createBashGuardianScriptCopyOperations(remap, targetRoot),
    createWriteValidatorScriptCopyOperation(remap, targetRoot),
    ...createCrusherScriptCopyOperations(remap, targetRoot),
    ...createOpenCodeSessionContextOperations(remap, targetRoot),
    pluginCopyOperation,
  ];
}

module.exports = createInstallTargetAdapter({
  id: 'opencode-home',
  target: 'opencode',
  kind: 'home',
  rootSegments: ['.config', 'opencode'],
  installStatePathSegments: ['egc', 'install-state.json'],
  nativeRootRelativePath: '.opencode',
  planOperations(input, adapter) {
    const { modules, planningInput, targetRoot } = resolveModulesPlan(input, adapter);

    const moduleOperations = modules.flatMap(module => {
      const paths = (Array.isArray(module.paths) ? module.paths : [])
        .filter(p => !isForeignPlatformPath(p, adapter.target));
      return paths.flatMap(sourceRelativePath => {
        const normalizedPath = normalizeRelativePath(sourceRelativePath);

        // OpenCode discovers skills at ~/.config/opencode/skills/<name>/ (flat).
        // Strip the leading category segment to match the expected structure.
        if (normalizedPath.startsWith('skills/')) {
          const parts = normalizedPath.slice('skills/'.length).split('/');
          const flatRemainder = parts.length >= 2 ? parts.slice(1).join('/') : parts.join('/');
          return [
            createRemappedOperation(
              adapter,
              module.id,
              sourceRelativePath,
              path.join(targetRoot, 'skills', flatRemainder),
              { strategy: 'preserve-relative-path' }
            ),
          ];
        }

        if (isOpenCodePackagePath(normalizedPath)) {
          return createOpenCodePackageOperations(adapter, module.id, sourceRelativePath, planningInput, targetRoot);
        }

        return [adapter.createScaffoldOperation(module.id, sourceRelativePath, planningInput)];
      });
    });

    return [
      ...moduleOperations,
      ...createOpenCodePluginOperations(adapter, targetRoot),
    ];
  },
  planRetirements(input, adapter) {
    const { planningInput } = resolveModulesPlan(input, adapter);
    return planOpenCodePackageRetirements(adapter, planningInput);
  },
});
