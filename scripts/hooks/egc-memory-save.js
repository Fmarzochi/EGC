'use strict';

const fs = require('node:fs');
const { writeSnapshotToDisk } = require('../lib/state-snapshot');

function main() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (_) { /* ignore: missing stdin safely defaults to empty state */ process.stdout.write('{}'); process.exit(0); } // NOSONAR

  let input = {};
  try { input = JSON.parse(raw); } catch (_) { /* ignore: malformed json passes through raw string safely */ process.stdout.write(raw); process.exit(0); } // NOSONAR

  // Direct write: guaranteed snapshot regardless of AI or tool availability.
  // Non-fatal: a write failure must never block the session from stopping.
  try { writeSnapshotToDisk(); } catch (_) { /* ignore: snapshot write failure is non-fatal and must not block session stop */ } // NOSONAR

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
