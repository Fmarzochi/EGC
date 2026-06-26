#!/usr/bin/env node
'use strict';

// Claude Code Stop hook. Injects a prompt asking the AI to call update_state
// via the egc-memory MCP tool before the session ends. Never blocks the Stop
// event: missing stdin or parse errors are silently ignored and exit 0.

const fs = require('node:fs');
const http = require('node:http');

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

  const output = { ...input, promptForAssistant: prompt };

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
    usage: input.usage || null,
  }, () => process.exit(0));
}

main();
