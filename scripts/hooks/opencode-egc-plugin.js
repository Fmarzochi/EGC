'use strict';

// EGC SessionStart + Guardian + Token Crusher plugin for OpenCode. OpenCode
// loads this file in-process; Guardian and Crusher run directly, while session
// restoration is delegated to a fail-open Node adapter around the shared,
// host-neutral session-context-loader core.

const path = require('node:path');
const { spawn } = require('node:child_process');
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
      child = spawn(process.execPath, [SESSION_CONTEXT_SCRIPT], {
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

const EgcGuardianCrusher = async ({ client, directory } = {}) => {
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
    // Current OpenCode dispatches bus events through this generic hook.
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
      const denial = guardianDenial(input?.tool, args, directory);
      if (denial) throw new Error(denial);
      if (input?.tool !== 'bash' || typeof args.command !== 'string') return;

      const rewritten = JSON.parse(runCrusherRewrite({ tool_input: { command: args.command } }));
      if (typeof rewritten?.tool_input?.command === 'string') {
        output.args.command = rewritten.tool_input.command;
      }
    },
  };
};

module.exports = { EgcGuardianCrusher };
