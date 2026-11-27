/**
 * The bridge over a NATS server (mcp/servers/egc-memory/src/relay/link-nats.ts):
 * the addresses the mesh accepts for one, the credentials file, two machines
 * speaking through a stand-in of the NATS client (presence answered at once,
 * a direct event, a broadcast, a lock, the goodbye of a machine that stops,
 * the reconnection when the server goes away, two teams kept apart on one
 * server), the CLI pointing a machine at a server, the Mesh block of the
 * doctor, and, when a nats-server is on this machine (EGC_NATS_SERVER or the
 * PATH), the same two machines through the real server, with and without a
 * token. Runs against the built memory server.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const { CLI_TIMEOUT_MS } = require('./fixtures/subprocess-timeouts');
const { buildMeshReport, printMeshReport } = require('../scripts/lib/doctor-mesh');
const meshStatus = require('../scripts/lib/mesh-status');
const { writeTeamConfig } = require('../scripts/lib/team-config');

const ROOT = path.join(__dirname, '..');
const SERVER_DIR = path.join(ROOT, 'mcp', 'servers', 'egc-memory');
const BUILD = path.join(SERVER_DIR, 'build');
const MESH_CLI = path.join(ROOT, 'scripts', 'mesh.js');
const STEP_TIMEOUT_MS = 8000;
const FAKE_SERVER = 'nats://127.0.0.1:4222';

if (!fs.existsSync(path.join(BUILD, 'relay', 'link-nats.js'))) {
  console.log(`[SKIP] relay build not found under ${BUILD}. Run 'npm run build' in mcp/servers/egc-memory first.`);
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

async function until(check, what, budgetMs = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// A checkout of the team's repository on one machine, laid out by hand: the
// identity of a project reads .git/config itself.
function checkoutOf(folder) {
  fs.mkdirSync(path.join(folder, '.git'), { recursive: true });
  fs.writeFileSync(path.join(folder, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(folder, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://example.com/team/app.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
  return folder;
}

function readStatus(home) {
  return JSON.parse(fs.readFileSync(path.join(home, '.egc', 'mesh', 'bridge.json'), 'utf8'));
}

function doctorLines(report) {
  const out = [];
  printMeshReport(report, line => out.push(line));
  return out.join('\n');
}

// A stand-in for a NATS server and the clients the library would give: a
// subject is matched whole, a message reaches every other client subscribed
// to it (the server does not echo), and the server can be taken down, which
// closes every client with an error, and brought back.
function fakeNats() {
  const clients = new Set();
  let down = false;
  const connect = async options => {
    if (down) throw new Error('connection refused');
    const subs = [];
    let settle;
    const closedPromise = new Promise(resolve => {
      settle = resolve;
    });
    const client = {
      options,
      info: { max_payload: 1024 * 1024 },
      subscribe(subject, { callback }) {
        subs.push({ subject, callback });
        return {};
      },
      publish(subject, data) {
        for (const other of clients) {
          if (other === client && options.noEcho) continue;
          for (const sub of other.subs) {
            if (sub.subject === subject) setImmediate(() => sub.callback(null, { subject, data }));
          }
        }
      },
      subs,
      async flush() {},
      async close() {
        if (!clients.has(client)) return;
        clients.delete(client);
        settle();
      },
      closed: () => closedPromise,
      drop() {
        if (!clients.has(client)) return;
        clients.delete(client);
        settle(new Error('the server went away'));
      },
    };
    clients.add(client);
    return client;
  };
  return {
    connect,
    get size() {
      return clients.size;
    },
    takeDown() {
      down = true;
      for (const client of [...clients]) client.drop();
    },
    bringBack() {
      down = false;
    },
  };
}

// A nats-server on this machine, when there is one: EGC_NATS_SERVER names
// the binary, else the PATH is tried; nothing is downloaded or required.
function findNatsServer() {
  const candidates = [process.env.EGC_NATS_SERVER, 'nats-server'].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

// Starts a real nats-server on a port of its choosing on the loopback and
// resolves with its address; extra arguments (a token) go to the server.
function startNatsServer(binary, extraArgs = []) {
  const child = spawn(binary, ['-a', '127.0.0.1', '-p', '-1', ...extraArgs], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.on('exit', resolve));
  let out = '';
  const address = new Promise((resolve, reject) => {
    // A server that never listens is killed here, so a failure of the
    // optional server never leaves a process behind the suite.
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      reject(new Error(`nats-server did not listen in time:\n${out}`));
    }, CLI_TIMEOUT_MS);
    const watch = chunk => {
      out += chunk;
      const match = /Listening for client connections on 127\.0\.0\.1:(\d+)/.exec(out);
      if (match) {
        clearTimeout(timer);
        resolve(`nats://127.0.0.1:${match[1]}`);
      }
    };
    child.stdout.on('data', watch);
    child.stderr.on('data', watch);
    exited.then(() => {
      clearTimeout(timer);
      reject(new Error(`nats-server exited before listening:\n${out}`));
    });
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
  return { address, stop };
}

async function runTests() {
  console.log('\n=== Testing the mesh over a NATS server ===\n');
  const linkNats = await import(pathToFileURL(path.join(BUILD, 'relay', 'link-nats.js')).href);
  const meshConfig = await import(pathToFileURL(path.join(BUILD, 'relay', 'mesh-config.js')).href);
  const { MeshBridge } = await import(pathToFileURL(path.join(BUILD, 'relay', 'bridge.js')).href);
  const { loadOrCreateMachine } = await import(pathToFileURL(path.join(BUILD, 'relay', 'machine.js')).href);
  const { openCompatDatabase } = await import(pathToFileURL(path.join(BUILD, 'sqlite-compat.js')).href);
  const bus = await import(pathToFileURL(path.join(BUILD, 'session-bus.js')).href);
  const encryption = await import(pathToFileURL(path.join(BUILD, 'encryption.js')).href);
  const nkeys = require(require.resolve('@nats-io/nkeys', { paths: [SERVER_DIR] }));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-mesh-nats-'));
  const teamKey = Buffer.alloc(32, 11);
  const databases = [];
  const bridges = [];

  async function machine(name) {
    const home = path.join(root, name);
    fs.mkdirSync(path.join(home, '.egc', 'memory'), { recursive: true });
    const db = await openCompatDatabase(path.join(home, '.egc', 'memory', 'state.db'), `mesh-nats-${name}`);
    databases.push(db);
    await bus.createSessionBusTables(db);
    const identity = loadOrCreateMachine(home);
    const keys = { personal: encryption.loadOrCreateEncKey(path.join(home, '.egc', 'encryption.key')), integrity: null };
    return { home, db, identity, keys, log: [] };
  }

  const bridgeFor = (m, extra = {}) => {
    const bridge = new MeshBridge({ home: m.home, db: m.db, teamKey, central: FAKE_SERVER, machine: m.identity, keys: m.keys, presenceMs: 300, reconnectMaxMs: 500, log: line => m.log.push(line), ...extra });
    bridges.push(bridge);
    return bridge;
  };
  const overFake = fake => (options, events) => linkNats.openNatsLink({ ...options, connect: fake.connect }, events);

  try {
    await test('the mesh takes the address of a NATS server, in the runtime and in the doctor alike, and keeps refusing what it refused', () => {
      const cases = [
        ['nats://192.168.1.50:4222', 'nats://192.168.1.50:4222'],
        ['tls://broker.example.com:4222', 'tls://broker.example.com:4222'],
        ['nats://broker.example.com', 'nats://broker.example.com'],
        ['nats://[fe80::1]:4222', 'nats://[fe80::1]:4222'],
        ['nats://alice:secret@broker.example.com:4222', null],
        ['nats://broker.example.com:4222?token=synthetic', null],
        ['nats://broker.example.com:4222/leaf', null],
        ['tls://broker.example.com:4222#fragment', null],
        ['nats://broker.example.com:4222/', 'nats://broker.example.com:4222'],
        ['mqtt://broker.example.com:1883', null],
        ['http://broker.example.com', null],
        ['broker.example.com', 'ws://broker.example.com:47470'],
        ['wss://mesh.example.com/relay', 'wss://mesh.example.com/relay'],
      ];
      for (const [given, expected] of cases) {
        assert.strictEqual(meshConfig.normalizeCentralAddress(given), expected, `runtime: ${given}`);
        assert.strictEqual(meshStatus.normalizeCentralAddress(given), expected, `doctor: ${given}`);
      }
      assert.strictEqual(meshConfig.centralKind('nats://broker.example.com:4222'), 'nats');
      assert.strictEqual(meshConfig.centralKind('tls://broker.example.com:4222'), 'nats');
      assert.strictEqual(meshConfig.centralKind('wss://mesh.example.com:47470'), 'relay');
      assert.strictEqual(meshStatus.centralKind('nats://broker.example.com:4222'), 'nats');
      assert.strictEqual(meshStatus.centralKind('ws://mesh.example.com:47470'), 'relay');
      const subjects = linkNats.meshSubjects('abcdef012345');
      assert.strictEqual(subjects.all, 'egc.mesh.abcdef012345.all');
      assert.strictEqual(subjects.to('f'.repeat(32)), `egc.mesh.abcdef012345.to.${'f'.repeat(32)}`);
    });

    await test('the credentials file kept in mesh.json stays while the central is the same and nothing is said about it, and goes when the central changes or null is given', () => {
      const home = path.join(root, 'home-config');
      fs.mkdirSync(home, { recursive: true });
      const authFile = path.join(home, 'nats-auth.json');
      fs.writeFileSync(authFile, JSON.stringify({ token: 'synthetic' }), { mode: 0o600 });
      assert.strictEqual(meshConfig.writeMeshConfig('nats://broker.local:4222', home, { authFile }).authFile, authFile);
      assert.strictEqual(meshConfig.writeMeshConfig('nats://broker.local:4222', home).authFile, authFile, 'a write of the same central with nothing said keeps the file');
      assert.strictEqual(meshConfig.readMeshConfig(home).authFile, authFile);
      assert.strictEqual(meshConfig.writeMeshConfig('nats://broker.local:4222', home, { authFile: null }).authFile, null, 'null forgets it');
      assert.strictEqual(meshConfig.writeMeshConfig('nats://broker.local:4222', home, { authFile }).authFile, authFile);
      assert.strictEqual(meshConfig.writeMeshConfig('nats://other.local:4222', home).authFile, null, 'another central starts without it');
      assert.strictEqual(meshConfig.writeMeshConfig('nats://broker.local:4222', home, { authFile }).authFile, authFile);
      assert.strictEqual(meshConfig.writeMeshConfig('192.168.1.50:47470', home).authFile, null, 'the central of egc mesh serve takes none');
    });

    await test('the credentials file is a .creds file, or JSON with a token, or with a user and a pass; anything else, and a file others can read, is refused', async () => {
      const dir = path.join(root, 'auth');
      fs.mkdirSync(dir, { recursive: true });
      const write = (name, content, mode = 0o600) => {
        const file = path.join(dir, name);
        fs.writeFileSync(file, content, { mode });
        return file;
      };
      assert.deepStrictEqual(await linkNats.readNatsAuth(null), { kind: 'none', options: {} });
      const token = await linkNats.readNatsAuth(write('token.json', JSON.stringify({ token: 'synthetic-token' })));
      assert.deepStrictEqual(token, { kind: 'token', options: { token: 'synthetic-token' } });
      const password = await linkNats.readNatsAuth(write('user.json', JSON.stringify({ user: 'alice', pass: 'synthetic-pass' })));
      assert.deepStrictEqual(password, { kind: 'password', options: { user: 'alice', pass: 'synthetic-pass' } });
      const user = nkeys.createUser();
      const creds = ['-----BEGIN NATS USER JWT-----', 'eyJ0eXAiOiJKV1QiLCJhbGciOiJlZDI1NTE5LW5rZXkifQ.e30.c3ludGhldGlj', '------END NATS USER JWT------', '', '-----BEGIN USER NKEY SEED-----', Buffer.from(user.getSeed()).toString(), '------END USER NKEY SEED------', ''].join('\n');
      const fromCreds = await linkNats.readNatsAuth(write('user.creds', creds));
      assert.strictEqual(fromCreds.kind, 'creds');
      assert.strictEqual(typeof fromCreds.options.authenticator, 'function', 'a .creds file gives the authenticator of the library');
      const answer = fromCreds.options.authenticator('a-nonce');
      assert.strictEqual(answer.jwt, 'eyJ0eXAiOiJKV1QiLCJhbGciOiJlZDI1NTE5LW5rZXkifQ.e30.c3ludGhldGlj');
      assert.strictEqual(answer.nkey, user.getPublicKey(), 'the seed of the file signs the nonce');
      await assert.rejects(() => linkNats.readNatsAuth(write('garbage.json', 'not json at all')), /neither a \.creds file nor JSON/);
      await assert.rejects(() => linkNats.readNatsAuth(write('empty.json', JSON.stringify({ token: '' }))), /neither a \.creds file nor JSON/);
      await assert.rejects(() => linkNats.readNatsAuth(path.join(dir, 'missing.json')), /does not exist/);
      await assert.rejects(() => linkNats.readNatsAuth(dir), /not a regular file/);
      if (process.platform !== 'win32') {
        await assert.rejects(() => linkNats.readNatsAuth(write('open.json', JSON.stringify({ token: 'x' }), 0o644)), /readable by other users/);
      }
    });

    const fake = fakeNats();
    const a = await machine('home-a');
    const b = await machine('home-b');
    const projectOnA = checkoutOf(path.join(root, 'work-a', 'app'));
    const projectOnB = checkoutOf(path.join(root, 'work-b', 'app'));
    const bridgeA = bridgeFor(a, { openLink: overFake(fake) });
    const bridgeB = bridgeFor(b, { openLink: overFake(fake) });

    await test('two machines connect to the NATS server and see each other within a second, since a presence from a newcomer is answered at once', async () => {
      bridgeA.start();
      await until(() => bridgeA.connected, 'A to connect');
      assert.strictEqual(fake.size, 1, 'one connection per machine');
      const startedB = Date.now();
      bridgeB.start();
      await until(() => bridgeB.connected && bridgeA.online.has(b.identity.id) && bridgeB.online.has(a.identity.id), 'each to see the other online', 3000);
      assert.ok(Date.now() - startedB < 3000, 'B saw A before the next presence of A would have come');
      assert.strictEqual(fake.size, 2);
      const status = readStatus(a.home);
      assert.strictEqual(status.central, FAKE_SERVER);
      assert.ok(status.online.includes(b.identity.id));
    });

    await test('a session announced on one machine is listed by session_peers on the other, with its machine, through the NATS server', async () => {
      await bus.announce(b.db, { sessionId: 'tab-on-b', projectPath: projectOnB, territory: 'the broker' });
      await until(async () => (await bus.listRemoteSessions(a.db)).some(session => session.id === 'tab-on-b'), 'the presence of B to land on A');
      const peers = await bus.listPeers(a.db, projectOnA);
      const remote = peers.find(peer => peer.id === 'tab-on-b');
      assert.ok(remote, `the session of B is among the peers of A: ${JSON.stringify(peers)}`);
      assert.strictEqual(remote.machine_label, b.identity.label);
      assert.strictEqual(remote.territory, 'the broker');
    });

    await test('a direct event, a broadcast and a lock cross the NATS server as they cross the central', async () => {
      await bus.announce(a.db, { sessionId: 'tab-on-a', projectPath: projectOnA, territory: 'the sender' });
      await until(async () => (await bus.listRemoteSessions(b.db)).some(session => session.id === 'tab-on-a'), 'the presence of A to land on B');
      const direct = await bus.sendEvent(a.db, { fromSession: 'tab-on-a', toSession: 'tab-on-b', projectPath: projectOnA, kind: 'handoff', payload: 'take the parser' });
      assert.strictEqual(direct.ok, true, `the event for the remote session is accepted: ${direct.reason}`);
      await until(async () => (await bus.readEvents(b.db, { sessionId: 'tab-on-b', projectPath: projectOnB })).some(event => event.kind === 'handoff' && event.payload === 'take the parser'), 'the direct event to reach B');
      const broadcast = await bus.sendEvent(b.db, { fromSession: 'tab-on-b', projectPath: projectOnB, kind: 'notice', payload: 'to everyone' });
      assert.strictEqual(broadcast.ok, true);
      await until(async () => (await bus.readEvents(a.db, { sessionId: 'tab-on-a', projectPath: projectOnA })).some(event => event.kind === 'notice'), 'the broadcast to reach A');
      const { events: outboundAgain } = await bus.listOutboundEvents(a.db, 0, null);
      assert.ok(!outboundAgain.some(event => event.kind === 'notice'), 'an event that came in from B never goes out of A again');
      const claimedOnB = await bus.claimPath(b.db, { sessionId: 'tab-on-b', path: 'src/parser.ts' });
      assert.strictEqual(claimedOnB.ok, true);
      await until(async () => (await bus.listLocks(a.db)).some(lock => lock.machine_id === b.identity.id), 'the lock of B to reach A');
      const refusedOnA = await bus.claimPath(a.db, { sessionId: 'tab-on-a', path: 'src/parser.ts' });
      assert.strictEqual(refusedOnA.ok, false);
      assert.ok(refusedOnA.reason.includes(b.identity.label), `the refusal names the machine: ${refusedOnA.reason}`);
      assert.strictEqual(await bus.releasePath(b.db, { sessionId: 'tab-on-b', path: 'src/parser.ts' }), true);
      await until(async () => (await bus.claimPath(a.db, { sessionId: 'tab-on-a', path: 'src/parser.ts' })).ok, 'the path to be free on A once B released it');
      await bus.releasePath(a.db, { sessionId: 'tab-on-a', path: 'src/parser.ts' });
    });

    await test('the server goes away and comes back: both bridges reconnect and the presence resumes', async () => {
      fake.takeDown();
      await until(() => !bridgeA.connected && !bridgeB.connected, 'both bridges to notice the server is gone');
      assert.ok(a.log.some(line => line.includes('was lost')), `the loss is said: ${a.log.join('\n')}`);
      fake.bringBack();
      await until(() => bridgeA.connected && bridgeB.connected, 'both bridges to reconnect');
      await until(() => bridgeA.online.has(b.identity.id) && bridgeB.online.has(a.identity.id), 'each to see the other online again');
      await bus.announce(b.db, { sessionId: 'tab-on-b', projectPath: projectOnB, territory: 'the broker' });
      await until(async () => (await bus.listRemoteSessions(a.db)).some(session => session.id === 'tab-on-b'), 'the presence of B to reach A again');
    });

    await test('a machine that stops says goodbye, and the other forgets it at once instead of after ten minutes of silence', async () => {
      await bridgeB.stop();
      await until(async () => !bridgeA.online.has(b.identity.id) && (await bus.listRemoteSessions(a.db)).every(session => session.machine_id !== b.identity.id), 'A to forget B', 3000);
      assert.strictEqual(fake.size, 1, 'the connection of B is closed');
    });

    await test('two teams on one server stay apart: a machine of another team never sees this one', async () => {
      const d = await machine('home-d');
      const otherTeam = Buffer.alloc(32, 12);
      const bridgeD = bridgeFor(d, { openLink: overFake(fake), teamKey: otherTeam });
      bridgeD.start();
      await until(() => bridgeD.connected, 'D to connect');
      await bus.announce(a.db, { sessionId: 'tab-on-a', projectPath: projectOnA, territory: 'still here' });
      await new Promise(resolve => setTimeout(resolve, 900));
      assert.ok(!bridgeD.online.has(a.identity.id), 'D does not see A');
      assert.ok(!bridgeA.online.has(d.identity.id), 'A does not see D');
      assert.strictEqual((await bus.listRemoteSessions(d.db)).length, 0);
      await bridgeD.stop();
    });

    await test('a credentials file that opens nothing keeps the bridge down, with the reason in the log, and the next attempt reads the file again', async () => {
      const c = await machine('home-c');
      const authFile = path.join(c.home, 'nats-auth.json');
      fs.writeFileSync(authFile, 'not json', { mode: 0o600 });
      const bridgeC = bridgeFor(c, { openLink: overFake(fake), authFile });
      bridgeC.start();
      await until(() => c.log.some(line => line.includes('neither a .creds file nor JSON')), 'the refusal to be logged');
      assert.strictEqual(bridgeC.connected, false);
      assert.strictEqual(readStatus(c.home).connected, false);
      fs.writeFileSync(authFile, JSON.stringify({ token: 'synthetic' }), { mode: 0o600 });
      await until(() => bridgeC.connected, 'C to connect once the file opens');
      await bridgeC.stop();
    });

    await test('egc mesh connect takes a nats:// address with --auth, status shows the file, and a central refuses --auth', () => {
      const home = path.join(root, 'home-cli');
      fs.mkdirSync(home, { recursive: true });
      const env = { ...process.env, HOME: home, USERPROFILE: home };
      const run = args => spawnSync(process.execPath, [MESH_CLI, ...args], { env, encoding: 'utf8', timeout: CLI_TIMEOUT_MS });
      const authFile = path.join(home, 'nats-auth.json');
      fs.writeFileSync(authFile, JSON.stringify({ token: 'synthetic' }), { mode: 0o600 });
      const ok = run(['connect', 'nats://broker.local:4222', '--auth', authFile]);
      assert.strictEqual(ok.status, 0, ok.stderr);
      assert.match(ok.stdout, /Central: nats:\/\/broker\.local:4222/);
      assert.match(ok.stdout, /Auth: {4}.*nats-auth\.json \(token\)/);
      const status = run(['status']);
      assert.strictEqual(status.status, 0, status.stderr);
      assert.match(status.stdout, /Central: nats:\/\/broker\.local:4222/);
      assert.match(status.stdout, /Auth: {4}.*nats-auth\.json/);
      const config = JSON.parse(fs.readFileSync(path.join(home, '.egc', 'mesh.json'), 'utf8'));
      assert.strictEqual(config.authFile, authFile);
      const plain = run(['connect', 'tls://broker.local:4222']);
      assert.strictEqual(plain.status, 0, plain.stderr);
      assert.ok(!plain.stdout.includes('Auth:'), 'no credentials file, no Auth line');
      const withCentral = run(['connect', '192.168.1.50:47470', '--auth', authFile]);
      assert.strictEqual(withCentral.status, 2);
      assert.match(withCentral.stderr, /goes with the address of a NATS server/);
      const missing = run(['connect', 'nats://broker.local:4222', '--auth', path.join(home, 'gone.json')]);
      assert.strictEqual(missing.status, 2);
      assert.match(missing.stderr, /does not exist/);
      const credentials = run(['connect', 'nats://alice:secret@broker.local:4222']);
      assert.strictEqual(credentials.status, 2);
      assert.match(credentials.stderr, /Not an address of a mesh central/);
      const dangling = run(['connect', 'nats://broker.local:4222', '--auth']);
      assert.strictEqual(dangling.status, 2);
      assert.match(dangling.stderr, /--auth takes the path/);
      const noAddress = run(['connect', '--auth', authFile]);
      assert.strictEqual(noAddress.status, 2, 'a credentials file with no address is refused before any search');
      assert.match(noAddress.stderr, /given on the command line/);
      assert.ok(!noAddress.stdout.includes('Looking for the central'), 'no search ran');
      const again = run(['connect', 'nats://broker.local:4222', '--auth', authFile]);
      assert.strictEqual(again.status, 0, again.stderr);
      const kept = run(['connect', 'nats://broker.local:4222']);
      assert.strictEqual(kept.status, 0, kept.stderr);
      assert.ok(!kept.stdout.includes('Auth:'), 'connect with no --auth forgets the credentials file on purpose');
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, '.egc', 'mesh.json'), 'utf8')).authFile, null);
    });

    await test('the Mesh block of the doctor names the NATS server, its credentials file, and warns when the file is gone or the bridge cannot reach the server', () => {
      const home = path.join(root, 'home-doctor');
      fs.mkdirSync(path.join(home, '.egc', 'mesh'), { recursive: true });
      writeTeamConfig({ backend: 'git', remote: 'https://example.com/team.git', branch: 'main', teamKey: 'ab'.repeat(32) }, home);
      const authFile = path.join(home, 'nats-auth.json');
      fs.writeFileSync(authFile, JSON.stringify({ token: 'synthetic' }), { mode: 0o600 });
      fs.writeFileSync(path.join(home, '.egc', 'mesh.json'), JSON.stringify({ central: 'nats://broker.example.com:4222', authFile, connectedAt: '2026-11-27T10:00:00.000Z' }));
      let report = buildMeshReport(home);
      assert.strictEqual(report.warningCount, 0, doctorLines(report));
      assert.strictEqual(report.authFile, authFile);
      let text = doctorLines(report);
      assert.ok(text.includes('Mesh: NATS server nats://broker.example.com:4222'), text);
      assert.ok(text.includes(`Auth:   ${authFile}`), text);
      const machineIdentity = { id: 'a1b2c3d4e5f60718a1b2c3d4e5f60718', label: 'desk', createdAt: '2026-11-21T10:00:00.000Z' };
      fs.writeFileSync(path.join(home, '.egc', 'mesh', 'bridge.json'), JSON.stringify({ pid: process.pid, machine: machineIdentity, central: 'nats://broker.example.com:4222', connected: false, online: [], updatedAt: new Date().toISOString() }));
      report = buildMeshReport(home);
      assert.strictEqual(report.warningCount, 1, doctorLines(report));
      assert.ok(doctorLines(report).includes('check that your NATS server runs there'), doctorLines(report));
      fs.writeFileSync(authFile, 'not json', { mode: 0o600 });
      report = buildMeshReport(home);
      assert.strictEqual(report.warningCount, 2, doctorLines(report));
      text = doctorLines(report);
      assert.ok(text.includes(`[WARNING] the credentials file ${authFile} that egc mesh connect --auth named is neither a .creds file nor JSON`), text);
      if (process.platform !== 'win32') {
        // Group-readable on purpose, set after the write so the umask of the
        // runner has no say: enough for the bridge, and the doctor, to refuse.
        const openFile = path.join(home, 'nats-open.json');
        fs.writeFileSync(openFile, JSON.stringify({ token: 'synthetic' }));
        fs.chmodSync(openFile, 0o640);
        fs.writeFileSync(path.join(home, '.egc', 'mesh.json'), JSON.stringify({ central: 'nats://broker.example.com:4222', authFile: openFile, connectedAt: '2026-11-27T10:00:00.000Z' }));
        assert.ok(doctorLines(buildMeshReport(home)).includes('is readable by other users'), 'the doctor sees what the bridge will refuse');
        fs.writeFileSync(path.join(home, '.egc', 'mesh.json'), JSON.stringify({ central: 'nats://broker.example.com:4222', authFile, connectedAt: '2026-11-27T10:00:00.000Z' }));
      }
      fs.rmSync(authFile);
      report = buildMeshReport(home);
      assert.strictEqual(report.warningCount, 2, doctorLines(report));
      text = doctorLines(report);
      assert.ok(text.includes(`[WARNING] the credentials file ${authFile} that egc mesh connect --auth named is gone`), text);
      fs.writeFileSync(path.join(home, '.egc', 'mesh.json'), JSON.stringify({ central: 'nats://broker.example.com:4222', connectedAt: '2026-11-27T10:00:00.000Z' }));
      text = doctorLines(buildMeshReport(home));
      assert.ok(text.includes('reachable from this machine') && !text.includes('credentials file'), 'a server that asks for no credentials gets a warning that names none');
    });

    const natsServer = findNatsServer();
    if (!natsServer) {
      console.log('  - a real nats-server was not found on this machine (EGC_NATS_SERVER or the PATH): the tests through the real server are skipped');
    } else {
      await test('two machines speak through a real nats-server: presence, a direct event, a broadcast and the goodbye', async () => {
        const server = startNatsServer(natsServer);
        const address = await server.address;
        const e = await machine('home-e');
        const f = await machine('home-f');
        const projectOnE = checkoutOf(path.join(root, 'work-e', 'app'));
        const projectOnF = checkoutOf(path.join(root, 'work-f', 'app'));
        const bridgeE = bridgeFor(e, { central: address });
        const bridgeF = bridgeFor(f, { central: address });
        try {
          bridgeE.start();
          bridgeF.start();
          await until(() => bridgeE.connected && bridgeF.connected, `E and F to connect to ${address}`);
          await until(() => bridgeE.online.has(f.identity.id) && bridgeF.online.has(e.identity.id), 'each to see the other online');
          await bus.announce(e.db, { sessionId: 'tab-on-e', projectPath: projectOnE, territory: 'real' });
          await bus.announce(f.db, { sessionId: 'tab-on-f', projectPath: projectOnF, territory: 'real too' });
          await until(async () => (await bus.listRemoteSessions(e.db)).some(session => session.id === 'tab-on-f'), 'the presence of F to land on E');
          await until(async () => (await bus.listRemoteSessions(f.db)).some(session => session.id === 'tab-on-e'), 'the presence of E to land on F');
          const direct = await bus.sendEvent(e.db, { fromSession: 'tab-on-e', toSession: 'tab-on-f', projectPath: projectOnE, kind: 'handoff', payload: 'over the real server' });
          assert.strictEqual(direct.ok, true, direct.reason);
          await until(async () => (await bus.readEvents(f.db, { sessionId: 'tab-on-f', projectPath: projectOnF })).some(event => event.kind === 'handoff'), 'the direct event to reach F');
          const broadcast = await bus.sendEvent(f.db, { fromSession: 'tab-on-f', projectPath: projectOnF, kind: 'notice', payload: 'to all, for real' });
          assert.strictEqual(broadcast.ok, true);
          await until(async () => (await bus.readEvents(e.db, { sessionId: 'tab-on-e', projectPath: projectOnE })).some(event => event.kind === 'notice'), 'the broadcast to reach E');
          await bridgeF.stop();
          await until(() => !bridgeE.online.has(f.identity.id), 'E to forget F after its goodbye', 3000);
        } finally {
          await bridgeE.stop();
          await bridgeF.stop();
          await server.stop();
        }
      });

      await test('a nats-server that asks for a token lets in the machine whose credentials file holds it and keeps out the one without', async () => {
        const server = startNatsServer(natsServer, ['--auth', 'synthetic-token']);
        const address = await server.address;
        const g = await machine('home-g');
        const h = await machine('home-h');
        const authFile = path.join(g.home, 'nats-auth.json');
        fs.writeFileSync(authFile, JSON.stringify({ token: 'synthetic-token' }), { mode: 0o600 });
        const bridgeG = bridgeFor(g, { central: address, authFile });
        const bridgeH = bridgeFor(h, { central: address });
        try {
          bridgeG.start();
          bridgeH.start();
          await until(() => bridgeG.connected, 'G, with the token, to connect');
          await until(() => h.log.some(line => /[Aa]uthorization/.test(line)), `H, without the token, to be refused: ${h.log.join('\n')}`);
          assert.strictEqual(bridgeH.connected, false);
        } finally {
          await bridgeG.stop();
          await bridgeH.stop();
          await server.stop();
        }
      });
    }
  } finally {
    for (const bridge of bridges) await bridge.stop();
    for (const db of databases) await db.close?.();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(error => {
  console.error(error);
  process.exit(1);
});
