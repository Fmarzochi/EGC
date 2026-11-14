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

const { readTeamConfig, teamConfigPath } = require('./team-config');
const { lastAutosync } = require('./team-autosync');

const TEAM_KEY_PATTERN = /^[0-9a-f]{64}$/i;
// The budget the hooks give their git calls; the reads of the checkout get
// the same, so a loaded machine does not lose the line.
const GIT_BUDGET_MS = 15000;
// One read of the remote, and no longer: the doctor says a remote did not
// answer instead of waiting for it.
const REMOTE_BUDGET_MS = 5000;
const SIDECAR_SUFFIX = '.hmac';
const SUPPORTED_BACKENDS = new Set(['git']);
// The hint of every warning that asks for an init: without --key an init
// starts a new team, and the other machines can no longer open the state.
const JOIN_HINT = 'run egc team init --backend git --remote <url> --key <team key>';
const CONFIG_PATH_SHOWN = '~/.egc/team.json';
const CHECKOUT_PATH_SHOWN = '~/.egc/team-sync';
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

// A text as the block shows it: the credentials a remote URL may carry
// (user:token@ after the scheme) never reach the terminal or a log; the raw
// value is kept for git alone. A scan, not a pattern, so the cost stays
// linear in the text whatever it holds.
function redactCredentials(text) {
  let shown = '';
  let rest = text;
  for (;;) {
    const scheme = rest.indexOf('://');
    if (scheme === -1) return shown + rest;
    const start = scheme + 3;
    const authority = rest.slice(start);
    const end = authority.search(/[/\s]/);
    const host = end === -1 ? authority : authority.slice(0, end);
    const at = host.lastIndexOf('@');
    shown += rest.slice(0, start) + (at === -1 ? host : host.slice(at + 1));
    rest = authority.slice(host.length);
  }
}

function displayRemote(remote) {
  if (typeof remote !== 'string' || !remote) return null;
  return redactCredentials(remote);
}

// Git without a terminal to ask anything: a prompt would hang the doctor.
// A command of the person's own in GIT_SSH_COMMAND or GIT_SSH stands as it
// is, as the sync keeps it (the server's git environment does the same);
// the budget of each call ends a prompt such a command opens.
function quietGitEnvironment(env) {
  const quiet = { ...env, GIT_TERMINAL_PROMPT: '0' };
  if (!quiet.GIT_SSH_COMMAND && !quiet.GIT_SSH) quiet.GIT_SSH_COMMAND = 'ssh -oBatchMode=yes';
  return quiet;
}

function runGit(args, budgetMs, env) {
  return execFileSync(GIT_BIN, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: budgetMs,
    env: quietGitEnvironment(env),
  }).trim();
}

// The first line git wrote about a failure, or its exit, never the command,
// and never a credential a URL in that line may carry.
function gitReason(error, budgetMs) {
  if (error?.code === 'ETIMEDOUT') return `did not answer within ${budgetMs} ms`;
  const line = String(error?.stderr || '').split(/\r?\n/).find(text => text.trim());
  if (line) return redactCredentials(line.trim());
  if (typeof error?.status === 'number') return `git exited with status ${error.status}`;
  return redactCredentials(String(error?.code || error?.message || 'git failed'));
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
    return runGit(['-C', dir, 'log', '-1', '--format=%cI'], budgetMs, env) || null;
  } catch {
    return null;
  }
}

// The same remote with or without a trailing slash; on Windows, where a
// local path is spelled with either slash, with either slash too.
function sameRemote(a, b) {
  const normalize = url => (process.platform === 'win32' ? url.replace(/\\/g, '/') : url).replace(/\/$/, '');
  return normalize(a) === normalize(b);
}

// What the checkout follows, read from its own git state: the url of origin
// and the branch checked out, null for either when git cannot say (no
// origin yet, a detached head).
function checkoutFollows(dir, budgetMs, env) {
  let remote = null;
  let branch = null;
  try {
    remote = runGit(['-C', dir, 'remote', 'get-url', 'origin'], budgetMs, env) || null;
  } catch {
    // a checkout without an origin adopts the configured remote at the next sync
  }
  try {
    branch = runGit(['-C', dir, 'symbolic-ref', '--short', 'HEAD'], budgetMs, env) || null;
  } catch {
    // a detached head has no branch to compare
  }
  return { remote, branch };
}

