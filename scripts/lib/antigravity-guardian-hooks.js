'use strict';

// The EGC Guardian in Antigravity's own hooks.json format
// (antigravity.google/docs/hooks): the file maps hook names to their events,
// so EGC owns one named hook, egc-guardian, and never touches the others.
// Its PreToolUse group matches Antigravity's shell and file-write tools and
// runs antigravity-guardian-adapter.js, which answers in Antigravity's
// {decision, reason} contract. The global file is the shared
// ~/.gemini/config/hooks.json, read by the Antigravity CLI, the IDE and
// Antigravity 2.0; the project file is .agents/hooks.json.

const fs = require('node:fs');
const path = require('node:path');

const HOOK_NAME = 'egc-guardian';
// Dispatch key for this operation in claude-settings-hooks.js's handler
// table; distinct from every Claude event name the table also holds.
const ANTIGRAVITY_GUARDIAN_HOOK_TAG = 'antigravity:egc-guardian';
const GUARDED_TOOLS_MATCHER = 'run_command|write_to_file|replace_file_content|multi_replace_file_content';
const HOOK_TIMEOUT_SECONDS = 30;
const ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/antigravity-guardian-adapter.js';

function resolveAdapterScriptDestination(targetRoot) {
  return path.join(targetRoot, 'scripts', 'hooks', 'antigravity-guardian-adapter.js');
}

function resolveGlobalHooksJsonPath(homeDir) {
  return path.join(homeDir, '.gemini', 'config', 'hooks.json');
}

function resolveProjectHooksJsonPath(projectRoot) {
  return path.join(projectRoot, '.agents', 'hooks.json');
}

function buildHookCommand(scriptPath) {
  return `"${process.execPath}" "${scriptPath}"`; // NOSONAR jssecurity:S8705
}

function guardianHookDefinition(adapterScriptPath) {
  return {
    PreToolUse: [
      {
        matcher: GUARDED_TOOLS_MATCHER,
        hooks: [{ type: 'command', command: buildHookCommand(adapterScriptPath), timeout: HOOK_TIMEOUT_SECONDS }],
      },
    ],
  };
}

function readAntigravityHooks(hooksJsonPath) {
  const raw = fs.existsSync(hooksJsonPath) ? fs.readFileSync(hooksJsonPath, 'utf8') : '';
  if (!raw.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse the Antigravity hooks file at ${hooksJsonPath}: ${error.message}`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid Antigravity hooks file at ${hooksJsonPath}: expected a JSON object of named hooks`);
  }
  return parsed;
}

function writeAntigravityHooks(hooksJsonPath, hooks) {
  fs.mkdirSync(path.dirname(hooksJsonPath), { recursive: true });
  fs.writeFileSync(hooksJsonPath, `${JSON.stringify(hooks, null, 2)}\n`, 'utf8');
}

function isCurrent(hooks, adapterScriptPath) {
  return JSON.stringify(hooks[HOOK_NAME]) === JSON.stringify(guardianHookDefinition(adapterScriptPath));
}

function applyAntigravityGuardianHookToFile(hooksJsonPath, adapterScriptPath) {
  const hooks = readAntigravityHooks(hooksJsonPath);
  if (isCurrent(hooks, adapterScriptPath)) return { changed: false };
  writeAntigravityHooks(hooksJsonPath, { ...hooks, [HOOK_NAME]: guardianHookDefinition(adapterScriptPath) });
  return { changed: true };
}

function removeAntigravityGuardianHookFromFile(hooksJsonPath) {
  if (!fs.existsSync(hooksJsonPath)) return { changed: false };
  const hooks = readAntigravityHooks(hooksJsonPath);
  if (!Object.hasOwn(hooks, HOOK_NAME)) return { changed: false };
  const rest = { ...hooks };
  delete rest[HOOK_NAME];
  writeAntigravityHooks(hooksJsonPath, rest);
  return { changed: true };
}

function inspectAntigravityGuardianHookFile(hooksJsonPath, adapterScriptPath) {
  try {
    return isCurrent(readAntigravityHooks(hooksJsonPath), adapterScriptPath) ? 'ok' : 'drifted';
  } catch {
    return 'drifted';
  }
}

module.exports = {
  ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
  ANTIGRAVITY_GUARDIAN_HOOK_TAG,
  GUARDED_TOOLS_MATCHER,
  HOOK_NAME,
  applyAntigravityGuardianHookToFile,
  guardianHookDefinition,
  inspectAntigravityGuardianHookFile,
  removeAntigravityGuardianHookFromFile,
  resolveAdapterScriptDestination,
  resolveGlobalHooksJsonPath,
  resolveProjectHooksJsonPath,
};
