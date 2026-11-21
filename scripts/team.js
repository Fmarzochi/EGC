#!/usr/bin/env node

const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');

const os = require('node:os');
const readline = require('node:readline');
const { execFileSync } = require('node:child_process');

const { callMcpTool: callMemoryTool } = require('./lib/team-mcp-client');
const { NOT_BUILT, loadRelay } = require('./lib/relay-module');
const { teamConfigPath, readTeamConfig, publishTeamConfigText, writeTeamConfig } = require('./lib/team-config');
const { lastAutosync, clearAutosyncStamp } = require('./lib/team-autosync');

const MEMORY_SERVER_SCRIPT = path.join(__dirname, '..', 'mcp', 'servers', 'egc-memory', 'build', 'index.js');
const TEAM_CONFIG_PATH = teamConfigPath();
// The sync checkout the memory server keeps next to the configuration.
const TEAM_SYNC_DIR = path.join(os.homedir(), '.egc', 'team-sync');
// The longest delay a Node timer takes; a larger one fires at once.
const MAX_TIMER_MS = 2147483647;
// How long one call to the memory server may take; a remote on a slow link
// can be given more through EGC_TEAM_CALL_TIMEOUT_MS (milliseconds).
const MCP_CALL_TIMEOUT_MS = callBudget(process.env.EGC_TEAM_CALL_TIMEOUT_MS, 60000);

// A budget is a whole number of milliseconds, above zero and within what a
// timer can hold; anything else is the default.
function callBudget(raw, fallback) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return fallback;
  const parsed = Number(raw.trim());
  return parsed > 0 && parsed <= MAX_TIMER_MS ? parsed : fallback;
}
// What a server that took the call and never answered most often waited
// for: a git that stopped to ask something no one could answer inside the
// server. A handshake that never came back is not git's doing.
const GIT_PROMPT_HINT = 'A git remote that asks a question (an unknown host key, a key passphrase, a credential) cannot be answered inside the server: '
  + 'run "git ls-remote <remote>" once in a terminal and answer it there, or give git a key or a credential helper that needs no prompt.';

// Prints the hint after a timeout of the call itself; a server that never
// answered the handshake ran no git.
function printPromptHint(err, print) {
  if (err.isTimeout && err.initialized) print(GIT_PROMPT_HINT);
}

// Resolve absolute git path once at startup to avoid PATH-reliance.
function resolveGitBin() {
  const lookupCmd = process.platform === 'win32' ? 'where' : 'which';
  let output;
  try {
    output = execFileSync(lookupCmd, ['git'], { encoding: 'utf-8', stdio: 'pipe' });
  } catch (err) {
    throw new Error(`git executable not found. Install git and ensure it is on PATH. ${err.message}`, { cause: err });
  }
  const gitPath = output.split('\n').map(s => s.trim()).find(Boolean);
  if (!gitPath || !path.isAbsolute(gitPath)) {
    throw new Error(`git executable not found at an absolute path (got: ${gitPath || 'none'})`);
  }
  return gitPath;
}

const GIT_BIN = resolveGitBin();

function safeGit(args, cwd) {
  return execFileSync(GIT_BIN, args, {
    cwd,
    stdio: 'pipe',
    encoding: 'utf-8',
  }).trim();
}

function showHelp() {
  console.log(`
EGC Team Memory: Sync state across teammates

Usage:
  egc team init --backend <backend> --remote <url> [--branch <branch>] [--key [<hex>]] [--no-autosync]
  egc team invite [--port <n>] [--host <address>] [--no-announce]
  egc team join [<host:port>]
  egc team sync
  egc team autosync on|off
  egc team leave
  egc team status

Commands:
  init      Configure a sync backend (e.g. git) and a remote URL
  invite    Hand the team to a new machine of yours by a short code: both screens show the same six
            digits, you confirm on both, and the key crosses sealed by the exchange (no key to copy)
  join      Join the team of your other machine by a short code: finds its invitation on the local
            network, or takes its address
  sync      Pull the teammates' sealed state, merge it, and push local state sealed with the team key
  autosync  Turn the sync around the session on or off: a sync when a session starts, before the
            state is read, and one after a response that changed the state (on from init)
  leave     Remove the configuration, the key and the sync checkout of this machine; the state
            files of this machine and the sealed state on the remote stay
  status    Show last sync time, conflict count, the autosync switch and its last run, and health

Options:
  --backend   Sync backend type (default: git)
  --remote    Remote URL for the sync storage
  --key       Team key (64 hex) shared by the member who initialized the team; alone, it asks for the
              key without showing it (nothing in the process list or the shell history); omit it to
              create a new team
  --branch    Git branch to use (default: main)
  --no-autosync  Leave the sync around the session off at init (it is on otherwise)

Examples:
  egc team init --backend git --remote git@github.com:org/egc-memory
  egc team init --backend git --remote git@github.com:org/egc-memory --branch team
  egc team init --backend git --remote git@github.com:org/egc-memory --key   # asks for the key, not shown
  egc team init --backend git --remote git@github.com:org/egc-memory --key <hex> --no-autosync
  egc team invite                      # on a machine of the team
  egc team join                        # on the new machine, same network
  egc team join 192.168.1.50:51234     # where the invitation is not found by itself
  egc team sync
  egc team autosync off
  egc team leave
  egc team status
`);
}

