'use strict';

const fs = require('fs');
const { getStateDir, detectBranch, resolveStateRead } = require('../lib/branch-state');

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

  try {
    const projectPath = process.env.PWD || process.cwd();
    const branch = detectBranch(projectPath);
    const resolved = resolveStateRead(getStateDir(), projectPath, branch);

    if (resolved.source === 'none') {
      process.stdout.write(JSON.stringify(input));
      process.exit(0);
    }

    const content = fs.readFileSync(resolved.filePath, 'utf8');
    const prompt =
      'You have persistent memory for this project. Resume exactly where you left off: no need to re-explain anything already decided.\n\n' +
      content;

    const output = Object.assign({}, input, { promptForAssistant: prompt });
    process.stdout.write(JSON.stringify(output));
  } catch (_) {
    process.stdout.write(JSON.stringify(input));
  }

  process.exit(0);
}

main();
