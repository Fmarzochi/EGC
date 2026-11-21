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

// The JSON object a file holds, or null when there is no file or no object.
function readJsonObject(file) {
  try {
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

function isLiveStatus(status, now = Date.now()) {
  if (!status || typeof status.updatedAt !== 'string' || !Number.isInteger(status.pid)) return false;
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
