'use strict';

/**
 * The sync of the Team Brain that runs by itself around a session (#2059):
 * once when a session starts, before the project state is read, so the
 * state the other machine pushed is what this session restores; and once
 * when a response ends, when a state file changed since the last run, so
 * what update_state wrote leaves the machine. Off unless ~/.egc/team.json
 * says `autosync: true`.
 *
 * The sync is the memory server's team_sync, reached the way `egc team sync`
 * reaches it: one MCP session with the built server in a child process of
 * its own (team-mcp-client.js spawns the Node executable with the script,
 * never a shell), under the budget the hook passes; a server that does not
 * answer in the budget is stopped and the hook goes on. The outcome goes to
 * ~/.egc/logs/team-autosync.log and to the stamp ~/.egc/team-autosync.json
 * that `egc team status` reads, never to the tool's chat.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readTeamConfig, isAutosyncOn } = require('./team-config');
const { callMcpTool } = require('./team-mcp-client');

// The budget a hook gives the sync when it passes none: the one the
// session-end hook gives its git calls.
const DEFAULT_BUDGET_MS = 15000;
// How long a server that answered may take to leave before it is stopped;
// a hook is waiting on it, so shorter than the grace the CLI gives.
const EXIT_GRACE_MS = 2000;
const SERVER_RELATIVE = ['mcp', 'servers', 'egc-memory', 'build', 'index.js'];
const SIDECAR_SUFFIX = '.hmac';

function egcDir(homeDir) {
  return path.join(homeDir, '.egc');
}

function stampPath(homeDir) {
  return path.join(egcDir(homeDir), 'team-autosync.json');
}

function logPath(homeDir) {
  return path.join(egcDir(homeDir), 'logs', 'team-autosync.log');
}

// The built memory server: the one of the EGC root this file runs from (a
// source checkout or the npm package), else the one the shared resolver
// finds for an install that copied this file next to the hooks. Null when
// there is none: the hooks then say so in the log instead of failing.
function memoryServerScript() {
  const local = path.join(__dirname, '..', '..', ...SERVER_RELATIVE);
  if (fs.existsSync(local)) return local;
  try {
    const { resolveEGCRoot } = require('./resolve-egc-root');
    const candidate = path.join(resolveEGCRoot({ probe: SERVER_RELATIVE.join('/') }), ...SERVER_RELATIVE);
    return fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

// The record of the last run: when, why, and how it went; null before the
// first run or when the file cannot be read.
function lastAutosync(homeDir = os.homedir()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stampPath(homeDir), 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeStamp(homeDir, stamp) {
  try {
    fs.mkdirSync(egcDir(homeDir), { recursive: true });
    // Written whole and moved into place, so a reader never sees a partial stamp.
    const draft = `${stampPath(homeDir)}.${process.pid}.tmp`;
    fs.writeFileSync(draft, JSON.stringify(stamp, null, 2), 'utf-8');
    fs.renameSync(draft, stampPath(homeDir));
  } catch {
    // The stamp serves the status and the next run; a hook never fails on it.
  }
}

function appendLog(homeDir, reason, line) {
  try {
    fs.mkdirSync(path.dirname(logPath(homeDir)), { recursive: true });
    fs.appendFileSync(logPath(homeDir), `${new Date().toISOString()} ${reason}: ${line}\n`, 'utf-8');
  } catch {
    // A log that cannot be written never fails the hook.
  }
}

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

// What the sync never ships: the integrity sidecars and the hidden entries
// (the markers the hooks keep next to the state), a hidden directory hiding
// everything below it. The sync skips them, so a change in them is no
// reason to run it.
function isStateDocument(entry) {
  return entry.isFile() && !entry.name.endsWith(SIDECAR_SUFFIX) && !entry.name.startsWith('.');
}

// Whether a state document under ~/.egc/state was written after the given
// moment: the documents are what the sync ships, so nothing else counts.
function stateChangedSince(homeDir, sinceMs) {
  const pending = [path.join(egcDir(homeDir), 'state')];
  while (pending.length > 0) {
    const dir = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.')) pending.push(full);
      else if (isStateDocument(entry) && mtimeOf(full) > sinceMs) return true;
    }
  }
  return false;
}

// The floor between two automatic pulls of one machine: several tabs
// opening at once pull once, not once each. The push at the end of a
// response is paced by the state itself (it runs only when a document
// changed), so no push has a floor.
const PULL_FLOOR_MS = 20000;
// The runs that pull before the state is read; the floor is between them.
const PULL_REASONS = new Set(['session-start']);
// The claim one session holds while it pulls, so two sessions starting at
// once do not both pull before either has left its stamp. A claim older
// than this belongs to a session that died holding it, and is taken over.
const PULL_CLAIM_STALE_MS = 60000;

function pullClaimPath(homeDir) {
  return path.join(egcDir(homeDir), 'team-autosync.pull');
}

function claimIsStale(claim, nowMs, staleMs = PULL_CLAIM_STALE_MS) {
  try {
    return nowMs - fs.statSync(claim).mtimeMs >= staleMs;
  } catch {
    return true;
  }
}

// Takes the pull claim for this process: false when another live session
// of this machine holds it.
function claimPull(homeDir, nowMs = Date.now()) {
  const claim = pullClaimPath(homeDir);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(path.dirname(claim), { recursive: true });
      fs.writeFileSync(claim, JSON.stringify({ pid: process.pid, since: new Date(nowMs).toISOString() }), { flag: 'wx' });
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST' || !claimIsStale(claim, nowMs)) return false;
      try {
        fs.rmSync(claim, { force: true });
      } catch {
        return false;
      }
    }
  }
  return false;
}

function releasePull(homeDir) {
  try {
    fs.rmSync(pullClaimPath(homeDir), { force: true });
  } catch {
    // a claim that cannot be removed goes stale and is taken over
  }
}

// A short exclusive hold on the stamp while it is read and rewritten, so a
// push and a pull ending together do not lose each other's record. It waits
// a few moments at most, since a hook is waiting on it, and a hold left by
// a session that died is taken over.
const STAMP_HOLD_RETRIES = 10;
const STAMP_HOLD_WAIT_MS = 20;
const STAMP_HOLD_STALE_MS = 5000;

function stampHoldPath(homeDir) {
  return `${stampPath(homeDir)}.hold`;
}

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function holdStamp(homeDir) {
  const hold = stampHoldPath(homeDir);
  for (let attempt = 0; attempt < STAMP_HOLD_RETRIES; attempt += 1) {
    try {
      fs.mkdirSync(path.dirname(hold), { recursive: true });
      fs.writeFileSync(hold, String(process.pid), { flag: 'wx' });
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') return false;
      if (!claimIsStale(hold, Date.now(), STAMP_HOLD_STALE_MS)) {
        pause(STAMP_HOLD_WAIT_MS);
        continue;
      }
      try {
        fs.rmSync(hold, { force: true });
      } catch {
        return false;
      }
    }
  }
  return false;
}

function releaseStamp(homeDir) {
  try {
    fs.rmSync(stampHoldPath(homeDir), { force: true });
  } catch {
    // a hold that cannot be removed goes stale and is taken over
  }
}

// The record of a run. The moment of the last pull travels with it through
// the pushes, so the floor still holds after one; it is read and written
// under the hold, so two runs ending together keep each other's record.
function recordRun(homeDir, reason, outcome) {
  const held = holdStamp(homeDir);
  try {
    const lastRun = new Date().toISOString();
    const lastPull = PULL_REASONS.has(reason) ? lastRun : lastPullOf(lastAutosync(homeDir));
    writeStamp(homeDir, { lastRun, reason, ok: outcome.ok, detail: outcome.detail, lastPull });
  } finally {
    if (held) releaseStamp(homeDir);
  }
}

// The moment of the last automatic pull: its own field in the stamp, kept
// through the pushes written after it; a stamp from before that field
// names it by its reason.
function lastPullOf(stamp) {
  if (!stamp) return undefined;
  if (typeof stamp.lastPull === 'string') return stamp.lastPull;
  return PULL_REASONS.has(stamp.reason) && typeof stamp.lastRun === 'string' ? stamp.lastRun : undefined;
}

// Whether a pull now would come too soon after the last automatic pull.
function pullTooSoon(homeDir, reason, nowMs = Date.now()) {
  if (!PULL_REASONS.has(reason)) return false;
  const lastMs = Date.parse(lastPullOf(lastAutosync(homeDir)) ?? '');
  return Number.isFinite(lastMs) && nowMs - lastMs < PULL_FLOOR_MS;
}

// Whether a run would start now: the switch on, the floor between pulls
// respected, and, when asked, a state document changed since the last run
// (or no run yet). The hooks ask this before giving up for lack of budget,
// so nothing is recorded as a run.
function wouldSync(options = {}) {
  const homeDir = options.homeDir ?? os.homedir();
  if (!isAutosyncOn(readTeamConfig(homeDir))) return false;
  if (pullTooSoon(homeDir, options.reason)) return false;
  if (!options.onlyIfStateChanged) return true;
  const last = Date.parse(lastAutosync(homeDir)?.lastRun ?? '');
  return !Number.isFinite(last) || stateChangedSince(homeDir, last);
}

// Forgets the last run: a machine that joins another team starts its
// record anew, so the status never shows a run of the team before.
function clearAutosyncStamp(homeDir = os.homedir()) {
  try {
    fs.rmSync(stampPath(homeDir), { force: true });
  } catch {
    // a stamp that cannot be removed is overwritten by the next run
  }
}

// What a team_sync answer says: `success` with no error is a completed sync.
function describeAnswer(answer) {
  const result = answer?.result ?? {};
  const errors = Array.isArray(result.errors) ? result.errors : [];
  const ok = answer?.success === true && errors.length === 0;
  const detail = ok
    ? `pulled ${result.pulledCount ?? 0} files, pushed ${result.pushedCount ?? 0} commits`
    : (errors.join(' | ') || 'the server did not report a completed sync');
  return { ok, detail };
}

function serverEnvironment(homeDir) {
  return homeDir === os.homedir() ? process.env : { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
}

/**
 * Runs the sync when the configuration asks for it. Never rejects.
 *
 * options.reason              'session-start' or 'session-end', for the log and the stamp
 * options.budgetMs            how long the whole sync may take (15 s by default)
 * options.onlyIfStateChanged  skip when no state file changed since the last run
 * options.homeDir             the home to read and write (the person's by default)
 *
 * Resolves with { ran: false, why } when nothing ran ('off', 'unchanged',
 * 'no-server' or 'too-soon'), or with { ran: true, ok, detail }.
 */
