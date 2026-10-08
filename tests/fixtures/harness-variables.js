'use strict';

/**
 * The environment variables that pin the EGC directory to one tool: the
 * harness variables getEGCDir() reads first (scripts/lib/utils.js,
 * resolveHarnessDirFromEnv), the explicit EGC_DIR override, and the explicit
 * roots the EGC root resolver reads first (scripts/lib/resolve-egc-root.js).
 * A test about where a file lands for a given home clears them, so the home
 * alone decides, whatever session the suite runs inside; tests/run-all.js
 * clears them for every test file.
 */

const HARNESS_VARIABLES = Object.freeze([
  'EGC_DIR',
  'EGC_PLUGIN_ROOT',
  'ECC_PLUGIN_ROOT',
  'GEMINI_PROJECT_DIR',
  'GEMINI_PLUGIN_ROOT',
  'CLAUDECODE',
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_PLUGIN_ROOT',
  'CODEBUDDY_PROJECT_DIR',
  'CODEBUDDY_PLUGIN_ROOT',
  'VSCODE_AGENT',
  'GITHUB_COPILOT_API_TOKEN',
  'KIRO_HOOK_FILE',
  'KIRO_FILE_PATH',
  'TRAE_ENV',
]);

// The variables that move a tool's config directory out of the home a test
// passes: Crush reads CRUSH_GLOBAL_CONFIG, then XDG_CONFIG_HOME, before the
// home (scripts/lib/install-targets/crush-home.js). CI runners on Linux
// export XDG_CONFIG_HOME, so a test that installs into a temporary home
// would otherwise write into the runner's real config directory, and every
// later test would find the tool there. tests/run-all.js clears them too.
const CONFIG_HOME_VARIABLES = Object.freeze([
  'CRUSH_GLOBAL_CONFIG',
  'XDG_CONFIG_HOME',
]);

function without(names, env) {
  const copy = { ...env };
  for (const name of names) delete copy[name];
  return copy;
}

function runWithout(names, fn) {
  const saved = new Map(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    return fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

// A copy of `env` without the harness variables, for a subprocess.
function withoutHarnessVariables(env) {
  return without(HARNESS_VARIABLES, env);
}

// Runs `fn` with the harness variables removed from process.env, then puts
// back exactly what was there.
function runWithoutHarnessVariables(fn) {
  return runWithout(HARNESS_VARIABLES, fn);
}

// A copy of `env` without the config-home variables, for a subprocess.
function withoutConfigHomeVariables(env) {
  return without(CONFIG_HOME_VARIABLES, env);
}

// Runs `fn` with the config-home variables removed from process.env, then
// puts back exactly what was there.
function runWithoutConfigHomeVariables(fn) {
  return runWithout(CONFIG_HOME_VARIABLES, fn);
}

module.exports = {
  HARNESS_VARIABLES,
  CONFIG_HOME_VARIABLES,
  withoutHarnessVariables,
  runWithoutHarnessVariables,
  withoutConfigHomeVariables,
  runWithoutConfigHomeVariables,
};
