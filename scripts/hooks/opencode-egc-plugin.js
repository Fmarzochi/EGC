'use strict';

// EGC Guardian + Token Crusher plugin for OpenCode (docs:
// https://opencode.ai/docs/plugins). Unlike Claude Code/Cursor/Windsurf --
// an external hook script spawned as a subprocess per invocation, with an
// event-specific wire contract on stdin/stdout -- OpenCode loads a plugin
// file like this one IN-PROCESS: `tool.execute.before(input, output)` runs
// directly inside OpenCode's own Bun runtime, `output` is a mutable object,
// and throwing blocks the tool call. That lets this plugin call straight
// into the same run() functions the other hosts' adapters spawn as
// subprocesses -- no translation adapter needed, just the two requires
// below.
//
// EGC-498: OpenCode is the only one of the four newly-researched hosts
// (Windsurf, Cursor, OpenCode, Kiro) whose hook contract supports mutating
// the tool call before it runs (`output.args.command = ...`), which the
// Token Crusher's rewrite-based design requires. Windsurf/Cursor/Kiro are
// block-only, so they only get the Guardian, not the Crusher, until a
// non-rewrite mechanism exists for them.
//
// pre-bash-guardian-validate.js's run() and pre-bash-crusher-rewrite.js's
// run() are copied alongside this file (same targetRoot, preserve-relative-
// path), so these requires resolve at install time.

const { run: runGuardian } = require('../scripts/hooks/pre-bash-guardian-validate');
const { run: runCrusherRewrite } = require('../scripts/hooks/pre-bash-crusher-rewrite');

const EgcGuardianCrusher = async ({ directory } = {}) => {
  return {
    'tool.execute.before': async (input, output) => {
      if (!input || input.tool !== 'bash' || typeof output?.args?.command !== 'string') {
        return;
      }

      const command = output.args.command;

      // Guardian first: a blocked command must never reach the Crusher
      // rewrite below -- rewriting a command that is about to be denied
      // anyway is pointless work on the hot path.
      const guardianResult = runGuardian({ tool_name: 'Bash', tool_input: { command }, cwd: directory });
      if (guardianResult.exitCode === 2) {
        throw new Error(guardianResult.stderr || 'Blocked by the EGC Guardian.');
      }

      // Crusher: run() is fail-open by design (returns the input JSON
      // unchanged on any error, missing engine, or non-crushable command --
      // see pre-bash-crusher-rewrite.js), so no try/catch is needed here.
      const rewritten = JSON.parse(runCrusherRewrite({ tool_input: { command } }));
      if (typeof rewritten?.tool_input?.command === 'string') {
        output.args.command = rewritten.tool_input.command;
      }
    },
  };
};

module.exports = { EgcGuardianCrusher };
