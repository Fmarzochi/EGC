// EGC Guardian + Token Crusher plugin for Amp (Sourcegraph). Amp loads a
// plugin like this one IN-PROCESS from .amp/plugins/*.ts (project) or
// ~/.config/amp/plugins/*.ts (home), executed directly by Amp's own Bun
// runtime -- confirmed against the official Plugin API reference
// (https://ampcode.com/manual/plugin-api), which explicitly states
// "Plugins live in .amp/plugins/ ... and are executed using Bun." No
// toolchain (tsc/ts-node) or `@ampcode/plugin` package install is required
// on the user's side: `import type` is erased entirely at compile time by
// TypeScript's own language semantics, and Bun runs .ts files natively.
//
// The `tool.call` event fires before a tool runs and can return `allow`,
// `reject-and-continue` (Guardian: block), `modify` (Crusher: rewrite the
// input), `synthesize`, or `error`. `amp.helpers.shellCommandFromToolCall`
// is the documented, tool-name-agnostic way to extract the command --
// Amp's own docs note it "extracts the shell command from a Bash or
// shell_command tool call," so this plugin never has to hardcode which
// literal tool name Amp uses for shell execution.
//
// Same in-process pattern as OpenCode's plugin
// (scripts/hooks/opencode-egc-plugin.js): call straight into the shared
// run() functions instead of spawning a subprocess and parsing a stdin/
// stdout wire contract, since there is no such contract here to translate.
// pre-bash-guardian-validate.js, pre-bash-crusher-rewrite.js and their own
// dependencies are copied alongside this file (same targetRoot,
// preserve-relative-path), so these requires resolve at install time.

const { run: runGuardian } = require('../scripts/hooks/pre-bash-guardian-validate');
const { run: runCrusherRewrite } = require('../scripts/hooks/pre-bash-crusher-rewrite');

export default function egcGuardianCrusherPlugin(amp: any) {
  amp.on('tool.call', async (event: any) => {
    const shellCommand = amp.helpers.shellCommandFromToolCall(event);
    if (!shellCommand || typeof shellCommand.command !== 'string') {
      return { action: 'allow' };
    }

    const command = shellCommand.command;

    // Guardian first: a blocked command must never reach the Crusher
    // rewrite below -- rewriting a command that is about to be denied
    // anyway is pointless work on the hot path (same ordering as every
    // other EGC adapter that wires both).
    const guardianInput: { tool_name: string; tool_input: { command: string }; cwd?: string } = {
      tool_name: 'Bash',
      tool_input: { command },
    };
    if (typeof shellCommand.dir === 'string') {
      guardianInput.cwd = shellCommand.dir;
    }
    const guardianResult = runGuardian(guardianInput);
    if (guardianResult.exitCode === 2) {
      return { action: 'reject-and-continue', message: guardianResult.stderr || 'Blocked by the EGC Guardian.' };
    }

    // Crusher: run() is fail-open by design (returns the input JSON
    // unchanged on any error, missing engine, or non-crushable command --
    // see pre-bash-crusher-rewrite.js), so no try/catch is needed here.
    const rewritten = JSON.parse(runCrusherRewrite({ tool_input: { command } }));
    if (typeof rewritten?.tool_input?.command === 'string' && rewritten.tool_input.command !== command) {
      return { action: 'modify', input: { ...event.input, command: rewritten.tool_input.command } };
    }

    return { action: 'allow' };
  });
}
