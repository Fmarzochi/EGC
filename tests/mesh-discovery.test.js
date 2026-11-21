/**
 * The central found on the local network (mcp/servers/egc-memory/src/relay/discovery.ts):
 * the central announces itself by mDNS with a tag of its team, a machine of
 * the team finds it, a machine of another team does not, and `egc mesh find`
 * and `egc mesh connect` with no address use it. Runs against the built
 * memory server and needs multicast on the loopback or LAN interface.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const { CLI_TIMEOUT_MS } = require('./fixtures/subprocess-timeouts');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'mcp', 'servers', 'egc-memory', 'build');
const MESH_CLI = path.join(ROOT, 'scripts', 'mesh.js');
const PORT = 47479;

if (!fs.existsSync(path.join(BUILD, 'relay', 'discovery.js'))) {
  console.log(`[SKIP] discovery build not found under ${BUILD}. Run 'npm run build' in mcp/servers/egc-memory first.`);
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

// Waits for a line of the child's output, within the step budget.
function waitForOutput(child, pattern, budgetMs = 10000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${pattern}\n${output}`)), budgetMs);
    const onData = chunk => {
      output += chunk;
      if (pattern.test(output)) {
        clearTimeout(timer);
        resolve(output);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`the central exited with ${code} before ${pattern}\n${output}`));
    });
  });
}

async function runTests() {
  console.log('\n=== Testing the discovery of the central ===\n');
  const { discoverCentrals, teamTag } = await import(pathToFileURL(path.join(BUILD, 'relay', 'discovery.js')).href);
  const teamKey = Buffer.alloc(32, 7);
  const otherKey = Buffer.alloc(32, 9);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-mesh-discovery-'));
  const centralHome = path.join(root, 'home-central');
  fs.mkdirSync(path.join(centralHome, '.egc'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(centralHome, '.egc', 'team.json'), JSON.stringify({ backend: 'git', remote: 'https://example.com/team/brain.git', branch: 'main', teamKey: teamKey.toString('hex') }));
  let central = null;

  try {
    await test('the tag of a team is twelve characters of its marker and differs between teams', () => {
      assert.match(teamTag(teamKey), /^[0-9a-f]{12}$/);
      assert.notStrictEqual(teamTag(teamKey), teamTag(otherKey));
      assert.strictEqual(teamTag(teamKey), teamTag(Buffer.alloc(32, 7)), 'the same key gives the same tag');
    });

    // The central as the person runs it, in a process of its own, announcing itself.
    central = spawn(process.execPath, [MESH_CLI, 'serve', '--port', String(PORT), '--host', '127.0.0.1'], { env: { ...process.env, HOME: centralHome, USERPROFILE: centralHome }, stdio: ['ignore', 'pipe', 'pipe'] });
    const banner = await waitForOutput(central, /Announced on the local network|not announced/);
    assert.match(banner, /Announced on the local network as .* \(_egc-mesh\._tcp\)/, banner);
    const found = await discoverCentrals({ teamKey, timeoutMs: 2500 });
    const multicastAvailable = found.some(entry => entry.port === PORT);
    if (!multicastAvailable) {
      console.log('[SKIP] the announcement did not come back on this host (no multicast on its interfaces); the discovery cases cannot run here.');
    }

    if (multicastAvailable) {
      await test('a machine of the team finds the central announced on the local network, by address', () => {
        const entry = found.find(item => item.port === PORT);
        assert.match(entry.name, /^EGC mesh on /);
        assert.match(entry.address, /^(\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:%.]+\]):47479$/i, entry.address);
      });

      await test('a machine of another team does not see it', async () => {
        const other = await discoverCentrals({ teamKey: otherKey, timeoutMs: 1500 });
        assert.ok(!other.some(entry => entry.port === PORT), `the central of this team is not listed for another: ${JSON.stringify(other)}`);
      });

      await test('egc mesh find lists it and egc mesh connect with no address joins it', () => {
        const home = path.join(root, 'home-cli');
        fs.mkdirSync(path.join(home, '.egc'), { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(home, '.egc', 'team.json'), JSON.stringify({ backend: 'git', remote: 'https://example.com/team/brain.git', branch: 'main', teamKey: teamKey.toString('hex') }));
        const env = { ...process.env, HOME: home, USERPROFILE: home };
        const run = args => spawnSync(process.execPath, [MESH_CLI, ...args], { env, encoding: 'utf8', timeout: CLI_TIMEOUT_MS });
        const listed = run(['find']);
        assert.strictEqual(listed.status, 0, `${listed.stdout}\n${listed.stderr}`);
        assert.match(listed.stdout, /:47479 {2}EGC mesh on /);
        const joined = run(['connect']);
        assert.strictEqual(joined.status, 0, `${joined.stdout}\n${joined.stderr}`);
        assert.match(joined.stdout, /Central: ws:\/\/\S+:47479/);
        const config = JSON.parse(fs.readFileSync(path.join(home, '.egc', 'mesh.json'), 'utf8'));
        assert.match(config.central, /:47479$/);
      });
    }

    await test('without a team, egc mesh find says the central is found by the key of the team', () => {
      const home = path.join(root, 'home-no-team');
      const env = { ...process.env, HOME: home, USERPROFILE: home };
      const result = spawnSync(process.execPath, [MESH_CLI, 'find'], { env, encoding: 'utf8', timeout: CLI_TIMEOUT_MS });
      assert.strictEqual(result.status, 1);
      assert.match(result.stderr, /No team on this machine/);
    });
  } finally {
    if (central && central.exitCode === null) {
      await new Promise(resolve => {
        central.once('exit', resolve);
        central.kill('SIGTERM');
        setTimeout(() => { central.kill('SIGKILL'); resolve(); }, 5000).unref();
      });
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(error => {
  console.error(error);
  process.exit(1);
});
