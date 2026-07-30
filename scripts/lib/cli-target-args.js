const fs = require('node:fs');
const path = require('node:path');

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
    const arg = args[index];

    if (arg === '--target') {
      parsed.targets.push(args[index + 1] || null);
      index += 1;
    } else if (arg === '--repo-root') {
      const rawRepoRoot = args[index + 1];
      if (!rawRepoRoot) {
        throw new Error('--repo-root requires a path argument');
      }
      parsed.repoRoot = path.resolve(rawRepoRoot);
      index += 1;
    } else if (supportsDryRun && arg === '--dry-run') {
      parsed.dryRun = true;
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (parsed.repoRoot && !fs.existsSync(parsed.repoRoot)) {
    throw new Error(`--repo-root path does not exist: ${parsed.repoRoot}`);
  }

  return parsed;
}

module.exports = { parseTargetArgs };
