'use strict';

// The session-start hook of the hosts that name their fields their own way
// (Qwen Code, CodeBuddy, Junie, Auggie, Goose, Droid, OpenHands, Devin, Kimi
// Code, Mistral Vibe, Crush, Grok Build, Letta Code). The payload comes on
// stdin; the project is the root the host names, before its working
// directory, since the memory is keyed by project; the shared session adapter
// pulls the Team Brain when the team asks for it, restores the project memory
// and emits telemetry, as it does for Claude, OpenCode, Cursor and Copilot;
// and the answer goes out in the shape the host reads, additionalContext at
// the top and under hookSpecificOutput for most, snake_case for Vibe. A host
// that reads nothing from this hook (Junie, Auggie, Kimi Code, Crush, Grok,
// Letta) still gets the pull. Each host has a thin wrapper in
// scripts/hooks/<host>-session-start.js.

const fs = require('node:fs');

function readPayload() {
  try {
    const parsed = JSON.parse(fs.readFileSync(0, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (_) { // NOSONAR: a missing or malformed payload restores the memory of the working directory
    // fall through to the empty payload
  }
  return {};
}

function firstString(...values) {
  return values.find(value => typeof value === 'string' && value.length > 0);
}

// The project: project_path (Junie), the first workspace root (Auggie),
// workspaceRoot (Grok), then cwd (Qwen, CodeBuddy, Droid, Kimi Code, Vibe,
// Crush), working_dir (Goose, OpenHands) or working_directory (Letta), then
// the project directory a host exports instead of naming it in the payload
// (DEVIN_PROJECT_DIR); a payload that names nothing leaves the working
// directory of the hook, which a project hook runs from.
function projectOf(payload, env = process.env) {
  const roots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots : [];
  return firstString(
    payload.project_path,
    ...roots,
    payload.workspaceRoot,
    payload.cwd,
    payload.working_dir,
    payload.working_directory,
    env.DEVIN_PROJECT_DIR
  ) || process.cwd();
}

// The session: session_id (most hosts), sessionId, or the conversation
// (Auggie); undefined when the host names none.
function sessionIdOf(payload) {
  return firstString(payload.session_id, payload.sessionId, payload.conversation_id);
}

// The shapes the hosts read: additionalContext at the top level (Droid,
// OpenHands) and under hookSpecificOutput (Qwen, CodeBuddy, Devin, Claude
// readers) for every host but Vibe, which reads additional_context under
// hook_specific_output, the snake_case of its own contract.
const ANSWER_SHAPES = Object.freeze({
  vibe: context => ({ hook_specific_output: { additional_context: context } }),
});

function claudeShapeAnswer(context) {
  return { additionalContext: context, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } };
}

function sessionStartAnswer(context, host) {
  if (!context) return {};
  return (ANSWER_SHAPES[host] || claudeShapeAnswer)(context);
}

async function runHostSessionStart(host, payload = readPayload()) {
  let restored = { host, context: '' };
  try {
    const { runSessionStartAdapter } = require('./session-start-adapter');
    restored = await runSessionStartAdapter({
      host,
      input: { cwd: projectOf(payload), session_id: sessionIdOf(payload), hook_event_name: 'SessionStart' },
    });
  } catch (_) { // NOSONAR: never block a session startup
    // Keep the empty fallback above.
  }
  return sessionStartAnswer(typeof restored.context === 'string' ? restored.context : '', host);
}

// The entry point of a wrapper: fail open, so a startup that cannot restore
// the context still lets the session begin.
function runHostSessionStartHook(host) {
  runHostSessionStart(host)
    .then(answer => process.stdout.write(JSON.stringify(answer)))
    .catch(() => {
      process.stdout.write('{}');
      process.exit(0);
    });
}

module.exports = { projectOf, readPayload, runHostSessionStart, runHostSessionStartHook, sessionIdOf, sessionStartAnswer };
