const os = require('node:os');
const path = require('node:path');

const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
} = require('./helpers');

// Kimi Code CLI (MoonshotAI/kimi-code) keeps everything under ~/.kimi-code/:
// config.toml for runtime settings, mcp.json for MCP servers in the standard
// {mcpServers: {}} JSON shape, and skills/<name>/ as the skill scan root.
// Skills install flat (the source category is stripped); agents, commands and
// rules land as library folders under the same root. The hook surface (a
// [[hooks]] array in config.toml) is deferred: the TOML merge and the exact
// matcher string for the Guardian and the Token Crusher still need machine
// verification, so this adapter ships skills and MCP registration only, the
// same way Warp and Qwen defer their hooks.
//
// KIMI_CODE_HOME moves the data root. It is read through resolveRoot, which
// createInstallTargetAdapter calls from every method that needs the root
// (resolveRoot, getInstallStatePath, resolveDestinationPath, resolveManagedRoots,
// planOperations and the retirement diff), so the override is honoured at call
// time, the same way trae-project.js re-reads TRAE_ENV. A leading tilde is
// expanded to the home directory so a value like ~/kimi-data is not read as
// relative to the process working directory.
function resolveKimiCodeRoot(input = {}) {
  const configured = process.env.KIMI_CODE_HOME;
  if (configured) {
    if (configured === '~' || configured.startsWith('~/')) {
      return path.join(input.homeDir || os.homedir(), configured.slice(1));
    }
    return path.resolve(configured);
  }
  return path.join(input.homeDir || os.homedir(), '.kimi-code');
}

module.exports = createInstallTargetAdapter({
  id: 'kimi-home',
  target: 'kimi',
  kind: 'home',
  resolveRoot(input = {}) {
    return resolveKimiCodeRoot(input);
  },
  installStatePathSegments: ['egc', 'install-state.json'],
  nativeRootRelativePath: '.kimi-code',
  planOperations: createFlatSkillPlanOperations,
});
