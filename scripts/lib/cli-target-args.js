const fs = require('node:fs');
const path = require('node:path');

function takeValue(args, index, errorMessage) {
  const value = args[index + 1];
  if (!value) throw new Error(errorMessage);
  return value;
}

// Returns the loop index to resume from (advanced past a consumed value, if any).
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

  for (let index = 0; index < args.length; index += 1) {
    index = consumeArg(args, index, parsed, supportsDryRun);
  }

  if (parsed.repoRoot && !fs.existsSync(parsed.repoRoot)) {
    throw new Error(`--repo-root path does not exist: ${parsed.repoRoot}`);
  }

  return parsed;
}

module.exports = { parseTargetArgs };
