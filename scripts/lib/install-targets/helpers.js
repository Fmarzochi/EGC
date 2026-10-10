const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { isGeneratedRuntimeSourcePath, isHostPlacedSourcePath, isIgnoredSourceDirectory, isIgnoredSourceFile } = require('../install-source-filters');
const { HOOK_OPERATION_KIND } = require('../claude-settings-hooks');

const PLATFORM_SOURCE_PATH_OWNERS = Object.freeze({
  '.gemini-plugin': 'egc',
  '.codex': 'codex',
  '.cursor': 'cursor',
  '.gemini': 'gemini',
  '.opencode': 'opencode',
  '.codebuddy': 'codebuddy',
  '.kiro': 'kiro',
});

function normalizeRelativePath(relativePath) {
  return String(relativePath || '')
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, ''); // NOSONAR: superlinear risk accepted: input is repo-owned or local state content, never network-controlled
}

// Paths that carry a platform identity rather than library content. Every
// target that takes agents-core receives agents/; only the ones listed here
// also take the Codex and Antigravity .agents tree and the root AGENTS.md,
// so a home root such as ~/.amp or ~/.claude never grows either.
const IDENTITY_SOURCE_PATH_OWNERS = Object.freeze({
  '.agents': Object.freeze(['egc', 'cursor', 'antigravity', 'codex', 'codebuddy', 'zed']),
  'AGENTS.md': Object.freeze(['egc', 'cursor', 'antigravity', 'codex', 'codebuddy', 'zed']),
});

function isForeignPlatformPath(sourceRelativePath, adapterTarget) {
  const normalizedPath = normalizeRelativePath(sourceRelativePath);

  for (const [prefix, ownerTarget] of Object.entries(PLATFORM_SOURCE_PATH_OWNERS)) {
    if (normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)) {
      return ownerTarget !== adapterTarget;
    }
  }

  for (const [prefix, owners] of Object.entries(IDENTITY_SOURCE_PATH_OWNERS)) {
    if (normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)) {
      return !owners.includes(adapterTarget);
    }
  }

  return false;
}

function resolveBaseRoot(scope, input = {}) {
  if (scope === 'home') {
    return input.homeDir || os.homedir();
  }

  if (scope === 'project') {
    const projectRoot = input.projectRoot || input.repoRoot;
    if (!projectRoot) {
      throw new Error('projectRoot or repoRoot is required for project install targets');
    }
    return projectRoot;
  }

  throw new Error(`Unsupported install target scope: ${scope}`);
}

// Every adapter's planOperations(input, adapter) accepts either a `modules`
// array (the shape registry.js's planInstallTargetScaffold always normalizes
// to before calling in) or a single `module` object (the shape a caller that
// invokes adapter.planOperations() directly, bypassing the registry, may
// still pass -- see the "singular input.module" test coverage in
// install-targets.test.js). This normalization was duplicated verbatim
// across nine adapter files plus twice more inside this file itself
// (createFlatSkillPlanOperations and createDefaultScaffoldOperations) before
// being consolidated here (EGC-539 audit).
function normalizeModulesInput(input = {}) {
  if (Array.isArray(input.modules)) {
    return input.modules;
  }

  if (input.module) {
    return [input.module];
  }

  return [];
}

// The normalizeModulesInput() call plus the repoRoot/projectRoot/homeDir
// planningInput shape plus the adapter.resolveRoot(planningInput) call were
// identical across claude-home.js, codex-home.js, gemini-home.js, and
// opencode-home.js's planOperations -- each rebuilding the same 3-value
// lookup before diverging into its own module-to-operation mapping.
// Collapsing normalizeModulesInput() alone (above) into a 1-line call
// elsewhere in this same audit round made this remaining prefix contiguous
// enough to cross SonarCloud's cross-file duplication threshold (EGC-539
// audit, PR #1150). Only these three values are pulled out -- adapters that
// need extra planningInput fields (e.g. cursor-project.js's
// seenDestinationPaths) or a different root-resolution path keep their own
// inline version rather than being forced through this.
function resolveModulesPlan(input, adapter) {
  const modules = normalizeModulesInput(input);
  const planningInput = {
    repoRoot: input.repoRoot,
    projectRoot: input.projectRoot,
    homeDir: input.homeDir,
  };
  const targetRoot = adapter.resolveRoot(planningInput);
  return { modules, planningInput, targetRoot };
}

function buildValidationIssue(severity, code, message, extra = {}) {
  return {
    severity,
    code,
    message,
    ...extra,
  };
}

