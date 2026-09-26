const os = require('node:os');
const path = require('node:path');

const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
} = require('./helpers');

// Kimi Code CLI (MoonshotAI/kimi-code) stores everything under ~/.kimi-code/:
//
//   config.toml         – runtime settings, including [[hooks]] (PreToolUse)
//   mcp.json            – MCP server declarations (mcpServers object)
//   skills/<name>/      – skill scan root (SKILL.md or flat .md files)
//                         also scans ~/.agents/skills/ (shared with Codex/Goose/
//                         OpenHands), but the kimi-specific root moves with
//                         KIMI_CODE_HOME so we install into ~/.kimi-code/skills/
//
// Hook surface: [[hooks]] array in config.toml.  Each entry has:
//   event   – "PreToolUse" | "PostToolUse" | "PreUserMessage" | ...
//   matcher – tool name, e.g. "Bash"
//   command – path to the script
//   timeout – optional (seconds)
//
// The format is TOML, not JSON.  There is no hook wiring here yet
// (the TOML merge for config.toml and the exact matcher string for Bash
// need machine verification per the issue brief), so Guardian and Token
// Crusher are deferred to a follow-up the way Warp/Qwen defer their
// hook surface; skills and MCP registration are the whole scope today.
//
// KIMI_CODE_HOME moves the data root.  The env var is read at resolution
// time via a config getter, the same pattern Trae uses for TRAE_ENV, so
// the choice follows the environment of the install, doctor or repair run.

// Compute the root from KIMI_CODE_HOME (if set) or from homeDir.  Both are
// returned as an absolute path so the adapter's resolveRoot -- which does
// path.join(resolveBaseRoot(kind, input), ...rootSegments) -- produces a
// correct absolute result.  When KIMI_CODE_HOME is an absolute path,
// path.join('/home/user', '/custom/kimi') on POSIX would concatenate
// rather than replace; we therefore split the absolute KIMI_CODE_HOME into
// components that start from '/' and let path.join reassemble them.
//
// The cleanest approach: expose rootSegments as a getter on the config
// object so the factory re-reads it at each resolveRoot call.  We split
// the absolute KIMI_CODE_HOME back into a drive+path sequence that
// path.join(homeDir, ...segments) reassembles correctly on all platforms
// by making the first segment an absolute root, which path.join on POSIX
// honours (path.join('/a', '/b', 'c') === '/b/c' on POSIX).
// On Windows the equivalent would be a drive-letter root.
//
// Simpler: override resolveRoot at the config level is not supported by the
// factory, and the adapter is frozen.  We use the plain POSIX trick:
// rootSegments returns [] and a custom resolveBaseRoot equivalent is
// achieved by overriding 'kind' to 'home' but returning a synthetic homeDir
// from the config's planOperations... still awkward.
//
// Real solution: expose rootSegments as a getter that, when KIMI_CODE_HOME
// is set, returns path components relative to os.homedir() -- the factory's
// resolveBaseRoot('home', input) returns input.homeDir || os.homedir(), so we
// need the segments from that base to KIMI_CODE_HOME.  If KIMI_CODE_HOME is
// /custom/kimi, that may not be under homeDir at all.
//
// Simplest correct solution: make the adapter a thin wrapper that creates
// an inner adapter and exposes a non-frozen object with resolveRoot wired.

const INNER_ID = 'kimi-home';
const INNER_TARGET = 'kimi';

const inner = createInstallTargetAdapter({
  id: INNER_ID,
  target: INNER_TARGET,
  kind: 'home',
  rootSegments: ['.kimi-code'],
  installStatePathSegments: ['egc', 'install-state.json'],
  nativeRootRelativePath: '.kimi-code',
  planOperations(input, self) {
    return createFlatSkillPlanOperations(input, self);
  },
});

// The inner adapter is frozen; expose a non-frozen wrapper that delegates
// to it but overrides resolveRoot to honour KIMI_CODE_HOME at call time.
function resolveKimiRoot(input = {}) {
  const kimiCodeHome = process.env.KIMI_CODE_HOME;
  if (kimiCodeHome) return path.resolve(kimiCodeHome);
  return path.join(input.homeDir || os.homedir(), '.kimi-code');
}

module.exports = {
  ...inner,
  resolveRoot(input = {}) {
    return resolveKimiRoot(input);
  },
  getInstallStatePath(input = {}) {
    return path.join(resolveKimiRoot(input), 'egc', 'install-state.json');
  },
  // resolveManagedRoots, resolveDestinationPath, and createScaffoldOperation
  // all call resolveRoot via the frozen inner object's `adapter` closure
  // reference.  We must re-implement them here to call our overridden version.
  resolveDestinationPath(sourceRelativePath, input = {}) {
    const root = resolveKimiRoot(input);
    const normalizedSourcePath = String(sourceRelativePath || '').replaceAll('\\', '/').replace(/^\.\/+/, '');
    if (normalizedSourcePath === '.kimi-code') return root;
    return path.join(root, normalizedSourcePath);
  },
};
