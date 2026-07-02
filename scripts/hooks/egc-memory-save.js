'use strict';

const fs = require('fs');
const { writeSnapshotToDisk } = require('../lib/state-snapshot');

function main() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (_) { process.stdout.write('{}'); process.exit(0); }

  let input = {};
  try { input = JSON.parse(raw); } catch (_) { process.stdout.write(raw); process.exit(0); }

  // Direct write: guaranteed snapshot regardless of AI or tool availability.
  // Non-fatal: a write failure must never block the session from stopping.
  try { writeSnapshotToDisk(); } catch (_) { /* non-fatal */ }

  // Prompt: lets a cooperative AI enrich the snapshot with synthesized
  // decisions, preferences, and next steps via update_state.
  const prompt =
    'Call update_state via the egc-memory MCP tool with the decisions, '
    + 'preferences, and next steps from this session. '
    + 'project_path is optional: omit it and it uses PWD automatically.';

  process.stdout.write(JSON.stringify(Object.assign({}, input, { promptForAssistant: prompt })));
  process.exit(0);
}

main();
