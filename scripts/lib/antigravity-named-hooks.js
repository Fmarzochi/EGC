'use strict';

// The named hooks EGC owns in Antigravity's hooks.json
// (antigravity.google/docs/hooks): the file maps hook names to their events,
// so each EGC hook is one name of its own, written whole and removed whole,
// and the names the person or another tool wrote are never touched. The
// global file is the shared ~/.gemini/config/hooks.json, read by the
// Antigravity CLI, the IDE and Antigravity 2.0; the project file is
// .agents/hooks.json.

const fs = require('node:fs');
const path = require('node:path');

function buildHookCommand(scriptPath) {
  return `"${process.execPath}" "${scriptPath}"`; // NOSONAR jssecurity:S8705
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

// hookName: the key EGC owns in the file. hookTag: the dispatch key of its
// install operation in claude-settings-hooks.js's handler table, distinct
// from every Claude event name the table also holds. definition:
// (adapterScriptPath) => the events object written under the name.
function createAntigravityNamedHook({ hookName, hookTag, adapterSourceRelativePath, definition }) {
  const isCurrent = (hooks, adapterScriptPath) => (
    JSON.stringify(hooks[hookName]) === JSON.stringify(definition(adapterScriptPath))
  );

  function applyToFile(hooksJsonPath, adapterScriptPath) {
    const hooks = readAntigravityHooks(hooksJsonPath);
    if (isCurrent(hooks, adapterScriptPath)) return { changed: false };
    writeAntigravityHooks(hooksJsonPath, { ...hooks, [hookName]: definition(adapterScriptPath) });
    return { changed: true };
  }

  function removeFromFile(hooksJsonPath) {
    if (!fs.existsSync(hooksJsonPath)) return { changed: false };
    const hooks = readAntigravityHooks(hooksJsonPath);
    if (!Object.hasOwn(hooks, hookName)) return { changed: false };
    const rest = { ...hooks };
    delete rest[hookName];
    writeAntigravityHooks(hooksJsonPath, rest);
    return { changed: true };
  }

  function inspectFile(hooksJsonPath, adapterScriptPath) {
    try {
      return isCurrent(readAntigravityHooks(hooksJsonPath), adapterScriptPath) ? 'ok' : 'drifted';
    } catch {
      return 'drifted';
    }
  }

  return {
    hookName,
    hookTag,
    adapterSourceRelativePath,
    definition,
    resolveAdapterScriptDestination: targetRoot => path.join(targetRoot, ...adapterSourceRelativePath.split('/')),
    applyToFile,
    removeFromFile,
    inspectFile,
  };
}

function resolveGlobalHooksJsonPath(homeDir) {
  return path.join(homeDir, '.gemini', 'config', 'hooks.json');
}

function resolveProjectHooksJsonPath(projectRoot) {
  return path.join(projectRoot, '.agents', 'hooks.json');
}

module.exports = {
  buildHookCommand,
  createAntigravityNamedHook,
  readAntigravityHooks,
  resolveGlobalHooksJsonPath,
  resolveProjectHooksJsonPath,
};
