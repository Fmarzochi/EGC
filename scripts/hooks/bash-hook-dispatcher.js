#!/usr/bin/env node
'use strict';

const { isHookEnabled } = require('../lib/hook-flags');
const { trace } = require('../lib/utils');
const { readHookInput } = require('../lib/guardian-bin');
const { toPreToolUseOutput } = require('./pretooluse-output');

const { run: runGuardianValidate } = require('./pre-bash-guardian-validate');
const { run: runBlockNoVerify } = require('./block-no-verify');
const { run: runAutoTmuxDev } = require('./auto-tmux-dev');
const { run: runTmuxReminder } = require('./pre-bash-tmux-reminder');
const { run: runGitPushReminder } = require('./pre-bash-git-push-reminder');
const { run: runCommitQuality } = require('./pre-bash-commit-quality');
const { run: runVerificationGate } = require('./pre-bash-verification-gate');
const { run: runGateGuard } = require('./gateguard-fact-force');
const { run: runCrusherRewrite } = require('./pre-bash-crusher-rewrite');
const { run: runBudgetCheck } = require('./pre-budget-check');
const { run: runCommandLog } = require('./post-bash-command-log');
const { run: runPrCreated } = require('./post-bash-pr-created');
const { run: runBuildComplete } = require('./post-bash-build-complete');

const PRE_BASH_HOOKS = [
  {
    id: 'pre:bash:guardian-validate',
    profiles: 'minimal,standard,strict',
    run: rawInput => runGuardianValidate(rawInput),
  },
  {
    id: 'pre:bash:block-no-verify',
    profiles: 'minimal,standard,strict',
    run: rawInput => runBlockNoVerify(rawInput),
  },
  {
    id: 'pre:bash:auto-tmux-dev',
    run: rawInput => runAutoTmuxDev(rawInput),
  },
  {
    id: 'pre:bash:tmux-reminder',
    profiles: 'strict',
    run: rawInput => runTmuxReminder(rawInput),
  },
  {
    id: 'pre:bash:git-push-reminder',
    profiles: 'strict',
    run: rawInput => runGitPushReminder(rawInput),
  },
  {
    id: 'pre:bash:commit-quality',
    profiles: 'strict',
    run: rawInput => runCommitQuality(rawInput),
  },
  {
    id: 'pre:bash:verification-gate',
    profiles: 'standard,strict',
    run: rawInput => runVerificationGate(rawInput),
  },
  {
    id: 'pre:bash:gateguard-fact-force',
    profiles: 'standard,strict',
    run: rawInput => runGateGuard(rawInput),
  },
  {
    id: 'pre:bash:crusher-rewrite',
    profiles: 'standard,strict',
    run: rawInput => runCrusherRewrite(rawInput),
  },
  {
    id: 'pre:bash:budget-check',
    profiles: 'minimal,standard,strict',
    run: rawInput => runBudgetCheck(rawInput),
  },
];

const POST_BASH_HOOKS = [
  {
    id: 'post:bash:command-log-audit',
    run: rawInput => runCommandLog(rawInput, 'audit'),
  },
  {
    id: 'post:bash:command-log-cost',
    run: rawInput => runCommandLog(rawInput, 'cost'),
  },
  {
    id: 'post:bash:pr-created',
    profiles: 'standard,strict',
    run: rawInput => runPrCreated(rawInput),
  },
  {
    id: 'post:bash:build-complete',
    profiles: 'standard,strict',
    run: rawInput => runBuildComplete(rawInput),
  },
];

// The hook input, at most the size the guards read, and whether any was cut.
function readStdinRaw() {
  return new Promise(resolve => readHookInput(resolve));
}

// The pre-mode answer to an input cut at the size the guards read: it is not the command
// that runs, since what was cut could hold the rest of it, so the guards
// are not run on its start.
function overLimitOutput() {
  return denyEnvelope('the hook input is larger than the 1 MiB the guards read, so the command was not validated; split it into smaller commands');
}

function normalizeHookResult(previousRaw, output) {
  if (typeof output === 'string' || Buffer.isBuffer(output)) {
    return {
      raw: String(output),
      stderr: '',
      exitCode: 0,
    };
  }

  if (output && typeof output === 'object') {
    let nextRaw;
    if (Object.hasOwn(output, 'stdout')) {
      nextRaw = String(output.stdout ?? '');
    } else if (!Number.isInteger(output.exitCode) || output.exitCode === 0) {
      nextRaw = previousRaw;
    } else {
      nextRaw = '';
    }

    return {
      raw: nextRaw,
      stderr: typeof output.stderr === 'string' ? output.stderr : '',
      exitCode: Number.isInteger(output.exitCode) ? output.exitCode : 0,
    };
  }

  return {
    raw: previousRaw,
    stderr: '',
    exitCode: 0,
  };
}