async function autosync(options = {}) {
  const homeDir = options.homeDir ?? os.homedir();
  const reason = options.reason ?? 'session';
  if (!isAutosyncOn(readTeamConfig(homeDir))) return { ran: false, why: 'off' };
  // A pull runs under the claim of this machine: a second session starting
  // at the same moment finds it held and leaves the pull to the first.
  const pulls = PULL_REASONS.has(reason);
  if (pulls && !claimPull(homeDir)) {
    appendLog(homeDir, reason, 'skipped: another session of this machine is pulling right now');
    return { ran: false, why: 'too-soon' };
  }
  try {
    return await runAutosync(homeDir, reason, options);
  } finally {
    if (pulls) releasePull(homeDir);
  }
}

// The run itself, under the claim when it pulls.
async function runAutosync(homeDir, reason, options) {
  if (pullTooSoon(homeDir, reason)) {
    appendLog(homeDir, reason, `skipped: the last pull was under ${PULL_FLOOR_MS / 1000} s ago`);
    return { ran: false, why: 'too-soon' };
  }
  if (options.onlyIfStateChanged && !wouldSync({ homeDir, reason, onlyIfStateChanged: true })) return { ran: false, why: 'unchanged' };
  const serverScript = memoryServerScript();
  if (!serverScript) {
    appendLog(homeDir, reason, 'skipped: the memory server is not built or was not found');
    return { ran: false, why: 'no-server' };
  }
  let outcome;
  try {
    const answer = await callMcpTool('team_sync', {}, {
      serverScript,
      timeoutMs: Math.max(1, options.budgetMs ?? DEFAULT_BUDGET_MS),
      exitGraceMs: EXIT_GRACE_MS,
      clientName: 'egc-autosync',
      env: serverEnvironment(homeDir),
    });
    outcome = describeAnswer(answer);
  } catch (error) {
    outcome = { ok: false, detail: error?.message || String(error) };
  }
  // The stamp is taken after the run, so the files the merge itself wrote
  // do not count as a change for the next one.
  recordRun(homeDir, reason, outcome);
  appendLog(homeDir, reason, `${outcome.ok ? 'ok' : 'failed'}: ${outcome.detail}`);
  return { ran: true, ...outcome };
}

module.exports = { autosync, wouldSync, lastAutosync, clearAutosyncStamp, stateChangedSince, memoryServerScript, pullTooSoon, claimPull, releasePull, holdStamp, releaseStamp, DEFAULT_BUDGET_MS, PULL_FLOOR_MS, PULL_REASONS };
