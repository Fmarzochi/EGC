'use strict';

// Shared PreToolUse output envelope for command-rewriting hooks.
//
// The pre-bash hook chain transforms input JSON to input JSON, so a rewrite
// leaves the command changed inside a bare `{tool_name, tool_input}` object.
// Hosts (Claude Code, Codex, CodeBuddy) ignore that shape and run the original
// command; a rewrite only takes effect when returned as
// `hookSpecificOutput.updatedInput`. This wraps a genuine rewrite in that
// envelope while forwarding deny/ask/context outputs and unchanged commands
// untouched. Fail-open: any parse failure emits the chain output verbatim.
function toPreToolUseOutput(originalRaw, finalRaw) {
  let original;
  let final;
  try {
    original = JSON.parse(originalRaw);
    final = JSON.parse(finalRaw);
  } catch {
    return finalRaw;
  }

  // A hook that denied, asked, or added context already speaks the host's
  // hook-output schema; forward it verbatim.
  if (final && typeof final === 'object'
    && (final.hookSpecificOutput || final.decision || final.continue === false)) {
    return finalRaw;
  }

  const originalCommand = original && original.tool_input && original.tool_input.command;
  const finalCommand = final && final.tool_input && final.tool_input.command;

  if (typeof finalCommand === 'string'
    && typeof originalCommand === 'string'
    && finalCommand !== originalCommand) {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: final.tool_input,
      },
    });
  }

  return finalRaw;
}

module.exports = { toPreToolUseOutput };
