// EGC SessionStart + Guardian + Token Crusher plugin for OpenCode. OpenCode
// loads this file in-process as an ES module, and two loaders read it:
// OpenCode 2 requires a default export with an id and a setup function, and
// OpenCode 1 (1.18.29 and newer) reads the server entrypoint of that same
// default export while calling every other export as a function, so the
// default export is the only export. Guardian and Crusher run directly, while
// session restoration is delegated to a fail-open Node adapter around the
// shared, host-neutral session-context-loader core.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

// The hook scripts installed next to this plugin are CommonJS modules.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { run: runGuardian } = require('../scripts/hooks/pre-bash-guardian-validate');
const { run: runWriteGuardian } = require('../scripts/hooks/pre-write-guardian-validate');
const { run: runCrusherRewrite } = require('../scripts/hooks/pre-bash-crusher-rewrite');

const SESSION_CONTEXT_SCRIPT = path.join(
  __dirname,
  '..',
  'scripts',
  'hooks',
  'opencode-session-start.js'
);
const DEFAULT_SESSION_CONTEXT_TIMEOUT_MS = 3000;

// OpenCode's file tools and the Claude-style names the write validator
// expects; OpenCode passes filePath/content/newString in the tool args.
const GUARDIAN_WRITE_TOOLS = { write: 'Write', edit: 'Edit' };

function writeToolInput(args) {
  return {
    file_path: args.filePath ?? args.file_path ?? args.path,
    content: typeof args.content === 'string' ? args.content : undefined,
    new_string: typeof args.newString === 'string' ? args.newString : undefined,
  };
}

// The Guardian's refusal for a write, edit or bash call, or null to proceed.
function guardianDenial(tool, args, directory) {
  const writeTool = GUARDIAN_WRITE_TOOLS[tool];
  let verdict = null;
  if (writeTool) {
    verdict = runWriteGuardian({ tool_name: writeTool, tool_input: writeToolInput(args), cwd: directory });
  } else if (tool === 'bash' && typeof args.command === 'string') {
    verdict = runGuardian({ tool_name: 'Bash', tool_input: { command: args.command }, cwd: directory });
  }
  return verdict?.exitCode === 2 ? (verdict.stderr || 'Blocked by the EGC Guardian.') : null;
}
const DEFAULT_MAX_SESSION_CONTEXT_BYTES = 1024 * 1024;

function positiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function sessionInfoFromEvent(event) {
  const info = event?.properties?.info;
  return info && typeof info.id === 'string' && info.id ? info : null;
}

function parseSessionContextOutput(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return typeof parsed?.context === 'string' && parsed.context.trim()
      ? parsed.context
      : '';
  } catch {
    return '';
  }
}

function withTimeout(operation, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('OpenCode session operation timed out.'));
    }, timeoutMs);

    Promise.resolve(operation).then(
      value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function findNodeOnPath() {
  const binaryName = process.platform === 'win32' ? 'node.exe' : 'node';
  const entries = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter);
  for (const entry of entries) {
    const dir = entry.replace(/^"(.*)"$/, '$1');
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, binaryName);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not in this entry; keep looking.
    }
  }
  return null;
}

function resolveNodeExecutable() {
  const binaryName = path.basename(process.execPath).toLowerCase();
  const isNode = ['node', 'node.exe', 'nodejs', 'nodejs.exe'].includes(binaryName);
  
  return isNode ? process.execPath : findNodeOnPath();
}

