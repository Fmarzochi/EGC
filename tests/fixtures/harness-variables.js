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

// A copy of `env` without the harness variables, for a subprocess.
function withoutHarnessVariables(env) {
  const copy = { ...env };
  for (const name of HARNESS_VARIABLES) delete copy[name];
  return copy;
}

// Runs `fn` with the harness variables removed from process.env, then puts
// back exactly what was there.
function runWithoutHarnessVariables(fn) {
  const saved = new Map(HARNESS_VARIABLES.map(name => [name, process.env[name]]));
  try {
    for (const name of HARNESS_VARIABLES) delete process.env[name];
    return fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

module.exports = { HARNESS_VARIABLES, withoutHarnessVariables, runWithoutHarnessVariables };
