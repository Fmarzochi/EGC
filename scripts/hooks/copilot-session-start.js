#!/usr/bin/env node
'use strict';

// GitHub Copilot's SessionStart hook (the CLI and the VS Code agent, which
// read the Claude Code hook format when the event is named in PascalCase).
// Copilot sends sessionId, cwd, source and timestamp, and reads the answer's
// additionalContext into the session; the shared adapter syncs the Team
// Brain when the team asks for it, restores the state and emits telemetry,
// as it does for Claude, OpenCode and Cursor.

const fs = require('node:fs');

function readPayload() {
  try {
    const parsed = JSON.parse(fs.readFileSync(0, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (_) { // NOSONAR: a missing or malformed payload starts the session without context
    // fall through to the empty payload
  }
  return {};
}

function firstString(...values) {
  return values.find(value => typeof value === 'string' && value.length > 0);
}

async function main() {
  const payload = readPayload();
  let restored = { host: 'copilot', context: '' };
  try {
    const { runSessionStartAdapter } = require('../lib/session-start-adapter');
    restored = await runSessionStartAdapter({
      host: 'copilot',
      input: {
        cwd: firstString(payload.cwd) || process.cwd(),
        session_id: firstString(payload.sessionId, payload.session_id),
        hook_event_name: 'SessionStart',
      },
    });
  } catch (_) { // NOSONAR: never block a Copilot session startup
    // Keep the empty fallback above.
  }

  const context = typeof restored.context === 'string' ? restored.context : '';
  // Copilot reads additionalContext at the top level; a Claude Code reader
  // of the same file finds it under hookSpecificOutput.
  const answer = context
    ? { additionalContext: context, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }
    : {};
  process.stdout.write(JSON.stringify(answer));
}

// Fail open: a startup that cannot restore the context still lets the
// session begin.
main().catch(() => {
  process.stdout.write('{}');
  process.exit(0);
});
