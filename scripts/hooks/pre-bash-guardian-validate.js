#!/usr/bin/env node
/**
 * Guardian Command Enforcement Hook
 *
 * Validates every Bash command with the egc-guardian validator before it
 * executes. Compound commands are split into segments so destructive
 * commands cannot hide behind chaining or wrappers like sudo.
 *
 * Blocking policy: only hard denials block (destructive commands,
 * protected paths, forbidden git flags). Allowlist misses and shell
 * metacharacter denials are advisory and never block, otherwise any
 * command outside the guardian allowlist would break the session.
 *
 * Without a validator installed the command is allowed, so a machine
 * without the build is never locked out. A validator that is installed but
 * gives no verdict (it stalls, stops, or answers something unreadable)
 * blocks the command, and the message says why and what to do. The
 * validator gets four seconds, or EGC_GUARDIAN_TIMEOUT_MS milliseconds when
 * that is set, so a slow machine raises the budget instead of the gate.
 *
 * Exit codes:
 *   0 = allow
 *   2 = block
 */

'use strict';

const { resolveGuardianCli, callGuardianVerdict, guardianFailureReason, readHookInput } = require('../lib/guardian-bin');
const { withGitBudget, gitIn } = require('./pre-bash-guardian-script-files');
const { bindingsOfSegments, resolveCommandWords, secondReadings, lineBoundOf, scriptSegmentsOf, commandContext } = require('./pre-bash-guardian-script-walk');
const { extractSegments, ProgramUnreadable } = require('./pre-bash-guardian-segmentation');

// An input cut at the size the hook reads is not the command that runs: what was cut could
// hold the rest of it, so it is refused rather than judged by its start.
const OVER_LIMIT = 'EGC Guardian BLOCKED this command: the hook input is larger than the 1 MiB this validator reads, so the command was not validated. Split it into smaller commands.';
const DEFAULT_VALIDATE_TIMEOUT_MS = 4000;

// The budget the validator gets, in milliseconds: EGC_GUARDIAN_TIMEOUT_MS
// when it is a positive whole number, the default otherwise.
function validateTimeoutMs() {
  const budget = Number(process.env.EGC_GUARDIAN_TIMEOUT_MS);
  return Number.isInteger(budget) && budget > 0 ? budget : DEFAULT_VALIDATE_TIMEOUT_MS;
}
const VALIDATE_TIMEOUT_MS = validateTimeoutMs();

const ADVISORY_REASONS = [
  'Shell chaining/metacharacters are forbidden',
  'is not in the allowlist',
];

function parseInput(inputOrRaw) {
  if (typeof inputOrRaw === 'string') {
    try {
      return inputOrRaw.trim() ? JSON.parse(inputOrRaw) : {};
    } catch {
      return {};
    }
  }
  return inputOrRaw && typeof inputOrRaw === 'object' ? inputOrRaw : {};
}

// A validator that knows the field says so itself; the marker scan only
// serves a verdict from an older build, which has no such field.
function isAdvisory(verdict) {
  if (typeof verdict.advisory === 'boolean') return verdict.advisory;
  const reason = String(verdict.reason || '');
  return ADVISORY_REASONS.some(marker => reason.includes(marker));
}

// The first verdict that denies for a hard reason, as the hook's answer.
function firstHardBlock(verdicts, segments) {
  for (let i = 0; i < verdicts.length; i++) {
    const verdict = verdicts[i] || {};
    if (verdict.allowed === false && !isAdvisory(verdict)) {
      return {
        exitCode: 2,
        stderr:
          `EGC Guardian BLOCKED this command: ${verdict.reason || 'denied by policy'} ` +
          `(segment: ${segments[i]}). Adjust the command to comply with the project safety rules.`,
      };
    }
  }
  return null;
}

// The hook's answer when an installed validator gave no verdict: the
// command does not run, and the one line says what happened, that nothing
// ran, and what to do. A validator that is not installed at all is the
// other case, handled in run(), so a machine without the build stays
// usable.
// A verdict says whether its segment is allowed; anything else in the list
// is no answer for that segment.
function isVerdict(entry) {
  return entry !== null && typeof entry === 'object' && typeof entry.allowed === 'boolean';
}

function withoutVerdict(failure) {
  return {
    exitCode: 2,
    stderr: `EGC Guardian could not validate this command, so it did not run: ${guardianFailureReason(failure, VALIDATE_TIMEOUT_MS)}. Nothing was executed. Run the command again; on a slow machine, set EGC_GUARDIAN_TIMEOUT_MS to a larger budget in milliseconds (${VALIDATE_TIMEOUT_MS} now). If this keeps happening, run 'egc doctor' to check the Guardian build, and set EGC_DISABLED_HOOKS=pre:bash:guardian-validate to lift this gate while you repair it.`,
  };
}

