#!/usr/bin/env node
'use strict';

// `egc mesh`: the real-time mesh between the machines of one person. `serve`
// runs the central that relays between them in the foreground; it lives in
// the built memory server, which the machines' bridges share it with.

const fs = require('node:fs');
const USAGE = [
  'Usage: egc mesh <serve [--port <n>] [--host <address>] [--no-announce] | connect [<address>] | find | disconnect | status | label <name>>',
  '',
  '  serve             Run the central that relays between your machines (port 47470 by default;',
  '                    --port and --host change where it listens; it announces itself on the local',
  '                    network unless --no-announce). It lets in the machines that hold the key of',
  '                    this machine\'s team (egc team init).',
  '  connect [<addr>]  Point this machine at a central (host:port, a host alone for port 47470,',
  '                    or a ws:// or wss:// URL). With no address, the central of your team on the',
  '                    local network is found (3 s). The memory servers connect from their next start.',
  '  find              List the centrals of your team that answer on the local network.',
  '  disconnect        Forget the central: the machine works alone again, and a running bridge',
  '                    steps down within half a minute.',
  '  status            This machine on the mesh: identity, central, connection, machines online.',
  '  label <name>      Rename this machine as the other machines see it.',
].join('\n');
const { NOT_BUILT, loadRelay } = require('./lib/relay-module');

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

// The centrals of this machine's team on the local network, listed; null
// when the mesh cannot be searched (no build, no team), an empty list when
// nothing of the team answered.
async function findCentrals() {
  const discovery = loadRelay('discovery');
  const teamSync = loadRelay('../sync/TeamSync');
  const envelope = loadRelay('../sync/envelope');
  if (!discovery || !teamSync || !envelope) {
    process.stderr.write(NOT_BUILT);
    process.exitCode = 1;
    return null;
  }
  const teamKey = envelope.parseTeamKey(teamSync.getTeamConfig()?.teamKey);
  if (!teamKey) {
    process.stderr.write('No team on this machine: run `egc team init` (with --key to join one). The central of your team is found by its key.\n');
    process.exitCode = 1;
    return null;
  }
  process.stdout.write('Looking for the central of your team on the local network (3 s)...\n');
  let found;
  try {
    found = await discovery.discoverCentrals({ teamKey });
  } catch (error) {
    process.stderr.write(`The local network could not be searched: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return null;
  }
  if (found.length === 0) {
    process.stdout.write('No central of your team answered on this network. Start one with `egc mesh serve`, or give its address: egc mesh connect <host:port>.\n');
    return found;
  }
  for (const central of found) process.stdout.write(`- ${central.address}  ${central.name}\n`);
  return found;
}

async function connectCentral(address) {
  const configModule = loadRelay('mesh-config');
  if (!configModule) {
    process.stderr.write(NOT_BUILT);
    process.exitCode = 1;
    return;
  }
  let target = address;
  if (!target) {
    const found = await findCentrals();
    if (found === null) return;
    if (found.length === 0) {
      process.exitCode = 1;
      return;
    }
    if (found.length > 1) {
      process.stdout.write('More than one central of your team answered: choose one with egc mesh connect <address>.\n');
      process.exitCode = 2;
      return;
    }
    target = found[0].address;
  }
  try {
    const config = configModule.writeMeshConfig(target);
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
  if (subcommand === 'find') {
    const found = await findCentrals();
    if (found !== null && found.length === 0) process.exitCode = 1;
    return;
  }
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