function listRelativeFiles(dirPath, prefix = '') {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true }).sort((left, right) => (
    left.name.localeCompare(right.name)
  ));
  const files = [];

  for (const entry of entries) {
    const entryPrefix = prefix ? path.join(prefix, entry.name) : entry.name;
    const absolutePath = path.join(dirPath, entry.name);

    // Same artifact exclusions as install-executor.js's listFilesRecursive:
    // adapter plans enumerate sources through this path too, and a local
    // .DS_Store or __pycache__ must never become a managed install source.
    if (entry.isDirectory()) {
      if (isIgnoredSourceDirectory(entry.name)) {
        continue;
      }
      files.push(...listRelativeFiles(absolutePath, entryPrefix));
    } else if (entry.isFile() && !isIgnoredSourceFile(entry.name)) {
      files.push(normalizeRelativePath(entryPrefix));
    }
  }

  return files;
}

function createManagedOperation({
  kind = 'copy-path',
  moduleId,
  sourceRelativePath,
  destinationPath,
  strategy = 'preserve-relative-path',
  ownership = 'managed',
  scaffoldOnly = true,
  ...rest
}) {
  return {
    kind,
    moduleId,
    sourceRelativePath: normalizeRelativePath(sourceRelativePath),
    destinationPath,
    strategy,
    ownership,
    scaffoldOnly,
    ...rest,
  };
}

const IDE_INSTALL_URLS = Object.freeze({
  claude:       { name: 'Claude Code',        url: 'https://claude.ai/download' },
  cursor:       { name: 'Cursor',             url: 'https://cursor.sh' },
  antigravity:  { name: 'Antigravity CLI',    url: 'https://github.com/google-gemini/gemini-cli' },
  codex:        { name: 'Codex CLI',          url: 'https://github.com/openai/codex' },
  opencode:     { name: 'OpenCode',           url: 'https://opencode.ai' },
  codebuddy:    { name: 'CodeBuddy',          url: 'https://copilot.tencent.com' },
  kiro:         { name: 'Kiro',               url: 'https://kiro.dev' },
  trae:         { name: 'Trae',               url: 'https://www.trae.ai' },
  junie:        { name: 'Junie',              url: 'https://www.jetbrains.com/junie/' },
  goose:        { name: 'Goose',              url: 'https://block.github.io/goose/' },
  openhands:    { name: 'OpenHands',          url: 'https://docs.openhands.dev' },
  aider:        { name: 'Aider',              url: 'https://aider.chat' },
  warp:         { name: 'Warp',               url: 'https://www.warp.dev' },
  windsurf:     { name: 'Devin Desktop',      url: 'https://devin.ai/desktop' },
  amp:          { name: 'Amp',                url: 'https://ampcode.com' },
  copilot:      { name: 'VS Code Copilot',    url: 'https://code.visualstudio.com' },
  zed:          { name: 'Zed',               url: 'https://zed.dev' },
  kimi:         { name: 'Kimi Code CLI',     url: 'https://github.com/MoonshotAI/kimi-code' },
  crush:        { name: 'Crush',             url: 'https://github.com/charmbracelet/crush' },
});

// An adapter that picks its root by policy (config.resolveRoot) is detected
// by the root it picked; the others by the tool's top directory.
function resolveDetectionRootDir(config, adapter, input, baseRoot) {
  if (typeof config.resolveRoot === 'function' && adapter) {
    return adapter.resolveRoot(input);
  }
  if (baseRoot && config.rootSegments && config.rootSegments.length > 0) {
    return path.join(baseRoot, config.rootSegments[0]);
  }
  return null;
}

function defaultValidateAdapterInput(config, input = {}, adapter = null) {
  if (config.kind === 'project' && !input.projectRoot && !input.repoRoot) {
    return [
      buildValidationIssue(
        'error',
        'missing-project-root',
        'projectRoot or repoRoot is required for project install targets'
      ),
    ];
  }

  if (config.kind === 'home' && !input.homeDir && !os.homedir()) {
    return [
      buildValidationIssue(
        'error',
        'missing-home-dir',
        'homeDir is required for home install targets'
      ),
    ];
  }

  const issues = [];
  const baseRoot = config.kind === 'home'
    ? (input.homeDir || os.homedir())
    : (input.projectRoot || input.repoRoot);

  const rootDir = resolveDetectionRootDir(config, adapter, input, baseRoot);
  if (rootDir) {
    if (!fs.existsSync(rootDir)) {
      const ide = IDE_INSTALL_URLS[config.target];
      if (ide) {
        issues.push(buildValidationIssue(
          'warning',
          'ide-not-detected',
          `${ide.name} does not appear to be installed on this machine.\n` +
          `  Expected config directory not found: ${rootDir}\n` +
          `  To install ${ide.name}, visit: ${ide.url}`
        ));
      }
    }
  }

  return issues;
}

function createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options = {}) {
  return createManagedOperation({
    kind: options.kind || 'copy-path',
    moduleId,
    sourceRelativePath,
    destinationPath,
    strategy: options.strategy || 'preserve-relative-path',
    ownership: options.ownership || 'managed',
    scaffoldOnly: Object.hasOwn(options, 'scaffoldOnly') ? options.scaffoldOnly : true,
    ...options.extra,
  });
}

function createFlatFileOperations({ // NOSONAR: directory walk building install operations kept inline; branches mirror the layout rules
  moduleId,
  repoRoot,
  sourceRelativePath,
  destinationDir,
  destinationNameTransform,
}) {
  const normalizedSourcePath = normalizeRelativePath(sourceRelativePath);
  const sourceRoot = path.join(repoRoot || '', normalizedSourcePath);

  if (!repoRoot || !fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
    return [];
  }

  const operations = [];
  const entries = fs.readdirSync(sourceRoot, { withFileTypes: true }).sort((left, right) => (
    left.name.localeCompare(right.name)
  ));

  for (const entry of entries) {
    const namespace = entry.name;
    const entryPath = path.join(sourceRoot, entry.name);

    // Same artifact exclusions as the nested listRelativeFiles walk: a
    // top-level __pycache__ namespace or a stray .DS_Store directly under
    // the source root must never become a managed install source either.
    if (entry.isDirectory() && !isIgnoredSourceDirectory(entry.name)) {
      const relativeFiles = listRelativeFiles(entryPath);
      for (const relativeFile of relativeFiles) {
        const defaultFileName = `${namespace}-${normalizeRelativePath(relativeFile).replaceAll('/', '-')}`;
        const sourceRelativeFile = path.join(normalizedSourcePath, namespace, relativeFile);
        const flattenedFileName = typeof destinationNameTransform === 'function'
          ? destinationNameTransform(defaultFileName, sourceRelativeFile)
          : defaultFileName;
        if (!flattenedFileName) {
          continue;
        }
        operations.push(createManagedOperation({
          moduleId,
          sourceRelativePath: sourceRelativeFile,
          destinationPath: path.join(destinationDir, flattenedFileName),
          strategy: 'flatten-copy',
        }));
      }
    } else if (entry.isFile() && !isIgnoredSourceFile(entry.name)) {
      const sourceRelativeFile = path.join(normalizedSourcePath, entry.name);
      const destinationFileName = typeof destinationNameTransform === 'function'
        ? destinationNameTransform(entry.name, sourceRelativeFile)
        : entry.name;
      if (!destinationFileName) {
        continue;
      }
      operations.push(createManagedOperation({
        moduleId,
        sourceRelativePath: sourceRelativeFile,
        destinationPath: path.join(destinationDir, destinationFileName),
        strategy: 'flatten-copy',
      }));
    }
  }

  return operations;
}

// The catalog agents flat under <root>/agents, each through the target's
// frontmatter transform when it has one (Claude Code and OpenCode read
// their own shapes). A single agent file keeps its name.
function planFlatAgentOperations(adapter, moduleId, sourceRelativePath, planningInput, targetRoot, transform) {
  const normalized = normalizeRelativePath(sourceRelativePath);
  const withTransform = operation => (transform ? { ...operation, transform } : operation);
  if (normalized === 'agents') {
    return createFlatFileOperations({
      moduleId,
      repoRoot: planningInput.repoRoot,
      sourceRelativePath,
      destinationDir: path.join(targetRoot, 'agents'),
    }).map(withTransform);
  }
  return [withTransform(createRemappedOperation(
    adapter,
    moduleId,
    sourceRelativePath,
    path.join(targetRoot, 'agents', ...normalized.slice('agents/'.length).split('/')),
    { strategy: 'preserve-relative-path' }
  ))];
}

function createFlatRuleOperations(options) {
  return createFlatFileOperations(options);
}

/**
 * Builds the install operation for a single module source path on a target
 * whose native skill layout is flat (<root>/skills/<name>/, no category
 * subfolder). Skill sources are remapped from skills/<category>/<name> to
 * skills/<name>; every other path scaffolds through the adapter's default
 * strategy. This is the one piece every flat-skill adapter shares -
 * including Claude Code's, which layers its own extra path filter and
 * hook-operation append around it - so it lives here instead of being
 * copied into each adapter file.
 */