/**
 * One MCP session with the built memory server (scripts/lib/team-mcp-client.js
 * holds the session); a server that is not built ends the command here, since
 * nothing below can run without it.
 */
function callMcpTool(toolName, args) {
  if (!fs.existsSync(MEMORY_SERVER_SCRIPT)) {
    console.error(`Memory server not built. Run "npm run build" in mcp/servers/egc-memory/`);
    process.exit(1);
  }
  return callMemoryTool(toolName, args, { serverScript: MEMORY_SERVER_SCRIPT, timeoutMs: MCP_CALL_TIMEOUT_MS });
}

function optionValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

// The key of the team for an init: given on the command line; typed without
// echo when `--key` comes alone, so it reaches neither the process list nor
// the shell history; or made here for a new team, so the config is complete
// even when the memory server cannot be reached right now. A value that is
// not a key ends the command.
async function teamKeyForInit(args) {
  const keyIndex = args.indexOf('--key');
  if (keyIndex === -1) return { teamKey: crypto.randomBytes(32).toString('hex'), provided: false };
  const given = args[keyIndex + 1];
  const asked = given === undefined || given.startsWith('--');
  const teamKey = asked ? (await readHidden('Team key (64 hexadecimal characters, not shown): ')).trim() : given;
  if (!TEAM_KEY_RE.test(teamKey)) {
    console.error(asked
      ? 'Error: the key typed is not 64 hexadecimal characters (the key shared by the member who initialized the team)'
      : 'Error: --key must be followed by 64 hexadecimal characters (the key shared by the member who initialized the team), or given alone to type the key without showing it');
    process.exit(1);
  }
  return { teamKey, provided: true };
}

async function handleInit(args) {
  const backend = optionValue(args, '--backend', 'git');
  const remote = optionValue(args, '--remote', null);
  const branch = optionValue(args, '--branch', 'main');
  // The remote is checked before any prompt: a missing option is told at
  // once, not after the person typed a key.
  if (!remote) {
    console.error('Error: --remote is required for team init');
    process.exit(1);
  }
  const { teamKey, provided } = await teamKeyForInit(args);

  // On from init: the sync around the session is what a team of machines is
  // for; --no-autosync leaves it off on a machine that syncs by hand.
  const autosync = !args.includes('--no-autosync');
  const config = autosync ? { backend, remote, branch, teamKey, autosync } : { backend, remote, branch, teamKey };
  // The configuration this command found, put back when the server refuses
  // the init: a sync must not run with a remote or a branch the checkout
  // does not follow.
  const previous = fs.existsSync(TEAM_CONFIG_PATH) ? fs.readFileSync(TEAM_CONFIG_PATH) : null;

  writeTeamConfig(config);
  const report = () => {
    console.log(`Team initialized:
  Backend: ${backend}
  Remote:  ${displayRemote(remote)}
  Branch:  ${branch}
  Autosync: ${autosync ? 'on' : 'off'}
  Config:  ${TEAM_CONFIG_PATH}`);
    if (!provided) {
      console.log(`Team key (share it out of band; teammates join with --key):\n  ${teamKey}`);
    }
  };

  // The switch on top of whatever the server wrote: the server writes the
  // configuration it was given, without it, whether it answered or timed
  // out after writing. The record of the last automatic run belongs to the
  // team before, so it goes.
  const settle = () => {
    if (autosync) writeTeamConfig({ ...(readTeamConfig() ?? config), autosync: true });
    clearAutosyncStamp();
  };

  // Now try to connect and set up via MCP tool.
  try {
    const result = await callMcpTool('team_init', { backend, remote, branch, team_key: teamKey });
    settle();
    report();
    if (result) {
      console.log('Sync backend configured successfully.');
    }
  } catch (err) {
    // A refusal by the server (a remote it cannot read, a checkout that
    // follows another remote or branch) is a failure of the init itself,
    // not of the server being away: the configuration goes back to what it
    // was, and the cause has to be fixed before anything can sync.
    if (err.isToolError) {
      restoreTeamConfig(previous);
      console.error(`Error: ${err.message}`);
      console.error(previous === null ? 'No configuration was written.' : 'The previous configuration was kept.');
      process.exit(1);
    }
    settle();
    report();
    console.log(`Note: Memory server setup returned: ${err.message}`);
    printPromptHint(err, console.log);
    console.log('The config file is saved. Run "egc team sync" to start syncing.');
  }
}

