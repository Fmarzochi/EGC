'use strict';

/**
 * The Mesh block of egc doctor: whether this machine points at a central,
 * who this machine is on the mesh, whether its bridge runs and is connected,
 * how many other machines it sees, and the warnings that would keep the
 * bridge off. It reads files only; it never calls the memory server, the
 * central or the network, and never writes anything.
 */

const fs = require('node:fs');
const os = require('node:os');

const { readTeamConfig } = require('./team-config');
const { bridgeStatusPath, centralKind, describeBridge, describeOnline, isLiveStatus, machineFilePath, meshConfigPath, normalizeCentralAddress, onlineCount, readJsonObject } = require('./mesh-status');

const TEAM_KEY_PATTERN = /^[0-9a-f]{64}$/i;
const CONFIG_PATH_SHOWN = '~/.egc/mesh.json';
const SHORT_ID = 8;

function readCentral(homeDir) {
  const file = meshConfigPath(homeDir);
  if (!fs.existsSync(file)) return { configured: false, unreadable: false, central: null };
  // Judged as the runtime judges it: a value the bridge would refuse leaves
  // the machine without a bridge, so it is an unreadable configuration.
  const config = readJsonObject(file);
  const central = typeof config?.central === 'string' ? normalizeCentralAddress(config.central) : null;
  // The credentials file of this machine on a NATS server, when the central is one.
  const authFile = central && centralKind(central) === 'nats' && typeof config.authFile === 'string' && config.authFile ? config.authFile : null;
  return central ? { configured: true, unreadable: false, central, authFile } : { configured: true, unreadable: true, central: null, authFile: null };
}

function readMachine(homeDir, status) {
  const fromStatus = status?.machine;
  const identity = fromStatus && typeof fromStatus === 'object' ? fromStatus : readJsonObject(machineFilePath(homeDir));
  if (!identity || typeof identity.id !== 'string') return null;
  return { id: identity.id, label: typeof identity.label === 'string' && identity.label ? identity.label : identity.id.slice(0, SHORT_ID) };
}

function hasTeamKey(homeDir) {
  const config = readTeamConfig(homeDir);
  return Boolean(config && typeof config.teamKey === 'string' && TEAM_KEY_PATTERN.test(config.teamKey));
}

// Everything the block prints, from files alone; `now` is for the tests.
function buildMeshReport(homeDir = os.homedir(), now = Date.now()) {
  const { configured, unreadable, central, authFile } = readCentral(homeDir);
  const warnings = [];
  if (!configured) return { configured, unreadable, central, authFile, machine: null, bridge: null, warnings, warningCount: 0 };
  if (unreadable) {
    warnings.push(`the mesh configuration at ${CONFIG_PATH_SHOWN} holds no address the mesh accepts (ws:// or wss:// for the central, nats:// or tls:// for a NATS server, a host, no user name): run egc mesh connect <address> again, or egc mesh disconnect to forget it`);
    return { configured, unreadable, central, authFile, machine: null, bridge: null, warnings, warningCount: warnings.length };
  }
  const status = readJsonObject(bridgeStatusPath(homeDir));
  const live = isLiveStatus(status, now);
  const bridge = {
    live,
    pid: live ? status.pid : null,
    connected: live ? status.connected === true : null,
    central: live && typeof status.central === 'string' ? status.central : null,
    online: onlineCount(status, live),
    updatedAt: live ? status.updatedAt : null,
  };
  if (!hasTeamKey(homeDir)) {
    warnings.push('a central is configured and this machine has no team: the bridge cannot prove itself to the central; run egc team init --backend git --remote <url> --key <team key> (the key of the team the central serves)');
  }
  if (authFile && !fs.existsSync(authFile)) {
    warnings.push(`the credentials file ${authFile} that egc mesh connect --auth named is gone, so the bridge cannot open the NATS server: run egc mesh connect ${central} --auth <file> again`);
  }
  if (live && bridge.central === central && bridge.connected === false) {
    warnings.push(centralKind(central) === 'nats'
      ? `the bridge is not connected to ${central}: check that your NATS server runs there, that the address is reachable from this machine, and that the credentials file still opens it`
      : `the bridge is not connected to ${central}: check that egc mesh serve runs there and that the address is reachable from this machine`);
  }
  return { configured, unreadable, central, authFile, machine: readMachine(homeDir, live ? status : null), bridge, warnings, warningCount: warnings.length };
}

function printWarnings(report, print) {
  for (const warning of report.warnings) print(`  - [WARNING] ${warning}`);
  print(`Mesh summary: warnings=${report.warningCount}`);
}

// The block as the doctor prints it; `print` takes one line at a time.
function printMeshReport(report, print = console.log) {
  if (!report.configured) {
    print('\nMesh: not configured (egc mesh connect <address> joins the central of your team; egc mesh serve starts one)');
    return;
  }
  if (report.unreadable) {
    print(`\nMesh: configuration unreadable (${CONFIG_PATH_SHOWN})`);
    printWarnings(report, print);
    return;
  }
  const machine = report.machine ? `, this machine ${report.machine.label} (${report.machine.id.slice(0, SHORT_ID)})` : '';
  print(`\nMesh: ${centralKind(report.central) === 'nats' ? 'NATS server' : 'central'} ${report.central}${machine}`);
  const status = report.bridge.live ? { pid: report.bridge.pid, central: report.bridge.central, connected: report.bridge.connected, online: new Array(report.bridge.online).fill('') } : null;
  print(`  Bridge: ${describeBridge(status, report.bridge.live, report.central)}`);
  print(`  Online: ${describeOnline(status, report.bridge.live)}`);
  if (report.authFile) print(`  Auth:   ${report.authFile}`);
  printWarnings(report, print);
}

module.exports = { buildMeshReport, printMeshReport };