function planFlatSkillOperation(adapter, moduleId, sourceRelativePath, planningInput, targetRoot, destSkillsDir = null) {
  const normalizedPath = normalizeRelativePath(sourceRelativePath);

  if (normalizedPath.startsWith('skills/')) {
    const parts = normalizedPath.slice('skills/'.length).split('/');
    const flatRemainder = parts.length >= 2 ? parts.slice(1).join('/') : parts.join('/');
    const destinationPath = destSkillsDir
      ? path.join(destSkillsDir, flatRemainder)
      : path.join(targetRoot, 'skills', flatRemainder);
    return createRemappedOperation(
      adapter,
      moduleId,
      sourceRelativePath,
      destinationPath,
      { strategy: 'preserve-relative-path' }
    );
  }

  return adapter.createScaffoldOperation(moduleId, sourceRelativePath, planningInput);
}

/**
 * Shared planOperations body for Tier 1 targets that discover skills flat
 * and have no adapter-specific path filtering or extra operations beyond
 * planFlatSkillOperation (Devin Desktop, Amp, Copilot, Zed, Continue.dev).
 *
 * Signature matches config.planOperations(input, adapter) so it can be
 * assigned directly (e.g. `planOperations: createFlatSkillPlanOperations`)
 * without a wrapper closure in each adapter file. `options.skillsDir`,
 * given the planning input, names a skills directory outside the root
 * (Zed: the shared ~/.agents/skills).
 */
function createFlatSkillPlanOperations(rawInput, adapter, options = {}) {
  const input = rawInput ?? {};
  const { modules, planningInput, targetRoot } = resolveModulesPlan(input, adapter);
  const skillsDir = typeof options.skillsDir === 'function' ? options.skillsDir(planningInput) : null;

  return modules.flatMap(module => {
    const paths = Array.isArray(module.paths) ? module.paths : [];
    return paths
      .filter(p => !isForeignPlatformPath(p, adapter.target))
      .map(sourceRelativePath => planFlatSkillOperation(adapter, module.id, sourceRelativePath, planningInput, targetRoot, skillsDir));
  });
}

// Same default-scaffold behavior createInstallTargetAdapter would otherwise
// supply on its own (preserve category structure, no flat stripping) --
// factored out so every adapter that defines a custom planOperations (to
// also emit its own extra operations alongside the default scaffold, e.g.
// the Guardian wiring of the since-retired Amazon Q and Roo Code adapters)
// can reuse it instead of each keeping its own copy. Was duplicated verbatim
// across the since-retired amazonq-project.js and roocode-project.js before
// this (SonarCloud new-code duplication finding on PR #1122); consolidated
// here as the single source of truth.
function createDefaultScaffoldOperations(input, adapter) {
  return normalizeModulesInput(input).flatMap(module => {
    const paths = Array.isArray(module.paths) ? module.paths : [];
    return paths
      .filter(p => !isForeignPlatformPath(p, adapter.target))
      .map(sourceRelativePath => adapter.createScaffoldOperation(module.id, sourceRelativePath, input));
  });
}

// The destinations one scaffold operation writes, added to `covered`. A
// directory copy covers the files it copies today, listed as
// materializeScaffoldOperation lists them (names unchanged; ignored names,
// generated install-states and host-placed sources left out), not every
// path under its destination; a directory that cannot be listed shields
// its whole subtree.
function addDirectoryCoverage(source, sourceDir, resolvedDestination, covered) {
  try {
    for (const relativeFile of listRelativeFiles(sourceDir)) {
      const sourceFile = `${source}/${relativeFile}`;
      if (isGeneratedRuntimeSourcePath(sourceFile) || isHostPlacedSourcePath(sourceFile)) continue;
      covered.files.add(path.join(resolvedDestination, ...relativeFile.split('/')));
    }
  } catch {
    covered.dirs.add(resolvedDestination);
  }
}

function addOperationCoverage(operation, repoRoot, covered) {
  const destination = typeof operation.destinationPath === 'string' ? operation.destinationPath : null;
  if (!destination) return;
  const resolvedDestination = path.resolve(destination);
  const source = typeof operation.sourceRelativePath === 'string' ? normalizeRelativePath(operation.sourceRelativePath) : null;
  // Nothing repo-relative to check the shape of (a merge or hook operation
  // may carry its payload some other way), or a source unreadable from
  // here: treat the destination as covered rather than guess, so it is
  // never offered up for retirement by mistake.
  if (!source) {
    covered.files.add(resolvedDestination);
    return;
  }
  const sourcePath = path.join(repoRoot, ...source.split('/'));
  let stat;
  try {
    stat = fs.statSync(sourcePath);
  } catch {
    covered.files.add(resolvedDestination);
    return;
  }
  if (stat.isDirectory()) addDirectoryCoverage(source, sourcePath, resolvedDestination, covered);
  else covered.files.add(resolvedDestination);
}