function loadSessionContext(projectDirectory, sessionId) {
  return new Promise(resolve => {
    const timeoutMs = positiveIntegerEnv(
      'EGC_SESSION_CONTEXT_TIMEOUT_MS',
      DEFAULT_SESSION_CONTEXT_TIMEOUT_MS
    );
    const maxOutputBytes = positiveIntegerEnv(
      'EGC_SESSION_CONTEXT_MAX_BYTES',
      DEFAULT_MAX_SESSION_CONTEXT_BYTES
    );
    let settled = false;
    let timer;
    let stdout = '';
    let stdoutBytes = 0;

    const finish = value => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };

    let child;
    try {
      const nodeExecutable = resolveNodeExecutable();
      if (!nodeExecutable) {
        finish('');
        return;
      }
      child = spawn(nodeExecutable, [SESSION_CONTEXT_SCRIPT], {
        cwd: projectDirectory,
        env: { ...process.env, OPENCODE_PROJECT_DIR: projectDirectory },
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      finish('');
      return;
    }

    timer = setTimeout(() => {
      child.kill();
      finish('');
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > maxOutputBytes) {
        child.kill();
        finish('');
        return;
      }
      stdout += chunk;
    });
    child.stdout.on('error', () => finish(''));
    child.on('error', () => finish(''));
    child.on('close', code => {
      finish(code === 0 ? parseSessionContextOutput(stdout) : '');
    });
    child.stdin.on('error', () => {});

    try {
      child.stdin.end(JSON.stringify({ cwd: projectDirectory, session_id: sessionId }));
    } catch {
      child.kill();
      finish('');
    }
  });
}

const PLUGIN_ID = 'egc';

// The Guardian's verdict on a tool call, then the Crusher's rewrite of a bash
// command, applied to the host's own args object. A denial throws, which both
// loaders turn into a rejected call.
function enforceToolCall(tool, args, directory) {
  const denial = guardianDenial(tool, args, directory);
  if (denial) throw new Error(denial);
  if (tool !== 'bash' || typeof args.command !== 'string') return;

  // The rewrite is an optimization: a Crusher that fails leaves the command
  // as the agent wrote it, after the Guardian has already judged it.
  try {
    const rewritten = JSON.parse(runCrusherRewrite({ tool_input: { command: args.command } }));
    if (typeof rewritten?.tool_input?.command === 'string') {
      args.command = rewritten.tool_input.command;
    }
  } catch {
    // The command runs unrewritten.
  }
}

// How many sessions the per-session caches remember in one OpenCode process,
// settled or still in flight; the oldest entry leaves when a newer session
// arrives past the cap.
const MAX_CACHED_SESSIONS = 64;

function remember(map, key, value) {
  if (!map.has(key) && map.size >= MAX_CACHED_SESSIONS) {
    map.delete(map.keys().next().value);
  }
  map.set(key, value);
}

// One value per session, computed once and shared by the requests that ask
// for it while it is still being computed; a computation that fails is not
// kept, so the next request asks again. A computation that finishes after
// clear() is not kept either: the generation it started in is gone. An entry
// the cap evicts while still in flight leaves the newer computation that took
// its place alone.
function createSessionCache(compute) {
  const settled = new Map();
  const pending = new Map();
  let generation = 0;

  const cache = sessionId => {
    if (settled.has(sessionId)) return Promise.resolve(settled.get(sessionId));
    if (!pending.has(sessionId)) {
      const started = generation;
      const promise = Promise.resolve()
        .then(() => compute(sessionId))
        .then(value => {
          if (started === generation) remember(settled, sessionId, value);
          return value;
        })
        .finally(() => {
          if (started === generation && pending.get(sessionId) === promise) pending.delete(sessionId);
        });
      remember(pending, sessionId, promise);
    }
    return pending.get(sessionId);
  };
  cache.clear = () => {
    generation += 1;
    settled.clear();
    pending.clear();
  };
  return cache;
}

// The directory a session works in, asked of the host once per session: a
// session may live in another checkout than the plugin instance, as the V1
// path reads it from the session event. The plugin's own location serves a
// session the host cannot describe, for the rest of that session, so a host
// that fails is not asked on every request.
function createDirectoryResolver(context) {
  const fallback = context?.location?.directory ?? context?.directory;
  const cache = createSessionCache(async sessionId => {
    const get = context?.session?.get;
    if (typeof get !== 'function') return fallback;
    try {
      const info = await get.call(context.session, { sessionID: sessionId });
      const own = info?.location?.directory ?? info?.directory;
      return typeof own === 'string' && own ? own : fallback;
    } catch {
      return fallback;
    }
  });

  const resolve = async sessionId => {
    if (typeof sessionId !== 'string' || !sessionId) return fallback;
    try {
      return await cache(sessionId);
    } catch {
      return fallback;
    }
  };
  resolve.clear = cache.clear;
  return resolve;
}

