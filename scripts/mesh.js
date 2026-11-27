#!/usr/bin/env node
'use strict';

// `egc mesh`: the real-time mesh between the machines of one person. `serve`
// runs the central that relays between them in the foreground; it lives in
// the built memory server, which the machines' bridges share it with.

const USAGE = [
  'Usage: egc mesh <serve [--port <n>] [--host <address>] [--no-announce] [--install | --uninstall] | connect [<address>] [--auth <file>] | find | disconnect | status | label <name>>',
  '',
  '  serve             Run the central that relays between your machines (port 47470 by default;',
  '                    --port and --host change where it listens; it announces itself on the local',
  '                    network unless --no-announce). It lets in the machines that hold the key of',
  '                    this machine\'s team (egc team init).',
  '                    --install runs it as a service of your session instead, back at every login',
  '                    (systemd on Linux, launchd on macOS, a scheduled task on Windows); --uninstall',
  '                    stops that service and removes it.',
  '  connect [<addr>]  Point this machine at a central (host:port, a host alone for port 47470,',
  '                    or a ws:// or wss:// URL). With no address, the central of your team on the',
  '                    local network is found (3 s). The memory servers connect from their next start.',
  '                    A nats:// or tls:// URL points it at a NATS server you run instead, and',
  '                    --auth <file> names your credentials on it: a .creds file, or JSON with a',
  '                    token, or with a user and a pass.',
  '  find              List the centrals of your team that answer on the local network.',
  '  disconnect        Forget the central: the machine works alone again, and a running bridge',
  '                    steps down within half a minute.',
  '  status            This machine on the mesh: identity, central, connection, machines online.',
  '  label <name>      Rename this machine as the other machines see it.',
].join('\n');
const { NOT_BUILT, loadRelay } = require('./lib/relay-module');

const { readStatusFile, isLiveStatus, describeBridge, describeOnline } = require('./lib/mesh-status');
const { installService, uninstallService, serviceStatus, describeService } = require('./lib/mesh-service');

function showStatus() {
  // The service is read from the files and tools of the platform alone, so
  // it is told even where the relay is not built yet.
  const serviceLine = `Service: ${describeService(serviceStatus())}`;
  const machineModule = loadRelay('machine');
  const configModule = loadRelay('mesh-config');
  const bridgeModule = loadRelay('bridge');
  if (!machineModule || !configModule || !bridgeModule) {
    process.stdout.write(`${serviceLine}\n`);
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
    if (config.authFile) lines.push(`Auth:    ${config.authFile}`);
  }
  lines.push(serviceLine);
  process.stdout.write(`${lines.join('\n')}\n`);
}

// The central as a service of this session: written and started here, or
// stopped and removed; the flags of serve travel into the unit.
function installCentral(args) {
  const installed = installService({ args: args.filter(arg => arg !== '--install') });
  const where = installed.path ? `\nUnit:    ${installed.path}` : '';
  process.stdout.write(`Service: installed and started (${describeService(serviceStatus())})${where}\n${installed.hint}\negc mesh status shows it; egc mesh serve --uninstall removes it.\n`);
}

function uninstallCentral() {
  const removed = uninstallService();
  process.stdout.write(removed.removed ? 'Service: stopped and removed. The central runs again with egc mesh serve, or egc mesh serve --install.\n' : 'Service: no service to remove on this machine.\n');
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

// `connect [<address>] [--auth <file>]`: the address, and the credentials
// file of this machine on a NATS server, when the address is one.
function parseConnectArgs(args) {
  let address = null;
  let authFile = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--auth') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) return '--auth takes the path of a credentials file.';
      authFile = value;
      i += 1;
    } else if (args[i].startsWith('--')) {
      return `Unknown option ${args[i]}.`;
    } else if (address === null) {
      address = args[i];
    } else {
      return 'connect takes one address.';
    }
  }
  return { address, authFile };
}

// With no address given, the central of the team on the local network, when
// exactly one answered; null once the search said what happened.
async function discoveredCentral() {
  const found = await findCentrals();
  if (found === null) return null;
  if (found.length === 0) {
    process.exitCode = 1;
    return null;
  }
  if (found.length > 1) {
    process.stdout.write('More than one central of your team answered: choose one with egc mesh connect <address>.\n');
    process.exitCode = 2;
    return null;
  }
  return found[0].address;
}

// The Auth line of connect and status: the credentials file, and what kind
// of credentials it held when it was read.
function describeAuth(config, authKind) {
  if (!config.authFile) return '';
  const kind = authKind ? ` (${authKind})` : '';
  return `\nAuth:    ${config.authFile}${kind}`;
}

// The credentials file is read once here, so a file the bridge could not
// use is refused now, with the reason, and not in the log of a server later.
async function readAuthKind(file) {
  const linkNats = loadRelay('link-nats');
  if (!linkNats) return null;
  return (await linkNats.readNatsAuth(file)).kind;
}

async function connectCentral(args) {
  const configModule = loadRelay('mesh-config');
  if (!configModule) {
    process.stderr.write(NOT_BUILT);
    process.exitCode = 1;
    return;
  }
  const parsed = parseConnectArgs(args);
  if (typeof parsed === 'string') {
    process.stderr.write(`${parsed}\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  const target = parsed.address ?? await discoveredCentral();
  if (!target) return;
  try {
    const authKind = parsed.authFile ? await readAuthKind(parsed.authFile) : null;
    const config = configModule.writeMeshConfig(target, undefined, { authFile: parsed.authFile });
    process.stdout.write(`Central: ${config.central}${describeAuth(config, authKind)}\nThe memory servers of this machine connect from their next start; egc mesh status shows the connection.\n`);
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
  if (subcommand === 'connect') return connectCentral(rest);
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
  const install = rest.includes('--install');
  const uninstall = rest.includes('--uninstall');
  if (install && uninstall) {
    process.stderr.write(`serve takes --install or --uninstall, not both.\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  if (uninstall) return uninstallCentral();
  if (install) return installCentral(rest);
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