// What today's scaffold operations would actually write, at the
// granularity the install-state records: one destination per file, so a
// file that left a planned directory, or another module's file under a
// directory copied onto the target root itself (codex's `.agents`, egc's
// `.gemini-plugin`, cursor's `.cursor/scripts`), is no longer shielded.
function collectCurrentlyCoveredDestinations(operations, repoRoot) {
  const covered = { files: new Set(), dirs: new Set() };
  for (const operation of Array.isArray(operations) ? operations : []) {
    addOperationCoverage(operation, repoRoot, covered);
  }
  return covered;
}

function isDestinationCovered(resolved, { files, dirs }) {
  if (files.has(resolved)) return true;
  for (const dir of dirs) {
    if (resolved === dir || resolved.startsWith(dir + path.sep)) return true;
  }
  return false;
}

// The roots an adapter may legitimately write install files under. Most
// adapters write everything under their own resolveRoot(), but a few
// deliberately land copies in a second location (Amp's plugin scripts go to
// ~/.config/amp/plugins/ via resolveAmpConfigRoot(), distinct from its skills
// root ~/.amp/). A retirement candidate is only ever considered for one of
// these trusted roots, so a target with a second root must declare it here or
// its own writes can never be retired.
function resolveAdapterManagedRoots(adapter, input = {}) {
  if (typeof adapter.resolveManagedRoots === 'function') {
    const declared = adapter.resolveManagedRoots(input);
    if (Array.isArray(declared)) {
      return declared.filter(root => typeof root === 'string' && root.length > 0);
    }
  }
  return [adapter.resolveRoot(input)];
}

// The managed copy-file operations an install-state records, the shape both
// the sibling check and the retirement diff read.
function recordedManagedCopies(state) {
  const operations = Array.isArray(state?.operations) ? state.operations : [];
  return operations.filter(operation => (
    operation.ownership === 'managed'
    && operation.kind === 'copy-file'
    && typeof operation.destinationPath === 'string'
    && operation.destinationPath.length > 0
  ));
}

// The marker for an install-state that exists but cannot be read or parsed:
// unlike a missing one it may still record destinations, so it must never be
// mistaken for an empty one.
const UNREADABLE_STATE = Symbol('unreadable install-state');