// The documents the sync would seal: every regular file under the state
// tree that is neither a sidecar nor hidden, under no hidden directory,
// the same rule the sync applies.
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
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) pending.push(path.join(dir, entry.name));
      else if (entry.isFile() && !entry.name.endsWith(SIDECAR_SUFFIX)) count += 1;
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

// One read of the remote's branch with git ls-remote, inside the budget: the
// remote is reachable when git answers, and the branch is there when the
// answer names it (a team before its first sync has a reachable remote and
// no branch yet).
function readRemote(config, options) {
  if (options.offline ?? looksOffline()) {
    return { checked: false, reachable: null, branchFound: null, reason: 'no network interface is up' };
  }
  const budgetMs = options.remoteTimeoutMs ?? REMOTE_BUDGET_MS;
  // ls-remote matches a pattern against the tail of a ref, so `main` would
  // also answer with feature/main: the full ref is asked for and the answer
  // is read for that exact ref.
  const ref = `refs/heads/${config.branch || 'main'}`;
  try {
    const out = runGit(['ls-remote', '--heads', config.remote, ref], budgetMs, options.env ?? process.env);
    const branchFound = out.split(/\r?\n/).some(line => line.split('\t')[1] === ref);
    return { checked: true, reachable: true, branchFound, reason: null };
  } catch (error) {
    return { checked: true, reachable: false, branchFound: null, reason: gitReason(error, budgetMs) };
  }
}

function keyIsValid(config) {
  return typeof config.teamKey === 'string' && TEAM_KEY_PATTERN.test(config.teamKey);
}

function configFileExists(homeDir) {
  try {
    fs.lstatSync(teamConfigPath(homeDir));
    return true;
  } catch {
    return false;
  }
}

// The report of a machine whose team.json exists and cannot be read as a
// team configuration: not a regular file, or not the JSON egc team init
// writes. That machine is in a team it cannot sync, so it is a warning,
// never the quiet line of a machine without a team.
function unreadableReport() {
  const warning = `The team configuration at ${CONFIG_PATH_SHOWN} exists but cannot be read as one (not a regular file, or not the JSON egc team init writes): fix it or ${JOIN_HINT}`;
  return { configured: false, unreadable: true, warnings: [warning], warningCount: 1 };
}

function checkoutWarnings(state, follows, config, shownRemote, branch) {
  const warnings = [];
  if (state === 'not-a-repository') {
    warnings.push(`The sync checkout at ${CHECKOUT_PATH_SHOWN} is not a git repository: remove it and ${JOIN_HINT}`);
    return warnings;
  }
  if (state !== 'repository') return warnings;
  if (follows.remote && typeof config.remote === 'string' && !sameRemote(follows.remote, config.remote)) {
    warnings.push(`The sync checkout at ${CHECKOUT_PATH_SHOWN} follows ${displayRemote(follows.remote)}, not the configured ${shownRemote}, so the next sync would refuse it: remove the directory and ${JOIN_HINT}`);
  }
  if (follows.branch && follows.branch !== branch) {
    warnings.push(`The sync checkout at ${CHECKOUT_PATH_SHOWN} is on branch ${follows.branch}, not the configured ${branch}, so the next sync would refuse it: remove the directory and ${JOIN_HINT}`);
  }
  return warnings;
}

/**
 * The Team block of a doctor run for `homeDir`.
 *
 * options.env              the environment git runs with (this process's by default)
 * options.gitTimeoutMs     the budget of each read of the checkout (15 s)
 * options.remoteTimeoutMs  the budget of the read of the remote (5 s)
 * options.offline          skip the read of the remote (detected by default)
 *
 * `warnings` are the lines the doctor counts; the block raises no error.
 */
