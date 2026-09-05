'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeInstallState } = require('../install-state');
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

function refuseLinkedDestination(destinationPath, targetRoot) {
  const root = targetRoot ? path.resolve(targetRoot) : null;
  let probe = path.resolve(destinationPath);
  for (;;) {
    let stat;
    try {
      stat = fs.lstatSync(probe);
    } catch {
      stat = null;
    }
    if (stat?.isSymbolicLink()) {
      throw new Error(`Refusing to write through a symbolic link at ${probe}`);
    }
    const parent = path.dirname(probe);
    if (!root || parent === probe || parent === root || !parent.startsWith(root + path.sep)) break;
    probe = parent;
  }
}

function applyInstallPlan(plan, { onWarning, homeDir, dbPath } = {}) {

  const resolvedClaudeHooksPlan = buildResolvedClaudeHooks(plan);
  const disabledServers = parseDisabledMcpServers(process.env.EGC_DISABLED_MCPS || process.env.ECC_DISABLED_MCPS);

  // Every destination is checked before the first write, the state file and
  // the hooks file included, so a planted link fails the install before it
  // changes anything.
  refuseLinkedDestination(plan.installStatePath, plan.targetRoot);
  if (resolvedClaudeHooksPlan) refuseLinkedDestination(resolvedClaudeHooksPlan.hooksDestinationPath, plan.targetRoot);
  for (const operation of plan.operations) {

    refuseLinkedDestination(operation.destinationPath, plan.targetRoot);

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

  if (resolvedClaudeHooksPlan) {
    refuseLinkedDestination(resolvedClaudeHooksPlan.hooksDestinationPath, plan.targetRoot);
    fs.mkdirSync(path.dirname(resolvedClaudeHooksPlan.hooksDestinationPath), { recursive: true });

    writeManagedText(resolvedClaudeHooksPlan.hooksDestinationPath, `${JSON.stringify(resolvedClaudeHooksPlan.resolvedHooksConfig, null, 2)}\n`);
  }

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

  const result = { ...plan, applied: true };
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
  deepMergeJson,
  refuseLinkedDestination,
  writeGuardianCliMarker,
  writeManagedText,



};
