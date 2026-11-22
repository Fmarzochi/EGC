'use strict';

// The central as a service of the person's session. `egc mesh serve
// --install` writes the unit of the platform and starts it, so the central
// comes back with every login; `--uninstall` stops it and removes the unit.
// Linux: a systemd user unit. macOS: a launchd agent. Windows: a task of the
// scheduler that runs at logon. Nothing here needs root.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SERVICE_NAME = 'egc-mesh';
const LAUNCHD_LABEL = 'com.egchq.egc.mesh';
const TASK_NAME = 'EGC Mesh';
const EGC_SCRIPT = path.join(__dirname, '..', 'egc.js');
const TOOL_OPTIONS = { encoding: 'utf8', stdio: 'pipe' };

function unitPath(home) {
  return path.join(home, '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
}

function plistPath(home) {
  return path.join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function uid() {
  return typeof process.getuid === 'function' ? process.getuid() : os.userInfo().uid;
}

// The command the service runs: this node, this egc, serve with the flags
// given (port, host, --no-announce), the same the person would type.
function serveCommand(args, node = process.execPath, script = EGC_SCRIPT) {
  return [node, script, 'mesh', 'serve', ...args];
}

// A word of ExecStart: % is a specifier to systemd, so it is doubled; a word
// with anything else unusual goes in quotes.
function systemdQuote(word) {
  const escaped = word.replace(/%/g, '%%');
  return /^[A-Za-z0-9_./:=@%-]+$/.test(escaped) ? escaped : `"${escaped.replace(/(["\\])/g, '\\$1')}"`;
}

function systemdUnit(command) {
  return [
    '[Unit]',
    'Description=EGC mesh central (relays between the machines of one person)',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    `ExecStart=${command.map(systemdQuote).join(' ')}`,
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function xmlEscape(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function launchdPlist(command, home) {
  const log = path.join(home, '.egc', 'logs', 'mesh-central.log');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${LAUNCHD_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...command.map(word => `    <string>${xmlEscape(word)}</string>`),
    '  </array>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    `  <key>StandardOutPath</key><string>${xmlEscape(log)}</string>`,
    `  <key>StandardErrorPath</key><string>${xmlEscape(log)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

// One word quoted the way Windows reads a command line: a quote inside is
// escaped together with the backslashes right before it, and backslashes at
// the end are doubled so they do not escape the closing quote.
function windowsQuote(word) {
  let out = '';
  let slashes = 0;
  for (const char of word) {
    if (char === '\\') {
      slashes += 1;
    } else if (char === '"') {
      out += `${'\\'.repeat(slashes * 2 + 1)}"`;
      slashes = 0;
    } else {
      out += `${'\\'.repeat(slashes)}${char}`;
      slashes = 0;
    }
  }
  return `"${out}${'\\'.repeat(slashes * 2)}"`;
}

// The command as one line for the scheduler of Windows: every word quoted.
function windowsCommandLine(command) {
  return command.map(windowsQuote).join(' ');
}

const MAX_PORT = 65535;

// The flags of serve, checked before anything is written: a unit that runs
// a serve that refuses its own arguments would fail at every login.
function validateServeArgs(args) {
  const clean = [];
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at];
    if (arg === '--no-announce') {
      clean.push(arg);
    } else if (arg === '--port' || arg === '--host') {
      const value = args[at + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      if (arg === '--port' && !(/^\d{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= MAX_PORT)) throw new Error(`--port takes a number from 1 to ${MAX_PORT}, not ${value}`);
      clean.push(arg, value);
      at += 1;
    } else {
      throw new Error(`serve does not take ${arg}; the service takes --port, --host and --no-announce`);
    }
  }
  return clean;
}

function toolWords(result) {
  return String(result.stderr || result.stdout || '').trim();
}

// A tool of the platform that must succeed; its own words come back in the
// error when it does not.
function runTool(run, file, args) {
  const result = run(file, args, TOOL_OPTIONS);
  if (result.error) throw new Error(`${file} could not run: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${file} ${args[0]} failed (${result.status}): ${toolWords(result)}`);
  return String(result.stdout || '');
}

// A tool that may fail for one expected reason (nothing to stop, nothing
// loaded): that answer is fine, any other failure is reported.
function runTolerating(run, file, args, tolerated) {
  const result = run(file, args, TOOL_OPTIONS);
  if (result.error) throw new Error(`${file} could not run: ${result.error.message}`);
  if (result.status !== 0 && !tolerated.test(toolWords(result))) throw new Error(`${file} ${args[0]} failed (${result.status}): ${toolWords(result)}`);
  return result;
}

const NOT_LOADED = /not loaded|does not exist|no such file|could not find|no such process|not found/i;
const MISSING_TASK = /cannot find|does not exist|not found/i;
const NOT_RUNNING = /not (currently )?running|no running instance|unable to end/i;

function installLinux(command, home, run) {
  const file = unitPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, systemdUnit(command), { mode: 0o644 });
  runTool(run, 'systemctl', ['--user', 'daemon-reload']);
  runTool(run, 'systemctl', ['--user', 'enable', '--now', SERVICE_NAME]);
  return { path: file, hint: `The central runs while you are logged in. For it to run with the machine on and nobody logged in: loginctl enable-linger ${os.userInfo().username}` };
}

function installDarwin(command, home, run) {
  const file = plistPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.join(home, '.egc', 'logs'), { recursive: true });
  fs.writeFileSync(file, launchdPlist(command, home), { mode: 0o644 });
  // A previous load of the same agent, if any, goes first; its absence is no error.
  run('launchctl', ['bootout', `gui/${uid()}`, file], TOOL_OPTIONS);
  runTool(run, 'launchctl', ['bootstrap', `gui/${uid()}`, file]);
  return { path: file, hint: 'The central runs while you are logged in and the Mac is awake: in System Settings, Energy, keep the Mac from sleeping while it serves your other machines.' };
}

function installWindows(command, run) {
  runTool(run, 'schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', TASK_NAME, '/TR', windowsCommandLine(command)]);
  runTool(run, 'schtasks', ['/Run', '/TN', TASK_NAME]);
  return { path: null, hint: 'The central runs at every logon while the machine is awake: in Settings, Power, set Sleep to Never while it serves your other machines.' };
}

function unsupported(platform) {
  return new Error(`no service for ${platform}: run egc mesh serve in a terminal, or under the supervisor of this system`);
}

// The service written and started; the hint says what the platform still
// asks of the person (lingering, sleep).
function installService({ platform = process.platform, home = os.homedir(), args = [], run = spawnSync } = {}) {
  const command = serveCommand(validateServeArgs(args));
  if (platform === 'linux') return { platform, ...installLinux(command, home, run) };
  if (platform === 'darwin') return { platform, ...installDarwin(command, home, run) };
  if (platform === 'win32') return { platform, ...installWindows(command, run) };
  throw unsupported(platform);
}

// The service is stopped before its unit goes: a stop that fails leaves the
// unit in place and is reported, so no running central is left without the
// unit that manages it. A service that was not loaded is nothing to stop.
function uninstallLinux(home, run) {
  const file = unitPath(home);
  const had = fs.existsSync(file);
  if (had) {
    runTolerating(run, 'systemctl', ['--user', 'disable', '--now', SERVICE_NAME], NOT_LOADED);
    fs.rmSync(file, { force: true });
    runTool(run, 'systemctl', ['--user', 'daemon-reload']);
  }
  return { removed: had, path: file };
}

function uninstallDarwin(home, run) {
  const file = plistPath(home);
  const had = fs.existsSync(file);
  if (had) {
    runTolerating(run, 'launchctl', ['bootout', `gui/${uid()}`, file], NOT_LOADED);
    fs.rmSync(file, { force: true });
  }
  return { removed: had, path: file };
}

// Whether the task is there: a query that fails for any reason other than a
// missing task (the tool absent, access denied) is reported, not read as absence.
function windowsTaskPresent(run) {
  const query = run('schtasks', ['/Query', '/TN', TASK_NAME, '/FO', 'LIST', '/V'], TOOL_OPTIONS);
  if (query.error) throw new Error(`schtasks could not run: ${query.error.message}`);
  if (query.status === 0) return { present: true, output: String(query.stdout || '') };
  if (MISSING_TASK.test(toolWords(query))) return { present: false, output: '' };
  throw new Error(`schtasks /Query failed (${query.status}): ${toolWords(query)}`);
}

function uninstallWindows(run) {
  const task = windowsTaskPresent(run);
  if (task.present) {
    // The task is ended before it is deleted: deleting alone leaves a
    // running central behind. A task not running is nothing to end.
    runTolerating(run, 'schtasks', ['/End', '/TN', TASK_NAME], NOT_RUNNING);
    runTool(run, 'schtasks', ['/Delete', '/F', '/TN', TASK_NAME]);
  }
  return { removed: task.present, path: null };
}

// The service stopped and its unit removed; removed says whether there was
// one to remove.
function uninstallService({ platform = process.platform, home = os.homedir(), run = spawnSync } = {}) {
  if (platform === 'linux') return { platform, ...uninstallLinux(home, run) };
  if (platform === 'darwin') return { platform, ...uninstallDarwin(home, run) };
  if (platform === 'win32') return { platform, ...uninstallWindows(run) };
  throw unsupported(platform);
}

// Whether the service is installed and running, from the unit and the tool
// of the platform; a platform without a service answers not installed.
// A tool that could not run at all: its words travel in `problem`, so the
// status says the state could not be read instead of calling it stopped.
function toolProblem(result) {
  return result.error ? `${result.error.message}` : null;
}

// Whether the service is installed and running, from the unit and the tool
// of the platform; a platform without a service answers not installed.
function serviceStatus({ platform = process.platform, home = os.homedir(), run = spawnSync } = {}) {
  if (platform === 'linux') {
    const file = unitPath(home);
    if (!fs.existsSync(file)) return { installed: false, active: false, path: file, problem: null };
    const result = run('systemctl', ['--user', 'is-active', SERVICE_NAME], TOOL_OPTIONS);
    const problem = toolProblem(result);
    return { installed: true, active: problem === null && String(result.stdout || '').trim() === 'active', path: file, problem };
  }
  if (platform === 'darwin') {
    const file = plistPath(home);
    if (!fs.existsSync(file)) return { installed: false, active: false, path: file, problem: null };
    const result = run('launchctl', ['print', `gui/${uid()}/${LAUNCHD_LABEL}`], TOOL_OPTIONS);
    const problem = toolProblem(result);
    return { installed: true, active: problem === null && result.status === 0, path: file, problem };
  }
  if (platform === 'win32') {
    let task;
    try {
      task = windowsTaskPresent(run);
    } catch (error) {
      return { installed: false, active: false, path: null, problem: error instanceof Error ? error.message : String(error) };
    }
    return { installed: task.present, active: task.present && /\bRunning\b/.test(task.output), path: null, problem: null };
  }
  return { installed: false, active: false, path: null, problem: null };
}

function serviceKind(platform) {
  if (platform === 'linux') return 'systemd user unit';
  if (platform === 'darwin') return 'launchd agent';
  return 'scheduled task';
}

function describeService(status, platform = process.platform) {
  if (status.problem) return `${status.installed ? 'installed, ' : ''}state could not be read (${status.problem})`;
  if (!status.installed) return 'not installed (egc mesh serve --install runs the central at every login)';
  const kind = serviceKind(platform);
  return status.active ? `installed and running (${kind})` : `installed, not running (${kind}; egc mesh serve --install starts it again)`;
}

module.exports = {
  SERVICE_NAME,
  LAUNCHD_LABEL,
  TASK_NAME,
  serveCommand,
  validateServeArgs,
  systemdUnit,
  launchdPlist,
  windowsCommandLine,
  unitPath,
  plistPath,
  installService,
  uninstallService,
  serviceStatus,
  describeService,
};
