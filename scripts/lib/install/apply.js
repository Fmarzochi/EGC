'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const { readInstallState, writeInstallState } = require('../install-state');
const { syncInstallStateToStore } = require('../install-state-store-sync');
const { assertSafeMcpConfig, filterMcpConfig, isMcpConfigPath, parseDisabledMcpServers, parseMcpConfigText } = require('../mcp-config');
const { copyFileKeepingMode, replaceFileWith, writeTextKeepingMode } = require('./preserving-write');
const { cloneJsonValue, deepMergeJson } = require('../json-merge');


const {
  HOOK_OPERATION_KIND,
  applyManagedHookOperation,
} = require('../claude-settings-hooks');
const {
  MERGE_YAML_READ_LIST_KIND,
  mergeAiderConfigReadList,
} = require('../aider-config-merge');
const {
  MERGE_MARKDOWN_INDEX_KIND,
  mergeSkillIndexEntry,
} = require('../warp-agents-merge');

function readJsonObject(filePath, label) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to parse ${label} at ${filePath}: ${error.message}`, { cause: error });
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid ${label} at ${filePath}: expected a JSON object`);
  }

  return parsed;
}

function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function replacePluginRootPlaceholders(value, pluginRoot) {
  if (!pluginRoot) {
    return value;
  }

  if (typeof value === 'string') {
    return value.split('${GEMINI_PLUGIN_ROOT}').join(pluginRoot);
  }

  if (Array.isArray(value)) {
    return value.map(item => replacePluginRootPlaceholders(item, pluginRoot));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        replacePluginRootPlaceholders(nestedValue, pluginRoot),
      ])
    );
  }

  return value;
}

function findHooksSourcePath(plan, hooksDestinationPath) {
  const operation = plan.operations.find(item => item.destinationPath === hooksDestinationPath);
  return operation ? operation.sourcePath : null;
}

function buildResolvedClaudeHooks(plan) {
  if (plan.adapter?.target !== 'egc') {
    return null;
  }

  const pluginRoot = plan.targetRoot;
  const hooksDestinationPath = path.join(plan.targetRoot, 'hooks', 'hooks.json');
  const hooksSourcePath = findHooksSourcePath(plan, hooksDestinationPath) || hooksDestinationPath;
  if (!fs.existsSync(hooksSourcePath)) {
    return null;
  }

  const hooksConfig = readJsonObject(hooksSourcePath, 'hooks config');
  const resolvedHooks = replacePluginRootPlaceholders(hooksConfig.hooks, pluginRoot);
  if (!resolvedHooks || typeof resolvedHooks !== 'object' || Array.isArray(resolvedHooks)) {
    throw new Error(`Invalid hooks config at ${hooksSourcePath}: expected "hooks" to be a JSON object`);
  }

  return {
    hooksDestinationPath,
    resolvedHooksConfig: {
      ...hooksConfig,
      hooks: resolvedHooks,
    },
  };
}

function applyMergeJsonOperation(operation, disabledServers) {
  const payload = cloneJsonValue(operation.mergePayload);
  if (payload === undefined) {
    throw new Error(`Missing merge payload for ${operation.destinationPath}`);
  }
  if (isMcpConfigPath(operation.destinationPath)) {
    assertSafeMcpConfig(payload, `merge into ${operation.destinationPath}`);
  }

  const filteredPayload = (
    isMcpConfigPath(operation.destinationPath) && disabledServers.length > 0
  )
    ? filterMcpConfig(payload, disabledServers).config
    : payload;

  const currentValue = fs.existsSync(operation.destinationPath)
    ? readJsonObject(operation.destinationPath, 'existing JSON config')
    : {};
  const mergedValue = deepMergeJson(currentValue, filteredPayload);
  writeManagedText(operation.destinationPath, formatJson(mergedValue));
}


function applyMergeYamlReadListOperation(operation) {
  if (!operation.readEntry) {
    throw new Error(`Missing readEntry for ${operation.destinationPath}`);
  }

  const existingContent = fs.existsSync(operation.destinationPath)
    ? fs.readFileSync(operation.destinationPath, 'utf8')
    : null;
  let nextContent;
  try {
    nextContent = mergeAiderConfigReadList(existingContent, operation.readEntry);
  } catch (error) {
    // js-yaml's raw SyntaxError gives no indication of which file or
    // that it's a YAML problem at all — matches readJsonObject's
    // actionable-error convention above instead of a bare crash.
    throw new Error(
      `Failed to parse Aider config at ${operation.destinationPath}: ${error.message}`,
      { cause: error },
    );
  }
  writeManagedText(operation.destinationPath, nextContent);
}