// The project memory of a session, loaded through the bridge once and kept
// for the session's later requests; concurrent requests of one session share
// the same load. A session without a directory or an id gets nothing.
function createContextCache(directoryOf) {
  const cache = createSessionCache(async sessionId => {
    const projectDirectory = await directoryOf(sessionId);
    if (typeof projectDirectory !== 'string' || !projectDirectory) return '';
    return loadSessionContext(projectDirectory, sessionId);
  });

  const load = sessionId => {
    if (typeof sessionId !== 'string' || !sessionId) return Promise.resolve('');
    return cache(sessionId);
  };
  load.clear = cache.clear;
  return load;
}

// OpenCode 2 entrypoint: the tool hook carries Guardian and Crusher, and the
// context hook adds the project memory to the system instructions of every
// request of a session. A host without one of the domains keeps the other.
async function setup(context) {
  const directoryOf = createDirectoryResolver(context);
  const loadOnce = createContextCache(directoryOf);
  const registrations = [];

  const register = async (domain, name, callback) => {
    const hook = context?.[domain]?.hook;
    if (typeof hook !== 'function') return;
    try {
      const registration = await hook.call(context[domain], name, callback);
      if (typeof registration?.dispose === 'function') registrations.push(registration);
    } catch {
      // A hook the host refuses leaves that feature off; the plugin still loads.
    }
  };

  await register('tool', 'execute.before', async event => {
    const args = event?.input;
    if (!args || typeof args !== 'object') return;
    enforceToolCall(event.tool, args, await directoryOf(event.sessionID));
  });

  await register('session', 'context', async event => {
    if (!event || !Array.isArray(event.system)) return;
    try {
      const text = await loadOnce(event.sessionID);
      if (text) event.system.push({ type: 'text', text });
    } catch {
      // Context restoration is best-effort and must never fail a request.
    }
  });

  // Every registration is disposed and both caches are cleared whatever one
  // disposer does, a synchronous throw included.
  return async () => {
    await Promise.allSettled(
      registrations.splice(0).map(registration => Promise.resolve().then(() => registration.dispose()))
    );
    loadOnce.clear();
    directoryOf.clear();
  };
}

// OpenCode 1 entrypoint: the hooks object of the V1 plugin API.
const server = async ({ client, directory } = {}) => {
  const injectedSessionIds = new Set();
  const pendingSessionIds = new Set();

  const handleSessionCreated = async event => {
    const info = sessionInfoFromEvent(event);
    const prompt = client?.session?.prompt;
    if (!info || typeof prompt !== 'function') return;
    if (injectedSessionIds.has(info.id) || pendingSessionIds.has(info.id)) return;

    const projectDirectory = typeof info.directory === 'string' && info.directory
      ? info.directory
      : directory;
    if (typeof projectDirectory !== 'string' || !projectDirectory) return;

    pendingSessionIds.add(info.id);
    try {
      const context = await loadSessionContext(projectDirectory, info.id);
      if (!context) return;

      const timeoutMs = positiveIntegerEnv(
        'EGC_SESSION_CONTEXT_TIMEOUT_MS',
        DEFAULT_SESSION_CONTEXT_TIMEOUT_MS
      );
      await withTimeout(
        prompt.call(client.session, {
          path: { id: info.id },
          body: {
            noReply: true,
            parts: [{ type: 'text', text: context }],
          },
        }),
        timeoutMs
      );
      injectedSessionIds.add(info.id);
    } catch {
      // Context restoration is best-effort and must never block a session.
    } finally {
      pendingSessionIds.delete(info.id);
    }
  };

  return {
    // OpenCode 1 dispatches bus events through this generic hook.
    event: async ({ event } = {}) => {
      if (event?.type !== 'session.created') return;
      await handleSessionCreated(event);
    },

    // Keep the event-specific form for compatibility with older OpenCode
    // plugin dispatchers and the repository's existing dogfooding contract.
    'session.created': handleSessionCreated,

    'tool.execute.before': async (input, output) => {
      const args = output?.args;
      if (!args || typeof args !== 'object') return;
      enforceToolCall(input?.tool, args, directory);
    },
  };
};

export default { id: PLUGIN_ID, setup, server };
