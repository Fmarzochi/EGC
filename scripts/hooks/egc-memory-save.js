'use strict';

const fs = require('fs');

function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    process.stdout.write('{}');
    process.exit(0);
  }

  let input = {};
  try {
    input = JSON.parse(raw);
  } catch (_) {
    process.stdout.write(raw);
    process.exit(0);
  }

  const prompt =
    'Call update_state via the egc-memory MCP tool with the decisions, preferences, and next steps from this session. project_path is optional: omit it and it uses PWD automatically.';

  const output = Object.assign({}, input, { promptForAssistant: prompt });
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

main();
