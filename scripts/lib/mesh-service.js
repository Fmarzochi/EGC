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

function systemdQuote(word) {
  return /^[A-Za-z0-9_./:=@-]+$/.test(word) ? word : `"${word.replace(/(["\\])/g, '\\$1')}"`;
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

// The command as one line for the scheduler of Windows: every word quoted.
function windowsCommandLine(command) {
  return command.map(word => `"${word.replace(/"/g, '\\"')}"`).join(' ');
}

// A tool of the platform that must succeed; its own words come back in the
// error when it does not.
function runTool(run, file, args) {
  const result = run(file, args, TOOL_OPTIONS);
  if (result.error) throw new Error(`${file} could not run: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${file} ${args[0]} failed (${result.status}): ${String(result.stderr || result.stdout || '').trim()}`);
  return String(result.stdout || '');
}

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
  const command = serveCommand(args);
  if (platform === 'linux') return { platform, ...installLinux(command, home, run) };
  if (platform === 'darwin') return { platform, ...installDarwin(command, home, run) };
  if (platform === 'win32') return { platform, ...installWindows(command, run) };
  throw unsupported(platform);
}

function uninstallLinux(home, run) {
  const file = unitPath(home);
  const had = fs.existsSync(file);
  if (had) {
    run('systemctl', ['--user', 'disable', '--now', SERVICE_NAME], TOOL_OPTIONS);
    fs.rmSync(file, { force: true });
    runTool(run, 'systemctl', ['--user', 'daemon-reload']);
  }
  return { removed: had, path: file };
}

function uninstallDarwin(home, run) {
  const file = plistPath(home);
  const had = fs.existsSync(file);
  if (had) {
    run('launchctl', ['bootout', `gui/${uid()}`, file], TOOL_OPTIONS);
    fs.rmSync(file, { force: true });
  }
  return { removed: had, path: file };
}

function uninstallWindows(run) {
  const query = run('schtasks', ['/Query', '/TN', TASK_NAME], TOOL_OPTIONS);
  const had = query.status === 0;
  if (had) runTool(run, 'schtasks', ['/Delete', '/F', '/TN', TASK_NAME]);
  return { removed: had, path: null };
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
function serviceStatus({ platform = process.platform, home = os.homedir(), run = spawnSync } = {}) {
  if (platform === 'linux') {
    const file = unitPath(home);
    if (!fs.existsSync(file)) return { installed: false, active: false, path: file };
    const result = run('systemctl', ['--user', 'is-active', SERVICE_NAME], TOOL_OPTIONS);
    return { installed: true, active: String(result.stdout || '').trim() === 'active', path: file };
  }
  if (platform === 'darwin') {
    const file = plistPath(home);
    if (!fs.existsSync(file)) return { installed: false, active: false, path: file };
    const result = run('launchctl', ['print', `gui/${uid()}/${LAUNCHD_LABEL}`], TOOL_OPTIONS);
    return { installed: true, active: result.status === 0, path: file };
  }
  if (platform === 'win32') {
    const result = run('schtasks', ['/Query', '/TN', TASK_NAME, '/FO', 'LIST', '/V'], TOOL_OPTIONS);
    if (result.status !== 0) return { installed: false, active: false, path: null };
    return { installed: true, active: /\bRunning\b/.test(String(result.stdout || '')), path: null };
  }
  return { installed: false, active: false, path: null };
}

function serviceKind(platform) {
  if (platform === 'linux') return 'systemd user unit';
  if (platform === 'darwin') return 'launchd agent';
  return 'scheduled task';
}

function describeService(status, platform = process.platform) {
  if (!status.installed) return 'not installed (egc mesh serve --install runs the central at every login)';
  const kind = serviceKind(platform);
  return status.active ? `installed and running (${kind})` : `installed, not running (${kind}; egc mesh serve --install starts it again)`;
}

module.exports = {
  SERVICE_NAME,
  LAUNCHD_LABEL,
  TASK_NAME,
  serveCommand,
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
