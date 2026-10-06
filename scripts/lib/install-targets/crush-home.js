'use strict';

const os = require('node:os');
const path = require('node:path');

const {
  createInstallTargetAdapter,
  createRemappedOperation,
  isForeignPlatformPath,
  planFlatSkillOperation,
  resolveModulesPlan,
} = require('./helpers');
const {
  createCrusherScriptCopyOperations,
} = require('../claude-settings-hooks');
const {
  createCrushCrusherHookMergeOperation,
  createCrushGuardianHookMergeOperation,
  createCrushGuardianScriptCopyOperations,
} = require('../crush-settings-hooks');

/**
 * Resolves the configuration directory for Charmbracelet Crush, the way
 * Crush's own GlobalConfig() does (internal/config/load.go): the
 * CRUSH_GLOBAL_CONFIG directory (always a directory, whatever its name),
 * then $XDG_CONFIG_HOME/crush, then ~/.config/crush on every platform,
 * Windows included. %LOCALAPPDATA%\crush only holds Crush's data config,
 * and CRUSH.md is read next to crush.json alone. A relative XDG_CONFIG_HOME
 * is invalid under the XDG spec and falls back to the home default.
 * @param {string|{homeDir?: string}} [input]
 * @returns {string}
 */
function resolveCrushConfigDir(input = {}) {
  const home = typeof input === 'string' ? input : (input?.homeDir || os.homedir());
  if (process.env.CRUSH_GLOBAL_CONFIG) {
    // Crush opens a relative override from its working directory, so it is
    // resolved against the current one, never against the home.
    return path.resolve(process.env.CRUSH_GLOBAL_CONFIG);
  }
  if (process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME)) {
    return path.join(process.env.XDG_CONFIG_HOME, 'crush');
  }
  return path.join(home, '.config', 'crush');
}

/**
 * Resolves the crush.json configuration file path for Charmbracelet Crush.
 * @param {string|{homeDir?: string}} [input]
 * @returns {string}
 */
function resolveCrushConfigPath(input = {}) {
  return path.join(resolveCrushConfigDir(input), 'crush.json');
}

/**
 * Creates file copy and hook merge operations for Crush installation.
 * @param {object} adapter
 * @param {string} targetRoot
 * @returns {Array<object>}
 */
function createCrushOperations(adapter, targetRoot) {
  const remap = (moduleId, sourceRelativePath, destinationPath, options) => (
    createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
  );

  return [
    ...createCrushGuardianScriptCopyOperations(remap, targetRoot),
    ...createCrusherScriptCopyOperations(remap, targetRoot),
    createCrushGuardianHookMergeOperation(targetRoot),
    createCrushCrusherHookMergeOperation(targetRoot),
  ];
}

const baseAdapter = createInstallTargetAdapter({
  id: 'crush-home',
  target: 'crush',
  kind: 'home',
  rootSegments: ['.config', 'crush'],
  installStatePathSegments: ['egc', 'crush-install-state.json'],
  nativeRootRelativePath: '.config/crush',
  /**
   * The Crush config directory, where crush.json, CRUSH.md, agents,
   * commands, rules and the hook scripts land.
   * @param {string|{homeDir?: string}} [input]
   * @returns {string}
   */
  resolveRoot(input = {}) {
    return resolveCrushConfigDir(input);
  },
  /**
   * The roots uninstall and retirement may touch: the config directory and
   * the ~/.agents root whose skills Crush shares with Codex, Goose and
   * OpenHands. Detection keys on the config directory alone.
   * @param {string|{homeDir?: string}} input
   * @param {object} adapter
   * @returns {string[]}
   */
  resolveManagedRoots(input, adapter) {
    const home = typeof input === 'string' ? input : (input?.homeDir || os.homedir());
    return [adapter.resolveRoot(input), path.join(home, '.agents')];
  },
  /**
   * Skills go flat into ~/.agents/skills; everything else lands under the
   * config directory, followed by the Guardian and Crusher hook operations.
   * @param {object} input
   * @param {object} adapter
   * @returns {Array<object>}
   */
  planOperations(input, adapter) {
    const { modules, planningInput, targetRoot } = resolveModulesPlan(input, adapter);
    const sharedAgentsRoot = path.join(planningInput.homeDir || os.homedir(), '.agents');

    const moduleOperations = modules.flatMap(module => {
      const paths = (Array.isArray(module.paths) ? module.paths : [])
        .filter(p => !isForeignPlatformPath(p, adapter.target));
      return paths.map(sourceRelativePath => planFlatSkillOperation(
        adapter,
        module.id,
        sourceRelativePath,
        planningInput,
        targetRoot,
        path.join(sharedAgentsRoot, 'skills')
      ));
    });

    return [
      ...moduleOperations,
      ...createCrushOperations(adapter, targetRoot),
    ];
  },
});

const adapter = Object.freeze({
  ...baseAdapter,
  resolveCrushConfigDir,
  resolveCrushConfigPath,
});

module.exports = adapter;

