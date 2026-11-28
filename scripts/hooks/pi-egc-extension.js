'use strict';

// EGC extension for pi: the Guardian and the Token Crusher on tool_call
// (#1499), and around the agent runs the project memory, the Team Brain
// sync and the Session Mesh notice. pi loads this file in its own process
// and awaits the handlers, so every part runs in-process over the scripts
// installed next to it and fails open: the memory is restored once per
// session through the shared session adapter (which pulls the Team Brain
// first when the team asks for it) and handed to the first agent run of the
// session as a custom message pi keeps in the session and sends to the
// model; the mesh notice is read before every run through the shared script
// and added when the bus moved since the session's last look; the Team Brain
// is pushed after each run, in the background, and before the session
// runtime goes down, only when a state document changed since the last run.

function loadHook(name) {
  try {
    return require(`../scripts/hooks/${name}`);
  } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND') throw error;
    return require(`./${name}`);
  }
}

// The libraries installed next to the hook scripts (scripts/lib under the
// agent directory), or beside this file's own in the repository.
function loadLib(name) {
  try {
    return require(`../scripts/lib/${name}`);
  } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND') throw error;
    return require(`../lib/${name}`);
  }
}

// A part an older install lacks leaves that feature off; the gates stay.
function loadOptional(load, name) {
  try {
    return load(name);
  } catch {
    return null;
  }
}

const { run: runGuardian } = loadHook('pre-bash-guardian-validate');
const { run: runWriteGuardian } = loadHook('pre-write-guardian-validate');
const { run: runCrusherRewrite } = loadHook('pre-bash-crusher-rewrite');
const sessionAdapter = loadOptional(loadLib, 'session-start-adapter');
const teamAutosync = loadOptional(loadLib, 'team-autosync');
const meshNotice = loadOptional(loadHook, 'mesh-events-inject');

const HOST = 'pi';
const MEMORY_MESSAGE_TYPE = 'egc-memory';
// How many sessions one pi process remembers as served; the oldest leaves
// when a newer one arrives past the cap.
const MAX_REMEMBERED_SESSIONS = 64;

const WRITE_TOOLS = { edit: 'MultiEdit', write: 'Write' };

function parsedEdits(edits) {
  if (typeof edits !== 'string') return edits;
  try {
    return JSON.parse(edits);
  } catch {
    return undefined;
  }
}

function piEdits(input) {
  let edits = parsedEdits(input.edits);
  if (edits && !Array.isArray(edits)) edits = [edits];
  if (!Array.isArray(edits)) edits = [{ oldText: input.oldText, newText: input.newText }];
  return edits
    .filter(edit => typeof edit?.newText === 'string')
    .map(edit => ({ old_string: typeof edit.oldText === 'string' ? edit.oldText : '', new_string: edit.newText }));
}

function writeToolInput(input) {
  return {
    file_path: input.path,
    path: input.path,
    content: typeof input.content === 'string' ? input.content : undefined,
    edits: piEdits(input),
  };
}

function guardianDenial(toolName, input, cwd) {
  if (!input || typeof input !== 'object') return null;
  let verdict = null;
  if (toolName === 'bash' && typeof input.command === 'string') {
    verdict = runGuardian({ tool_name: 'Bash', tool_input: { command: input.command }, cwd });
  } else if (WRITE_TOOLS[toolName] && typeof input.path === 'string') {
    verdict = runWriteGuardian({ tool_name: WRITE_TOOLS[toolName], tool_input: writeToolInput(input), cwd });
  }
  return verdict?.exitCode === 2 ? (verdict.stderr || 'Blocked by the EGC Guardian.') : null;
}

function crushCommand(input) {
  try {
    const rewritten = JSON.parse(runCrusherRewrite({ tool_input: { command: input.command } }));
    if (typeof rewritten?.tool_input?.command === 'string') input.command = rewritten.tool_input.command;
  } catch {
    return;
  }
}

function cwdOf(ctx) {
  return typeof ctx?.cwd === 'string' && ctx.cwd ? ctx.cwd : process.cwd();
}

function handleToolCall(event, ctx) {
  const cwd = cwdOf(ctx);
  const denial = guardianDenial(event?.toolName, event?.input, cwd);
  if (denial) return { block: true, reason: denial };
  if (event?.toolName === 'bash' && typeof event.input?.command === 'string') crushCommand(event.input);
  return undefined;
}

// The session pi is running, from its session manager; null when the
// context names none, in which case no memory and no notice are injected,
// since both are keyed by the session.
function sessionIdOf(ctx) {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

// The project memory of a session, through the shared adapter: the Team
// Brain pull when the team asks for it, the restore, the telemetry and the
// session marker, as in the session-start hook of every other host.
async function restoreMemory(cwd, sessionId) {
  if (!sessionAdapter) return '';
  try {
    const restored = await sessionAdapter.runSessionStartAdapter({
      host: HOST,
      input: { cwd, session_id: sessionId, hook_event_name: 'SessionStart' },
    });
    return typeof restored?.context === 'string' ? restored.context : '';
  } catch {
    return '';
  }
}

// The mesh notice of one run, or null: read before every run and never
// cached, since the bus may move between two runs of one session.
function meshNoticeFor(sessionId) {
  if (!meshNotice || !sessionId) return null;
  try {
    return meshNotice.run({ session_id: sessionId });
  } catch {
    return null;
  }
}

// Which sessions of this process already got their memory: the first run of
// a session is the one that injects it.
function createServedSessions() {
  const served = new Set();
  return sessionId => {
    if (served.has(sessionId)) return false;
    if (served.size >= MAX_REMEMBERED_SESSIONS) served.delete(served.values().next().value);
    served.add(sessionId);
    return true;
  };
}

// The Team Brain push, one at a time: a push asked while another runs queues
// behind it, and a push that could not run is a line in the EGC log.
function createPush() {
  let chain = Promise.resolve();
  return () => {
    if (!teamAutosync) return chain;
    chain = chain
      .then(() => teamAutosync.autosync({ reason: 'session-end', onlyIfStateChanged: true }))
      .catch(() => {});
    return chain;
  };
}

// What the first run of a session gets (the project memory) and what every
// run gets when the bus moved (the mesh notice), as one hidden message pi
// keeps in the session and sends to the model.
async function beforeAgentStart(ctx, firstRunOf) {
  const sessionId = sessionIdOf(ctx);
  const parts = [];
  if (sessionId && firstRunOf(sessionId)) {
    const memory = await restoreMemory(cwdOf(ctx), sessionId);
    if (memory) parts.push(memory);
  }
  const notice = meshNoticeFor(sessionId);
  if (notice) parts.push(notice);
  if (parts.length === 0) return undefined;
  return { message: { customType: MEMORY_MESSAGE_TYPE, content: parts.join('\n\n'), display: false } };
}

function egcPiExtension(pi) {
  const firstRunOf = createServedSessions();
  const push = createPush();
  pi.on('tool_call', async (event, ctx) => handleToolCall(event, ctx));
  pi.on('before_agent_start', async (_event, ctx) => beforeAgentStart(ctx, firstRunOf));
  // After a run the push goes on in the background: the answer is done and
  // the sync has a budget of its own. At shutdown it is awaited, so a session
  // that ends right after a change still ships it.
  pi.on('agent_end', async () => {
    void push();
  });
  pi.on('session_shutdown', async () => {
    await push();
  });
}

module.exports = egcPiExtension;
module.exports.default = egcPiExtension;
module.exports.guardianDenial = guardianDenial;
module.exports.handleToolCall = handleToolCall;
