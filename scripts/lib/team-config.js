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

const { spawnSync } = require('node:child_process');
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

// The account that keeps a file to itself on Windows: DOMAIN\user when the
// session names a domain, the user name alone otherwise.
function windowsAccount(env = process.env) {
  const user = env.USERNAME || os.userInfo().username;
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${user}` : user;
}

// The icacls call that leaves one account on a file or a directory: the
// inherited entries removed, one full-control entry for the account, and on
// a directory that entry inherited by what the directory will hold.
function privateAclArguments(target, { directory = false, account = windowsAccount() } = {}) {
  return ['icacls', [target, '/inheritance:r', '/grant:r', `${account}:${directory ? '(OI)(CI)F' : 'F'}`]];
}

// Private to the user on every platform: the POSIX mode where modes exist,
// the ACL above on Windows, where chmod changes nothing. A protection that
// cannot be applied never blocks the write: the file is left as it is, and
// the caller learns it from the answer.
function makePrivate(target, mode, { directory = false, platform = process.platform, run = spawnSync } = {}) {
  if (platform === 'win32') {
    try {
      const [command, args] = privateAclArguments(target, { directory });
      const result = run(command, args, { stdio: 'ignore', windowsHide: true });
      return Boolean(result) && result.status === 0;
    } catch {
      return false;
    }
  }
  try {
    fs.chmodSync(target, mode);
    return true;
  } catch {
    return false;
  }
}

// Writes the configuration text as it is: the previous file of a refused
// init goes back through here byte for byte.
function publishTeamConfigText(text, homeDir = os.homedir()) {
  const file = teamConfigPath(homeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  makePrivate(path.dirname(file), 0o700, { directory: true });
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

module.exports = { teamConfigPath, readTeamConfig, isAutosyncOn, publishTeamConfigText, writeTeamConfig, makePrivate, privateAclArguments, windowsAccount };
