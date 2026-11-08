'use strict';

const fs = require('node:fs');
const { getStateDir, resolveHeadState, resolveStateRead } = require('../lib/branch-state');
const { getHomeDir } = require('../lib/utils');

function tryRequire(modulePath) {
  try {
    return require(modulePath);
  } catch {
    return null;
  }
}

const globalState = tryRequire('../lib/global-state');
const stateCrypto = tryRequire('../lib/state-crypto');

// The state file is read through the crypto helper of the hooks when it is
// there (legacy plaintext passes, an encrypted file is decrypted, an
// unreadable one is empty); without the helper a plaintext file is read and
// an encrypted one is left out, so ciphertext never reaches the session.
function readStateContent(filePath) {
  if (stateCrypto) return stateCrypto.readStateFileDecrypted(filePath) || '';
  const raw = fs.readFileSync(filePath);
  return raw.subarray(0, 5).toString('utf8') === 'EGC1:' ? '' : raw.toString('utf8');
}

// The retired marks the team sync merge keeps in the header are bookkeeping,
// not memory: the `retired:` line of the header (before the first section)
// stays out of what is injected, wherever the file ends.
function withoutRetiredLine(content) {
  const lines = content.split('\n');
  const firstSection = lines.findIndex(line => /^## /.test(line));
  const headerEnd = firstSection === -1 ? lines.length : firstSection;
  return lines.filter((line, index) => index >= headerEnd || !line.startsWith('retired:')).join('\n');
}

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
    const { branch, detachedCommit } = resolveHeadState(projectPath);
    // The state directory and the encryption key come from the same home
    // (HOME, then USERPROFILE, then the OS), the home the server writes under.
    const resolved = resolveStateRead(getStateDir(getHomeDir()), projectPath, branch, detachedCommit);

    const content = resolved.source === 'none' ? '' : withoutRetiredLine(readStateContent(resolved.filePath));
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