// Puts back the team configuration a refused init found: the file as it
// was, or none when there was none.
function restoreTeamConfig(previous) {
  if (previous === null) {
    fs.rmSync(TEAM_CONFIG_PATH, { force: true });
    return;
  }
  publishTeamConfigText(previous);
}

// The switch of the sync around the session, in the configuration file
// where the rest of the team lives: the hooks read it on every session.
function handleAutosync(args) {
  const value = args[1];
  if (value !== 'on' && value !== 'off') {
    console.error('Error: egc team autosync takes "on" or "off"');
    process.exit(1);
  }
  const config = readTeamConfig();
  if (!config) {
    console.error('Error: Team not initialized. Run "egc team init" first.');
    process.exit(1);
  }
  const rest = { ...config };
  delete rest.autosync;
  writeTeamConfig(value === 'on' ? { ...rest, autosync: true } : rest);
  console.log(`Autosync: ${value}`);
  console.log(value === 'on'
    ? 'The state syncs when a session starts, before it is read, and after a response that changed it. The outcome of each run is in ~/.egc/logs/team-autosync.log.'
    : 'Nothing syncs by itself; run "egc team sync".');
}

// The autosync line of the status: the switch, and the last run when there
// was one.
function printAutosyncStatus(config) {
  const last = lastAutosync();
  let run = '';
  if (last?.lastRun) {
    const outcome = last.ok ? 'ok' : 'failed';
    run = ` (last run ${last.lastRun}, ${last.reason}, ${outcome}: ${last.detail})`;
  }
  console.log(`Autosync: ${config.autosync === true ? 'on' : 'off'}${run}`);
}

// The remote as the CLI shows it: a credential embedded in the URL is
// masked, and the raw value is only ever handed to git.
function displayRemote(remote) {
  try {
    const url = new URL(remote);
    if (!url.username && !url.password) return remote;
    url.username = '***';
    url.password = '';
    return url.toString();
  } catch {
    return remote;
  }
}

// Leaves the team on this machine: the configuration (with the key) and the
// sync checkout go, the state files of this machine stay, and the sealed
// state on the remote stays for the other machines. init --key joins again.
// A file that is not a readable configuration is refused, like every other
// team command refuses it, never removed.
function handleLeave() {
  if (!fs.existsSync(TEAM_CONFIG_PATH)) {
    console.error('Error: Team not initialized. Nothing to leave.');
    process.exit(1);
  }
  const config = readTeamConfig();
  if (!config) {
    console.error(`Error: ${TEAM_CONFIG_PATH} is not a readable team configuration. Nothing was removed; inspect the file before removing it by hand.`);
    process.exit(1);
  }
  fs.rmSync(TEAM_CONFIG_PATH, { force: true });
  fs.rmSync(TEAM_SYNC_DIR, { recursive: true, force: true });
  clearAutosyncStamp();
  const remote = typeof config.remote === 'string' && config.remote ? displayRemote(config.remote) : '<remote>';
  const branch = typeof config.branch === 'string' && config.branch ? ` --branch ${config.branch}` : '';
  console.log(`Left the team:
  Removed: ${TEAM_CONFIG_PATH} (the configuration and the key of this machine)
  Removed: ${TEAM_SYNC_DIR} (the sync checkout)
  Kept:    the state files of this machine under ~/.egc/state, and the sealed state on ${remote}
To join again: egc team init --backend ${config.backend ?? 'git'} --remote ${remote}${branch} --key <team key>`);
}

const TEAM_KEY_RE = /^[0-9a-f]{64}$/i;