// The hooks run one after the other, each consuming the output the one
// before produced, so they cannot run concurrently. A hook may answer with
// a promise: it is awaited, so a deny it resolves to is a deny, never an
// allow read off a pending object.
function runHooks(rawInput, hooks) {
  const start = { output: rawInput, stderr: '', exitCode: 0, done: false };
  return hooks
    .reduce((chain, hook) => chain.then(state => (state.done ? state : runHook(state, hook))), Promise.resolve(start))
    .then(({ output, stderr, exitCode }) => ({ output, stderr, exitCode }));
}

function appendStderr(stderr, addition) {
  if (!addition) return stderr;
  return stderr + (addition.endsWith('\n') ? addition : `${addition}\n`);
}

async function runHook(state, hook) {
  try {
    // A failure while reading hook flags must never silently skip a
    // security hook: treat an unreadable flag as enabled so the guard runs.
    let enabled = true;
    try {
      enabled = isHookEnabled(hook.id, { profiles: hook.profiles });
    } catch (flagError) {
      trace('hook:dispatch:flag-error', { id: hook.id, error: flagError.message });
    }
    if (!enabled) {
      trace('hook:dispatch:skipped', { id: hook.id });
      return state;
    }

    trace('hook:dispatch:running', { id: hook.id });
    const result = normalizeHookResult(state.output, await hook.run(state.output));
    const stderr = appendStderr(state.stderr, result.stderr);
    if (result.exitCode !== 0) {
      trace('hook:dispatch:failed', { id: hook.id, exitCode: result.exitCode });
      return { output: result.raw, stderr, exitCode: result.exitCode, done: true };
    }
    trace('hook:dispatch:success', { id: hook.id });
    return { output: result.raw, stderr, exitCode: 0, done: false };
  } catch (error) {
    trace('hook:dispatch:error', { id: hook.id, error: error.message });
    return { output: state.output, stderr: `${state.stderr}[Hook] ${hook.id} failed: ${error.message}\n`, exitCode: 1, done: true };
  }
}

function runPreBash(rawInput) {
  return runHooks(rawInput, PRE_BASH_HOOKS);
}

function runPostBash(rawInput) {
  return runHooks(rawInput, POST_BASH_HOOKS);
}

function denyEnvelope(reason) {
  // PreToolUse deny envelope honored by Claude Code, Codex and CodeBuddy: the
  // host blocks the command when this JSON is on stdout AND the process exits 0
  // (a non-zero exit without valid JSON reads as a crashed hook and falls back
  // to the host default, which can allow).
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `[EGC] Blocked for safety: ${reason}`,
    },
  });
}

// Formats the pre-mode stdout for a chain result while preserving the chain's
// decision: if envelope formatting itself throws, a deny stays a deny and an
// allow still passes the command through unchanged.
function resolvePreOutput(raw, result) {
  try {
    return toPreToolUseOutput(raw, result.output);
  } catch (formatError) {
    process.stderr.write(`[Hook] output formatting failed: ${formatError.message}\n`);
    return result.exitCode !== 0
      ? denyEnvelope('a security hook denied the command but its response could not be formatted')
      : result.output;
  }
}

// The stdout a dispatcher emits when its own infrastructure crashes before the
// chain can decide. Pre mode gates security, so it fails closed (deny); post
// mode is observational and fails open (emit nothing).
function failClosedOutput(mode) {
  return mode === 'post'
    ? ''
    : denyEnvelope('the security dispatcher crashed before the guards could run');
}

async function main() {
  const mode = process.argv[2];
  const { raw, truncated } = await readStdinRaw();
  // The exit code is set, not forced, so what was written reaches the host
  // before the process ends, whatever the pipe.
  if (truncated && mode !== 'post') {
    process.stdout.write(overLimitOutput());
    process.exitCode = 0;
    return;
  }

  const result = mode === 'post'
    ? await runPostBash(raw)
    : await runPreBash(raw);

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  const output = mode === 'post' ? result.output : resolvePreOutput(raw, result);
  process.stdout.write(output);
  process.exitCode = result.exitCode;
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`[Hook] bash-hook-dispatcher failed: ${error.message}\n`);
    // Pre mode gates security: a dispatcher-infrastructure crash before the
    // guards run must fail closed (deny), never silently allow. Post mode is
    // observational, so a crash there is safe to swallow.
    const out = failClosedOutput(process.argv[2]);
    if (out) {
      process.stdout.write(out);
    }
    process.exitCode = 0;
  });
}

module.exports = {
  PRE_BASH_HOOKS,
  POST_BASH_HOOKS,
  runHooks,
  runPreBash,
  runPostBash,
  toPreToolUseOutput,
  denyEnvelope,
  resolvePreOutput,
  failClosedOutput,
  overLimitOutput,
};
