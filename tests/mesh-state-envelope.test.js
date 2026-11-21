/**
 * The state document through the mesh (mcp/servers/egc-memory/src/relay/state-envelope.ts),
 * the two halves on their own: what the sender refuses to seal (a credential
 * shape, a document behind a link, a text above the cap), what the receiver
 * refuses (a path that leaves the inbox, a text above the cap, an inbox
 * behind a link), the document of a detached checkout, and the key of the
 * machine taken from EGC_ENCRYPTION_KEY_FILE. Runs against the built memory
 * server.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'mcp', 'servers', 'egc-memory', 'build');
const POSIX = process.platform !== 'win32';
const DETACHED_COMMIT = '0123456789abcdef0123456789abcdef01234567';

if (!fs.existsSync(path.join(BUILD, 'relay', 'state-envelope.js'))) {
  console.log(`[SKIP] state-envelope build not found under ${BUILD}. Run 'npm run build' in mcp/servers/egc-memory first.`);
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

// A repository checkout by hand: HEAD as given and an origin, so the state
// of the project is keyed by the identity of the remote.
function checkoutOf(dir, headLine) {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), `${headLine}\n`);
  fs.writeFileSync(path.join(dir, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://example.com/team/app.git\n');
  return dir;
}

function noticeFor(projectPath, branch) {
  return { kind: 'state', projectPath, branch, scope: 'project', at: new Date().toISOString(), hint: '' };
}

async function runTests() {
  console.log('\n=== Testing the state envelope of the mesh ===\n');
  const envelopes = await import(pathToFileURL(path.join(BUILD, 'relay', 'state-envelope.js')).href);
  const sync = await import(pathToFileURL(path.join(BUILD, 'sync', 'envelope.js')).href);
  const encryption = await import(pathToFileURL(path.join(BUILD, 'encryption.js')).href);
  const branchState = await import(pathToFileURL(path.join(BUILD, 'branch-state.js')).href);
  const teamKey = Buffer.alloc(32, 5);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-state-envelope-'));
  const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, EGC_ENCRYPTION_KEY_FILE: process.env.EGC_ENCRYPTION_KEY_FILE };

  function machine(name) {
    const home = path.join(root, name);
    fs.mkdirSync(path.join(home, '.egc'), { recursive: true, mode: 0o700 });
    return { home, keys: { personal: encryption.loadOrCreateEncKey(path.join(home, '.egc', 'encryption.key')), integrity: null }, stateDir: path.join(home, '.egc', 'state') };
  }

  function writeState(m, project, branch, detachedCommit, body) {
    const file = branchState.resolveStateWrite(m.stateDir, project, branch, detachedCommit);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const branchLine = branch ? `branch: ${branch}\n` : '';
    encryption.writeStateFile(file, `# Project State\nproject: ${project}\n${branchLine}\n## Context\n${body}\n`, m.keys.personal);
    return file;
  }

  try {
    await test('an envelope whose path has a dot component, or leaves the tree, is not an envelope', () => {
      for (const relativePath of ['../state.md', 'a/../b.md', './a.md', 'a/./b.md', '/abs/a.md']) {
        assert.strictEqual(envelopes.cleanStateEnvelope({ tree: 'state', relativePath, sealed: 'x' }), null, relativePath);
      }
      assert.ok(envelopes.cleanStateEnvelope({ tree: 'state', relativePath: 'abc/def.md', sealed: 'x' }), 'a plain path is accepted');
    });

    await test('the receiver refuses a text above the cap of a box, as the sender would, and writes nothing', () => {
      const m = machine('home-cap');
      const big = `# Project State\nproject: /work/app\nbranch: main\n\n## Context\n${'x'.repeat(envelopes.MAX_ENVELOPE_PLAINTEXT_BYTES)}\n`;
      const outcome = envelopes.receiveStateEnvelope(m.home, m.keys, teamKey, { tree: 'state', relativePath: 'proj/main.md', sealed: sync.sealEnvelope(big, teamKey, 'proj/main.md') });
      assert.strictEqual(outcome.merged, 0);
      assert.strictEqual(outcome.rejected.length, 1, JSON.stringify(outcome));
      assert.match(outcome.rejected[0], /bytes/);
      assert.ok(!fs.existsSync(path.join(m.stateDir, 'proj', 'main.md')), 'nothing lands in the state');
      assert.ok(!fs.existsSync(path.join(m.home, '.egc', 'mesh', 'inbox', 'state', 'proj', 'main.md')), 'nothing lands in the inbox');
    });

    await test('the sender refuses a document that holds what looks like a credential', () => {
      const m = machine('home-secret');
      const project = checkoutOf(path.join(root, 'proj-secret'), 'ref: refs/heads/main');
      writeState(m, project, 'main', null, 'api_key = "sk-live-0123456789abcdef0123456789abcdef"');
      assert.throws(() => envelopes.sealStateDocument(m.home, m.keys, teamKey, noticeFor(project, 'main')), /looks like .* and is not sent/);
    });

    await test('the sender refuses a document above the cap of a box', () => {
      const m = machine('home-big');
      const project = checkoutOf(path.join(root, 'proj-big'), 'ref: refs/heads/main');
      writeState(m, project, 'main', null, 'y'.repeat(envelopes.MAX_ENVELOPE_PLAINTEXT_BYTES));
      assert.throws(() => envelopes.sealStateDocument(m.home, m.keys, teamKey, noticeFor(project, 'main')), /above the .* bytes a box may carry/);
    });

    if (POSIX) {
      await test('the sender refuses a state document that sits behind a link', () => {
        const m = machine('home-linked-doc');
        const project = checkoutOf(path.join(root, 'proj-linked'), 'ref: refs/heads/main');
        const elsewhere = path.join(m.home, 'elsewhere.md');
        encryption.writeStateFile(elsewhere, `# Project State\nproject: ${project}\nbranch: main\n\n## Context\nNot state.\n`, m.keys.personal);
        const target = branchState.resolveStateWrite(m.stateDir, project, 'main', null);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.symlinkSync(elsewhere, target);
        assert.throws(() => envelopes.sealStateDocument(m.home, m.keys, teamKey, noticeFor(project, 'main')), /behind a link and is not sent/);
      });

      await test('the receiver refuses an inbox that is a link and writes nothing through it', () => {
        const m = machine('home-linked-inbox');
        const elsewhere = path.join(m.home, 'elsewhere');
        fs.mkdirSync(elsewhere);
        fs.symlinkSync(elsewhere, path.join(m.home, '.egc', 'mesh'));
        const text = '# Project State\nproject: /work/app\nbranch: main\n\n## Context\nSmall.\n';
        const outcome = envelopes.receiveStateEnvelope(m.home, m.keys, teamKey, { tree: 'state', relativePath: 'proj/main.md', sealed: sync.sealEnvelope(text, teamKey, 'proj/main.md') });
        assert.strictEqual(outcome.merged, 0);
        assert.match(outcome.rejected[0] ?? '', /link/);
        assert.deepStrictEqual(fs.readdirSync(elsewhere), [], 'nothing is written where the link points');
      });
    }

    await test('the document of a detached checkout travels under its own name and merges on the other machine', () => {
      const sender = machine('home-detached-a');
      const receiver = machine('home-detached-b');
      const project = checkoutOf(path.join(root, 'proj-detached'), DETACHED_COMMIT);
      writeState(sender, project, null, DETACHED_COMMIT, 'Written at a detached commit.');
      const sealed = envelopes.sealStateDocument(sender.home, sender.keys, teamKey, noticeFor(project, null));
      assert.ok(sealed, 'the detached document is sealed');
      assert.match(sealed.relativePath, new RegExp(`/detached--${DETACHED_COMMIT}\\.md$`));
      const outcome = envelopes.receiveStateEnvelope(receiver.home, receiver.keys, teamKey, sealed);
      assert.strictEqual(outcome.merged, 1, JSON.stringify(outcome));
      const landed = path.join(receiver.stateDir, ...sealed.relativePath.split('/'));
      assert.ok(fs.existsSync(landed), `the document lands under the same path: ${landed}`);
      assert.ok(encryption.readStateFile(landed, receiver.keys.personal).includes('Written at a detached commit.'));
    });

    await test('the keys of the machine take the personal key from EGC_ENCRYPTION_KEY_FILE when it is set', () => {
      const home = path.join(root, 'home-keyfile');
      fs.mkdirSync(path.join(home, '.egc'), { recursive: true, mode: 0o700 });
      const configured = path.join(home, 'vault', 'egc.key');
      fs.mkdirSync(path.dirname(configured), { recursive: true, mode: 0o700 });
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      process.env.EGC_ENCRYPTION_KEY_FILE = configured;
      try {
        const keys = envelopes.machineKeys(home);
        assert.strictEqual(keys.personal.length, 32);
        assert.ok(fs.existsSync(configured), 'the key lives at the configured path');
        assert.ok(!fs.existsSync(path.join(home, '.egc', 'encryption.key')), 'no key is created in the home');
        assert.strictEqual(keys.personal.toString('hex'), fs.readFileSync(configured, 'utf8').trim(), 'it is the configured key');
      } finally {
        process.env.HOME = savedEnv.HOME;
        process.env.USERPROFILE = savedEnv.USERPROFILE;
        if (savedEnv.EGC_ENCRYPTION_KEY_FILE === undefined) delete process.env.EGC_ENCRYPTION_KEY_FILE;
        else process.env.EGC_ENCRYPTION_KEY_FILE = savedEnv.EGC_ENCRYPTION_KEY_FILE;
      }
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
