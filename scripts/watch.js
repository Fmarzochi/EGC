#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { StateWatcher } = require('./lib/watch-state');

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { projectPath: process.cwd(), quiet: false, help: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') { opts.help = true; continue; }
    if (args[i] === '--quiet' || args[i] === '-q') { opts.quiet = true; continue; }
    if ((args[i] === '--project' || args[i] === '-p') && args[i + 1]) {
      opts.projectPath = path.resolve(args[++i]);
      continue;
    }
    if (!args[i].startsWith('-')) {
      opts.projectPath = path.resolve(args[i]);
    }
  }

  return opts;
}

function showHelp() {
  console.log(`
egc watch -- bidirectional state sync daemon

Watches all EGC-managed tool config files in the project. When any file
is modified outside of EGC's own propagation cycle, the change is synced
to all other tools automatically.

Usage:
  egc watch [project-path] [options]

Options:
  --project, -p <path>  Project root to watch (default: cwd)
  --quiet, -q           Suppress sync notifications
  --help, -h            Show this help

Supported tools:
  Cursor, Copilot, Gemini CLI, Windsurf, Trae, Zed, Cline, Aider,
  .cursorrules (legacy Cursor), AGENTS.md, llms.txt

Exit: Ctrl+C
`);
}

function main() {
  const opts = parseArgs(process.argv);

  if (opts.help) {
    showHelp();
    process.exit(0);
  }

  const watcher = new StateWatcher(opts.projectPath, {
    onSync({ sourceTool, syncedTools, stateUpdated }) {
      if (opts.quiet) return;
      const targets = syncedTools.length > 0 ? syncedTools.join(', ') : 'none';
      const stateNote = stateUpdated ? ' + state file' : '';
      console.log(`[egc watch] ${sourceTool} changed -> synced to: ${targets}${stateNote}`);
    },
    onError(err) {
      console.error(`[egc watch] error: ${err.message}`);
    },
  });

  const count = watcher.start();

  if (count === 0) {
    console.log('[egc watch] No EGC-managed tool config files found in this project.');
    console.log('            Run egc install --target <tool> to set up a target first.');
    process.exit(0);
  }

  if (!opts.quiet) {
    console.log(`[egc watch] Watching ${count} tool config file(s) in ${opts.projectPath}`);
    console.log('[egc watch] Press Ctrl+C to stop.');
  }

  process.on('SIGINT', () => {
    watcher.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    watcher.stop();
    process.exit(0);
  });
}

main();
