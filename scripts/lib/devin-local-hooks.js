'use strict';

// Devin Local, the agent in Devin Desktop and the Devin CLI since Cascade was
// removed on 2026-09-08, reads lifecycle hooks in the Claude Code settings
// shape: {"hooks": {"PreToolUse": [{"matcher", "hooks": [{"type", "command"}]}]}}
// (docs.devin.ai/cli/extensibility/hooks). The user level is
// ~/.config/devin/config.json on Linux and macOS and %APPDATA%\devin\config.json
// on Windows; the project level used here is .devin/config.local.json, the
// local override that keeps this machine's absolute script paths out of the
// committed .devin/config.json. The matchers are regexes over tool_name and
// follow `devin migrate hooks`, which turns pre_run_command into ^exec$ and
// pre_write_code into ^(edit|write|notebook_edit)$; multi_edit and
// apply_patch are the vendor's other file-writing tools.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEVIN_GUARDIAN_MATCHER = '^exec$';
const DEVIN_GATEGUARD_MATCHER = '^(exec|edit|write|notebook_edit|multi_edit|apply_patch)$';

// %APPDATA% belongs to the account running EGC, so it only applies when the
// install targets that account's own home; a sandboxed or redirected home
// gets the default layout under itself and never writes into the real one.
function resolveDevinUserConfigRoot(homeDir, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const home = homeDir || os.homedir();
  if (platform !== 'win32') {
    return path.join(home, '.config', 'devin');
  }
  const appData = typeof env.APPDATA === 'string' && env.APPDATA.length > 0 ? env.APPDATA : '';
  const isOwnHome = path.resolve(home) === path.resolve(os.homedir());
  return path.join(appData && isOwnHome ? appData : path.join(home, 'AppData', 'Roaming'), 'devin');
}

function resolveDevinUserConfigPath(homeDir, options = {}) {
  return path.join(resolveDevinUserConfigRoot(homeDir, options), 'config.json');
}

function resolveDevinProjectConfigPath(projectRoot) {
  return path.join(projectRoot, '.devin', 'config.local.json');
}

// Devin reads its config as JSONC, and EGC writes plain JSON: a file with
// comments would lose them, so anything but a plain JSON object is refused
// before the install changes anything. Returns the reason, or null.
function describeUnwritableDevinConfig(configPath) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    return error.code === 'ENOENT' ? null : `Devin Local's config at ${configPath} cannot be read: ${error.message}`;
  }
  if (!raw.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return null;
    }
  } catch {
    // Reported below with the rest of the non-JSON cases.
  }
  return `Devin Local's config at ${configPath} is not a plain JSON object (Devin allows comments in it). `
    + 'EGC does not rewrite it, since the comments would be lost: remove them, or add the EGC PreToolUse hooks there by hand, then run the install again.';
}

// The validation issue for a Devin config EGC cannot rewrite, if any.
function devinConfigIssues(configPath, buildValidationIssue) {
  const reason = describeUnwritableDevinConfig(configPath);
  return reason ? [buildValidationIssue('error', 'devin-config-not-json', reason)] : [];
}

module.exports = {
  DEVIN_GATEGUARD_MATCHER,
  DEVIN_GUARDIAN_MATCHER,
  devinConfigIssues,
  resolveDevinProjectConfigPath,
  resolveDevinUserConfigPath,
  resolveDevinUserConfigRoot,
};
