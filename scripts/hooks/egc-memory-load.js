'use strict';

const fs = require('node:fs');
const { getStateDir, detectBranch, resolveStateRead } = require('../lib/branch-state');

function tryRequire(modulePath) {
  try {
    return require(modulePath);
  } catch {
    return null;
  }
}

const globalState = tryRequire('../lib/global-state');
const stateCrypto = tryRequire('../lib/state-crypto');

function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) { // NOSONAR: missing stdin safely defaults to empty JSON state
    process.stdout.write('{}');
    process.exit(0);
  }

  let input = {};
  try {
    input = JSON.parse(raw);
  } catch (_) { // NOSONAR: malformed JSON passes through unchanged for the next hook
    process.stdout.write(raw);
    process.exit(0);
  }

  try {
    const projectPath = process.env.PWD || process.cwd();
    const branch = detectBranch(projectPath);
    const resolved = resolveStateRead(getStateDir(), projectPath, branch);

    const content = resolved.source === 'none' ? '' : fs.readFileSync(resolved.filePath, 'utf8');
    const appendix = globalState ? globalState.readGlobalAppendix(content, stateCrypto) : null;

    if (!content && !appendix) {
      process.stdout.write(JSON.stringify(input));
      process.exit(0);
    }

    const prompt =
      'You have persistent memory for this project. Resume exactly where you left off: no need to re-explain anything already decided.\n\n' +
      content + (appendix ? `\n${appendix}\n` : '');

    const output = { ...input, promptForAssistant: prompt };
    process.stdout.write(JSON.stringify(output));
  } catch (_) { // NOSONAR: enrichment failure falls back to the original input untouched
    process.stdout.write(JSON.stringify(input));
  }

  process.exit(0);
}

main();
