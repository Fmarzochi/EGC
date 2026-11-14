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
    fs.writeFileSync(stampPath(homeDir), JSON.stringify(stamp, null, 2), 'utf-8');
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

// Whether a run would start now: the switch on, and, when asked, a state
// document changed since the last run (or no run yet). The hooks ask this
// before giving up for lack of budget, so nothing is recorded as a run.
function wouldSync(options = {}) {
  const homeDir = options.homeDir ?? os.homedir();
  if (!isAutosyncOn(readTeamConfig(homeDir))) return false;
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
 * Resolves with { ran: false, why } when nothing ran ('off', 'unchanged' or
 * 'no-server'), or with { ran: true, ok, detail }.
 */
async function autosync(options = {}) {
  const homeDir = options.homeDir ?? os.homedir();
  const reason = options.reason ?? 'session';
  if (!isAutosyncOn(readTeamConfig(homeDir))) return { ran: false, why: 'off' };
  if (options.onlyIfStateChanged && !wouldSync({ homeDir, onlyIfStateChanged: true })) return { ran: false, why: 'unchanged' };
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
  writeStamp(homeDir, { lastRun: new Date().toISOString(), reason, ok: outcome.ok, detail: outcome.detail });
  appendLog(homeDir, reason, `${outcome.ok ? 'ok' : 'failed'}: ${outcome.detail}`);
  return { ran: true, ...outcome };
}

module.exports = { autosync, wouldSync, lastAutosync, clearAutosyncStamp, stateChangedSince, memoryServerScript, DEFAULT_BUDGET_MS };
