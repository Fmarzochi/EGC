'use strict';

// The Team Brain sync at the turn boundary of the hosts that have no session
// start or stop hook (Antigravity, Codex, Trae, Amp, Kiro): a sync once per
// session before its first prompt is answered, which pulls what the other
// machine pushed and pushes what this machine has that the remote lacks, so
// the state the agent restores is the shared one; and on the later turns a
// push when a state document changed since the last run. Synchronous on
// purpose: the hosts call it from handlers that cannot wait on a promise,
// so the sync runs in a child the caller waits for inside a deadline below
// the hosts' own hook timeouts (10 seconds on Kiro and on Antigravity).

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The budget the sync itself gets, and the whole wait on the child: the
// budget, the two seconds the client gives a server that answered to leave,
// and the start of Node itself, all under the ten seconds of the strictest
// host.
const TURN_BUDGET_MS = 6000;
const CHILD_TIMEOUT_MS = 9000;
// A session the host does not name syncs whole again after this long, so a
// host without session ids still sees the other machine now and then.
const ANONYMOUS_AGAIN_MS = 10 * 60 * 1000;
const RUNNER = path.join(__dirname, 'team-autosync-run.js');

// The mark of a session that synced at its first turn is named by a hash of
// the raw session id, so two sessions never share one; the notice cache
// flattens the id and is kept apart.
function markKey(sessionId) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  return id ? crypto.createHash('sha256').update(id).digest('hex').slice(0, 24) : 'anon';
}

function markPath(homeDir, key) {
  return path.join(homeDir, '.egc', 'mesh', `team-pull-${key}.json`);
}

// Whether this session already synced at its start: a regular file of its
// own (a link at the name is nobody's mark), and a fresh one when the
// session is anonymous.
function syncedAlready(homeDir, key) {
  try {
    const stat = fs.lstatSync(markPath(homeDir, key));
    if (!stat.isFile()) return false;
    return key !== 'anon' || Date.now() - stat.mtimeMs < ANONYMOUS_AGAIN_MS;
  } catch {
    return false;
  }
}

// The mark is written whole into a sibling created exclusively, so a link
// planted at the name is never followed, then moved into place.
function markSynced(homeDir, key) {
  const mark = markPath(homeDir, key);
  try {
    fs.mkdirSync(path.dirname(mark), { recursive: true, mode: 0o700 });
    const draft = `${mark}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    const descriptor = fs.openSync(draft, 'wx', 0o600);
    try {
      fs.writeSync(descriptor, JSON.stringify({ syncedAt: new Date().toISOString() }));
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(draft, mark);
  } catch {
    // an unwritable mark only costs another sync at the next turn
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

// Never throws: { ran: false, why } when nothing ran, else the runner's
// outcome. The first turn of a session syncs whole, and the session is
// marked only when that sync ran, or when another session of this machine
// was pulling at that moment (its pull is as good as ours), so a first sync
// the server or the budget denied is tried again at the next prompt.
// `run` is the sync itself, replaceable by a test.
function turnSync({ sessionId, homeDir = os.homedir(), run = runSync } = {}) {
  try {
    const { readTeamConfig, isAutosyncOn } = require('./team-config');
    if (!isAutosyncOn(readTeamConfig(homeDir))) return { ran: false, why: 'off' };
  } catch {
    return { ran: false, why: 'unavailable' };
  }
  const key = markKey(sessionId);
  if (syncedAlready(homeDir, key)) return run(homeDir, 'turn', true);
  const outcome = run(homeDir, 'turn-start', false);
  if (outcome?.ran === true || outcome?.why === 'too-soon') markSynced(homeDir, key);
  return outcome;
}

module.exports = { turnSync, markKey, TURN_BUDGET_MS, CHILD_TIMEOUT_MS };
