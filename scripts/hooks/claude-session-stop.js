#!/usr/bin/env node
'use strict';

// Claude Code Stop hook. Injects a prompt asking the AI to call update_state
// via the egc-memory MCP tool before the session ends. Never blocks the Stop
// event: missing stdin or parse errors are silently ignored and exit 0.

const fs = require('node:fs');

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
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

main();
