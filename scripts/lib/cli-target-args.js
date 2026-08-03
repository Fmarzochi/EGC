const fs = require('node:fs');
const path = require('node:path');

function takeValue(args, index, errorMessage) {
  const value = args[index + 1];
  if (!value) throw new Error(errorMessage);
  return value;
}

// Returns the index of the last arg this call consumed (itself, or the value
// after it for flags that take one) -- the caller resumes from +1 past that.
function consumeArg(args, index, parsed, supportsDryRun) {
  const arg = args[index];

  if (arg === '--target') {
    parsed.targets.push(takeValue(args, index, '--target requires a value'));
    return index + 1;
  }
  if (arg === '--repo-root') {
    parsed.repoRoot = path.resolve(takeValue(args, index, '--repo-root requires a path argument'));
    return index + 1;
  }
  if (supportsDryRun && arg === '--dry-run') {
    parsed.dryRun = true;
    return index;
  }
  if (arg === '--json') {
    parsed.json = true;
    return index;
  }
  if (arg === '--help' || arg === '-h') {
    parsed.help = true;
    return index;
  }
  throw new Error(`Unknown argument: ${arg}`);
}

function parseTargetArgs(argv, { supportsDryRun = false } = {}) {
  const args = argv.slice(2);
  const parsed = {
    targets: [],
    repoRoot: null,
    dryRun: false,
    json: false,
    help: false,
  };

  let index = 0;
  while (index < args.length) {
    index = consumeArg(args, index, parsed, supportsDryRun) + 1;
  }

  if (parsed.repoRoot && !fs.existsSync(parsed.repoRoot)) {
    throw new Error(`--repo-root path does not exist: ${parsed.repoRoot}`);
  }

  return parsed;
}

module.exports = { parseTargetArgs };