// The team key typed without echo: it reaches neither the process list nor
// the shell history. A terminal is read key by key in raw mode; a piped
// stdin gives its first line.
function readHidden(prompt) {
  const input = process.stdin;
  process.stderr.write(prompt);
  return new Promise((resolve, reject) => {
    let typed = '';
    // The terminal is put back (echo on) whichever way the read ends: a
    // line, the end of the input, or an error of the input.
    const restore = () => {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onError);
      if (input.isTTY) input.setRawMode(false);
      input.pause();
      if (typeof input.unref === 'function') input.unref();
      process.stderr.write('\n');
    };
    const finish = value => {
      restore();
      resolve(value);
    };
    const onError = error => {
      restore();
      reject(error);
    };
    const onEnd = () => finish(typed);
    const onData = chunk => {
      for (const char of chunk) {
        if (char === '\u0003') {
          finish('');
          process.exit(130);
        }
        if (char === '\r' || char === '\n') {
          finish(typed);
          return;
        }
        if (char === '\u007f' || char === '\b') typed = typed.slice(0, -1);
        else typed += char;
      }
    };
    input.setEncoding('utf8');
    if (input.isTTY) input.setRawMode(true);
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('error', onError);
    input.resume();
  });
}

// The person, asked on this screen whether the other one shows the same code.
function askSameCode(pairing) {
  return code => new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\nCode: ${pairing.formatCode(code)}\nThe same six digits on the other screen? [y/N] `, answer => {
      rl.close();
      // A piped stdin would keep the process alive after the answer.
      if (typeof process.stdin.unref === 'function') process.stdin.unref();
      resolve(/^y(?:es)?$/i.test(answer.trim()));
    });
  });
}

function loadPairing() {
  const pairing = loadRelay('pairing');
  if (!pairing) {
    console.error(NOT_BUILT.trim());
    process.exit(1);
  }
  return pairing;
}

async function handleInvite(args) {
  const pairing = loadPairing();
  const team = readTeamConfig();
  if (!team || !TEAM_KEY_RE.test(team.teamKey ?? '')) {
    console.error('No team on this machine: run `egc team init` first, or join the team of your other machine with `egc team join`.');
    process.exit(1);
  }
  const port = Number(optionValue(args, '--port', '0'));
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('Error: --port takes a number from 0 to 65535');
    process.exit(1);
  }
  const central = loadRelay('mesh-config')?.readMeshConfig()?.central ?? null;
  const outcome = await pairing.invite({
    team,
    central,
    port,
    host: optionValue(args, '--host', '0.0.0.0'),
    announce: !args.includes('--no-announce'),
    confirm: askSameCode(pairing),
    onReady: info => {
      // An IPv6 address goes in brackets before the port, as join reads it.
      const shown = address => (address.includes(':') && !address.startsWith('[') ? `[${address}]` : address);
      const where = info.addresses.length > 0 ? info.addresses.map(address => `${shown(address)}:${info.port}`).join('  or  ') : `<this machine>:${info.port}`;
      const found = info.announced ? '\n  egc team join                 (finds this machine on the local network)' : '';
      console.log(`Waiting for your other machine (5 min). On it, run:${found}\n  egc team join ${where}`);
    },
  });
  if (!outcome.paired) {
    console.error(`Not paired: ${outcome.reason}`);
    process.exit(1);
  }
  console.log('Your other machine joined the team. Its sessions sync from here on; on it, `egc team sync` pulls the state now.');
}

async function handleJoin(args) {
  const pairing = loadPairing();
  const existing = readTeamConfig();
  if (existing && TEAM_KEY_RE.test(existing.teamKey ?? '')) {
    console.error(`This machine already has a team (${displayRemote(existing.remote)}): run \`egc team leave\` first to join another.`);
    process.exit(1);
  }
  // A configuration that is there but does not read as a team is not
  // written over: it may be damaged team data the person wants back.
  if (fs.existsSync(TEAM_CONFIG_PATH)) {
    console.error(`This machine has a team configuration that cannot be read as a team (${TEAM_CONFIG_PATH}): look at it, or run \`egc team leave\` to set it aside, before joining.`);
    process.exit(1);
  }
  const address = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
  if (!address) console.log('Looking for an invitation on the local network (3 s). On your other machine, run `egc team invite`.');
  const outcome = await pairing.join({ address, confirm: askSameCode(pairing) });
  if (!outcome.paired) {
    console.error(`Not joined: ${outcome.reason}`);
    process.exit(1);
  }
  console.log(`Joined the team:
  Remote:  ${displayRemote(outcome.team.remote)}
  Branch:  ${outcome.team.branch}
  Central: ${outcome.central ?? 'none yet (egc mesh connect when there is one)'}
  Config:  ${TEAM_CONFIG_PATH}
Run \`egc team sync\` to pull the state of your other machines now; the sessions sync by themselves from here on.`);
}

