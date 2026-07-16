#!/usr/bin/env node
'use strict';

// Claude Code Stop hook. Injects a prompt asking the AI to call update_state
// via the egc-memory MCP tool before the session ends. Never blocks the Stop
// event: missing stdin or parse errors are silently ignored and exit 0.
//
// The save prompt is throttled: firing it on every assistant stop made the
// AI persist memory after each reply, stalling real work. One reminder per
// project per interval (default 30 minutes, EGC_STOP_SAVE_INTERVAL_MINUTES)
// keeps memory fresh without interrupting every exchange.

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_INTERVAL_MINUTES = 30;

function saveIntervalMs() {
  const parsed = Number.parseInt(process.env.EGC_STOP_SAVE_INTERVAL_MINUTES, 10);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed * 60 * 1000;
  return DEFAULT_INTERVAL_MINUTES * 60 * 1000;
}

function projectSlug(projectPath) {
  const parts = projectPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-2).join('--').replace(/[^a-zA-Z0-9-_]/g, '_') || 'default';
}

function markerPath(input) {
  const cwd = (typeof input.cwd === 'string' && input.cwd)
    ? input.cwd
    : (process.env.CLAUDE_PROJECT_DIR || process.env.PWD || process.cwd());
  return path.join(os.homedir(), '.egc', 'state', `.save-prompt-${projectSlug(cwd)}`);
}

// One save prompt per project per interval. The marker mtime records the last
// prompt; read or write failures fail open so a broken marker never silently
// disables memory saves.
function shouldPromptSave(input, nowMs) {
  const interval = saveIntervalMs();
  if (interval === 0) return true;

  const marker = markerPath(input);
  try {
    if (nowMs - fs.statSync(marker).mtimeMs < interval) return false;
  } catch {
    // No marker yet: first stop for this project.
  }

  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, new Date(nowMs).toISOString(), 'utf8');
  } catch {
    // Marker is best-effort; still prompt.
  }
  return true;
}

function post(ev, done) {
  const body = JSON.stringify(ev);
  const req = http.request(
    { hostname: '127.0.0.1', port: 7890, path: '/event', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 300 },
    () => done()
  );
  req.on('error', () => done());
  req.on('timeout', () => { req.destroy(); done(); });
  req.end(body);
}

// The Claude Code Stop hook payload does not include usage or model.
// Extract them from the last assistant message in the transcript JSONL.
function readTranscriptLast(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return {};
  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry;
      try { entry = JSON.parse(lines[i]); } catch { continue; }
      const msg = entry.message || entry;
      const usage = msg.usage;
      if (usage && typeof usage.input_tokens === 'number') {
        return { usage, model: typeof msg.model === 'string' ? msg.model : null };
      }
    }
  } catch { /* unreadable or missing transcript */ }
  return {};
}

function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    process.exit(0);
  }

  let input = {};
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const prompt =
    'Call update_state via the egc-memory MCP tool with the decisions, '
    + 'preferences, and next steps from this session. '
    + 'project_path is optional: omit it and it uses PWD automatically.';

  const output = shouldPromptSave(input, Date.now())
    ? { ...input, promptForAssistant: prompt }
    : { ...input };

  const transcript = readTranscriptLast(input.transcript_path);

  // Write the assistant prompt to stdout first (synchronous, always completes).
  // Then post the session_end event and exit only after the dashboard has
  // acknowledged it (or the 300ms timeout fires). This prevents process.exit()
  // from tearing down the socket before the HTTP request is flushed.
  process.stdout.write(JSON.stringify(output));
  post({
    ide: 'claude',
    event: 'session_end',
    agent: 'main',
    session_id: input.session_id,
    stop_reason: input.stop_reason || null,
    model: input.model || transcript.model || null,
    usage: input.usage || transcript.usage || null,
  }, () => process.exit(0));
}

main();
