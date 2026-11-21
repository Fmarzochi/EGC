/**
 * The bridge of a machine on the mesh (mcp/servers/egc-memory/src/relay/bridge.ts):
 * two machines, each with its own home and bus and its own checkout of the
 * same repository, connect to the central, tell each other their sessions,
 * and session_peers on one lists the sessions of the other with its label;
 * a central that goes away is reconnected to when it comes back; a machine
 * that leaves disappears from the other; the election gives the bridge to
 * one process of a machine, a lost lock makes it step down and the next
 * server takes over, and forgetting the central stops a running bridge; and
 * `egc mesh connect`, `status`, `label` and `disconnect` keep the
 * configuration and the identity. Runs against the built memory server.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const { CLI_TIMEOUT_MS } = require('./fixtures/subprocess-timeouts');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'mcp', 'servers', 'egc-memory', 'build');
const MESH_CLI = path.join(ROOT, 'scripts', 'mesh.js');
const STEP_TIMEOUT_MS = 8000;

if (!fs.existsSync(path.join(BUILD, 'relay', 'bridge.js'))) {
  console.log(`[SKIP] bridge build not found under ${BUILD}. Run 'npm run build' in mcp/servers/egc-memory first.`);
  process.exit(0);
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    failed++;
  }
}

// Waits for a condition, polling, within the step budget.
async function until(check, what, budgetMs = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// A checkout of the team's repository on one machine: its own folder, the
// same origin, which is what the project filter compares across machines.
// The identity of a project reads .git/config itself, so the checkout is
// laid out by hand and no git binary is involved.
function checkoutOf(folder) {
  fs.mkdirSync(path.join(folder, '.git'), { recursive: true });
  fs.writeFileSync(path.join(folder, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(folder, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://example.com/team/app.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
  return folder;
}

function readStatus(home) {
  return JSON.parse(fs.readFileSync(path.join(home, '.egc', 'mesh', 'bridge.json'), 'utf8'));
}

async function runTests() {
  console.log('\n=== Testing the mesh bridge ===\n');
  const { startHub } = await import(pathToFileURL(path.join(BUILD, 'relay', 'hub.js')).href);
  const protocol = await import(pathToFileURL(path.join(BUILD, 'relay', 'protocol.js')).href);
  const { MeshBridge, BridgeLock, startBridgeIfElected } = await import(pathToFileURL(path.join(BUILD, 'relay', 'bridge.js')).href);
  const { loadOrCreateMachine } = await import(pathToFileURL(path.join(BUILD, 'relay', 'machine.js')).href);
  const meshConfig = await import(pathToFileURL(path.join(BUILD, 'relay', 'mesh-config.js')).href);
  const { openCompatDatabase } = await import(pathToFileURL(path.join(BUILD, 'sqlite-compat.js')).href);
  const bus = await import(pathToFileURL(path.join(BUILD, 'session-bus.js')).href);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-mesh-bridge-'));
  const teamKey = Buffer.alloc(32, 5);
  const authKey = protocol.meshAuthKey(teamKey);
  let hub = await startHub({ authKey, port: 0, host: '127.0.0.1', heartbeatMs: 60_000 });
  const central = `ws://127.0.0.1:${hub.port}`;

  const databases = [];
  async function machine(name) {
    const home = path.join(root, name);
    fs.mkdirSync(path.join(home, '.egc', 'memory'), { recursive: true });
    const db = await openCompatDatabase(path.join(home, '.egc', 'memory', 'state.db'), `mesh-bridge-${name}`);
    databases.push(db);
    await bus.createSessionBusTables(db);
    const identity = loadOrCreateMachine(home);
    return { home, db, identity };
  }

  const a = await machine('home-a');
  const b = await machine('home-b');
  const projectOnA = checkoutOf(path.join(root, 'work-a', 'app'));
  const projectOnB = checkoutOf(path.join(root, 'work-b', 'app'));
  const bridges = [];
  const handles = [];
  const bridgeFor = (m, extra = {}) => {
    const bridge = new MeshBridge({ home: m.home, db: m.db, teamKey, central, machine: m.identity, presenceMs: 300, reconnectMaxMs: 500, ...extra });
    bridges.push(bridge);
    return bridge;
  };

  try {
    await test('the identity of a machine is made once and kept', () => {
      assert.match(a.identity.id, /^[0-9a-f]{32}$/);
      assert.ok(a.identity.label.length > 0);
      assert.deepStrictEqual(loadOrCreateMachine(a.home), a.identity, 'a second load reads the same identity');
      assert.notStrictEqual(a.identity.id, b.identity.id, 'two homes are two machines');
    });

    const bridgeA = bridgeFor(a);
    const bridgeB = bridgeFor(b);
    await test('two machines connect to the central and see each other online', async () => {
      bridgeA.start();
      bridgeB.start();
      await until(() => bridgeA.connected && bridgeB.connected, 'both bridges to connect');
      await until(() => bridgeA.online.has(b.identity.id) && bridgeB.online.has(a.identity.id), 'each to see the other online');
    });

    await test('a session announced on one machine is listed by session_peers on the other, with the label of its machine, under the other checkout of the same repository', async () => {
      await bus.announce(b.db, { sessionId: 'tab-on-b', projectPath: projectOnB, territory: 'the bridge' });
      await until(async () => (await bus.listRemoteSessions(a.db)).length > 0, 'the presence of B to land on A');
      const peers = await bus.listPeers(a.db);
      const remote = peers.find(peer => peer.id === 'tab-on-b');
      assert.ok(remote, `the session of B is among the peers of A: ${JSON.stringify(peers)}`);
      assert.strictEqual(remote.machine_label, b.identity.label);
      assert.strictEqual(remote.machine_id, b.identity.id);
      assert.strictEqual(remote.territory, 'the bridge');
      const filtered = await bus.listPeers(a.db, projectOnA);
      assert.ok(filtered.some(peer => peer.id === 'tab-on-b'), 'the project filter matches the remote session by the identity of its repository, not by the folder');
      const other = await bus.listPeers(a.db, path.join(root, 'elsewhere'));
      assert.ok(!other.some(peer => peer.id === 'tab-on-b'), 'another project does not list it');
    });

    await test('a box sent to one machine reaches it opened, and the status file says who is online', async () => {
      const received = [];
      const bridgeC = bridgeFor(await machine('home-c'), { onMessage: (from, message) => received.push({ from, message }) });
      bridgeC.start();
      await until(() => bridgeC.connected, 'C to connect');
      assert.ok(bridgeA.send(bridgeC.machine.id, { type: 'event', body: { text: 'hello C' } }), 'A hands the box to the central');
      await until(() => received.length > 0, 'C to receive the box');
      assert.strictEqual(received[0].from, a.identity.id);
      assert.deepStrictEqual(received[0].message, { type: 'event', body: { text: 'hello C' } });
      await until(() => readStatus(a.home).online.includes(bridgeC.machine.id), 'the status of A to list C');
      const status = readStatus(a.home);
      assert.strictEqual(status.connected, true);
      assert.ok(status.online.includes(b.identity.id));
      await bridgeC.stop();
    });

    await test('a central that goes away is reconnected to when it comes back, and the presence resumes', async () => {
      const port = hub.port;
      await hub.close();
      await until(() => !bridgeA.connected && !bridgeB.connected, 'both bridges to notice the central is gone');
      hub = await startHub({ authKey, port, host: '127.0.0.1', heartbeatMs: 60_000 });
      await until(() => bridgeA.connected && bridgeB.connected, 'both bridges to reconnect');
      await until(() => bridgeA.online.has(b.identity.id) && bridgeB.online.has(a.identity.id), 'each to see the other online again');
      await bus.announce(b.db, { sessionId: 'tab-on-b', projectPath: projectOnB, territory: 'the bridge' });
      await until(async () => (await bus.listRemoteSessions(a.db)).some(session => session.id === 'tab-on-b'), 'the presence of B to reach A again');
    });

    await test('a machine that leaves is forgotten by the others', async () => {
      await bridgeB.stop();
      await until(async () => (await bus.listRemoteSessions(a.db)).every(session => session.machine_id !== b.identity.id), 'B to leave the peers of A');
      assert.ok(!bridgeA.online.has(b.identity.id));
    });

    await test('the election gives the bridge to one process, and a stale holder is replaced', () => {
      const home = path.join(root, 'home-lock');
      let now = 1_000_000_000_000;
      const first = new BridgeLock(home, () => now);
      const second = new BridgeLock(home, () => now);
      assert.strictEqual(first.claim(), true);
      assert.strictEqual(second.claim(), false, 'the lock is held by a live process');
      assert.strictEqual(first.renew(), true);
      now += 120_000;
      assert.strictEqual(second.claim(), true, 'a heartbeat older than the limit frees the lock');
      assert.strictEqual(first.renew(), false, 'the first holder sees it lost the lock');
      second.release();
      assert.ok(!fs.existsSync(path.join(home, '.egc', 'mesh', 'bridge.lock')));
    });

    await test('the servers of a machine hold one bridge among them: a lost lock makes the holder step down and the next server takes over, and forgetting the central stops it', async () => {
      const e = await machine('home-e');
      meshConfig.writeMeshConfig(central, e.home);
      const options = { db: e.db, home: e.home, teamKey, electionMs: 150, presenceMs: 300, reconnectMaxMs: 500 };
      const first = startBridgeIfElected(options);
      const second = startBridgeIfElected(options);
      handles.push(first, second);
      const holders = () => [first, second].filter(handle => handle.bridge?.connected);
      await until(() => holders().length === 1, 'one server to hold the bridge and connect');
      assert.strictEqual(second.bridge, null, 'the second server stands aside while the first holds the lock');
      const lockFile = path.join(e.home, '.egc', 'mesh', 'bridge.lock');
      fs.writeFileSync(lockFile, JSON.stringify({ pid: 999_999, token: 'f'.repeat(32), heartbeatAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() }));
      await until(() => first.bridge === null, 'the holder to step down once its lock is gone');
      await until(() => holders().length === 1, 'the next server to take the stale lock and connect');
      meshConfig.clearMeshConfig(e.home);
      await until(() => first.bridge === null && second.bridge === null, 'the bridge to step down once the central is forgotten');
      await until(() => readStatus(e.home).connected === false, 'the status file to say the bridge is down');
      meshConfig.writeMeshConfig(central, e.home);
      await until(() => holders().length === 1, 'a central configured later to be joined');
      await first.stop();
      await second.stop();
      assert.ok(!fs.existsSync(lockFile), 'the stopped bridge released its lock');
    });

    await test('egc mesh connect, status, label and disconnect keep the configuration and the identity', () => {
      const home = path.join(root, 'home-cli');
      const env = { ...process.env, HOME: home, USERPROFILE: home };
      const run = args => spawnSync(process.execPath, [MESH_CLI, ...args], { env, encoding: 'utf8', timeout: CLI_TIMEOUT_MS });
      const before = run(['status']);
      assert.strictEqual(before.status, 0, before.stderr);
      const id = /\(([0-9a-f]{32})\)/.exec(before.stdout)?.[1];
      assert.ok(id, `status shows the id of the machine: ${before.stdout}`);
      const bad = run(['connect', 'not an address']);
      assert.strictEqual(bad.status, 2);
      assert.match(bad.stderr, /Not an address of a mesh central/);
      assert.strictEqual(run(['connect', 'https://central:47470']).status, 2, 'an address with another scheme is refused');
      const ok = run(['connect', '192.168.1.50:47470']);
      assert.strictEqual(ok.status, 0, ok.stderr);
      assert.match(ok.stdout, /Central: ws:\/\/192\.168\.1\.50:47470/);
      const labeled = run(['label', 'desk at home']);
      assert.strictEqual(labeled.status, 0, labeled.stderr);
      assert.strictEqual(labeled.stdout.trim(), `Machine: desk at home (${id})`, 'the label changes and the id does not');
      const status = run(['status']);
      assert.strictEqual(status.status, 0, status.stderr);
      assert.match(status.stdout, new RegExp(`Machine: desk at home \\(${id}\\)`));
      assert.match(status.stdout, /Central: ws:\/\/192\.168\.1\.50:47470/);
      assert.match(status.stdout, /Bridge: {2}not running/);
      const off = run(['disconnect']);
      assert.strictEqual(off.status, 0, off.stderr);
      assert.match(off.stdout, /Central forgotten/);
      assert.match(run(['status']).stdout, /Central: none/);
      assert.match(run(['disconnect']).stdout, /No central was configured/);
    });
  } finally {
    for (const handle of handles) await handle.stop();
    for (const bridge of bridges) await bridge.stop();
    await hub.close();
    for (const db of databases) await db.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(error => {
  console.error(error);
  process.exit(1);
});
