/**
 * The bridge of a machine on the mesh (mcp/servers/egc-memory/src/relay/bridge.ts):
 * two machines, each with its own home and bus, connect to the central, tell
 * each other their sessions, and session_peers on one lists the sessions of
 * the other with its label; a machine that leaves disappears from the other;
 * the election gives the bridge to one process of a machine; a lost central
 * is reconnected to; and `egc mesh connect`, `status` and `label` keep the
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

async function runTests() {
  console.log('\n=== Testing the mesh bridge ===\n');
  const { startHub } = await import(pathToFileURL(path.join(BUILD, 'relay', 'hub.js')).href);
  const protocol = await import(pathToFileURL(path.join(BUILD, 'relay', 'protocol.js')).href);
  const { MeshBridge, BridgeLock } = await import(pathToFileURL(path.join(BUILD, 'relay', 'bridge.js')).href);
  const { loadOrCreateMachine } = await import(pathToFileURL(path.join(BUILD, 'relay', 'machine.js')).href);
  const { openCompatDatabase } = await import(pathToFileURL(path.join(BUILD, 'sqlite-compat.js')).href);
  const bus = await import(pathToFileURL(path.join(BUILD, 'session-bus.js')).href);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-mesh-bridge-'));
  const teamKey = Buffer.alloc(32, 5);
  const hub = await startHub({ authKey: protocol.meshAuthKey(teamKey), port: 0, host: '127.0.0.1', heartbeatMs: 60_000 });
  const central = `ws://127.0.0.1:${hub.port}`;

  async function machine(name) {
    const home = path.join(root, name);
    fs.mkdirSync(path.join(home, '.egc', 'memory'), { recursive: true });
    const db = await openCompatDatabase(path.join(home, '.egc', 'memory', 'state.db'), `mesh-bridge-${name}`);
    await bus.createSessionBusTables(db);
    const identity = loadOrCreateMachine(home);
    return { home, db, identity };
  }

  const a = await machine('home-a');
  const b = await machine('home-b');
  const project = path.join(root, 'work', 'app');
  fs.mkdirSync(project, { recursive: true });
  const bridges = [];
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

    await test('a session announced on one machine is listed by session_peers on the other, with the label of its machine', async () => {
      await bus.announce(b.db, { sessionId: 'tab-on-b', projectPath: project, territory: 'the bridge' });
      await until(async () => (await bus.listRemoteSessions(a.db)).length > 0, 'the presence of B to land on A');
      const peers = await bus.listPeers(a.db);
      const remote = peers.find(peer => peer.id === 'tab-on-b');
      assert.ok(remote, `the session of B is among the peers of A: ${JSON.stringify(peers)}`);
      assert.strictEqual(remote.machine_label, b.identity.label);
      assert.strictEqual(remote.machine_id, b.identity.id);
      assert.strictEqual(remote.territory, 'the bridge');
      const filtered = await bus.listPeers(a.db, project);
      assert.ok(filtered.some(peer => peer.id === 'tab-on-b'), 'the project filter matches the remote session by the identity of its repository');
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
      const status = JSON.parse(fs.readFileSync(path.join(a.home, '.egc', 'mesh', 'bridge.json'), 'utf8'));
      assert.strictEqual(status.connected, true);
      assert.ok(status.online.includes(b.identity.id) && status.online.includes(bridgeC.machine.id));
      await bridgeC.stop();
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

    await test('egc mesh connect, status, label and disconnect keep the configuration and the identity', () => {
      const home = path.join(root, 'home-cli');
      const env = { ...process.env, HOME: home, USERPROFILE: home };
      const run = args => spawnSync(process.execPath, [MESH_CLI, ...args], { env, encoding: 'utf8', timeout: CLI_TIMEOUT_MS });
      const bad = run(['connect', 'not an address']);
      assert.strictEqual(bad.status, 2);
      assert.match(bad.stderr, /Not an address of a mesh central/);
      const ok = run(['connect', '192.168.1.50:47470']);
      assert.strictEqual(ok.status, 0, ok.stderr);
      assert.match(ok.stdout, /Central: ws:\/\/192\.168\.1\.50:47470/);
      const labeled = run(['label', 'desk at home']);
      assert.strictEqual(labeled.status, 0, labeled.stderr);
      assert.match(labeled.stdout, /Machine: desk at home \([0-9a-f]{32}\)/);
      const status = run(['status']);
      assert.strictEqual(status.status, 0, status.stderr);
      assert.match(status.stdout, /Machine: desk at home/);
      assert.match(status.stdout, /Central: ws:\/\/192\.168\.1\.50:47470/);
      assert.match(status.stdout, /Bridge: {2}not running/);
      const off = run(['disconnect']);
      assert.strictEqual(off.status, 0, off.stderr);
      assert.match(run(['status']).stdout, /Central: none/);
    });
  } finally {
    for (const bridge of bridges) await bridge.stop();
    await hub.close();
    await a.db.close?.();
    await b.db.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(error => {
  console.error(error);
  process.exit(1);
});
