#!/usr/bin/env node
'use strict';

// `egc mesh`: the real-time mesh between the machines of one person. `serve`
// runs the central that relays between them in the foreground; it lives in
// the built memory server, which the machines' bridges share it with.

const fs = require('node:fs');
const path = require('node:path');

const RELAY_RELATIVE = ['mcp', 'servers', 'egc-memory', 'build', 'relay'];
const USAGE = [
  'Usage: egc mesh <serve [--port <n>] [--host <address>] | connect <address> | disconnect | status | label <name>>',
  '',
  '  serve             Run the central that relays between your machines (port 47470 by default;',
  '                    --port and --host change where it listens).',
  '                    It lets in the machines that hold the key of this machine\'s team (egc team init).',
  '  connect <addr>    Point this machine at a central (host:port, a host alone for port 47470,',
  '                    or a ws:// or wss:// URL). The memory servers connect from their next start.',
  '  disconnect        Forget the central: the machine works alone again, and a running bridge',
  '                    steps down within half a minute.',
  '  status            This machine on the mesh: identity, central, connection, machines online.',
  '  label <name>      Rename this machine as the other machines see it.',
].join('\n');
const NOT_BUILT = 'The memory server is not built, so the mesh cannot run: in a checkout of EGC run `bash scripts/install.sh`, which builds the servers, or `npm run build` in mcp/servers/egc-memory.\n';

// The built relay modules: the ones of the EGC root this file runs from,
// else the ones the shared resolver finds for an install elsewhere; null
// when the memory server was not built.
function relayModule(name) {
  const relative = [...RELAY_RELATIVE, `${name}.js`];
  const local = path.join(__dirname, '..', ...relative);
  if (fs.existsSync(local)) return local;
  try {
    const { resolveEGCRoot } = require('./lib/resolve-egc-root');
    const candidate = path.join(resolveEGCRoot({ probe: relative.join('/') }), ...relative);
    return fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function loadRelay(name) {
  const script = relayModule(name);
  return script ? require(script) : null;
}

const { readStatusFile, isLiveStatus, describeBridge, describeOnline } = require('./lib/mesh-status');

function showStatus() {
  const machineModule = loadRelay('machine');
  const configModule = loadRelay('mesh-config');
  const bridgeModule = loadRelay('bridge');
  if (!machineModule || !configModule || !bridgeModule) {
    process.stderr.write(NOT_BUILT);
    process.exitCode = 1;
    return;
  }
  const machine = machineModule.loadOrCreateMachine();
  const config = configModule.readMeshConfig();
  const status = readStatusFile(bridgeModule.bridgeStatusPath());
  const lines = [
    `Machine: ${machine.label} (${machine.id})`,
    `Central: ${config ? config.central : 'none (egc mesh connect <address> to join one)'}`,
  ];
  if (config) {
    const live = isLiveStatus(status);
    lines.push(`Bridge:  ${describeBridge(status, live, config.central)}`);
    lines.push(`Online:  ${describeOnline(status, live)}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function connectCentral(address) {
  const configModule = loadRelay('mesh-config');
  if (!configModule) {
    process.stderr.write(NOT_BUILT);
    process.exitCode = 1;
    return;
  }
  if (!address) {
    process.stderr.write(`connect needs the address of the central.\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    const config = configModule.writeMeshConfig(address);
    process.stdout.write(`Central: ${config.central}\nThe memory servers of this machine connect from their next start; egc mesh status shows the connection.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

function disconnectCentral() {
  const configModule = loadRelay('mesh-config');
  if (!configModule) {
    process.stderr.write(NOT_BUILT);
    process.exitCode = 1;
    return;
  }
  try {
    process.stdout.write(configModule.clearMeshConfig() ? 'Central forgotten: a running bridge steps down within half a minute, and the memory servers start alone from now on.\n' : 'No central was configured.\n');
  } catch (error) {
    process.stderr.write(`The central could not be forgotten: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

function relabel(name) {
  const machineModule = loadRelay('machine');
  if (!machineModule) {
    process.stderr.write(NOT_BUILT);
    process.exitCode = 1;
    return;
  }
  try {
    const machine = machineModule.setMachineLabel(name || '');
    process.stdout.write(`Machine: ${machine.label} (${machine.id})\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    process.exitCode = 2;
  }
}

async function main(argv) {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (subcommand === 'status') return showStatus();
  if (subcommand === 'connect') return connectCentral(rest[0]);
  if (subcommand === 'disconnect') return disconnectCentral();
  if (subcommand === 'label') return relabel(rest.join(' '));
  if (subcommand !== 'serve') {
    process.stderr.write(`Unknown subcommand ${subcommand}.\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  const serve = loadRelay('serve');
  if (!serve) {
    process.stderr.write(NOT_BUILT);
    process.exitCode = 1;
    return;
  }
  await serve.main(rest);
}

main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`egc mesh: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
