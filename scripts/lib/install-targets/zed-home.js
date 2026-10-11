const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
} = require('./helpers');

function resolveSharedAgentsRoot(input) {
  const home = typeof input === 'string' ? input : input?.homeDir;
  return path.join(home || os.homedir(), '.agents');
}

// Zed reads personal instructions (AGENTS.md) from ~/.config/zed/AGENTS.md
// on Linux and macOS, and from %APPDATA%\Zed\AGENTS.md on Windows
// (https://zed.dev/docs/ai/instructions). %APPDATA% belongs to the account
// running EGC, so it only applies when the install targets that account's
// own home; a sandboxed or redirected home gets AppData\Roaming under itself.
function resolveZedConfigRoot(input = {}, options = {}) {
  const home = typeof input === 'string' ? input : (input?.homeDir || os.homedir());
  const platform = options.platform || (typeof input === 'object' && input?.platform) || process.platform;
  const env = options.env || (typeof input === 'object' && input?.env) || process.env;
  if (platform !== 'win32') {
    return path.join(home, '.config', 'zed');
  }
  const appData = typeof env.APPDATA === 'string' && env.APPDATA.length > 0 ? env.APPDATA : '';
  const resolvedHome = path.resolve(home);
  const ownHome = path.resolve(os.homedir());
  const isOwnHome = resolvedHome.toLowerCase() === ownHome.toLowerCase();
  return path.join(appData && isOwnHome ? appData : path.join(home, 'AppData', 'Roaming'), 'Zed');
}

const baseAdapter = createInstallTargetAdapter({
  id: 'zed-home',
  target: 'zed',
  kind: 'home',
  rootSegments: ['.config', 'zed'],
  installStatePathSegments: ['egc', 'install-state.json'],
  nativeRootRelativePath: '.zed',
  resolveRoot(input = {}) {
    return resolveZedConfigRoot(input);
  },
  resolveManagedRoots(input, adapter) {
    const home = typeof input === 'string' ? input : (input?.homeDir || os.homedir());
    const platform = (typeof input === 'object' && input?.platform) || process.platform;
    const roots = [adapter.resolveRoot(input), resolveSharedAgentsRoot(input)];
    if (platform === 'win32') {
      const legacyRoot = path.join(home, '.config', 'zed');
      if (!roots.includes(legacyRoot)) {
        roots.push(legacyRoot);
      }
    }
    return roots;
  },
  resolveLegacyInstallStatePaths(input, adapter) {
    const home = typeof input === 'string' ? input : (input?.homeDir || os.homedir());
    const platform = (typeof input === 'object' && input?.platform) || process.platform;
    if (platform !== 'win32') return [];
    const legacyStatePath = path.join(home, '.config', 'zed', 'egc', 'install-state.json');
    if (legacyStatePath === adapter.getInstallStatePath(input) || !fs.existsSync(legacyStatePath)) {
      return [];
    }
    return [legacyStatePath];
  },
  planOperations(input, adapter) {
    return createFlatSkillPlanOperations(input, adapter, {
      skillsDir: planningInput => path.join(resolveSharedAgentsRoot(planningInput), 'skills'),
    });
  },
});

module.exports = Object.freeze({
  ...baseAdapter,
  resolveZedConfigRoot,
});
