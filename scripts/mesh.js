#!/usr/bin/env node
'use strict';

// `egc mesh`: the real-time mesh between the machines of one person. `serve`
// runs the central that relays between them in the foreground; it lives in
// the built memory server, which the machines' bridges share it with.

const fs = require('node:fs');
const path = require('node:path');

const SERVE_RELATIVE = ['mcp', 'servers', 'egc-memory', 'build', 'relay', 'serve.js'];
const USAGE = [
  'Usage: egc mesh serve [--port <0-65535>] [--host <address>]',
  '',
  '  serve   Run the central that relays between your machines (port 47470 by default).',
  '          It lets in the machines that hold the key of this machine\'s team (egc team init).',
].join('\n');

// The built central: the one of the EGC root this file runs from, else the
// one the shared resolver finds for an install elsewhere; null when the
// memory server was not built.
function serveScript() {
  const local = path.join(__dirname, '..', ...SERVE_RELATIVE);
  if (fs.existsSync(local)) return local;
  try {
    const { resolveEGCRoot } = require('./lib/resolve-egc-root');
    const candidate = path.join(resolveEGCRoot({ probe: SERVE_RELATIVE.join('/') }), ...SERVE_RELATIVE);
    return fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

async function main(argv) {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (subcommand !== 'serve') {
    process.stderr.write(`Unknown subcommand ${subcommand}.\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  const script = serveScript();
  if (!script) {
    process.stderr.write('The memory server is not built, so the mesh central cannot run: in a checkout of EGC run `bash scripts/install.sh`, which builds the servers, or `npm run build` in mcp/servers/egc-memory.\n');
    process.exitCode = 1;
    return;
  }
  await require(script).main(rest);
}

main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`egc mesh: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
