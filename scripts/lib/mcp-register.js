'use strict';

/**
 * MCP server registration for `egc init`.
 *
 * Extracted from scripts/init.js so the registration logic (which tool
 * configs get egc-guardian / egc-memory written into) can be unit tested
 * without running the full init CLI, which executes top-to-bottom on
 * require() and has no exports of its own.
 *
 * scripts/init.js remains the only caller in production; it supplies the
 * real HOME dir, real bin paths, and wires the callbacks to its own
 * colorized console output. Tests supply a temp dir and inert bin paths
 * instead.
 */
const { resolveCrushConfigDir, resolveCrushConfigPath } = require('./install-targets/crush-home');
const { assertLandsInside } = require('./mcp-register-config-io');
const { findInlineMcpServersArray } = require('./mcp-register-toml-text');
const { registerToml } = require('./mcp-register-toml');
const { quoteForCmdShell, registerClaudeCli } = require('./mcp-register-claude-cli');
const {
  parseJsonObject,
  registerAmpSettings,
  registerCrushMcp,
  registerJson,
  registerOpenCodeMcp,
  registerZedContextServers,
} = require('./mcp-register-json-writers');
const { registerGooseYaml } = require('./mcp-register-yaml');
const {
  buildMcpRegistrationTargets,
  kiloConfigDir,
  openCodeConfigDir,
  openCodeConfigPath,
  registerOpenCodeInstructions,
} = require('./mcp-register-targets');

const FORMAT_HANDLERS = {
  'json': registerJson,
  'toml': registerToml,
  'zed-context-servers': registerZedContextServers,
  'opencode-mcp': registerOpenCodeMcp,
  'claude-cli': registerClaudeCli,
  'crush-mcp': registerCrushMcp,
  'goose-yaml': registerGooseYaml,
  'amp-settings': registerAmpSettings,
};

function registerTarget(target, bins, roots, onRegister, onWarn, onUnchanged) {
  const handler = FORMAT_HANDLERS[target.format];
  if (!handler) return;
  try {
    // The Claude Code CLI writes its own file; every other handler writes here.
    if (target.format !== 'claude-cli') assertLandsInside(target.path, target.allowedRoot ? [...roots, target.allowedRoot] : roots);
    const registered = handler(target.path, bins, target);
    if (registered) {
      if (onRegister) onRegister(target);
    } else if (onUnchanged) {
      onUnchanged(target);
    }
  } catch (err) {
    if (onWarn) onWarn(target, err);
  }
}

/**
 * Walks every gated target for homeDir and registers egc-guardian /
 * egc-memory into whichever tools are actually installed. Callbacks let the
 * caller (scripts/init.js) drive its own console output without this module
 * needing to know about colors or dry-run formatting: onRegister when a
 * target was written, onUnchanged when both servers were already there,
 * onWarn when the target could not be updated, onSkip on a dry run.
 */
function registerMcpServers(homeDir, bins, callbacks = {}) {
  const { dryRun = false, onSkip, onRegister, onWarn, onUnchanged } = callbacks;
  const targets = buildMcpRegistrationTargets(homeDir);
  const roots = [homeDir, process.env.XDG_CONFIG_HOME].filter(Boolean);

  for (const target of targets) {
    if (!target.gate()) continue;
    if (dryRun) {
      if (onSkip) onSkip(target);
      continue;
    }
    registerTarget(target, bins, roots, onRegister, onWarn, onUnchanged);
  }

  return targets;
}

module.exports = {
  assertLandsInside,
  buildMcpRegistrationTargets,
  findInlineMcpServersArray,
  parseJsonObject,
  registerJson,
  registerToml,
  registerZedContextServers,
  registerOpenCodeMcp,
  kiloConfigDir,
  openCodeConfigDir,
  openCodeConfigPath,
  registerOpenCodeInstructions,
  registerClaudeCli,
  registerCrushMcp,
  registerGooseYaml,
  registerAmpSettings,
  resolveCrushConfigDir,
  resolveCrushConfigPath,
  quoteForCmdShell,
  registerMcpServers,
};
