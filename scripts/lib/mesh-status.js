'use strict';

/**
 * The status file of the mesh bridge (~/.egc/mesh/bridge.json), as `egc mesh
 * status` and the Mesh block of `egc doctor` read it: the bridge refreshes
 * it with every presence (30 s), so a file older than two minutes, or whose
 * process is gone, belongs to a bridge that is gone.
 */

const fs = require('node:fs');
const path = require('node:path');

const LIVE_WINDOW_MS = 2 * 60 * 1000;

function meshConfigPath(homeDir) {
  return path.join(homeDir, '.egc', 'mesh.json');
}

function bridgeStatusPath(homeDir) {
  return path.join(homeDir, '.egc', 'mesh', 'bridge.json');
}

function machineFilePath(homeDir) {
  return path.join(homeDir, '.egc', 'machine.json');
}

const DEFAULT_CENTRAL_PORT = 47470;

// The rules of normalizeCentralAddress in relay/mesh-config.ts, kept here
// so the doctor judges an address as the runtime does without the built
// server: ws:// or wss:// (the central) or nats:// or tls:// (a NATS server)
// with a host and no user name or password; a bare host is read as ws://
// and gets the port of the central.
function normalizeCentralAddress(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text);
  if (scheme && !/^(?:wss?|nats|tls)$/i.test(scheme[1])) return null;
  let url;
  try {
    url = new URL(scheme ? text : `ws://${text}`);
  } catch {
    return null;
  }
  if (!/^(?:wss?|nats|tls):$/.test(url.protocol) || !url.hostname) return null;
  if (url.username || url.password) return null;
  // A NATS address is host and port alone: credentials come from --auth.
  if (/^(?:nats|tls):$/.test(url.protocol) && (url.search || url.hash || (url.pathname && url.pathname !== '/'))) return null;
  if (!scheme && !url.port) url.port = String(DEFAULT_CENTRAL_PORT);
  return url.toString().replace(/\/$/, '');
}

// What the address points at: the central of egc mesh serve, or a NATS
// server, which runs nothing of EGC and tells nobody who comes and goes.
function centralKind(central) {
  return /^(?:nats|tls):\/\//i.test(String(central ?? '')) ? 'nats' : 'relay';
}

// The JSON object a regular file holds, or null when there is no such file,
// what sits there is not a regular file (a link, a FIFO that would block the
// read), or it holds no object.
function readJsonObject(file) {
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// A status counts as live with a real process id: a damaged file with 0 or
// a negative number would make process.kill speak of the process group.
function isLiveStatus(status, now = Date.now()) {
  if (!status || typeof status.updatedAt !== 'string' || !Number.isSafeInteger(status.pid) || status.pid <= 0) return false;
  return now - Date.parse(status.updatedAt) < LIVE_WINDOW_MS && processAlive(status.pid);
}

// A live bridge still attached to a central that is no longer the configured
// one is in transition: it steps down and the new central is joined within
// one election period.
function describeBridge(status, live, central) {
  if (!live) return 'not running (starts with the next memory server)';
  const pid = `pid ${status.pid}`;
  if (status.central !== central) return `moving to the new central (pid ${status.pid}, still on ${status.central}; the change takes up to half a minute)`;
  return status.connected === true ? `connected (${pid})` : `reconnecting (${pid})`;
}

function onlineCount(status, live) {
  return live && Array.isArray(status.online) ? status.online.length : 0;
}

function describeOnline(status, live) {
  const online = onlineCount(status, live);
  return online === 0 ? 'no other machine seen' : `${online} other machine(s)`;
}

module.exports = {
  LIVE_WINDOW_MS,
  DEFAULT_CENTRAL_PORT,
  normalizeCentralAddress,
  centralKind,
  meshConfigPath,
  bridgeStatusPath,
  machineFilePath,
  readJsonObject,
  readStatusFile: readJsonObject,
  processAlive,
  isLiveStatus,
  describeBridge,
  describeOnline,
  onlineCount,
};
