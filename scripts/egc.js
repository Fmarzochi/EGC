#!/usr/bin/env node

const _nodeMajor = parseInt(process.versions.node, 10);
if (_nodeMajor < 20) {
  process.stderr.write(
    `EGC requires Node.js 20 or later (found: ${process.version}).\n` +
    'Update with:  mise install node@lts  OR  nvm install --lts  OR  https://nodejs.org\n'
  );
  process.exit(1);
}

const { spawnSync } = require('child_process');
const path = require('path');
const { version: PACKAGE_VERSION } = require('../package.json');
const { listAvailableLanguages } = require('./lib/install-executor');
const { formatOSC8 } = require('./lib/utils');
const { ensureConsent, ping } = require('./lib/telemetry');

const COMMANDS = {
  init: {
    script: 'init.js',
    description: 'First-run bootstrap (cognitive protocol + MCP registration + doctor)',
  },
  install: {
    script: 'install-apply.js',
    description: 'Install EGC content into a supported target',
  },
  plan: {
    script: 'install-plan.js',
    description: 'Inspect selective-install manifests and resolved plans',
  },
  catalog: {
    script: 'catalog.js',
    description: 'Discover install profiles and component IDs',
  },
  consult: {
    script: 'consult.js',
    description: 'Recommend EGC components and profiles from a natural language query',
  },
  consolidate: {
    script: 'consolidate.js',
    description: 'Compact oversized project state files into layered summaries',
  },
  'install-plan': {
    script: 'install-plan.js',
    description: 'Alias for plan',
  },
  'list-installed': {
    script: 'list-installed.js',
    description: 'Inspect install-state files for the current context',
  },
  doctor: {
    script: 'doctor.js',
    description: 'Diagnose missing or drifted EGC-managed files',
  },
  repair: {
    script: 'repair.js',
    description: 'Restore drifted or missing EGC-managed files',
  },
  'auto-update': {
    script: 'auto-update.js',
    description: 'Pull latest EGC changes and reinstall the current managed targets',
  },
  status: {
    script: 'status.js',
    description: 'Query the EGC SQLite state store status summary',
  },
  overview: {
    script: 'overview.js',
    description: 'Aggregated read-only view of every per-project memory state',
  },
  verify: {
    script: 'verify.js',
    description: 'Run the project verification command and record a receipt for the commit gate',
  },
  sessions: {
    script: 'sessions-cli.js',
    description: 'List or inspect EGC sessions from the SQLite state store',
  },
  replay: {
    script: 'replay.js',
    description: 'List or replay recorded sessions with timeline scrubbing',
  },
  prompt: {
    script: 'gemini.js',
    description: 'Execute an LLM prompt via the Gemini backend (EGC Bridge)',
  },
  'session-inspect': {
    script: 'session-inspect.js',
    description: 'Emit canonical EGC session snapshots from dmux or Gemini history targets',
  },
  'loop-status': {
    script: 'loop-status.js',
    description: 'Inspect Gemini transcripts for stale loop wakeups and pending tool results',
  },
  uninstall: {
    script: 'uninstall.js',
    description: 'Remove EGC-managed files recorded in install-state',
  },
  watch: {
    script: 'watch.js',
    description: 'Watch tool config files and sync state changes bidirectionally',
  },
  telemetry: {
    script: 'telemetry.js',
    description: 'Manage anonymous usage telemetry (status | on | off)',
  },
  dashboard: {
    script: 'dashboard.js',
    description: 'Start the EGC Dashboard (localhost:7890). Use "stop" or "status" as sub-args.',
  },
  team: {
    script: 'team.js',
    description: 'Team memory sync: init, sync, or status. Share state across teammates.',
  },
  budget: {
    script: 'budget.js',
    description: 'Budget guardian: set, status, reset token/cost limits per session.',
  },
  plugin: {
    script: 'plugin.js',
    description: 'Plugin registry: install, list, remove, update EGC plugins from npm or local path.',
  },
};

const PRIMARY_COMMANDS = [
  'init',
  'install',
  'plan',
  'catalog',
  'consult',
  'consolidate',
  'list-installed',
  'doctor',
  'repair',
  'auto-update',
  'status',
  'overview',
  'verify',
  'sessions',
  'replay',
  'session-inspect',
  'loop-status',
  'uninstall',
  'watch',
  'telemetry',
  'dashboard',
  'team',
  'budget',
  'plugin',
];