async function handleSync() {
  const config = readTeamConfig();
  if (!config) {
    console.error('Error: Team not initialized. Run "egc team init" first.');
    process.exit(1);
  }

  console.log('Syncing team memory...');
  let response;
  try {
    response = await callMcpTool('team_sync', {});
  } catch (err) {
    // State leaves this machine only sealed by the memory server; the old
    // direct git fallback pushed the state directory in the clear.
    console.error(`Error: team sync needs the memory server (${err.message}). Run "egc doctor" and try again.`);
    printPromptHint(err, console.error);
    process.exit(1);
  }

  // The tool answers { success, result }, where result carries the counts and
  // the errors of the run; anything else is not a completed sync.
  const result = response?.result ?? {};
  const errors = Array.isArray(result.errors) ? result.errors : [];
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const failed = response?.success !== true || errors.length > 0;
  console.log(failed ? 'Sync did not complete:' : 'Sync complete:');
  if (result.pulledCount !== undefined) console.log(`  Pulled: ${result.pulledCount} files`);
  if (result.pushedCount !== undefined) console.log(`  Pushed: ${result.pushedCount} commits`);
  if (result.rejectedCount !== undefined && result.rejectedCount > 0) {
    console.log(`  Rejected: ${result.rejectedCount} files (not verified team envelopes)`);
  }
  if (result.conflictCount !== undefined && result.conflictCount > 0) {
    console.log(`  Conflicts: ${result.conflictCount} (resolve manually in ~/.egc/team-sync/)`);
  }
  for (const warning of warnings) {
    console.log(`  Warning: ${warning}`);
  }
  for (const error of errors) {
    console.error(`  Error: ${error}`);
  }
  if (failed) process.exit(1);
}

function printFallbackStatus(config) {
  console.log(`Backend: ${config.backend}`);
  console.log(`Remote:  ${config.remote}`);
  console.log(`Branch:  ${config.branch}`);
  const syncDir = path.join(os.homedir(), '.egc', 'team-sync');
  const isRepo = fs.existsSync(path.join(syncDir, '.git'));
  console.log(`Repo:    ${isRepo ? 'initialized' : 'not initialized'}`);
  if (isRepo) {
    try {
      const log = safeGit(['log', '-1', '--format=%ai'], syncDir);
      if (log) console.log(`Last commit: ${log}`);
    } catch {
      // no commits yet
    }
  }
}

async function handleStatus() {
  const config = readTeamConfig();
  if (!config) {
    console.error('Error: Team not initialized. Run "egc team init" first.');
    process.exit(1);
  }

  try {
    // The tool answers { success, status }, where status carries the fields.
    const status = (await callMcpTool('team_status', {}))?.status ?? {};
    if (status.lastSyncTime) console.log(`Last sync: ${status.lastSyncTime}`);
    if (status.hasUncommittedChanges !== undefined) console.log(`Uncommitted changes: ${status.hasUncommittedChanges}`);
    if (status.conflictCount !== undefined && status.conflictCount > 0) console.log(`Conflicts: ${status.conflictCount}`);
    console.log(`Remote: ${status.remoteUrl || config.remote}`);
  } catch {
    printFallbackStatus(config);
  }
  printAutosyncStatus(config);
}

async function main() {
  // egc.js already strips the "team" command word before spawning this script,
  // so argv is ["node", "team.js", ...subcommandArgs]; slice(2) keeps them.
  const args = process.argv.slice(2);
  const firstArg = args[0];

  if (!firstArg || firstArg === '--help' || firstArg === '-h') {
    showHelp();
    process.exit(0);
  }

  switch (firstArg) {
    case 'init':
      await handleInit(args);
      break;

    case 'invite':
      await handleInvite(args);
      break;

    case 'join':
      await handleJoin(args);
      break;

    case 'sync':
      await handleSync();
      break;

    case 'autosync':
      handleAutosync(args);
      break;

    case 'leave':
      handleLeave();
      break;

    case 'status':
      await handleStatus();
      break;

    default:
      console.error(`Unknown team subcommand: ${firstArg}`);
      showHelp();
      process.exit(1);
  }
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
