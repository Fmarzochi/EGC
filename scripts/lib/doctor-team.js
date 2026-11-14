'use strict';

/**
 * The Team block of egc doctor (#2058): whether this machine has a team,
 * what it follows, when it last synced, how much local state waits to be
 * sealed, whether the sync runs by itself, and the warnings that would stop
 * the next sync. It reads files and runs git inside a budget; it never calls
 * the memory server and never writes anything.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readTeamConfig } = require('./team-config');
const { lastAutosync } = require('./team-autosync');

const TEAM_KEY_PATTERN = /^[0-9a-f]{64}$/i;
// The budget the hooks give their git calls; the log of the checkout gets
// the same, so a loaded machine does not lose the line.
const GIT_BUDGET_MS = 15000;
// One read of the remote, and no longer: the doctor says a remote did not
// answer instead of waiting for it.
const REMOTE_BUDGET_MS = 5000;
const SIDECAR_SUFFIX = '.hmac';
// Fixed git locations before a PATH lookup, as the hooks do.
const GIT_BIN = [
  '/usr/bin/git',
  '/usr/local/bin/git',
  '/opt/homebrew/bin/git',
  String.raw`C:\Program Files\Git\cmd\git.exe`,
].find(candidate => fs.existsSync(candidate)) || 'git';

function syncCheckoutDir(homeDir) {
  return path.join(homeDir, '.egc', 'team-sync');
}

function stateDir(homeDir) {
  return path.join(homeDir, '.egc', 'state');
}

// Git without a terminal to ask anything: a prompt would hang the doctor.
function quietGitEnvironment(env) {
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: env.GIT_SSH_COMMAND || 'ssh -oBatchMode=yes',
  };
}

// The first line git wrote about a failure, or its exit, never the command.
function gitReason(error, budgetMs) {
  if (error?.code === 'ETIMEDOUT') return `did not answer within ${budgetMs} ms`;
  const line = String(error?.stderr || '').split(/\r?\n/).find(text => text.trim());
  if (line) return line.trim();
  if (typeof error?.status === 'number') return `git exited with status ${error.status}`;
  return String(error?.code || error?.message || 'git failed');
}

// 'absent' when no checkout exists, 'repository' when it is one, and
// 'not-a-repository' when a directory sits there without .git.
function checkoutState(dir) {
  if (!fs.existsSync(dir)) return 'absent';
  return fs.existsSync(path.join(dir, '.git')) ? 'repository' : 'not-a-repository';
}

// The time of the last commit of the checkout, ISO 8601, or null when it has
// none or git cannot say in the budget.
function lastSyncTime(dir, budgetMs, env) {
  try {
    const out = execFileSync(GIT_BIN, ['-C', dir, 'log', '-1', '--format=%cI'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: budgetMs,
      env: quietGitEnvironment(env),
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

// The documents the sync would seal: every regular file under the state
// tree that is neither a sidecar nor a hidden marker of the hooks.
function countStateDocuments(homeDir) {
  const pending = [stateDir(homeDir)];
  let count = 0;
  while (pending.length > 0) {
    const dir = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) pending.push(path.join(dir, entry.name));
      else if (entry.isFile() && !entry.name.endsWith(SIDECAR_SUFFIX) && !entry.name.startsWith('.')) count += 1;
    }
  }
  return count;
}

// A machine with no interface up beyond loopback is offline: the remote is
// not read, and the block says so instead of waiting on the network.
function looksOffline() {
  const interfaces = os.networkInterfaces();
  return !Object.values(interfaces).some(addresses => (addresses || []).some(address => !address.internal));
}

// One read of the remote's branch with git ls-remote, inside the budget.
function readRemote(config, options) {
  if (options.offline ?? looksOffline()) {
    return { checked: false, reachable: null, reason: 'no network interface is up' };
  }
  const budgetMs = options.remoteTimeoutMs ?? REMOTE_BUDGET_MS;
  try {
    execFileSync(GIT_BIN, ['ls-remote', '--heads', config.remote, config.branch || 'main'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: budgetMs,
      env: quietGitEnvironment(options.env ?? process.env),
    });
    return { checked: true, reachable: true, reason: null };
  } catch (error) {
    return { checked: true, reachable: false, reason: gitReason(error, budgetMs) };
  }
}

function keyIsValid(config) {
  return typeof config.teamKey === 'string' && TEAM_KEY_PATTERN.test(config.teamKey);
}

/**
 * The Team block of a doctor run for `homeDir`.
 *
 * options.env              the environment git runs with (this process's by default)
 * options.gitTimeoutMs     the budget of the log of the checkout (15 s)
 * options.remoteTimeoutMs  the budget of the read of the remote (5 s)
 * options.offline          skip the read of the remote (detected by default)
 *
 * `warnings` are the lines the doctor counts; the block raises no error.
 */
