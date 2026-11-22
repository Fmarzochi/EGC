/**
 * The central as a service (scripts/lib/mesh-service.js): the unit each
 * platform gets, the tools it calls, what status reads back, and the CLI
 * installing against a stand-in systemctl on Linux. The tools of the
 * platforms are stand-ins that record their calls; nothing here touches the
 * services of the machine that runs the suite.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const service = require('../../scripts/lib/mesh-service');

const MESH_CLI = path.join(__dirname, '..', '..', 'scripts', 'mesh.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    failed++;
  }
}

// A stand-in for the tools of a platform: every call recorded, each answer
// scripted by tool name, success by default.
function fakeTools(answers = {}) {
  const calls = [];
  const run = (file, args) => {
    calls.push([file, ...args]);
    const answer = answers[file] ? answers[file](args) : null;
    return { status: 0, stdout: '', stderr: '', ...(answer || {}) };
  };
  return { calls, run };
}

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'egc-mesh-service-'));
}

console.log('\n=== Testing the central as a service ===\n');
const homes = [];

test('on Linux, install writes the systemd user unit with the serve command and enables it, status reads it, uninstall removes it', () => {
  const home = tempHome();
  homes.push(home);
  const tools = fakeTools({ systemctl: args => (args[1] === 'is-active' ? { stdout: 'active\n' } : null) });
  const installed = service.installService({ platform: 'linux', home, args: ['--port', '47471', '--no-announce'], run: tools.run });
  assert.strictEqual(installed.path, service.unitPath(home));
  const unit = fs.readFileSync(installed.path, 'utf8');
  assert.strictEqual(unit, service.systemdUnit(service.serveCommand(['--port', '47471', '--no-announce'])), 'the unit is the one the generator gives for this node and these flags');
  assert.ok(unit.includes(' mesh serve --port 47471 --no-announce'), unit);
  assert.ok(unit.includes('WantedBy=default.target'), unit);
  assert.deepStrictEqual(tools.calls, [
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'enable', '--now', service.SERVICE_NAME],
  ]);
  assert.ok(installed.hint.includes('loginctl enable-linger'), installed.hint);
  const status = service.serviceStatus({ platform: 'linux', home, run: tools.run });
  assert.deepStrictEqual(status, { installed: true, active: true, path: installed.path, problem: null });
  assert.ok(service.describeService(status, 'linux').startsWith('installed and running'));
  const removed = service.uninstallService({ platform: 'linux', home, run: tools.run });
  assert.strictEqual(removed.removed, true);
  assert.ok(!fs.existsSync(installed.path), 'the unit is gone');
  assert.deepStrictEqual(tools.calls.slice(-2), [
    ['systemctl', '--user', 'disable', '--now', service.SERVICE_NAME],
    ['systemctl', '--user', 'daemon-reload'],
  ]);
  assert.strictEqual(service.serviceStatus({ platform: 'linux', home, run: tools.run }).installed, false);
  assert.strictEqual(service.uninstallService({ platform: 'linux', home, run: tools.run }).removed, false, 'nothing to remove the second time');
});

test('on macOS, install writes the launchd agent with the command as ProgramArguments and bootstraps it; uninstall boots it out', () => {
  const home = tempHome();
  homes.push(home);
  const tools = fakeTools({ launchctl: args => (args[0] === 'print' ? { status: 0 } : null) });
  const installed = service.installService({ platform: 'darwin', home, args: ['--host', '0.0.0.0'], run: tools.run });
  assert.strictEqual(installed.path, service.plistPath(home));
  const plist = fs.readFileSync(installed.path, 'utf8');
  assert.ok(plist.includes(`<string>${service.LAUNCHD_LABEL}</string>`), plist);
  assert.ok(plist.includes(`<string>${process.execPath}</string>`), plist);
  assert.ok(plist.includes('<string>serve</string>') && plist.includes('<string>0.0.0.0</string>'), plist);
  assert.ok(plist.includes('<key>KeepAlive</key><true/>'), plist);
  assert.strictEqual(tools.calls[0][0], 'launchctl');
  assert.strictEqual(tools.calls[0][1], 'bootout', 'a previous load goes first');
  assert.deepStrictEqual(tools.calls[1].slice(0, 2), ['launchctl', 'bootstrap']);
  assert.strictEqual(service.serviceStatus({ platform: 'darwin', home, run: tools.run }).active, true);
  const removed = service.uninstallService({ platform: 'darwin', home, run: tools.run });
  assert.strictEqual(removed.removed, true);
  assert.ok(!fs.existsSync(installed.path));
  assert.strictEqual(tools.calls.at(-1)[1], 'bootout');
});

test('on Windows, install creates the task at logon with every word of the command quoted and runs it; status reads Running; uninstall deletes it', () => {
  const tools = fakeTools({ schtasks: args => (args[0] === '/Query' ? { status: 0, stdout: 'TaskName: \\EGC Mesh\nStatus: Running\n' } : null) });
  const installed = service.installService({ platform: 'win32', home: 'C:\\Users\\me', args: ['--port', '47470'], run: tools.run });
  assert.strictEqual(installed.path, null);
  const create = tools.calls[0];
  assert.deepStrictEqual(create.slice(0, 7), ['schtasks', '/Create', '/F', '/SC', 'ONLOGON', '/TN', service.TASK_NAME]);
  assert.strictEqual(create[7], '/TR');
  assert.ok(create[8].includes(`"${process.execPath}"`) && create[8].endsWith('"mesh" "serve" "--port" "47470"'), create[8]);
  assert.deepStrictEqual(tools.calls[1], ['schtasks', '/Run', '/TN', service.TASK_NAME]);
  const status = service.serviceStatus({ platform: 'win32', run: tools.run });
  assert.deepStrictEqual(status, { installed: true, active: true, path: null, problem: null });
  assert.ok(service.describeService(status, 'win32').includes('scheduled task'));
  const removed = service.uninstallService({ platform: 'win32', run: tools.run });
  assert.strictEqual(removed.removed, true);
  assert.deepStrictEqual(tools.calls.at(-2), ['schtasks', '/End', '/TN', service.TASK_NAME], 'the task is ended before it is deleted');
  assert.deepStrictEqual(tools.calls.at(-1), ['schtasks', '/Delete', '/F', '/TN', service.TASK_NAME]);
});

test('a tool that fails is reported with its own words, and a platform without a service is refused with the way out', () => {
  const home = tempHome();
  homes.push(home);
  const tools = fakeTools({ systemctl: args => (args[1] === 'enable' ? { status: 1, stderr: 'Failed to connect to bus: No medium found' } : null) });
  assert.throws(
    () => service.installService({ platform: 'linux', home, run: tools.run }),
    /systemctl --user failed \(1\): Failed to connect to bus/
  );
  assert.throws(() => service.installService({ platform: 'freebsd', home, run: tools.run }), /no service for freebsd: run egc mesh serve in a terminal/);
  const elsewhere = service.serviceStatus({ platform: 'freebsd', home, run: tools.run });
  assert.deepStrictEqual(elsewhere, { installed: false, active: false, path: null, problem: null });
  assert.match(service.describeService(elsewhere, 'freebsd'), /no service on freebsd .*run egc mesh serve in a terminal/, 'the status does not promise an install that would be refused');
});

test('the flags of serve are checked before anything is written', () => {
  const home = tempHome();
  homes.push(home);
  const tools = fakeTools();
  assert.throws(() => service.installService({ platform: 'linux', home, args: ['--port', '70000'], run: tools.run }), /--port takes a number from 1 to 65535, not 70000/);
  assert.throws(() => service.installService({ platform: 'linux', home, args: ['--bogus'], run: tools.run }), /serve does not take --bogus/);
  assert.throws(() => service.installService({ platform: 'linux', home, args: ['--host'], run: tools.run }), /--host needs a value/);
  assert.ok(!fs.existsSync(service.unitPath(home)), 'no unit was written');
  assert.deepStrictEqual(tools.calls, [], 'no tool was called');
  assert.deepStrictEqual(service.validateServeArgs(['--port', '47470', '--host', '::', '--no-announce']), ['--port', '47470', '--host', '::', '--no-announce']);
});

test('a stop that fails keeps the unit and is reported; a service that was not loaded is nothing to stop', () => {
  const home = tempHome();
  homes.push(home);
  const failing = fakeTools({ systemctl: args => (args[1] === 'disable' ? { status: 1, stderr: 'Failed to stop egc-mesh.service: Access denied' } : null) });
  service.installService({ platform: 'linux', home, run: failing.run });
  assert.throws(() => service.uninstallService({ platform: 'linux', home, run: failing.run }), /systemctl --user failed \(1\): Failed to stop/);
  assert.ok(fs.existsSync(service.unitPath(home)), 'the unit stays while the service may still run');
  const unloaded = fakeTools({ systemctl: args => (args[1] === 'disable' ? { status: 1, stderr: 'Unit egc-mesh.service not loaded.' } : null) });
  assert.strictEqual(service.uninstallService({ platform: 'linux', home, run: unloaded.run }).removed, true);
  assert.ok(!fs.existsSync(service.unitPath(home)));
});

test('a tool that cannot run shows in the status as a state that could not be read, and a query the scheduler refuses is not read as absence', () => {
  const home = tempHome();
  homes.push(home);
  const ok = fakeTools();
  service.installService({ platform: 'linux', home, run: ok.run });
  const missing = fakeTools({ systemctl: () => ({ status: null, error: new Error('spawnSync systemctl ENOENT') }) });
  const status = service.serviceStatus({ platform: 'linux', home, run: missing.run });
  assert.strictEqual(status.installed, true);
  assert.strictEqual(status.active, false);
  assert.match(status.problem, /ENOENT/);
  assert.match(service.describeService(status, 'linux'), /installed, state could not be read \(.*ENOENT/);
  const denied = fakeTools({ schtasks: () => ({ status: 1, stderr: 'ERROR: Access is denied.' }) });
  const windows = service.serviceStatus({ platform: 'win32', run: denied.run });
  assert.strictEqual(windows.installed, false);
  assert.match(windows.problem, /Access is denied/);
  assert.throws(() => service.uninstallService({ platform: 'win32', run: denied.run }), /Access is denied/);
  const absent = fakeTools({ schtasks: () => ({ status: 1, stderr: 'ERROR: The system cannot find the file specified.' }) });
  assert.deepStrictEqual(service.serviceStatus({ platform: 'win32', run: absent.run }), { installed: false, active: false, path: null, problem: null });
  assert.strictEqual(service.uninstallService({ platform: 'win32', run: absent.run }).removed, false);
});

test('the unit, the plist and the command line of Windows quote what needs quoting', () => {
  const unit = service.systemdUnit(['/opt/node js/node', '/x/egc.js', 'mesh', 'serve', '--host', 'name%eth0']);
  assert.ok(unit.includes('ExecStart="/opt/node js/node" /x/egc.js mesh serve --host name%%eth0'), unit);
  const plist = service.launchdPlist(['/n', '/x/egc.js', 'mesh', 'serve', '--host', 'a&b'], '/home/me');
  assert.ok(plist.includes('<string>a&amp;b</string>'), plist);
  assert.strictEqual(service.windowsCommandLine(['C:\\n.exe', 'say "hi"']), '"C:\\n.exe" "say \\"hi\\""');
  assert.strictEqual(service.windowsCommandLine(['C:\\dir\\', 'x\\"y']), '"C:\\dir\\\\" "x\\\\\\"y"', 'backslashes before a quote and at the end are doubled');
});

if (process.platform === 'linux') {
  test('egc mesh serve --install on Linux writes the unit and calls systemctl; --uninstall removes it; status tells', () => {
    const home = tempHome();
    homes.push(home);
    fs.mkdirSync(path.join(home, '.egc'), { recursive: true, mode: 0o700 });
    // A stand-in systemctl ahead on the PATH records its calls and succeeds;
    // is-active answers active, so the status reads running.
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    const log = path.join(home, 'systemctl.log');
    fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\necho "$@" >> "${log}"\ncase "$*" in *is-active*) echo active;; esac\nexit 0\n`, { mode: 0o755 });
    const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    const install = spawnSync(process.execPath, [MESH_CLI, 'serve', '--install', '--port', '47472'], { encoding: 'utf8', env });
    assert.strictEqual(install.status, 0, `${install.stdout}\n${install.stderr}`);
    assert.ok(install.stdout.includes('Service:'), install.stdout);
    const unit = fs.readFileSync(service.unitPath(home), 'utf8');
    assert.ok(unit.includes('mesh serve --port 47472'), unit);
    assert.ok(fs.readFileSync(log, 'utf8').includes('--user enable --now egc-mesh'), 'systemctl was asked to enable the unit');
    const status = spawnSync(process.execPath, [MESH_CLI, 'status'], { encoding: 'utf8', env });
    assert.ok(status.stdout.includes('Service: installed and running'), `${status.stdout}\n${status.stderr}`);
    const uninstall = spawnSync(process.execPath, [MESH_CLI, 'serve', '--uninstall'], { encoding: 'utf8', env });
    assert.strictEqual(uninstall.status, 0, `${uninstall.stdout}\n${uninstall.stderr}`);
    assert.ok(!fs.existsSync(service.unitPath(home)), 'the unit is gone');
    const again = spawnSync(process.execPath, [MESH_CLI, 'serve', '--uninstall'], { encoding: 'utf8', env });
    assert.strictEqual(again.status, 0);
    assert.ok(again.stdout.includes('no service to remove'), again.stdout);
    const both = spawnSync(process.execPath, [MESH_CLI, 'serve', '--install', '--uninstall'], { encoding: 'utf8', env });
    assert.strictEqual(both.status, 2, `${both.stdout}\n${both.stderr}`);
    assert.ok(both.stderr.includes('not both'), both.stderr);
    assert.ok(!fs.existsSync(service.unitPath(home)), 'neither flag ran');
  });
}

for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