const TELEMETRY_COMMANDS = new Set(['install', 'doctor', 'init']);

function showHelp(exitCode = 0) {
  console.log(`
EGC: Extended Global Context
Developed by Felipe Marzochi
@FEMARZOCHI
${formatOSC8('https://github.com/Fmarzochi/EGC', 'https://github.com/Fmarzochi/EGC')}
© All rights reserved

EGC selective-install CLI

Usage:
  egc <command> [args...]
  egc [install args...]

Commands:
${PRIMARY_COMMANDS.map(command => `  ${command.padEnd(15)} ${COMMANDS[command].description}`).join('\n')}

Compatibility:
  egc-install        Legacy install entrypoint retained for existing flows
  egc [args...]      Without a command, args are routed to "install"
  egc help <command> Show help for a specific command

Examples:
  egc typescript
  egc install --profile developer --target egc
  egc plan --profile core --target cursor
  egc catalog profiles
  egc catalog components --family language
  egc catalog show framework:nextjs
  egc consult "security reviews"
  egc consolidate --dry-run
  egc list-installed --json
  egc doctor --target cursor
  egc repair --dry-run
  egc auto-update --dry-run
  egc status --json
  egc overview
  egc overview --json
  egc verify
  egc verify -- npm run test:unit
  egc sessions
  egc sessions session-active --json
  egc session-inspect egc:latest
  egc loop-status --json
  egc uninstall --target antigravity --dry-run
  egc watch
  egc watch --project /path/to/project --quiet
  egc telemetry status
  egc telemetry off
`);

  process.exit(exitCode);
}

function resolveCommand(argv) {
  const args = argv.slice(2);

  if (args.length === 0) {
    return { mode: 'help' };
  }

  const [firstArg, ...restArgs] = args;

  if (firstArg === '--help' || firstArg === '-h') {
    return { mode: 'help' };
  }

  if (firstArg === '--version' || firstArg === '-v') {
    return { mode: 'version' };
  }

  if (firstArg === 'help') {
    return {
      mode: 'help-command',
      command: restArgs[0] || null,
    };
  }

  if (COMMANDS[firstArg]) {
    return {
      mode: 'command',
      command: firstArg,
      args: restArgs,
    };
  }

  if (firstArg === '-p') {
    return {
      mode: 'command',
      command: 'prompt',
      args,
    };
  }

  const knownLegacyLanguages = listAvailableLanguages();
  const shouldTreatAsImplicitInstall = (
    firstArg.startsWith('-')
    || knownLegacyLanguages.includes(firstArg)
  );

  if (!shouldTreatAsImplicitInstall) {
    throw new Error(`Unknown command: ${firstArg}`);
  }

  return {
    mode: 'command',
    command: 'install',
    args,
  };
}

function runCommand(commandName, args) {
  const command = COMMANDS[commandName];
  if (!command) {
    throw new Error(`Unknown command: ${commandName}`);
  }

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, command.script), ...args],
    {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    }
  );

  if (result.error) {
    throw result.error;
  }

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (typeof result.status === 'number') {
    return result.status;
  }

  if (result.signal) {
    throw new Error(`Command "${commandName}" terminated by signal ${result.signal}`);
  }

  return 1;
}

async function main() {
  try {
    const resolution = resolveCommand(process.argv);

    if (resolution.mode === 'help') {
      showHelp(0);
    }

    if (resolution.mode === 'version') {
      console.log(PACKAGE_VERSION);
      process.exit(0);
    }

    if (resolution.mode === 'help-command') {
      if (!resolution.command) {
        showHelp(0);
      }

      if (!COMMANDS[resolution.command]) {
        throw new Error(`Unknown command: ${resolution.command}`);
      }

      process.exitCode = runCommand(resolution.command, ['--help']);
      return;
    }

    if (TELEMETRY_COMMANDS.has(resolution.command)) {
      const telemetryEnabled = await ensureConsent();
      if (telemetryEnabled) {
        ping(`/cli/egc-${resolution.command}`, `EGC CLI v${PACKAGE_VERSION}`);
      }
    }

    process.exitCode = runCommand(resolution.command, resolution.args);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
