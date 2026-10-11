'use strict';

const os = require('node:os');
const path = require('node:path');

const { createInstallTargetAdapter } = require('./helpers');
const { planVibeOperations } = require('../vibe-operations');

// Mistral Vibe (mistralai/mistral-vibe, README of v2.26.1 and the hooks and
// skills pages of docs.mistral.ai/vibe/code/cli, read on 2026-10-10) keeps
// everything under ~/.vibe/: config.toml, hooks.toml, skills/<name>/SKILL.md,
// agents/ (its own TOML profiles), prompts/ (whole system prompts) and
// AGENTS.md, the user-level instructions file the cognitive bootstrap fills.
// VIBE_HOME moves that root; it is read through resolveRoot, which
// createInstallTargetAdapter calls from every method that needs the root,
// so the override is honoured at call time, the way kimi-home.js reads
// KIMI_CODE_HOME. A leading tilde is expanded to the home directory.
//
// Skills install flat under skills/ (Vibe also reads ~/.agents/skills, but
// .vibe is its own canonical location, the same reasoning as Auggie).
// Agents, commands and rules have no markdown equivalent there (agents/
// holds TOML profiles, prompts/ replaces the whole system prompt), so they
// land as library folders under egc/library/ in the root, where nothing of
// Vibe's looks. The root AGENTS.md installs as <root>/AGENTS.md, the
// user-level instructions file, and the cognitive bootstrap keeps the
// memory protocol in it. hooks.toml takes [[hooks]] entries of type
// pre_tool with a tool-name matcher: the Guardian denies through
// vibe-guardian-adapter.js and the Token Crusher rewrites the command
// through vibe-crusher-adapter.js (scripts/lib/vibe-hooks-toml.js). The MCP
// servers are registered by egc init, not by the install, as [[mcp_servers]]
// tables in config.toml (scripts/lib/mcp-register.js).
function resolveVibeHome(input = {}) {
  const home = typeof input === 'string' ? input : (input?.homeDir || os.homedir());
  const configured = process.env.VIBE_HOME;
  if (configured) {
    if (configured === '~' || configured.startsWith('~/')) {
      return path.join(home, configured.slice(1));
    }
    return path.resolve(configured);
  }
  return path.join(home, '.vibe');
}

const baseAdapter = createInstallTargetAdapter({
  id: 'vibe-home',
  target: 'vibe',
  kind: 'home',
  resolveRoot(input = {}) {
    return resolveVibeHome(input);
  },
  installStatePathSegments: ['egc', 'install-state.json'],
  nativeRootRelativePath: '.vibe',
  planOperations: planVibeOperations,
});

module.exports = Object.freeze({ ...baseAdapter, resolveVibeHome });
