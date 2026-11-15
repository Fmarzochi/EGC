'use strict';

// The Team Brain sync at the turn boundary of the hosts that have no session
// start or stop hook (Antigravity, Codex, Trae, Amp, Kiro): a pull once per
// session before its first prompt is answered, so the state the agent
// restores is the one the other machine pushed, and on the later turns a
// push when a state document changed since the last run. Synchronous on
// purpose: the hosts call it from handlers that cannot wait on a promise,
// so the sync runs in a child the caller waits for inside a budget below
// the hosts' own hook timeouts (10 seconds on Kiro and on Antigravity).

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TURN_BUDGET_MS = 8000;
// The wait on the child: the budget, the moments the sync client gives a
// server that answered to leave, and the start of Node itself.
const CHILD_TIMEOUT_MS = TURN_BUDGET_MS + 6000;
// A session the host does not name pulls again after this long, so a host
// without session ids still sees the other machine now and then.
const ANONYMOUS_PULL_AGAIN_MS = 10 * 60 * 1000;
const RUNNER = path.join(__dirname, 'team-autosync-run.js');

function pullMarkPath(homeDir, sessionKey) {
  return path.join(homeDir, '.egc', 'mesh', `team-pull-${sessionKey}.json`);
}

// Whether this session already pulled: a mark of this session, and a fresh
// one when the session is anonymous.
function pulledAlready(homeDir, sessionKey) {
  try {
    const stat = fs.statSync(pullMarkPath(homeDir, sessionKey));
    return sessionKey !== 'anon' || Date.now() - stat.mtimeMs < ANONYMOUS_PULL_AGAIN_MS;
  } catch {
    return false;
  }
}

function markPulled(homeDir, sessionKey) {
  try {
    fs.mkdirSync(path.dirname(pullMarkPath(homeDir, sessionKey)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(pullMarkPath(homeDir, sessionKey), JSON.stringify({ pulledAt: new Date().toISOString() }));
  } catch {
    // an unwritable mark only costs another pull on the next turn
  }
}

function runSync(homeDir, reason, onlyIfStateChanged) {
  const args = [RUNNER, '--reason', reason, '--budget', String(TURN_BUDGET_MS)];
  if (onlyIfStateChanged) args.push('--only-if-changed');
  const env = homeDir === os.homedir() ? process.env : { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
  const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    return JSON.parse(result.stdout || '');
  } catch {
    return { ran: false, why: result.error ? 'runner' : 'timeout' };
  }
}

// Never throws: { ran: false, why } when nothing ran, else the runner's outcome.
function turnSync({ sessionKey = 'anon', homeDir = os.homedir() } = {}) {
  try {
    const { readTeamConfig, isAutosyncOn } = require('./team-config');
    if (!isAutosyncOn(readTeamConfig(homeDir))) return { ran: false, why: 'off' };
  } catch {
    return { ran: false, why: 'unavailable' };
  }
  if (!pulledAlready(homeDir, sessionKey)) {
    markPulled(homeDir, sessionKey);
    return runSync(homeDir, 'turn-start', false);
  }
  return runSync(homeDir, 'turn', true);
}

module.exports = { turnSync, TURN_BUDGET_MS };