function applyMergeMarkdownIndexOperation(operation) {
  const existingContent = fs.existsSync(operation.destinationPath)
    ? fs.readFileSync(operation.destinationPath, 'utf8')
    : null;
  const nextContent = mergeSkillIndexEntry(existingContent, {
    name: operation.skillName,
    description: operation.skillDescription,
    relativePath: operation.relativePath,
  });
  writeManagedText(operation.destinationPath, nextContent);
}

// The text that was validated is the text that lands (or the filtered form
// of exactly that parse), so nothing can change between check and write.
function applyMcpCopyFileOperation(operation, disabledServers) {
  const text = fs.readFileSync(operation.sourcePath, 'utf8');
  const sourceConfig = parseMcpConfigText(text, operation.sourcePath);
  assertSafeMcpConfig(sourceConfig, operation.sourcePath);
  const landed = disabledServers.length === 0
    ? text
    : formatJson(filterMcpConfig(sourceConfig, disabledServers).config);
  writeTextKeepingMode(operation.destinationPath, landed, operation.sourcePath);
}

// apply.js's own location is always the real installed package: unlike
// guardian-bin.js, shell-split.js, and the hook scripts it copies
// (createBashGuardianScriptCopyOperations in claude-settings-hooks.js), this
// file is never itself copied out into an install target, so a __dirname-
// relative walk-up is reliable for both a repo checkout and a real
// `npm install -g` (mirrors guardian-bin.js's own fromPackageLayout()).
function resolvePackageRoot() {
  return path.join(__dirname, '..', '..', '..');
}

// Home-scoped, tool-agnostic anchor for guardian-bin.js's
// fromEgcHomeMarker() resolution strategy (2026-07-27 internal design
// review, EGC-465): a Copilot- or CodeBuddy-only install has no MCP config
// file of its own to trust, so this records the real package root at the
// one moment it is actually known -- install time -- for any standalone
// copy of guardian-bin.js to read back later.
//
// Deliberately NOT getEGCDir() (scripts/lib/utils.js): that helper is
// polymorphic on the CALLING process's own env vars (CLAUDE_PROJECT_DIR,
// VSCODE_AGENT, ...) and would place the marker under the wrong tool's
// directory depending on which CLI happens to be running `egc install` at
// the time, defeating the whole point of a tool-agnostic anchor.
//
// Written unconditionally on every apply (any target), so it self-heals if
// the package is reinstalled at a new path. A write failure (read-only
// HOME, permissions) only removes one of four resolution strategies -- the
// existing ones are unaffected -- so it is logged and swallowed rather than
// failing the whole install.
function writeGuardianCliMarker(onWarning, homeDir) {
  const home = homeDir || os.homedir();
  const markerPath = path.join(home, '.egc', 'guardian-cli-path.json');
  try {
    // The marker's own directory answers to the same link check as every
    // install destination; a linked ~/.egc turns the write into a warning.
    refuseLinkedDestination(markerPath, home);
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });

    writeManagedText(markerPath, `${JSON.stringify({ packageRoot: resolvePackageRoot() }, null, 2)}\n`);
  } catch (error) {
    const msg = `Warning: Failed to write Guardian CLI marker: ${error.message}`;
    if (typeof onWarning === 'function') {
      onWarning(msg);
    } else {
      console.error(msg);
    }
  }
}

// The installer never writes through a link: a destination that is a
// symbolic link, or that sits under a linked directory strictly inside the
// target root, is refused before anything is created. The root itself may be
// a link the user made (a dotfiles manager, say); what lies below it is what
// the installer owns.
// Every managed file lands through an exclusive temporary and a rename, so a
// link at the destination (planted before the pre-flight check or swapped in
// after it) is replaced, never written through.
function writeManagedText(destinationPath, text) {
  replaceFileWith(destinationPath, descriptor => fs.writeFileSync(descriptor, text, 'utf8'));
}

// Until 10 June 2026 the Antigravity CLI skills landed as one link per
// skill into the copy EGC installs under the same target root (for the
// Gemini home, ~/.gemini/skills/egc). Those links are EGC's own layout, not
// something the person made: a link below the target root whose resolved
// target sits inside that copy is replaced by the real files on the next
// install (#1400). A link that resolves anywhere else keeps the refusal.
function legacyLinkRoots(root) {
  if (!root) return [];
  const managed = path.join(root, 'skills', 'egc');
  // The link target is compared as a real path, so the managed copy is
  // spelled through the root's own real path too (on macOS the temp and
  // home directories sit behind links: /var is /private/var). Only that
  // alias is accepted: a managed directory that is itself a link to
  // somewhere else is not EGC's copy, and links into it keep the refusal.
  let realRoot;
  try {
    realRoot = fs.realpathSync.native(root);
  } catch {
    return [managed];
  }
  const realManaged = path.join(realRoot, 'skills', 'egc');
  try {
    if (fs.realpathSync.native(managed) !== realManaged) return [];
  } catch {
    // Absent: a link into it dangles and is refused like any other.
  }
  return realManaged === managed ? [managed] : [managed, realManaged];
}