function buildTeamReport(homeDir = os.homedir(), options = {}) {
  const config = readTeamConfig(homeDir);
  if (!config) {
    if (configFileExists(homeDir)) return unreadableReport();
    return { configured: false, unreadable: false, warnings: [], warningCount: 0 };
  }
  const env = options.env ?? process.env;
  const gitBudgetMs = options.gitTimeoutMs ?? GIT_BUDGET_MS;
  const checkout = syncCheckoutDir(homeDir);
  const state = checkoutState(checkout);
  const backend = config.backend || 'git';
  const backendSupported = SUPPORTED_BACKENDS.has(backend);
  const branch = config.branch || 'main';
  const shownRemote = displayRemote(config.remote);
  const keyPresent = keyIsValid(config);
  const warnings = [];
  if (!backendSupported) {
    warnings.push(`Backend "${backend}" in ${CONFIG_PATH_SHOWN} is not supported, only git is: ${JOIN_HINT}`);
  }
  if (!shownRemote) {
    warnings.push(`No remote in ${CONFIG_PATH_SHOWN}: ${JOIN_HINT}`);
  }
  if (!keyPresent) {
    warnings.push(`Team key missing or invalid in ${CONFIG_PATH_SHOWN}: ${JOIN_HINT}`);
  }
  const follows = state === 'repository' ? checkoutFollows(checkout, gitBudgetMs, env) : { remote: null, branch: null };
  warnings.push(...checkoutWarnings(state, follows, config, shownRemote, branch));
  const remote = backendSupported && shownRemote
    ? readRemote(config, { ...options, env })
    : { checked: false, reachable: null, branchFound: null, reason: backendSupported ? 'no remote configured' : 'backend not supported' };
  if (remote.checked && !remote.reachable) {
    warnings.push(`The remote ${shownRemote} cannot be read: ${remote.reason}`);
  }
  return {
    configured: true,
    unreadable: false,
    backend,
    backendSupported,
    remote: shownRemote,
    branch,
    keyPresent,
    autosync: config.autosync === true,
    lastAutosync: lastAutosync(homeDir),
    checkout: state,
    checkoutRemote: displayRemote(follows.remote),
    checkoutBranch: follows.branch,
    lastSyncTime: state === 'repository' ? lastSyncTime(checkout, gitBudgetMs, env) : null,
    stateDocuments: countStateDocuments(homeDir),
    remoteCheck: remote,
    warnings,
    warningCount: warnings.length,
  };
}

function describeRemoteCheck(check) {
  if (!check.checked) return `not checked (${check.reason})`;
  if (!check.reachable) return `cannot be read: ${check.reason}`;
  return check.branchFound ? 'reachable' : 'reachable, no branch pushed yet';
}

function describeAutosync(report) {
  if (!report.autosync) return 'off';
  const last = report.lastAutosync;
  if (!last?.lastRun) return 'on (no run yet)';
  return `on (last run ${last.lastRun}, ${last.reason}, ${last.ok ? 'ok' : 'failed'})`;
}

function printWarnings(report, print) {
  for (const warning of report.warnings) {
    print(`  - [WARNING] ${warning}`);
  }
  print(`Team summary: warnings=${report.warningCount}`);
}

// The block as the doctor prints it; `print` takes one line at a time.
function printTeamReport(report, print = console.log) {
  if (!report.configured) {
    if (report.unreadable) {
      print(`\nTeam: configuration unreadable (${CONFIG_PATH_SHOWN})`);
      printWarnings(report, print);
      return;
    }
    print('\nTeam: not configured (egc team init --backend git --remote <url>, with --key <team key> to join a team)');
    return;
  }
  print(`\nTeam: ${report.backend} ${report.remote ?? '(no remote)'}, branch ${report.branch}, ${report.keyPresent ? 'key present' : 'key missing or invalid'}`);
  print(`  Last sync: ${report.lastSyncTime || 'never'}`);
  print(`  Local state: ${report.stateDocuments} files to seal`);
  print(`  Autosync: ${describeAutosync(report)}`);
  print(`  Remote: ${describeRemoteCheck(report.remoteCheck)}`);
  printWarnings(report, print);
}

module.exports = {
  GIT_BUDGET_MS,
  REMOTE_BUDGET_MS,
  buildTeamReport,
  printTeamReport,
  countStateDocuments,
  checkoutState,
  displayRemote,
  quietGitEnvironment,
};
