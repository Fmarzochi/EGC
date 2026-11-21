/**
 * The mesh relay between machines (mcp/servers/egc-memory/src/relay): the
 * keys derived from the team key, the answer to the central's challenge, the
 * sealed box and the refusal of a replayed or stale message; the central
 * letting in only the machines of the team, passing a box to one machine or
 * to all, keeping one for a machine that is off and giving way to a newer
 * connection of the same machine; and `egc mesh serve`. Runs against the
 * built memory server.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVER_DIR = path.join(ROOT, 'mcp', 'servers', 'egc-memory');
const BUILD = path.join(SERVER_DIR, 'build', 'relay');
const MESH_CLI = path.join(ROOT, 'scripts', 'mesh.js');
const STEP_TIMEOUT_MS = 5000;

if (!fs.existsSync(path.join(BUILD, 'hub.js'))) {
  console.log(`[SKIP] relay build not found under ${BUILD}. Run 'npm run build' in mcp/servers/egc-memory first.`);
  process.exit(0);
}

const protocol = require(path.join(BUILD, 'protocol.js'));
const { startHub, CLOSE_NOT_MEMBER, CLOSE_NO_HELLO, CLOSE_REPLACED } = require(path.join(BUILD, 'hub.js'));
const WebSocket = require(require.resolve('ws', { paths: [SERVER_DIR] }));

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

function within(promise, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), STEP_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// A machine connected to the central: every frame it receives is queued, and
// next(type) resolves with the first frame of that type not yet taken.
function connectMachine(port, machine, authKey) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const frames = [];
  const waiters = [];
  const closed = new Promise(resolve => socket.on('close', code => resolve(code)));
  socket.on('message', data => {
    const frame = protocol.parseHubFrame(data.toString());
    if (frame?.t === 'challenge') {
      socket.send(JSON.stringify({ t: 'hello', v: protocol.MESH_PROTOCOL_VERSION, machine, proof: protocol.helloProof(authKey, frame.challenge, machine) }));
      return;
    }
    frames.push(frame);
    for (const waiter of waiters.splice(0)) waiter();
  });
  const next = type => within(new Promise(resolve => {
    const take = () => {
      const index = frames.findIndex(frame => frame?.t === type);
      if (index === -1) {
        waiters.push(take);
        return;
      }
      resolve(frames.splice(index, 1)[0]);
    };
    take();
  }), `a ${type} frame`);
  const sendBox = (to, box, id) => socket.send(JSON.stringify({ t: 'send', v: protocol.MESH_PROTOCOL_VERSION, to, id, box }));
  return { socket, next, closed, sendBox, close: () => socket.close() };
}

async function runTests() {
  console.log('\n=== Testing the mesh relay ===\n');
  const teamKey = Buffer.alloc(32, 7);
  const authKey = protocol.meshAuthKey(teamKey);
  const sealKey = protocol.meshSealKey(teamKey);
  const A = protocol.newHexId();
  const B = protocol.newHexId();

  await test('the central key and the box key are derived apart from the team key and from each other', () => {
    assert.notDeepStrictEqual(authKey, sealKey);
    assert.notDeepStrictEqual(authKey, teamKey);
    assert.deepStrictEqual(protocol.meshAuthKey(Buffer.alloc(32, 7)), authKey, 'the same team key gives the same keys');
  });

  await test('the answer to a challenge proves the key for that challenge and that machine only', () => {
    const challenge = protocol.newChallenge();
    const proof = protocol.helloProof(authKey, challenge, A);
    assert.ok(protocol.proofMatches(authKey, challenge, A, proof));
    assert.ok(!protocol.proofMatches(authKey, protocol.newChallenge(), A, proof), 'another challenge');
    assert.ok(!protocol.proofMatches(authKey, challenge, B, proof), 'another machine');
    assert.ok(!protocol.proofMatches(protocol.meshAuthKey(Buffer.alloc(32, 8)), challenge, A, proof), 'another team');
    assert.ok(!protocol.proofMatches(authKey, challenge, A, 'not hex'), 'a malformed answer');
  });

  await test('a sealed box opens only with the box key, for its sender, addressee and id, and untouched', () => {
    const address = { from: A, to: B, id: protocol.newHexId() };
    const box = protocol.sealBox(sealKey, address, { type: 'event', body: { text: 'hello from A' } }, 1_000_000);
    const opened = protocol.openBox(sealKey, address, box);
    assert.deepStrictEqual(opened, { ts: 1_000_000, message: { type: 'event', body: { text: 'hello from A' } } });
    assert.strictEqual(protocol.openBox(sealKey, { ...address, to: protocol.BROADCAST }, box), null, 'another addressee');
    assert.strictEqual(protocol.openBox(sealKey, { ...address, id: protocol.newHexId() }, box), null, 'another id');
    assert.strictEqual(protocol.openBox(authKey, address, box), null, 'the central key');
    const bytes = Buffer.from(box, 'base64');
    bytes[bytes.length - 1] ^= 1;
    assert.strictEqual(protocol.openBox(sealKey, address, bytes.toString('base64')), null, 'an altered box');
  });

  await test('a message is accepted once, within its day and not ahead of the clock beyond the skew', () => {
    let now = 50_000_000_000;
    const guard = new protocol.ReplayGuard(() => now);
    const id = protocol.newHexId();
    const sealedAt = now - 1000;
    assert.ok(guard.accept(id, sealedAt));
    assert.ok(!guard.accept(id, sealedAt), 'the same id again');
    assert.ok(!guard.accept(protocol.newHexId(), now - protocol.MESSAGE_TTL_MS - 1), 'older than a day');
    assert.ok(!guard.accept(protocol.newHexId(), now + protocol.CLOCK_SKEW_MS + 1), 'too far ahead');
    now += protocol.MESSAGE_TTL_MS + 2000;
    assert.ok(!guard.accept(id, sealedAt), 'once the id is forgotten, the old message stays refused by its age');
  });

  await test('a frame outside the protocol is refused: another version, a bad id, a box that is not base64 or too large', () => {
    const id = protocol.newHexId();
    const ok = { t: 'send', v: 1, to: B, id, box: 'AAAA' };
    assert.ok(protocol.parseMachineFrame(JSON.stringify(ok)));
    assert.strictEqual(protocol.parseMachineFrame(JSON.stringify({ ...ok, v: 2 })), null);
    assert.strictEqual(protocol.parseMachineFrame(JSON.stringify({ ...ok, to: 'machine-b' })), null);
    assert.strictEqual(protocol.parseMachineFrame(JSON.stringify({ ...ok, box: 'not base64!' })), null);
    assert.strictEqual(protocol.parseMachineFrame(JSON.stringify({ ...ok, box: 'A'.repeat(protocol.MAX_BOX_BYTES + 4) })), null);
    assert.strictEqual(protocol.parseMachineFrame('not json'), null);
  });

  const hub = await startHub({ authKey, port: 0, host: '127.0.0.1', helloTimeoutMs: 500, heartbeatMs: 60_000 });
  try {
    await test('two machines of the team get in, see each other, and a box sent to one reaches it sealed as sent', async () => {
      const a = connectMachine(hub.port, A, authKey);
      await a.next('welcome');
      const b = connectMachine(hub.port, B, authKey);
      const welcomeB = await b.next('welcome');
      assert.deepStrictEqual(welcomeB.online, [A]);
      assert.deepStrictEqual(await a.next('presence'), { t: 'presence', v: 1, machine: B, online: true });
      const id = protocol.newHexId();
      a.sendBox(B, protocol.sealBox(sealKey, { from: A, to: B, id }, { type: 'event', body: 'to B' }), id);
      const delivered = await b.next('deliver');
      assert.strictEqual(delivered.from, A);
      assert.strictEqual(protocol.openBox(sealKey, { from: delivered.from, to: delivered.to, id: delivered.id }, delivered.box).message.body, 'to B');
      const all = protocol.newHexId();
      b.sendBox(protocol.BROADCAST, protocol.sealBox(sealKey, { from: B, to: protocol.BROADCAST, id: all }, { type: 'event', body: 'to all' }), all);
      const broadcast = await a.next('deliver');
      assert.strictEqual(broadcast.to, protocol.BROADCAST);
      a.close();
      b.close();
      await Promise.all([a.closed, b.closed]);
    });

    await test('a box for a machine that is off waits at the central and arrives when it connects again', async () => {
      const a = connectMachine(hub.port, A, authKey);
      await a.next('welcome');
      const id = protocol.newHexId();
      a.sendBox(B, protocol.sealBox(sealKey, { from: A, to: B, id }, { type: 'event', body: 'while you were off' }), id);
      const b = connectMachine(hub.port, B, authKey);
      await b.next('welcome');
      const delivered = await b.next('deliver');
      assert.strictEqual(delivered.id, id);
      a.close();
      b.close();
      await Promise.all([a.closed, b.closed]);
    });

    await test('a machine without the team key is shut out, and one that never answers is closed', async () => {
      const outsider = connectMachine(hub.port, protocol.newHexId(), protocol.meshAuthKey(Buffer.alloc(32, 9)));
      assert.strictEqual(await within(outsider.closed, 'the outsider to be closed'), CLOSE_NOT_MEMBER);
      const silent = new WebSocket(`ws://127.0.0.1:${hub.port}`);
      const code = await within(new Promise(resolve => silent.on('close', resolve)), 'the silent socket to be closed');
      assert.strictEqual(code, CLOSE_NO_HELLO);
    });

    await test('a box for a machine never seen is answered with an error, and a second connection of a machine replaces the first', async () => {
      const a = connectMachine(hub.port, A, authKey);
      await a.next('welcome');
      const id = protocol.newHexId();
      const stranger = protocol.newHexId();
      a.sendBox(stranger, protocol.sealBox(sealKey, { from: A, to: stranger, id }, { type: 'event', body: 'lost' }), id);
      assert.match((await a.next('error')).reason, /was seen in the last day/);
      const again = connectMachine(hub.port, A, authKey);
      await again.next('welcome');
      assert.strictEqual(await within(a.closed, 'the first connection to be replaced'), CLOSE_REPLACED);
      again.close();
      await again.closed;
    });
  } finally {
    await hub.close();
  }

  await test('egc mesh serve runs the central with the key of the team and stops on SIGTERM; without a team it says so', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-mesh-serve-'));
    try {
      const env = { ...process.env, HOME: home, USERPROFILE: home };
      const lonely = spawnSync(process.execPath, [MESH_CLI, 'serve', '--port', '0', '--host', '127.0.0.1'], { env, encoding: 'utf8', timeout: STEP_TIMEOUT_MS });
      assert.strictEqual(lonely.status, 1);
      assert.match(lonely.stderr, /No team on this machine/);
      const badPort = spawnSync(process.execPath, [MESH_CLI, 'serve', '--port', 'many'], { env, encoding: 'utf8', timeout: STEP_TIMEOUT_MS });
      assert.strictEqual(badPort.status, 2);
      fs.mkdirSync(path.join(home, '.egc'), { recursive: true });
      fs.writeFileSync(path.join(home, '.egc', 'team.json'), JSON.stringify({ backend: 'git', remote: path.join(home, 'x.git'), branch: 'main', teamKey: teamKey.toString('hex') }));
      const child = spawn(process.execPath, [MESH_CLI, 'serve', '--port', '0', '--host', '127.0.0.1'], { env });
      const exited = new Promise(resolve => child.on('exit', resolve));
      const port = await within(new Promise(resolve => {
        let out = '';
        child.stdout.on('data', chunk => {
          out += chunk;
          const match = /listening on 127\.0\.0\.1:(\d+)/.exec(out);
          if (match) resolve(Number(match[1]));
        });
      }), 'the central to listen');
      const a = connectMachine(port, A, authKey);
      await a.next('welcome');
      a.close();
      await a.closed;
      child.kill('SIGTERM');
      await within(exited, 'the central to stop');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(error => {
  console.error(error);
  process.exit(1);
});