// The resolved target of the link at linkPath when it is EGC's legacy
// layout, null otherwise (a dangling link resolves nowhere and is refused
// like any other).
function legacyLinkTarget(linkPath, root) {
  let resolved;
  try {
    resolved = fs.realpathSync.native(linkPath);
  } catch {
    return null;
  }
  const inside = legacyLinkRoots(root).some(legacyRoot => resolved === legacyRoot || resolved.startsWith(legacyRoot + path.sep));
  return inside ? resolved : null;
}

// Refuses a link at the destination or under a linked directory strictly
// inside the target root. With `migrate` given, a link that is EGC's legacy
// layout is not refused: it is recorded in that list (linkPath, resolvedTo)
// and, unless `dryRun`, removed so the real directory takes its place; the
// unlink removes the link only, never what it pointed at. The apply
// collects with dryRun first and unlinks only after every path passed.
function refuseLinkedDestination(destinationPath, targetRoot, { migrate, dryRun = false } = {}) {
  const root = targetRoot ? path.resolve(targetRoot) : null;
  let probe = path.resolve(destinationPath);
  for (;;) {
    if (isSymbolicLink(probe)) handleLinkedProbe(probe, root, migrate, dryRun);
    const parent = path.dirname(probe);
    if (!insideRoot(parent, probe, root)) break;
    probe = parent;
  }
}

// Files a target wants removed: written by an earlier EGC install (the
// target reads them from the previous install-state) and no longer part of
// the plan. Only a regular file at the recorded path goes; a link or a
// directory there is not what EGC wrote and is left alone. Directories the
// removal empties are dropped too, up to the target root.
function retirePlannedFiles(plan) {
  const retired = [];
  for (const { retirement, root } of retirableEntries(plan)) {
    fs.unlinkSync(retirement.destinationPath);
    retired.push(retirement);
    removeEmptyParents(path.dirname(retirement.destinationPath), root);
  }
  return retired;
}

// The roots a plan writes under: the target root, plus any second root the
// adapter declared (Amp's plugin config directory). A destination is checked
// against the root it belongs to, so the linked-ancestor walk and the
// empty-parent climb cover that root and never leave it.
function managedRootsOf(plan) {
  const declared = Array.isArray(plan.managedRoots) ? plan.managedRoots : [];
  const roots = [plan.targetRoot, ...declared]
    .filter(root => typeof root === 'string' && root.length > 0)
    .map(root => path.resolve(root));
  return [...new Set(roots)];
}

// The managed root a destination falls under; a destination outside every
// declared root is walked against the target root, as before.
function managedRootFor(plan, destinationPath) {
  const resolved = path.resolve(destinationPath);
  const root = managedRootsOf(plan).find(candidate => resolved === candidate || resolved.startsWith(candidate + path.sep));
  return root || plan.targetRoot;
}

// The retirements of a plan that would actually be removed right now, each
// with the root it belongs to: the same test the apply runs, so a dry run
// lists exactly what the apply does.
function retirableEntries(plan) {
  const roots = managedRootsOf(plan);
  const result = [];
  for (const retirement of Array.isArray(plan.retirements) ? plan.retirements : []) {
    const filePath = path.resolve(retirement.destinationPath);
    const root = roots.find(candidate => filePath.startsWith(candidate + path.sep));
    if (!root) continue;
    if (!isRetirableFile(filePath, root, retirement.sourcePath, plan)) continue;
    result.push({ retirement: { ...retirement, destinationPath: filePath }, root });
  }
  return result;
}

function retirableFiles(plan) {
  return retirableEntries(plan).map(entry => entry.retirement);
}

