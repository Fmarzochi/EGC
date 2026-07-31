'use strict';

// EGC SessionStart + Guardian + Token Crusher plugin for OpenCode. OpenCode
// loads this file in-process; Guardian and Crusher run directly, while session
// restoration is delegated to a fail-open Node adapter around the shared,
// host-neutral session-context-loader core.

const path = require('node:path');
const { spawn } = require('node:child_process');
const { run: runGuardian } = require('../scripts/hooks/pre-bash-guardian-validate');
const { run: runCrusherRewrite } = require('../scripts/hooks/pre-bash-crusher-rewrite');

const SESSION_CONTEXT_SCRIPT = path.join(
  __dirname,
  '..',
  'scripts',
  'hooks',
  'opencode-session-start.js'
);
const SESSION_CONTEXT_TIMEOUT_MS = 3000;
const MAX_SESSION_CONTEXT_BYTES = 1024 * 1024;

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

function loadSessionContext(projectDirectory, sessionId) {
  return new Promise(resolve => {
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
    }, SESSION_CONTEXT_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > MAX_SESSION_CONTEXT_BYTES) {
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

      await prompt.call(client.session, {
        path: { id: info.id },
        body: {
          noReply: true,
          parts: [{ type: 'text', text: context }],
        },
      });
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
      if (!input || input.tool !== 'bash' || typeof output?.args?.command !== 'string') {
        return;
      }

      const command = output.args.command;

      const guardianResult = runGuardian({
        tool_name: 'Bash',
        tool_input: { command },
        cwd: directory,
      });
      if (guardianResult.exitCode === 2) {
        throw new Error(guardianResult.stderr || 'Blocked by the EGC Guardian.');
      }

      const rewritten = JSON.parse(runCrusherRewrite({ tool_input: { command } }));
      if (typeof rewritten?.tool_input?.command === 'string') {
        output.args.command = rewritten.tool_input.command;
      }
    },
  };
};

module.exports = { EgcGuardianCrusher };
