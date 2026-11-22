/**
 * A new machine joins the team by a short code (mcp/servers/egc-memory/src/relay/pairing.ts):
 * the two machines show the same six digits, the team crosses sealed only
 * after both said yes, a no on either side shares nothing, a key planted in
 * the middle gives the two screens different digits, and `egc team invite`
 * and `egc team join` drive it from the terminal. Runs against the built
 * memory server.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const { CLI_TIMEOUT_MS } = require('./fixtures/subprocess-timeouts');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'mcp', 'servers', 'egc-memory', 'build');
const TEAM_CLI = path.join(ROOT, 'scripts', 'team.js');
const TEAM_KEY = 'a1'.repeat(32);
const TEAM = { backend: 'git', remote: 'https://example.com/team/brain.git', branch: 'main', teamKey: TEAM_KEY, autosync: true };
const CENTRAL = 'wss://mesh.example.com:47470';

if (!fs.existsSync(path.join(BUILD, 'relay', 'pairing.js'))) {
  console.log(`[SKIP] pairing build not found under ${BUILD}. Run 'npm run build' in mcp/servers/egc-memory first.`);
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

async function until(check, what, budgetMs = CLI_TIMEOUT_MS) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// The person at both screens: each side waits until both codes are known
// and says yes only when they match, as a person comparing them would.
function personAtBothScreens() {
  const codes = {};
  let bothKnown;
  const both = new Promise(resolve => { bothKnown = resolve; });
  const confirm = side => async code => {
    codes[side] = code;
    if (codes.inviter && codes.joiner) bothKnown();
    await both;
    return codes.inviter === codes.joiner;
  };
  return { codes, inviter: confirm('inviter'), joiner: confirm('joiner') };
}

// One leg of a relay in the middle: the first hello crosses with the key of
// the relay in place of the sender's, everything after crosses as it is.
function swapFirstHello(from, to, keys) {
  let swapped = false;
  let buffer = '';
  from.setEncoding('utf8');
  from.on('data', chunk => {
    if (swapped) {
      to.write(chunk);
      return;
    }
    buffer += chunk;
    const at = buffer.indexOf('\n');
    if (at === -1) return;
    const frame = JSON.parse(buffer.slice(0, at));
    if (frame.t === 'hello') frame.pub = keys.publicKey.toString('base64');
    to.write(`${JSON.stringify(frame)}\n${buffer.slice(at + 1)}`);
    swapped = true;
  });
  from.on('end', () => to.end());
  from.on('error', () => to.destroy());
}

// Someone in the middle: a relay that answers each side with a key of its
// own, so each side shares a secret with the relay and not with the other.
async function keyInTheMiddle(pairing, upstreamPort) {
  const server = net.createServer(client => {
    const upstream = net.connect({ host: '127.0.0.1', port: upstreamPort });
    swapFirstHello(client, upstream, pairing.newPairingKeys());
    swapFirstHello(upstream, client, pairing.newPairingKeys());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => new Promise(done => server.close(() => done())) };
}

function cliProcess(args, home) {
  const child = spawn(process.execPath, [TEAM_CLI, ...args], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  // A child that a signal ended has no code; exited tells it apart from one
  // still running, and signal says what ended it.
  const out = { text: '', code: null, signal: null, exited: false };
  child.stdout.on('data', chunk => { out.text += chunk; });
  child.stderr.on('data', chunk => { out.text += chunk; });
  child.on('exit', (code, signal) => { out.code = code; out.signal = signal; out.exited = true; });
  return { child, out };
}

async function runTests() {
  console.log('\n=== Testing the pairing by a short code ===\n');
  const pairing = await import(pathToFileURL(path.join(BUILD, 'relay', 'pairing.js')).href);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-pairing-'));
  const homeOf = name => {
    const home = path.join(root, name);
    fs.mkdirSync(path.join(home, '.egc'), { recursive: true, mode: 0o700 });
    return home;
  };
  const inviteOn = (options) => {
    let port;
    const ready = new Promise(resolve => { options.onReady = info => { port = info.port; resolve(info); }; });
    const outcome = pairing.invite({ team: TEAM, central: CENTRAL, host: '127.0.0.1', announce: false, timeoutMs: 20_000, ...options });
    return { ready, outcome, port: () => port };
  };

  try {
    await test('the code of an exchange is six digits, the same from either side', () => {
      const a = pairing.newPairingKeys();
      const b = pairing.newPairingKeys();
      const fromA = pairing.pairingCode(pairing.sharedSecret(a, b.publicKey), a.publicKey, b.publicKey);
      const fromB = pairing.pairingCode(pairing.sharedSecret(b, a.publicKey), b.publicKey, a.publicKey);
      assert.match(fromA, /^\d{6}$/);
      assert.strictEqual(fromA, fromB);
      assert.strictEqual(pairing.formatCode(fromA), `${fromA.slice(0, 3)} ${fromA.slice(3)}`);
    });

    await test('an invitation holds a bounded number of silent connections and turns the one past the cap away at once', async () => {
      const invitation = inviteOn({ confirm: async () => true, timeoutMs: 1500 });
      await invitation.ready;
      const silent = [];
      for (let count = 0; count < 8; count += 1) silent.push(net.connect(invitation.port(), '127.0.0.1'));
      await new Promise(resolve => setTimeout(resolve, 300));
      const extra = net.connect(invitation.port(), '127.0.0.1');
      const told = await new Promise(resolve => {
        let text = '';
        extra.on('data', chunk => { text += chunk; });
        extra.on('close', () => resolve(text));
        extra.on('error', () => resolve(text));
      });
      assert.match(told, /the invitation is busy/);
      for (const socket of silent) socket.destroy();
      const outcome = await invitation.outcome;
      assert.strictEqual(outcome.paired, false, 'nobody said hello, so nothing was paired');
    });

    await test('both screens show the same code, both say yes, and the team with its central lands on the new machine, sealed on the way', async () => {
      const person = personAtBothScreens();
      const written = [];
      const invitation = inviteOn({ confirm: person.inviter });
      await invitation.ready;
      const joined = await pairing.join({ address: `127.0.0.1:${invitation.port()}`, confirm: person.joiner, write: (team, central) => written.push({ team, central }) });
      const invited = await invitation.outcome;
      assert.strictEqual(person.codes.inviter, person.codes.joiner, 'the same six digits on both screens');
      assert.deepStrictEqual(invited, { paired: true, reason: null }, JSON.stringify(invited));
      assert.strictEqual(joined.paired, true, joined.reason ?? '');
      assert.deepStrictEqual(joined.team, { backend: 'git', remote: TEAM.remote, branch: 'main' });
      assert.strictEqual(joined.central, CENTRAL);
      assert.strictEqual(written.length, 1);
      assert.deepStrictEqual(written[0].team, TEAM, 'the team key and the sync settings arrive whole, with the sync on');
    });

    await test('a no on the joining machine shares nothing', async () => {
      const written = [];
      const invitation = inviteOn({ confirm: async () => true });
      await invitation.ready;
      const joined = await pairing.join({ address: `127.0.0.1:${invitation.port()}`, confirm: async () => false, write: () => written.push(true) });
      const invited = await invitation.outcome;
      assert.strictEqual(joined.paired, false);
      assert.match(joined.reason, /nothing was written/);
      assert.strictEqual(invited.paired, false);
      assert.match(invited.reason, /other machine said the codes differ/);
      assert.strictEqual(written.length, 0);
    });

    await test('a no on the inviting machine shares nothing', async () => {
      const written = [];
      const invitation = inviteOn({ confirm: async () => false });
      await invitation.ready;
      const joined = await pairing.join({ address: `127.0.0.1:${invitation.port()}`, confirm: async () => true, write: () => written.push(true) });
      const invited = await invitation.outcome;
      assert.strictEqual(invited.paired, false);
      assert.strictEqual(joined.paired, false);
      assert.match(joined.reason, /inviting machine said the codes differ/);
      assert.strictEqual(written.length, 0);
    });

    await test('a key planted in the middle gives the two screens different codes, and the person who says no keeps the team home', async () => {
      const person = personAtBothScreens();
      const written = [];
      const invitation = inviteOn({ confirm: person.inviter });
      await invitation.ready;
      const relay = await keyInTheMiddle(pairing, invitation.port());
      try {
        const joined = await pairing.join({ address: `127.0.0.1:${relay.port}`, confirm: person.joiner, write: () => written.push(true) });
        const invited = await invitation.outcome;
        assert.notStrictEqual(person.codes.inviter, person.codes.joiner, 'the codes differ with a key in the middle');
        assert.strictEqual(joined.paired, false);
        assert.strictEqual(invited.paired, false);
        assert.strictEqual(written.length, 0, 'nothing crossed');
      } finally {
        await relay.close();
      }
    });

    await test('what does not open as a team is not written', async () => {
      const written = [];
      const server = net.createServer(socket => {
        socket.setEncoding('utf8');
        socket.on('data', chunk => {
          if (chunk.includes('"hello"')) {
            const keys = pairing.newPairingKeys();
            socket.write(`${JSON.stringify({ t: 'hello', v: 1, pub: keys.publicKey.toString('base64') })}\n`);
          }
          if (chunk.includes('"confirm"')) socket.write(`${JSON.stringify({ t: 'team', id: 'ab'.repeat(16), box: Buffer.from('not a box at all, forty bytes of nothing..').toString('base64') })}\n`);
        });
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const joined = await pairing.join({ address: `127.0.0.1:${server.address().port}`, confirm: async () => true, write: () => written.push(true), timeoutMs: 10_000 });
        assert.strictEqual(joined.paired, false);
        assert.match(joined.reason, /did not open as a team/);
        assert.strictEqual(written.length, 0);
      } finally {
        await new Promise(resolve => server.close(resolve));
      }
    });

    await test('egc team invite and egc team join pair two homes from the terminal, and the new home holds the team', async () => {
      const homeA = homeOf('home-a');
      const homeB = homeOf('home-b');
      fs.writeFileSync(path.join(homeA, '.egc', 'team.json'), JSON.stringify(TEAM));
      const inviter = cliProcess(['invite', '--host', '127.0.0.1', '--no-announce'], homeA);
      try {
        await until(() => /egc team join 127\.0\.0\.1:\d+/.test(inviter.out.text), `the invitation to be ready:\n${inviter.out.text}`);
        const port = /egc team join 127\.0\.0\.1:(\d+)/.exec(inviter.out.text)[1];
        const joiner = cliProcess(['join', `127.0.0.1:${port}`], homeB);
        try {
          await until(() => /Code: \d{3} \d{3}/.test(inviter.out.text) && /Code: \d{3} \d{3}/.test(joiner.out.text), 'both codes on the screens');
          const codeA = /Code: (\d{3} \d{3})/.exec(inviter.out.text)[1];
          const codeB = /Code: (\d{3} \d{3})/.exec(joiner.out.text)[1];
          assert.strictEqual(codeA, codeB);
          inviter.child.stdin.end('y\n');
          joiner.child.stdin.end('y\n');
          await until(() => inviter.out.exited && joiner.out.exited, `both commands to end:\n${inviter.out.text}\n${joiner.out.text}`);
          assert.strictEqual(inviter.out.code, 0, inviter.out.text);
          assert.strictEqual(joiner.out.code, 0, joiner.out.text);
          assert.match(inviter.out.text, /joined the team/);
          assert.match(joiner.out.text, /Joined the team/);
          const onB = JSON.parse(fs.readFileSync(path.join(homeB, '.egc', 'team.json'), 'utf8'));
          assert.deepStrictEqual(onB, TEAM);
          assert.ok(!fs.existsSync(path.join(homeB, '.egc', 'mesh.json')), 'no central on A, none written on B');
        } finally {
          if (!joiner.out.exited) joiner.child.kill();
        }
      } finally {
        if (!inviter.out.exited) inviter.child.kill();
      }
    });

    await test('egc team join refuses to run over a team this machine already has, and egc team invite needs one', async () => {
      const homeC = homeOf('home-c');
      fs.writeFileSync(path.join(homeC, '.egc', 'team.json'), JSON.stringify(TEAM));
      const joiner = cliProcess(['join', '127.0.0.1:1'], homeC);
      await until(() => joiner.out.exited, 'join to end');
      assert.strictEqual(joiner.out.code, 1);
      assert.match(joiner.out.text, /already has a team/);
      const inviter = cliProcess(['invite'], homeOf('home-d'));
      await until(() => inviter.out.code !== null, 'invite to end');
      assert.strictEqual(inviter.out.code, 1);
      assert.match(inviter.out.text, /No team on this machine/);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(error => {
  console.error(error);
  process.exit(1);
});
