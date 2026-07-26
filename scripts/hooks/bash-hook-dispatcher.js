#!/usr/bin/env node
'use strict';

const { isHookEnabled } = require('../lib/hook-flags');
const { trace } = require('../lib/utils');
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

const MAX_STDIN = 1024 * 1024;

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

function readStdinRaw() {
  return new Promise(resolve => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      if (raw.length < MAX_STDIN) {
        const remaining = MAX_STDIN - raw.length;
        raw += chunk.substring(0, remaining);
      }
    });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', () => resolve(raw));
  });
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

function runHooks(rawInput, hooks) {
  let currentRaw = rawInput;
  let stderr = '';

  for (const hook of hooks) {
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
        continue;
      }

      trace('hook:dispatch:running', { id: hook.id });
      const result = normalizeHookResult(currentRaw, hook.run(currentRaw));
      currentRaw = result.raw;
      if (result.stderr) {
        stderr += result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`;
      }
      if (result.exitCode !== 0) {
        trace('hook:dispatch:failed', { id: hook.id, exitCode: result.exitCode });
        return { output: currentRaw, stderr, exitCode: result.exitCode };
      }
      trace('hook:dispatch:success', { id: hook.id });
    } catch (error) {
      trace('hook:dispatch:error', { id: hook.id, error: error.message });
      stderr += `[Hook] ${hook.id} failed: ${error.message}\n`;
      return { output: currentRaw, stderr, exitCode: 1 };
    }
  }

  return { output: currentRaw, stderr, exitCode: 0 };
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
  const raw = await readStdinRaw();

  const result = mode === 'post'
    ? runPostBash(raw)
    : runPreBash(raw);

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  const output = mode === 'post' ? result.output : resolvePreOutput(raw, result);
  process.stdout.write(output);
  process.exit(result.exitCode);
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
    process.exit(0);
  });
}

module.exports = {
  PRE_BASH_HOOKS,
  POST_BASH_HOOKS,
  runPreBash,
  runPostBash,
  toPreToolUseOutput,
  denyEnvelope,
  resolvePreOutput,
  failClosedOutput,
};