function buildTeamReport(homeDir = os.homedir(), options = {}) {
  const config = readTeamConfig(homeDir);
  if (!config) {
    return { configured: false, warnings: [], warningCount: 0 };
  }
  const env = options.env ?? process.env;
  const checkout = syncCheckoutDir(homeDir);
  const state = checkoutState(checkout);
  const warnings = [];
  const keyPresent = keyIsValid(config);
  if (!keyPresent) {
    warnings.push('Team key missing or invalid in ~/.egc/team.json: run egc team init again');
  }
  if (state === 'not-a-repository') {
    warnings.push('The sync checkout at ~/.egc/team-sync is not a git repository: remove it and run egc team init again');
  }
  const remote = readRemote(config, { ...options, env });
  if (remote.checked && !remote.reachable) {
    warnings.push(`The remote ${config.remote} cannot be read: ${remote.reason}`);
  }
  return {
    configured: true,
    backend: config.backend || 'git',
    remote: config.remote || null,
    branch: config.branch || 'main',
    keyPresent,
    autosync: config.autosync === true,
    lastAutosync: lastAutosync(homeDir),
    checkout: state,
    lastSyncTime: state === 'repository' ? lastSyncTime(checkout, options.gitTimeoutMs ?? GIT_BUDGET_MS, env) : null,
    stateDocuments: countStateDocuments(homeDir),
    remoteCheck: remote,
    warnings,
    warningCount: warnings.length,
  };
}

function describeRemoteCheck(check) {
  if (!check.checked) return `not checked (${check.reason})`;
  return check.reachable ? 'reachable' : `cannot be read: ${check.reason}`;
}

function describeAutosync(report) {
  if (!report.autosync) return 'off';
  const last = report.lastAutosync;
  if (!last?.lastRun) return 'on (no run yet)';
  return `on (last run ${last.lastRun}, ${last.reason}, ${last.ok ? 'ok' : 'failed'})`;
}

// The block as the doctor prints it; `print` takes one line at a time.
function printTeamReport(report, print = console.log) {
  if (!report.configured) {
    print('\nTeam: not configured (egc team init --backend git --remote <url>)');
    return;
  }
  print(`\nTeam: ${report.backend} ${report.remote}, branch ${report.branch}, ${report.keyPresent ? 'key present' : 'key missing or invalid'}`);
  print(`  Last sync: ${report.lastSyncTime || 'never'}`);
  print(`  Local state: ${report.stateDocuments} files to seal`);
  print(`  Autosync: ${describeAutosync(report)}`);
  print(`  Remote: ${describeRemoteCheck(report.remoteCheck)}`);
  for (const warning of report.warnings) {
    print(`  - [WARNING] ${warning}`);
  }
  print(`Team summary: warnings=${report.warningCount}`);
}

module.exports = {
  GIT_BUDGET_MS,
  REMOTE_BUDGET_MS,
  buildTeamReport,
  printTeamReport,
  countStateDocuments,
  checkoutState,
};