// An install-state, null when nothing sits at the path (a definite ENOENT
// and nothing else: a dangling link, a parent that cannot be inspected or
// is not a directory all count as a state that cannot be trusted), and
// UNREADABLE_STATE when something is there but cannot be read or parsed.
function readInstallStateOrNull(statePath) {
  if (typeof statePath !== 'string' || statePath.length === 0) return null;
  try {
    fs.lstatSync(statePath);
  } catch (error) {
    return error.code === 'ENOENT' ? null : UNREADABLE_STATE;
  }
  const { readInstallState } = require('../install-state');
  try {
    return readInstallState(statePath);
  } catch {
    return UNREADABLE_STATE;
  }
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

function isPersonOwnedDestination(destination, sourcePath, recordedDestinations) {
  const stat = fs.lstatSync(destination, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink()) return false;
  const resolved = path.resolve(destination);
  if (recordedDestinations?.some(recorded => recorded === resolved || recorded.startsWith(resolved + path.sep))) {
    return false;
  }
  return !(sourcePath && isSameTree(sourcePath, resolved));
}

// Destinations a sibling adapter sharing the same trusted root still records
// as its own managed copies. codex-home, goose-home and openhands-home all
// write skills into the shared ~/.agents tree, each with its own
// install-state: if one adapter removes a skill from its plan, its retirement
// diff must not delete the file another adapter still installs. The sibling
// coverage check reads those sibling state files (passed in by registry.js
// when it plans) and refuses any candidate another adapter still owns. A
// sibling with no state file owns nothing; a sibling whose state exists but
// cannot be read may own any of them, so the answer is null: unknown
// ownership fails closed, never open.
function collectSiblingOwnedDestinations(statePaths) {
  const owned = new Set();
  for (const statePath of Array.isArray(statePaths) ? statePaths : []) {
    const siblingState = readInstallStateOrNull(statePath);
    if (siblingState === UNREADABLE_STATE) return null;
    for (const operation of recordedManagedCopies(siblingState)) {
      owned.add(path.resolve(operation.destinationPath));
    }
  }
  return owned;
}

// Whether a recorded destination is still a candidate once the boundaries
// apply: inside a root this adapter manages, not already offered, not owned
// by a sibling, and not covered by what today's plan writes.
function isRetirementCandidate(resolved, { managedRoots, seen, siblingOwned, covered }) {
  if (!managedRoots.some(root => resolved.startsWith(root + path.sep))) return false;
  if (seen.has(resolved) || siblingOwned.has(resolved)) return false;
  return !isDestinationCovered(resolved, covered);
}

// The default planRetirements body: compares the previous install-state's
// managed copy-file operations against what this plan would write today. A
// destination the state remembers EGC copied, recorded by a module this plan
// still selects, and that no scaffold operation in the plan still covers, is
// offered up for retirement. Renaming or dropping a command, prompt, rule or
// skill from the package is exactly this: the old destination stops being
// covered and is cleaned up on the next install or auto-update.
//
// The module gate is what tells a rename apart from a module that simply was
// not selected this run: a targeted --modules install, or a narrower profile,
// leaves the files of the modules it did not select exactly where they are.
//
// Only recorded copy-file operations are diffed; merge-json and hook
// operations (settings.json entries, MCP config merges) have no counterpart
// here yet, an open question left by #1412.
//
// This only decides which destinations are candidates. The identity check
// that decides whether one is actually safe to delete (a regular file,
// reached through no link, byte-identical to the source EGC copied) happens
// later in install/apply.js's isRetirableFile, the same test #1411
// introduced for OpenCode. A source no longer in the repository (the file was
// renamed, moved or removed) passes that check only when the bytes on disk
// match a file the plan copies today; otherwise the candidate is listed
// nowhere and the file is left in place, never deleted on the strength of the
// state entry alone.
// The states whose managed copies the diff reads: the current one and any
// legacy one the adapter still answers for. Trusted only when at least one
// state was read and none was unreadable: one unreadable state makes the
// whole set untrusted, the same conservative answer as for a single one.
function readRecordedStates(adapter, input) {
  const statePaths = [adapter.getInstallStatePath(input), ...adapter.resolveLegacyInstallStatePaths(input)];
  const operations = [];
  let found = false;
  for (const statePath of statePaths) {
    const state = readInstallStateOrNull(statePath);
    if (state === UNREADABLE_STATE) return { trusted: false, operations: [] };
    if (!state) continue;
    found = true;
    operations.push(...(Array.isArray(state.operations) ? state.operations : []));
  }
  return { trusted: found, operations };
}

function planGenericRetirements(input, adapter) {
  // The operations being diffed were planned against the package source
  // root; without it identities cannot be compared, so the conservative
  // answer is to retire nothing rather than to guess a directory.
  const repoRoot = typeof input.repoRoot === 'string' && input.repoRoot.length > 0 ? input.repoRoot : null;
  if (!repoRoot) return [];
  const previous = readRecordedStates(adapter, input);
  if (!previous.trusted) return [];

  // Destinations another adapter sharing this root still manages: never a
  // retirement candidate here, whatever this adapter's own coverage says. A
  // sibling state that cannot be read may still own any of them, so nothing
  // is retired until it can be trusted again.
  const siblingOwned = collectSiblingOwnedDestinations(input.siblingStatePaths);
  if (!siblingOwned) return [];

  const operations = Array.isArray(input.operations) ? input.operations : adapter.planOperations(input);
  const activeModuleIds = collectActiveModuleIds(input, operations, adapter);
  const boundaries = {
    managedRoots: resolveAdapterManagedRoots(adapter, input).map(root => path.resolve(root)),
    seen: new Set(),
    siblingOwned,
    covered: collectCurrentlyCoveredDestinations(operations, repoRoot),
  };

  const retirements = [];
  for (const operation of recordedManagedCopies(previous)) {
    if (!activeModuleIds.has(operation.moduleId)) continue;
    const resolved = path.resolve(operation.destinationPath);
    if (!isRetirementCandidate(resolved, boundaries)) continue;
    const source = normalizeRelativePath(String(operation.sourceRelativePath || ''));
    if (!source) continue;
    boundaries.seen.add(resolved);
    retirements.push(retirementOf(operation, resolved, source, repoRoot));
  }
  return retirements;
}

// The file EGC copied there, for the apply to compare against: a file the
// person replaced since is theirs and stays. A transformed copy is compared
// against the transformed source.
// The modules this install still carries: the ones the person selected plus
// the ones the adapter plans on its own (hook scripts and their entries,
// recorded under ids no manifest lists). Whatever such a module no longer
// plans has left the plan; a module that is no longer installed at all is
// left to the uninstall, unless the adapter declares it retired: then what
// it recorded leaves with it (the Token Crusher hook on Antigravity, which
// never fired, is the first).
function collectActiveModuleIds(input, operations, adapter) {
  const active = new Set(Array.isArray(adapter?.retiredModuleIds) ? adapter.retiredModuleIds : []);
  for (const module of Array.isArray(input.modules) ? input.modules : []) {
    if (module && typeof module.id === 'string') active.add(module.id);
  }
  for (const operation of operations) {
    if (operation && typeof operation.moduleId === 'string') active.add(operation.moduleId);
  }
  return active;
}

function recordedManagedHooks(state) {
  const operations = Array.isArray(state?.operations) ? state.operations : [];
  return operations.filter(operation => (
    operation.ownership === 'managed'
    && operation.kind === HOOK_OPERATION_KIND
    && [operation.destinationPath, operation.hookEvent, operation.hookScriptPath]
      .every(value => typeof value === 'string' && value.length > 0)
  ));
}

// One entry is one script under one event in one file; the matcher is part
// of what the plan asks for, so an entry that only changed matcher is
// retired and written again.
function hookEntryKey(operation) {
  return [path.resolve(operation.destinationPath), operation.hookEvent, path.resolve(operation.hookScriptPath)].join('\n');
}

function hookEntryIdentity(operation) {
  return `${hookEntryKey(operation)}\n${operation.hookMatcher || ''}`;
}

// Entries another adapter's state still records are never retired here;
// one unreadable sibling state makes every entry untouchable.
function collectSiblingHookKeys(statePaths) {
  const keys = new Set();
  for (const statePath of Array.isArray(statePaths) ? statePaths : []) {
    const siblingState = readInstallStateOrNull(statePath);
    if (siblingState === UNREADABLE_STATE) return null;
    for (const operation of recordedManagedHooks(siblingState)) keys.add(hookEntryKey(operation));
  }
  return keys;
}

// The hook entries a previous install of this adapter recorded, under a
// module the install still carries, that the current plan no longer makes
// (Devin Desktop's Cascade events, removed with Cascade on 2026-09-08, are
// the first). The apply removes each through the handler the uninstall
// uses, once the current entries are written. Only files under the
// adapter's managed roots are touched, and only when every recorded state
// can be read.
function planHookRetirements(input, adapter) {
  const previous = readRecordedStates(adapter, input);
  if (!previous.trusted) return [];
  const siblingKeys = collectSiblingHookKeys(input.siblingStatePaths);
  if (!siblingKeys) return [];

  const operations = Array.isArray(input.operations) ? input.operations : adapter.planOperations(input);
  const planned = new Set(operations.filter(operation => operation?.kind === HOOK_OPERATION_KIND).map(hookEntryIdentity));
  const activeModuleIds = collectActiveModuleIds(input, operations, adapter);
  const managedRoots = resolveAdapterManagedRoots(adapter, input).map(root => path.resolve(root));
  const seen = new Set();
  const retirements = [];
  for (const operation of recordedManagedHooks(previous)) {
    const identity = hookEntryIdentity(operation);
    const destinationPath = path.resolve(operation.destinationPath);
    const isManaged = managedRoots.some(root => destinationPath.startsWith(root + path.sep));
    if (!isManaged || !activeModuleIds.has(operation.moduleId)) continue;
    if (planned.has(identity) || seen.has(identity) || siblingKeys.has(hookEntryKey(operation))) continue;
    seen.add(identity);
    retirements.push({
      kind: HOOK_OPERATION_KIND,
      moduleId: operation.moduleId,
      destinationPath,
      hookEvent: operation.hookEvent,
      hookScriptPath: operation.hookScriptPath,
      ...(operation.hookMatcher ? { hookMatcher: operation.hookMatcher } : {}),
      reason: 'hook entry left the install plan',
    });
  }
  return retirements;
}

function retirementOf(operation, destinationPath, source, repoRoot) {
  return {
    destinationPath,
    sourceRelativePath: source,
    sourcePath: path.join(repoRoot, ...source.split('/')),
    ...(operation.transform ? { transform: operation.transform } : {}),
    ...(typeof operation.contentSha256 === 'string' ? { contentSha256: operation.contentSha256 } : {}),
    reason: 'file left the install plan',
  };
}

function createInstallTargetAdapter(config) {
  const adapter = {
    id: config.id,
    target: config.target,
    kind: config.kind,
    nativeRootRelativePath: config.nativeRootRelativePath || null,
    // Module ids this adapter stopped planning on purpose: what an earlier
    // install recorded under them is retired on upgrade like the rest.
    retiredModuleIds: Array.isArray(config.retiredModuleIds) ? [...config.retiredModuleIds] : [],
    supports(target) {
      return target === config.target || target === config.id;
    },
    resolveRoot(input = {}) {
      if (typeof config.resolveRoot === 'function') {
        return config.resolveRoot(input, adapter);
      }
      const baseRoot = resolveBaseRoot(config.kind, input);
      return path.join(baseRoot, ...config.rootSegments);
    },
    // The roots under which config.resolveManagedRoots (when declared) lets
    // retirement plan writes; defaults to resolveRoot() alone. A target that
    // lands install files in a second directory (Amp's plugin config root)
    // declares the full list so its own writes can be retired too.
    resolveManagedRoots(input = {}) {
      if (typeof config.resolveManagedRoots === 'function') {
        const declared = config.resolveManagedRoots(input, adapter);
        if (Array.isArray(declared)) {
          return declared.filter(root => typeof root === 'string' && root.length > 0);
        }
      }
      return [adapter.resolveRoot(input)];
    },
    getInstallStatePath(input = {}) {
      const root = adapter.resolveRoot(input);
      return path.join(root, ...config.installStatePathSegments);
    },
    // Install states this adapter wrote under a root it no longer picks
    // (the workspace moved to a new layout), still read by doctor,
    // uninstall and the retirement diff until the next install replaces
    // them with the current state; none by default.
    resolveLegacyInstallStatePaths(input = {}) {
      if (typeof config.resolveLegacyInstallStatePaths !== 'function') return [];
      const declared = config.resolveLegacyInstallStatePaths(input, adapter);
      return Array.isArray(declared)
        ? declared.filter(statePath => typeof statePath === 'string' && statePath.length > 0)
        : [];
    },
    resolveDestinationPath(sourceRelativePath, input = {}) {
      const normalizedSourcePath = normalizeRelativePath(sourceRelativePath);
      const targetRoot = adapter.resolveRoot(input);

      if (
        config.nativeRootRelativePath
        && normalizedSourcePath === normalizeRelativePath(config.nativeRootRelativePath)
      ) {
        return targetRoot;
      }

      return path.join(targetRoot, normalizedSourcePath);
    },
    determineStrategy(sourceRelativePath) {
      const normalizedSourcePath = normalizeRelativePath(sourceRelativePath);

      if (
        config.nativeRootRelativePath
        && normalizedSourcePath === normalizeRelativePath(config.nativeRootRelativePath)
      ) {
        return 'sync-root-children';
      }

      return 'preserve-relative-path';
    },
    createScaffoldOperation(moduleId, sourceRelativePath, input = {}) {
      const normalizedSourcePath = normalizeRelativePath(sourceRelativePath);
      return createManagedOperation({
        moduleId,
        sourceRelativePath: normalizedSourcePath,
        destinationPath: adapter.resolveDestinationPath(normalizedSourcePath, input),
        strategy: adapter.determineStrategy(normalizedSourcePath),
      });
    },
    planOperations(input = {}) {
      if (typeof config.planOperations === 'function') {
        return config.planOperations(input, adapter);
      }

      // Same body createDefaultScaffoldOperations exposes for adapters that
      // define a custom planOperations of their own -- this default branch
      // used to keep an unreduced copy of the exact same logic (EGC-539
      // audit) instead of calling that already-extracted helper.
      return createDefaultScaffoldOperations(input, adapter);
    },
    // Files a previous install wrote that this plan no longer covers and
    // that the target wants removed on the next apply. An adapter
    // with its own rules (e.g. OpenCode's egc-universal package
    // cleanup, narrower and with its own kept-files exception)
    // defines config.planRetirements and is used as-is; every other
    // target falls back to the generic plan-diff below (#1412).
    planRetirements(input = {}) {
      if (typeof config.planRetirements === 'function') {
        return config.planRetirements(input, adapter);
      }
      return planGenericRetirements(input, adapter);
    },
    supportsModule(module, input = {}) {
      if (typeof config.supportsModule === 'function') {
        return config.supportsModule(module, input, adapter);
      }

      return true;
    },
    validate(input = {}) {
      if (typeof config.validate === 'function') {
        return config.validate(input, adapter);
      }

      // validateMore adds the adapter's own checks to the default ones
      // instead of replacing them.
      const issues = defaultValidateAdapterInput(config, input, adapter);
      return typeof config.validateMore === 'function'
        ? [...issues, ...config.validateMore(input, adapter)]
        : issues;
    },
  };

  return Object.freeze(adapter);
}

module.exports = {
  UNREADABLE_STATE,
  buildValidationIssue,
  collectSiblingOwnedDestinations,
  createDefaultScaffoldOperations,
  createFlatFileOperations,
  createFlatRuleOperations,
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
  createManagedOperation,
  createManagedScaffoldOperation: (moduleId, sourceRelativePath, destinationPath, strategy) => (
    createManagedOperation({
      moduleId,
      sourceRelativePath,
      destinationPath,
      strategy,
    })
  ),
  createRemappedOperation,
  isForeignPlatformPath,
  normalizeModulesInput,
  normalizeRelativePath,
  planFlatAgentOperations,
  planFlatSkillOperation,
  planGenericRetirements,
  planHookRetirements,
  readInstallStateOrNull,
  collectRecordedDestinations,
  isPersonOwnedDestination,
  isSameTree,
  resolveAdapterManagedRoots,
  resolveBaseRoot,
  resolveModulesPlan,
};
