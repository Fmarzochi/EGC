'use strict';

/**
 * The team configuration of this machine, ~/.egc/team.json: the backend,
 * the remote, the branch, the team key, and `autosync`, the switch of the
 * sync that runs around the session (#2059). The hooks and the CLI read it
 * from here; the memory server keeps its own reader of the same file. A
 * write goes whole through a private temporary next to the file and a
 * rename over it, so an interrupted write never leaves a truncated file
 * that would look like a missing team.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function teamConfigPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.egc', 'team.json');
}

// The text of a regular file, read without following a link and without
// blocking on a FIFO planted at its path: a hook reads this at the start of
// every session and must never hang on it. Null when there is no such file.
function readRegularFile(file) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  let descriptor;
  try {
    descriptor = fs.openSync(file, flags);
  } catch {
    return null;
  }
  try {
    if (!fs.fstatSync(descriptor).isFile()) return null;
    return fs.readFileSync(descriptor, 'utf-8');
  } catch {
    return null;
  } finally {
    fs.closeSync(descriptor);
  }
}

// The configuration, or null when the file is missing, is not a regular
// file or is not a JSON object.
function readTeamConfig(homeDir = os.homedir()) {
  const text = readRegularFile(teamConfigPath(homeDir));
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Whether the sync runs by itself around the session: `autosync: true` in
// the configuration and nothing else, so it is off by default and off
// without a team.
function isAutosyncOn(config = readTeamConfig()) {
  return config?.autosync === true;
}

function makePrivate(target, mode) {
  try {
    fs.chmodSync(target, mode);
  } catch {
    // modes are not supported on this filesystem
  }
}

// Writes the configuration text as it is: the previous file of a refused
// init goes back through here byte for byte.
function publishTeamConfigText(text, homeDir = os.homedir()) {
  const file = teamConfigPath(homeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  makePrivate(path.dirname(file), 0o700);
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  // Created exclusively: a link planted at the temporary name is never
  // written through.
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, text, { encoding: 'utf-8' });
  } finally {
    fs.closeSync(descriptor);
  }
  makePrivate(temporary, 0o600);
  fs.renameSync(temporary, file);
}

function writeTeamConfig(config, homeDir = os.homedir()) {
  publishTeamConfigText(JSON.stringify(config, null, 2), homeDir);
}

module.exports = { teamConfigPath, readTeamConfig, isAutosyncOn, publishTeamConfigText, writeTeamConfig };
