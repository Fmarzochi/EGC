'use strict';

// PreToolUse rewrite for the Token Crusher: routes crushable commands through
// `egc run` so noisy output is compressed before it reaches the model. Fail-open
// everywhere: no engine, no egc CLI, complex shell syntax or an already-wrapped
// command all pass through untouched. Disable with
// EGC_DISABLED_HOOKS=pre:bash:crusher-rewrite.

const { spawnSync } = require('node:child_process');

function tryRequire(modulePath) {
  try {
    return require(modulePath);
  } catch {
    return null;
  }
}

// Repo layout first, flattened install layout second.
const engine = tryRequire('../lib/crusher/engine') || tryRequire('../lib/crusher-engine');

// EGC_CRUSHER_SKIP_PREFIXES lists extra command prefixes (comma-separated)
// that mean the command is already handled by another local CLI proxy.
function wrappedRe() {
  const extra = (process.env.EGC_CRUSHER_SKIP_PREFIXES || '')
    .split(',')
    .map(p => p.trim())
    .filter(p => /^[\w.-]+$/.test(p));
  const prefixes = ['egc', ...extra].join('|');
  return new RegExp(`(?:^\\s*(?:${prefixes})\\s)|(?:--raw\\b)`);
}
// Wrapping changes semantics for pipelines, chaining, redirection, substitution
// and multi-line commands, so those never get rewritten.
const COMPLEX_SHELL_RE = /[|&;<>$`()\n]/;

let egcAvailable = null;
function hasEgcCli() {
  if (process.env.EGC_ASSUME_EGC_CLI === '1') return true;
  if (process.env.EGC_ASSUME_EGC_CLI === '0') return false;
  if (egcAvailable === null) {
    const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['egc'], { encoding: 'utf8' });
    egcAvailable = probe.status === 0;
  }
  return egcAvailable;
}

function run(rawInput) {
  try {
    const input = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
    const cmd = input.tool_input?.command || '';

    if (
      !engine
      || !cmd
      || wrappedRe().test(cmd)
      || COMPLEX_SHELL_RE.test(cmd)
      || engine.commandKind(cmd) === 'generic'
      || !hasEgcCli()
    ) {
      return JSON.stringify(input);
    }

    return JSON.stringify({
      ...input,
      tool_input: {
        ...input.tool_input,
        command: `egc run ${cmd}`,
      },
    });
  } catch {
    return typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput);
  }
}

module.exports = { run };