function isSymbolicLink(filePath) {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

const plannedContentHashesByPlan = new WeakMap();

// The content of every file the plan copies, hashed once per plan and only
// when a candidate needs it: a candidate whose recorded source is gone (the
// file was renamed or moved in the package) is still EGC's when its bytes
// match a file the plan writes today.
function plannedContentHashes(plan) {
  if (plannedContentHashesByPlan.has(plan)) return plannedContentHashesByPlan.get(plan);
  const hashes = new Set();
  for (const operation of Array.isArray(plan.operations) ? plan.operations : []) {
    if (operation.kind !== 'copy-file' || typeof operation.sourcePath !== 'string') continue;
    try {
      hashes.add(sha256(fs.readFileSync(operation.sourcePath)));
    } catch {
      // An unreadable source vouches for nothing.
    }
  }
  plannedContentHashesByPlan.set(plan, hashes);
  return hashes;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Whether the file at filePath is the one EGC wrote and may go: a regular
// file (never a link), reached through no link between the root and it (a
// linked ancestor would point the unlink outside the root), and byte-identical
// to what EGC copied: the recorded source when it is still there, or, when
// that source is gone because the file was renamed or moved in the package, a
// file the plan copies today. A file the person replaced since is theirs, and
// a file whose source is gone and matches nothing the plan writes cannot be
// told apart from one, so both stay.
function isRetirableFile(filePath, root, sourcePath, plan = {}) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  for (let dir = path.dirname(filePath); dir !== root && dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
    if (isSymbolicLink(dir)) return false;
  }
  if (!sourcePath) return false;
  let content;
  try {
    content = fs.readFileSync(filePath);
  } catch {
    return false;
  }
  try {
    const source = fs.statSync(sourcePath);
    if (!source.isFile()) return false;
    return fs.readFileSync(sourcePath).equals(content);
  } catch (error) {
    // Only a source that is gone falls through to the content match; any
    // other failure to read it keeps the file.
    if (error.code !== 'ENOENT') return false;
  }
  return plannedContentHashes(plan).has(sha256(content));
}

function removeEmptyParents(dirPath, root) {
  let current = dirPath;
  while (current !== root && current.startsWith(root + path.sep)) {
    try {
      if (fs.readdirSync(current).length > 0) return;
      fs.rmdirSync(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

// Whether the walk continues to `parent`: only strictly inside the root,
// never the root itself (it may be a link the user made) and never past it.
function insideRoot(parent, probe, root) {
  return Boolean(root) && parent !== probe && parent !== root && parent.startsWith(root + path.sep);
}

// A link found on the walk: refused, unless migration is on and it is
// EGC's legacy layout, in which case it is recorded once (and removed
// unless this is a dry run).
function handleLinkedProbe(probe, root, migrate, dryRun) {
  const resolvedTo = migrate ? legacyLinkTarget(probe, root) : null;
  if (!resolvedTo) throw new Error(`Refusing to write through a symbolic link at ${probe}`);
  if (!migrate.some(entry => entry.linkPath === probe)) migrate.push({ linkPath: probe, resolvedTo });
  if (!dryRun) fs.unlinkSync(probe);
}

// Every path the apply checks for links: the state file, the hooks file
// and each operation, in that order.
function checkedDestinations(plan) {
  const resolvedClaudeHooksPlan = buildResolvedClaudeHooks(plan);
  const paths = [plan.installStatePath];
  if (resolvedClaudeHooksPlan) paths.push(resolvedClaudeHooksPlan.hooksDestinationPath);
  for (const operation of plan.operations) paths.push(operation.destinationPath);
  return paths.filter(Boolean);
}

// The legacy links a plan would migrate, without touching anything. With
// `strict`, a link that is not ours throws here, before anything is
// removed; without it (the dry run) such a link is left for the apply to
// refuse and only the migratable ones are listed. The dry run and the
// apply walk the same paths, so the list is what the apply will do.
function findLegacyLinks(plan, { strict = false } = {}) {
  const migrate = [];
  const targetRoot = plan.targetRoot ? path.resolve(plan.targetRoot) : null;
  for (const destinationPath of checkedDestinations(plan)) {
    // The legacy layout (#1400) only ever lived under the target root: a
    // link under a declared second root is refused outright.
    const root = managedRootFor(plan, destinationPath);
    const options = root === targetRoot ? { migrate, dryRun: true } : { dryRun: true };
    try {
      refuseLinkedDestination(destinationPath, root, options);
    } catch (error) {
      if (strict) throw error;
    }
  }
  return migrate;
}

// Removes the collected legacy links, deepest path first so a link seen
// through another is gone before the one it was seen through. Each link is
// checked again right before the unlink: it must still be a link resolving
// to the target recorded by the scan, otherwise the path changed under the
// install and is refused, never removed. unlink never follows a link, so
// only the link itself goes.
function removeLegacyLinks(links, targetRoot) {
  const root = targetRoot ? path.resolve(targetRoot) : null;
  const deepestFirst = [...links].sort((a, b) => segments(b.linkPath) - segments(a.linkPath));
  // Every link is checked before any is removed, so a link that changed is
  // refused with the layout still whole, not after part of it is gone.
  for (const link of deepestFirst) assertStillLegacyLink(link, root);
  for (const link of deepestFirst) {
    assertStillLegacyLink(link, root);
    fs.unlinkSync(link.linkPath);
  }
}

function assertStillLegacyLink(link, root) {
  let stat;
  try {
    stat = fs.lstatSync(link.linkPath);
  } catch {
    stat = null;
  }
  if (!stat?.isSymbolicLink() || legacyLinkTarget(link.linkPath, root) !== link.resolvedTo) {
    throw new Error(`Refusing to write through a symbolic link at ${link.linkPath}: it changed during the install`);
  }
}

function segments(filePath) {
  return path.resolve(filePath).split(path.sep).length;
}

// A shape transition is a destination where the plan must convert an
// existing file into a directory, or the reverse: the recorded source moved
// from one shape to the other (rules/foo.md being a file, then becoming a
// directory keeps its name but not its shape). A naive apply would falter on
// EEXIST here after already writing part of the layout, so the transition is
// resolved first: files are retired through the same identity check
// retirement uses -- a file a previous install recorded and that is still
// byte-identical to something this plan copies may go, everything else is
// refused with a clear message.

// Every copy-file destination a plan writes to or into: the planned files
// themselves and the directories that contain them, up to each managed root.
// Only these paths can change shape; a destination the plan stops touching
// is the retirement path's business, not ours.
function plannedWriteShapes(plan) {
  const roots = managedRootsOf(plan);
  const files = new Set();
  const parents = new Set();
  for (const operation of plan.operations) {
    if (operation.kind !== 'copy-file') continue;
    const destinationPath = path.resolve(operation.destinationPath);
    files.add(destinationPath);
    // The directories the install materializes for that file, each strictly
    // inside a managed root: a destination the installer writes outside its
    // roots must not get one of its parents turned into a directory.
    for (let dir = path.dirname(destinationPath); dir !== path.dirname(dir); dir = path.dirname(dir)) {
      const root = roots.find(candidate => dir === candidate || dir.startsWith(candidate + path.sep));
      if (!root) break;
      parents.add(dir);
      if (dir === root) break;
    }
  }
  return { files, parents };
}

// The managed copy-file destinations a previous install recorded, keyed by
// their resolved path. A missing or unreadable state explains nothing: the
// caller gets an empty map and every potential retirement is refused, which
// is the honest answer when we cannot prove a file is ours.
function previousStateManagedCopies(plan) {
  const recorded = new Map();
  let operations;
  try {
    operations = readInstallState(plan.installStatePath).operations || [];
  } catch {
    return recorded;
  }
  for (const operation of operations) {
    if (operation.kind !== 'copy-file' || operation.ownership !== 'managed') continue;
    recorded.set(path.resolve(operation.destinationPath), operation);
  }
  return recorded;
}

// The identity check for a file a shape transition wants to retire. Where a
// normal retirement also allows the original source file to still exist and
// match, a transition's recorded source is by definition gone or changed
// shape, so identity is only ever established against the files this plan
// copies today.
function isShapeTransitionRemovable(filePath, plan) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const root = managedRootFor(plan, filePath);
  if (!root) return false;
  for (let dir = path.dirname(filePath); dir !== root && dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
    if (isSymbolicLink(dir)) return false;
  }
  let content;
  try {
    content = fs.readFileSync(filePath);
  } catch {
    return false;
  }
  return plannedContentHashes(plan).has(sha256(content));
}

// Everything inside a directory a dir-to-file transition has to give way for,
// recursed depth-first: the regular files (each must pass identity before it
// can go), the directories that hold them (dropped once empty), and anything
// that is neither -- a link, a socket... -- that refuses the transition
// outright. A directory that cannot even be listed cannot be safely emptied,
// so it refuses too.
function collectShapeBlockingEntries(directory) {
  const files = [];
  const directories = [];
  const blocking = [];
  let inspectable = true;

  const walk = current => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      inspectable = false;
      return;
    }
    for (const entry of entries) {
      const resolved = path.join(current, entry.name);
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
        blocking.push(resolved);
      } else if (entry.isDirectory()) {
        directories.push(resolved);
        walk(resolved);
      } else {
        files.push(resolved);
      }
    }
  };

  walk(directory);
  return { files, directories, blocking, inspectable };
}

// Resolves a destination the plan writes as a directory out of what is today
// a file: it may be turned into the directory only when the scan can prove
// the file is EGC's by a previous install. Comes back as a refusal otherwise,
// or null when the destination already satisfies the planned shape.
function resolveFileToDirCandidate(destinationPath, { recorded, plan, onDiskFile, onDiskLink, legacyLinks }) {
  if (onDiskLink) {
    if (legacyLinks().has(destinationPath)) return null;
    return {
      refusal: {
        destinationPath,
        reason: 'a symbolic link or special file is in the way that EGC would not migrate',
      },
    };
  }
  if (!onDiskFile) return null;
  const recordedEntry = recorded.get(destinationPath);
  if (!recordedEntry) {
    return {
      refusal: {
        destinationPath,
        reason: 'a file EGC did not install must not be turned into a directory',
      },
    };
  }
  if (!isShapeTransitionRemovable(destinationPath, plan)) {
    return {
      refusal: {
        destinationPath,
        reason: 'a file is in the way that is EGC-modified or changed since install',
      },
    };
  }
  return {
    transition: {
      type: 'file-to-dir',
      destinationPath,
      sourceRelativePath: recordedEntry.sourceRelativePath || '',
    },
  };
}

// Resolves a destination the plan writes as a file out of what is today a
// directory: every regular file inside must be proven EGC's by a previous
// install, or the transition is refused with the directory untouched. A link
// or special entry inside, or a directory that cannot even be listed, refuses
// too -- the walk's empty directories are dropped, being indistinguishable
// from ones the person made.
function resolveDirToFileCandidate(destinationPath, { recorded, plan }) {
  const summary = collectShapeBlockingEntries(destinationPath);
  if (!summary.inspectable) {
    return {
      refusal: {
        destinationPath,
        reason: 'a directory that could not be listed must not be silently emptied',
      },
    };
  }
  if (summary.blocking.length > 0) {
    return {
      refusal: {
        destinationPath,
        reason: `a symbolic link or special file refuses the transition: ${summary.blocking
          .map(filePath => path.relative(path.resolve(destinationPath), filePath))
          .join(', ')}`,
      },
    };
  }
  const unreconciled = summary.files.filter(filePath => {
    const recordedEntry = recorded.get(filePath);
    return !recordedEntry || !isShapeTransitionRemovable(filePath, plan);
  });
  if (unreconciled.length > 0) {
    return {
      refusal: {
        destinationPath,
        reason: `files are in the way whose content is not in this package anymore, so EGC cannot prove they are untouched: ${unreconciled
          .map(filePath => path.relative(path.resolve(destinationPath), filePath))
          .join(', ')}`,
      },
    };
  }
  return {
    transition: {
      type: 'dir-to-file',
      destinationPath,
      children: [...summary.files].sort((a, b) => a.localeCompare(b)),
      directories: [...summary.directories, destinationPath].sort((a, b) => a.localeCompare(b)),
    },
  };
}

// Scans the destinations a plan will write to or into for shape transitions,
// read-only: the dry run lists them and the apply runs them. Anything the
// scan cannot reconcile is returned as a refusal instead of throwing, so a
// dry run can show every problem at once and the apply refuses before the
// first write.
function collectShapeTransitions(plan) {
  const recorded = previousStateManagedCopies(plan);
  const transitions = [];
  const refusals = [];
  const { files: plannedFiles, parents: plannedParents } = plannedWriteShapes(plan);
  const roots = managedRootsOf(plan);
  // The links this run migrates as EGC's own June 2026 legacy layout
  // (#1400). A planned path that is one of them is the apply's business and
  // is left for it; any other link the scan meets is refused here too, so a
  // dry run shows exactly what the apply will do. Resolved on the first link
  // the scan meets, never before one.
  let legacyLinkPaths = null;
  const legacyLinks = () => {
    if (!legacyLinkPaths) legacyLinkPaths = new Set(findLegacyLinks(plan).map(link => link.linkPath));
    return legacyLinkPaths;
  };

  for (const destinationPath of new Set([...plannedFiles, ...plannedParents])) {
    if (!roots.some(candidate => destinationPath === candidate || destinationPath.startsWith(candidate + path.sep))) continue;

    const wantsFile = plannedFiles.has(destinationPath);
    const wantsDirectory = plannedParents.has(destinationPath);

    // The plan both writes this path and writes into it -- structurally
    // impossible, never let install.sh find out the hard way. Raised before
    // the destination is even read, so a broken plan refuses on a fresh
    // install too, and a path in both sets is visited once, for one refusal.
    if (wantsFile && wantsDirectory) {
      refusals.push({
        destinationPath,
        reason: 'the plan writes this path as both a file and a directory',
      });
      continue;
    }

    let stat;
    try {
      stat = fs.lstatSync(destinationPath);
    } catch {
      continue;
    }
    const onDiskDirectory = stat.isDirectory();
    const onDiskFile = stat.isFile();

    if (wantsDirectory && !onDiskDirectory) {
      const result = resolveFileToDirCandidate(destinationPath, {
        recorded,
        plan,
        onDiskFile,
        onDiskLink: !onDiskFile && !onDiskDirectory,
        legacyLinks,
      });
      // null means the destination is a legacy link EGC migrates itself
      // (#1400) or already satisfies the planned shape: neither a transition
      // nor a refusal, and the apply's own link machinery owns it.
      if (!result) continue;
      if (result.transition) transitions.push(result.transition);
      else if (result.refusal) refusals.push(result.refusal);
      continue;
    }

    if (wantsFile && onDiskDirectory) {
      const result = resolveDirToFileCandidate(destinationPath, { recorded, plan });
      if (result.transition) transitions.push(result.transition);
      else if (result.refusal) refusals.push(result.refusal);
      continue;
    }
  }

  return { transitions, refusals };
}

function formatShapeTransitionsRefusal(refusals) {
  const lines = refusals.map(refusal => `  ${refusal.destinationPath}: ${refusal.reason}`);
  return (
    `Shape transition refused:\n${lines.join('\n')}\n` +
    'Move or remove the conflicting destination by hand, then run the install again.'
  );
}

// Converts the collected transitions. Deepest first so a nested transition is
// resolved before the one it is inside. Every file is verified before any is
// removed -- a transition is all-or-nothing, never a child at a time -- so a
// file that changed between the scan and the removal is refused with the
// whole layout still in place, and directories are only removed once empty.
function performShapeTransitions(transitions, plan) {
  const deepestFirst = [...transitions].sort((a, b) => segments(b.destinationPath) - segments(a.destinationPath));
  const offenders = [];
  for (const transition of deepestFirst) {
    const offender = verifyShapeTransition(transition, plan);
    if (offender) offenders.push(offender);
  }
  if (offenders.length > 0) {
    throw new Error(formatShapeTransitionsRefusal(offenders));
  }
  for (const transition of deepestFirst) {
    if (transition.type === 'file-to-dir') performFileToDir(transition);
    else performDirToFile(transition);
  }
}

// Re-checks the bytes of one transition against the disk right before the
// removals, so nothing EGC cannot prove is its own ever goes: the single file
// of a file-to-dir transition, every child of a dir-to-file one. Returns the
// first offender, or null when the transition may proceed.
function verifyShapeTransition(transition, plan) {
  if (transition.type === 'file-to-dir') {
    if (!isShapeTransitionRemovable(transition.destinationPath, plan)) {
      return { destinationPath: transition.destinationPath, reason: 'no longer a byte-identical EGC copy' };
    }
    return null;
  }
  for (const childPath of transition.children) {
    if (!isShapeTransitionRemovable(childPath, plan)) {
      return { destinationPath: childPath, reason: 'no longer a byte-identical EGC copy' };
    }
  }
  return null;
}

// Retires the EGC-installed file making room for the planned directory.
function performFileToDir(transition) {
  fs.rmSync(transition.destinationPath, { force: true });
}

// Retires the EGC-installed directory making room for the planned file: its
// children first, then the directories that held them, deepest first. A
// directory that grew content while the install ran is refused, not removed.
function performDirToFile(transition) {
  for (const childPath of transition.children) {
    fs.rmSync(childPath, { force: true });
  }
  const emptiestFirst = [...transition.directories].sort((a, b) => segments(b) - segments(a));
  for (const directoryPath of emptiestFirst) {
    try {
      fs.rmdirSync(directoryPath);
    } catch (error) {
      if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error;
      throw new Error(
        `Refusing to turn ${transition.destinationPath} into a file: ${directoryPath} grew content during the install`,
        { cause: error }
      );
    }
  }
}

function applyInstallPlan(plan, { onWarning, homeDir, dbPath } = {}) {

  const resolvedClaudeHooksPlan = buildResolvedClaudeHooks(plan);
  const disabledServers = parseDisabledMcpServers(process.env.EGC_DISABLED_MCPS || process.env.ECC_DISABLED_MCPS);

  // Shape transitions are resolved before the first write: a refusal throws
  // with the layout still untouched, so a source that changed shape between
  // installs fails clearly instead of hitting EEXIST mid-copy.
  const shapeResult = collectShapeTransitions(plan);
  if (shapeResult.refusals.length > 0) {
    throw new Error(formatShapeTransitionsRefusal(shapeResult.refusals));
  }
  plan.shapeTransitions = shapeResult.transitions;

  // A transition is only performed when the operation that will consume it is
  // reached: a dir-to-file right before the file write that replaces the
  // directory, a file-to-dir before the first child copy that needs it. A
  // failure in an earlier operation then leaves the old layout in place
  // instead of deleting it and never replacing it.
  const pendingTransitions = new Map(
    (plan.shapeTransitions || []).map(transition => [path.resolve(transition.destinationPath), transition])
  );
  const performPendingTransitionsFor = destinationPath => {
    const resolved = path.resolve(destinationPath);
    const due = [];
    for (const [target, transition] of pendingTransitions) {
      if (resolved === target || resolved.startsWith(target + path.sep)) due.push(transition);
    }
    if (due.length === 0) return;
    due.sort((a, b) => segments(b.destinationPath) - segments(a.destinationPath));
    for (const transition of due) {
      performShapeTransitions([transition], plan);
      pendingTransitions.delete(path.resolve(transition.destinationPath));
    }
  };

  // Every destination is checked before the first write, the state file and
  // the hooks file included, so a planted link fails the install before it
  // changes anything. Links that are EGC's own legacy layout (#1400) are
  // collected in that same pass and only removed once every path has
  // passed: a refusal further down never leaves a skill half migrated.
  // The per-destination check below then runs as before; a link swapped in
  // after this point is refused like any other.
  const migratedLegacyLinks = findLegacyLinks(plan, { strict: true });
  removeLegacyLinks(migratedLegacyLinks, plan.targetRoot);
  refuseLinkedDestination(plan.installStatePath, plan.targetRoot);
  if (resolvedClaudeHooksPlan) refuseLinkedDestination(resolvedClaudeHooksPlan.hooksDestinationPath, plan.targetRoot);
  for (const operation of plan.operations) {

    refuseLinkedDestination(operation.destinationPath, managedRootFor(plan, operation.destinationPath));
    performPendingTransitionsFor(operation.destinationPath);

    fs.mkdirSync(path.dirname(operation.destinationPath), { recursive: true });


    if (operation.kind === HOOK_OPERATION_KIND) {
      applyManagedHookOperation(operation);
    } else if (operation.kind === 'merge-json') {
      applyMergeJsonOperation(operation, disabledServers);
    } else if (operation.kind === MERGE_YAML_READ_LIST_KIND) {
      applyMergeYamlReadListOperation(operation);
    } else if (operation.kind === MERGE_MARKDOWN_INDEX_KIND) {
      applyMergeMarkdownIndexOperation(operation);
    } else if (operation.kind === 'copy-file' && isMcpConfigPath(operation.destinationPath)) {
      applyMcpCopyFileOperation(operation, disabledServers);
    } else {
      copyFileKeepingMode(operation.sourcePath, operation.destinationPath);

    }
  }

  // A listed transition always has its consuming operation; a transition
  // still pending here could not have been reached by the loop and is
  // resolved so the report matches the disk.
  performShapeTransitions([...pendingTransitions.values()], plan);

  if (resolvedClaudeHooksPlan) {
    refuseLinkedDestination(resolvedClaudeHooksPlan.hooksDestinationPath, plan.targetRoot);
    fs.mkdirSync(path.dirname(resolvedClaudeHooksPlan.hooksDestinationPath), { recursive: true });

    writeManagedText(resolvedClaudeHooksPlan.hooksDestinationPath, `${JSON.stringify(resolvedClaudeHooksPlan.resolvedHooksConfig, null, 2)}\n`);
  }

  const retiredFiles = retirePlannedFiles(plan);

  writeInstallState(plan.installStatePath, plan.statePreview);


  writeGuardianCliMarker(onWarning, homeDir);

  // Capture the async promise so callers (e.g. install() in the operations
  // registry) can await it before restoring console.error, ensuring that the
  // onError callback fires while any console intercept is still in place.
  // The promise is attached as a non-enumerable property so it never appears
  // in JSON.stringify() output (e.g. egc install --json).
  const syncPromise = syncInstallStateToStore(plan.statePreview, {
    homeDir,
    dbPath,
    onError: error => {
      const msg = `Warning: Failed to sync install state to status store: ${error.message}`;
      if (typeof onWarning === 'function') {
        onWarning(msg);
      } else {
        console.error(msg);
      }
    },
  });

  const result = { ...plan, applied: true, migratedLegacyLinks, retiredFiles, shapeTransitions: shapeResult.transitions };
  Object.defineProperty(result, 'syncPromise', {
    value: syncPromise,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return result;
}

module.exports = {
  applyInstallPlan,
  managedRootFor,
  retirableFiles,
  retirePlannedFiles,
  checkedDestinations,
  deepMergeJson,
  findLegacyLinks,
  refuseLinkedDestination,
  removeLegacyLinks,
  writeGuardianCliMarker,
  writeManagedText,
  collectShapeTransitions,
  performShapeTransitions,
  formatShapeTransitionsRefusal,



};