// `options.truncated`: the input was cut at the size the caller reads, as
// run-with-flags reports it.
function run(inputOrRaw, options = {}) {
  if (options.truncated) return { exitCode: 2, stderr: OVER_LIMIT };
  try {
    return withGitBudget(() => judgeCommand(inputOrRaw));
  } catch (error) {
    if (error instanceof ProgramUnreadable) return { exitCode: 2, stderr: `EGC Guardian BLOCKED this command: ${error.message}.` };
    throw error;
  }
}

function judgeCommand(inputOrRaw) {
  const input = parseInput(inputOrRaw);
  const command = input?.tool_input?.command;
  if (!command || typeof command !== 'string') return { exitCode: 0 };

  const extracted = extractSegments(command);
  if (extracted === null) {
    return {
      exitCode: 2,
      stderr:
        'EGC Guardian BLOCKED this command: nested command/process substitutions ' +
        'go deeper than this validator can safely unwrap and analyze. Simplify the ' +
        'command so every substitution can be validated.',
    };
  }
  if (extracted.length === 0) return { exitCode: 0 };

  // A command word that comes from an expansion is judged by every value it
  // can take (X=rm; $X -rf / -> rm -rf /; an empty $X hands the command to
  // the next word), and fails closed when that value cannot be read.
  const bindings = bindingsOfSegments(extracted);
  const words = resolveCommandWords(extracted, bindings, true);
  if (words.blocked) return { exitCode: 2, stderr: `EGC Guardian BLOCKED this command: ${words.blocked}.` };
  const reread = secondReadings(command, bindings, true);
  if (reread.blocked) return { exitCode: 2, stderr: `EGC Guardian BLOCKED this command: ${reread.blocked}.` };
  const segments = [...words.segments, ...reread.segments];

  const cli = resolveGuardianCli();
  // resolveGuardianCli() only returns falsy when all 3 of its resolution
  // strategies fail at once (env var, package-relative build, and both
  // trusted MCP config files) — reproduced deterministically in
  // tests/hooks/pre-bash-guardian-validate.test.js by stubbing guardian-bin
  // in require.cache before re-requiring this file, so the falsy-cli branch
  // is genuinely exercised (and its coverage correctly attributed here)
  // without needing a real "nothing resolves" filesystem/HOME setup.
  if (!cli) {
    return { exitCode: 0 };
  }

  const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;
  const lineBound = lineBoundOf(extracted, bindings);
  const scripts = scriptSegmentsOf(segments, cwd, 0, new Set(), commandContext(segments, cwd, bindings, lineBound));
  if (scripts.blocked) {
    return {
      exitCode: 2,
      stderr: `EGC Guardian BLOCKED this command: ${scripts.blocked}.`,
    };
  }
  const committed = [...segments.map(() => false), ...scripts.committed];
  // A target spelled with a variable the line sets (`D=file; echo x > "$D"`)
  // is judged by every value the line gives it, in the typed segments and in
  // the scripts they run; the validator reads the values in.
  // Each distinct map is sent once, in `bounds`; a segment names its map by
  // index in `bound`, so a line of many segments does not repeat the map.
  const boundMaps = [...segments.map(() => lineBound), ...scripts.bound];
  const bounds = [];
  const bound = boundMaps.map(map => {
    const at = bounds.indexOf(map);
    return at === -1 ? bounds.push(map) - 1 : at;
  });
  // A segment is judged in every directory a cd before it can have left it
  // in (`cd dir && git status` runs git in dir), a script's from where the
  // script runs; code the line reads after expanding, and a segment after a
  // move only the running shell knows, where the line starts.
  const cwds = [...segments.map((_, i) => (i < words.segments.length ? scripts.places[i] ?? null : null)), ...scripts.collectedPlaces];
  segments.push(...scripts.segments);
  const answer = callGuardianVerdict(
    cli,
    ['command-batch'],
    JSON.stringify({ commands: segments, cwd, cwds, committed, bounds, bound }),
    VALIDATE_TIMEOUT_MS,
  );
  if (!answer.ok) return withoutVerdict(answer);
  const verdicts = answer.value;
  if (!Array.isArray(verdicts)) {
    return withoutVerdict({ kind: 'unreadable', detail: 'something that is not a list of verdicts' });
  }
  // One verdict per segment, in order: a shorter list would leave the
  // segments past its end unjudged, and a longer one belongs to another
  // command.
  if (verdicts.length !== segments.length) {
    return withoutVerdict({ kind: 'unreadable', detail: 'an incomplete list of verdicts' });
  }
  if (!verdicts.every(isVerdict)) {
    return withoutVerdict({ kind: 'unreadable', detail: 'a list with an entry that is not a verdict' });
  }
  const hardBlock = firstHardBlock(verdicts, segments);
  if (hardBlock) return hardBlock;

  return { exitCode: 0 };
}

module.exports = { run, extractSegments, isAdvisory, bindingsOfSegments, gitIn, withGitBudget, ProgramUnreadable };

if (require.main === module) {
  readHookInput(({ raw, truncated }) => {
    const result = run(raw, { truncated });
    if (result.stderr) process.stderr.write(result.stderr + '\n');
    if (result.exitCode === 2) process.exit(2);
    process.stdout.write(raw);
  });
}

