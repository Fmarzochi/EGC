'use strict';
/**
 * buildRelevantContext is what orchestrate_task calls: it owns the safety
 * checks, the lock, the audit events, and turning every failure into an
 * "unavailable" answer instead of an error.
 *
 * Run with: node tests/egc-guardian-graph-context.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CLI_TIMEOUT_MS } = require('./fixtures/subprocess-timeouts.js');

const buildDir = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build');
if (!fs.existsSync(path.join(buildDir, 'graph-context.js'))) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}
const { buildRelevantContext } = require(path.join(buildDir, 'graph-context.js'));
const { graphDbPath, openGraphStore } = require(path.join(buildDir, 'graph-store.js'));
const { withBuildLock } = require(path.join(buildDir, 'graph-build.js'));

let passed = 0;
let failed = 0;
async function run(name, fn) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.stack || err.message}`);
    failed++;
  }
}

// Resolves once the child is gone. On Windows a process that is still dying holds
// the database under the temp tree open, and the tree cannot be removed under it.
function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    child.once('exit', resolve);
    child.kill();
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-graph-context-'));
const env = { ...process.env, EGC_DIR: path.join(tmp, 'egc-home') };
const root = path.join(tmp, 'proj');
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, 'helper.js'), 'export function parseHelper(input) {\n  return String(input).trim();\n}\n');
fs.writeFileSync(path.join(root, 'main.js'), "import { parseHelper } from './helper.js';\nexport function runMain(x) {\n  return parseHelper(x);\n}\n");
fs.writeFileSync(path.join(root, 'secrets.js'), 'export const apiKey = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";\nexport function useKey() { return apiKey; }\n');

(async () => {
  await run('returns ranked snippets with graph stats, then refreshes nothing on the second call', async () => {
    const audits = [];
    const deps = { env, audit: (action, details) => audits.push({ action, details }) };
    const first = await buildRelevantContext('change parseHelper to also lowercase', root, undefined, deps);
    assert.strictEqual(first.status, 'ok', JSON.stringify(first));
    assert.strictEqual(first.files[0].path, 'helper.js');
    assert.strictEqual(first.files[0].snippets[0].symbol, 'parseHelper');
    assert.ok('start_line' in first.files[0].snippets[0]);
    assert.ok(first.files.some(f => f.path === 'main.js'), 'the caller comes along');
    assert.strictEqual(first.graph.refreshed, 3);
    assert.strictEqual(first.graph.build, 'ran');

    const second = await buildRelevantContext('change parseHelper', root, undefined, deps);
    assert.strictEqual(second.graph.refreshed, 0);
    const events = audits.map(a => a.action);
    assert.ok(events.includes('GRAPH_QUERY'));
    assert.ok(!JSON.stringify(audits).includes('trim()'), 'audit events carry no snippet text');
  });

  await run('a directory swapped for a link after the build never leaks what is outside the project', async () => {
    const proj = path.join(tmp, 'swap');
    fs.mkdirSync(path.join(proj, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'lib', 'helper.js'), 'export function leakTarget() {\n  return 1;\n}\n');
    const outside = path.join(tmp, 'outside-swap');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'helper.js'), 'export function leakTarget() {\n  return "TOP-SECRET-OUTSIDE";\n}\n');
    const deps = {
      env,
      // After the build has indexed lib/helper.js and before the snippets are read.
      audit: action => {
        if (action !== 'GRAPH_BUILD') return;
        fs.rmSync(path.join(proj, 'lib'), { recursive: true, force: true });
        try {
          fs.symlinkSync(outside, path.join(proj, 'lib'), 'junction');
          swapped = true;
        } catch {
          // links are not available here
        }
      }
    };
    let swapped = false;
    const r = await buildRelevantContext('change leakTarget', proj, undefined, deps);
    assert.ok(!JSON.stringify(r).includes('TOP-SECRET-OUTSIDE'), 'content from outside the project was returned');
    if (!swapped) console.log('    - directory links not available here (EPERM); nothing to swap');
  });

  await run('a build held by another process is reported unavailable after the wait, then works once it ends', async () => {
    const proj = path.join(tmp, 'busy');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'a.js'), 'export function busyTarget() {\n  return 1;\n}\n');
    const dbPath = graphDbPath(fs.realpathSync(proj), env);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    let release;
    const holder = withBuildLock(dbPath, () => new Promise(resolve => { release = resolve; }));
    await new Promise(resolve => setTimeout(resolve, 50));
    const busy = await buildRelevantContext('change busyTarget', proj, undefined, { env, lockWaitMs: 120 });
    assert.strictEqual(busy.status, 'unavailable', JSON.stringify(busy));
    assert.ok(String(busy.reason).includes('another process'), busy.reason);
    assert.ok(!fs.existsSync(dbPath), 'a caller without the lock opens no store, so it cannot write a stale copy back');
    release();
    await holder;
    const after = await buildRelevantContext('change busyTarget', proj, undefined, { env });
    assert.strictEqual(after.status, 'ok', JSON.stringify(after));
    assert.strictEqual(after.files[0].path, 'a.js');
  });

  await run('the full protection check runs on the root and on snippet files only; the cheap one covers every file', async () => {
    const proj = path.join(tmp, 'tiers');
    fs.mkdirSync(proj, { recursive: true });
    const FILES = 25;
    for (let i = 0; i < FILES; i++) fs.writeFileSync(path.join(proj, `m${i}.js`), `export function tiered${i}() {\n  return ${i};\n}\n`);
    const full = [];
    const cheap = [];
    const deps = {
      env,
      isProtectedPath: p => { full.push(p); return false; },
      isIndexExcluded: p => { cheap.push(p); return false; }
    };
    const r = await buildRelevantContext('change tiered3', proj, undefined, deps);
    assert.strictEqual(r.status, 'ok', JSON.stringify(r));
    assert.ok(cheap.length >= FILES, `the cheap check saw ${cheap.length} paths`);
    assert.ok(full.length <= 1 + r.files.reduce((n, f) => n + f.snippets.length, 0), `the full check ran ${full.length} times`);
    assert.ok(full.length < FILES, 'the full check did not run for every file');
  });

  await run('a file the full check protects is never read for a snippet, even though the cheap check let it be indexed', async () => {
    const proj = path.join(tmp, 'tiers-snippet');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'guarded.js'), 'export function guardedTarget() {\n  return "GUARDED-CONTENT";\n}\n');
    const asked = [];
    const deps = {
      env,
      isProtectedPath: p => {
        asked.push(p);
        return p.endsWith('guarded.js');
      },
      isIndexExcluded: () => false
    };
    const r = await buildRelevantContext('change guardedTarget', proj, undefined, deps);
    // Not vacuous: the call succeeded and the full check was asked about the file a snippet would come from.
    assert.strictEqual(r.status, 'ok', JSON.stringify(r));
    assert.ok(asked.some(p => p.endsWith('guarded.js')), 'the snippet guard was never reached');
    assert.ok(!JSON.stringify(r).includes('GUARDED-CONTENT'), 'the protected file was read for a snippet');
  });

  await run('a protection check that throws gives an unavailable graph, not a rejected call', async () => {
    const proj = path.join(tmp, 'tiers-throws');
    fs.mkdirSync(proj, { recursive: true });
    const r = await buildRelevantContext('anything', proj, undefined, {
      env,
      isProtectedPath: () => {
        throw new Error('check blew up');
      }
    });
    assert.strictEqual(r.status, 'unavailable');
    assert.ok(String(r.reason).includes('check blew up'), r.reason);
  });

  await run('a protected project root is unavailable', async () => {
    const proj = path.join(tmp, 'tiers-root');
    fs.mkdirSync(proj, { recursive: true });
    const r = await buildRelevantContext('anything', proj, undefined, { env, isProtectedPath: () => true });
    assert.strictEqual(r.status, 'unavailable');
    assert.ok(String(r.reason).includes('protected'), r.reason);
  });

  await run('a store that fails to save on close makes the call unavailable, not ok', async () => {
    const proj = path.join(tmp, 'closefail');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'a.js'), 'export function closeTarget() {\n  return 1;\n}\n');
    const audits = [];
    const deps = {
      env,
      audit: action => audits.push(action),
      openStore: async dbPath => {
        const real = await openGraphStore(dbPath);
        return new Proxy(real, {
          get(target, prop) {
            if (prop === 'close') {
              return async () => {
                await target.close();
                throw new Error('could not persist the graph');
              };
            }
            const value = target[prop];
            return typeof value === 'function' ? value.bind(target) : value;
          }
        });
      }
    };
    const r = await buildRelevantContext('change closeTarget', proj, undefined, deps);
    assert.strictEqual(r.status, 'unavailable', JSON.stringify(r));
    assert.ok(String(r.reason).includes('could not persist'), r.reason);
    assert.ok(audits.includes('GRAPH_ERROR'));
  });

  await run('a database that opens but is damaged further in is rebuilt once, and other failures are not retried', async () => {
    const proj = path.join(tmp, 'late-damage');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'a.js'), 'export function lateTarget() {\n  return 1;\n}\n');
    let opened = 0;
    const damagedOnce = {
      env,
      openStore: async dbPath => {
        const real = await openGraphStore(dbPath);
        opened++;
        if (opened > 1) return real;
        return new Proxy(real, {
          get(target, prop) {
            if (prop === 'getFiles') return async () => { throw new Error('database disk image is malformed'); };
            const value = target[prop];
            return typeof value === 'function' ? value.bind(target) : value;
          }
        });
      }
    };
    const recovered = await buildRelevantContext('change lateTarget', proj, undefined, damagedOnce);
    assert.strictEqual(recovered.status, 'ok', JSON.stringify(recovered));
    assert.strictEqual(opened, 2, 'opened once to find the damage and once after removing the database');
    assert.strictEqual(recovered.files[0].path, 'a.js');

    let attempts = 0;
    const refused = await buildRelevantContext('change lateTarget', proj, undefined, {
      env,
      openStore: async () => {
        attempts++;
        throw new Error('EACCES: permission denied');
      }
    });
    assert.strictEqual(refused.status, 'unavailable');
    assert.strictEqual(attempts, 1, 'a failure that is not damage is not retried');

    let always = 0;
    const stillDamaged = await buildRelevantContext('change lateTarget', proj, undefined, {
      env,
      openStore: async () => {
        always++;
        throw new Error('SQLITE_CORRUPT: database disk image is malformed');
      }
    });
    assert.strictEqual(stillDamaged.status, 'unavailable');
    assert.strictEqual(always, 2, 'damage that comes back is reported after one rebuild, not retried forever');
  });

  await run('transformSnippet is applied to everything returned', async () => {
    const r = await buildRelevantContext('parseHelper', root, undefined, { env, transformSnippet: t => t.replace(/trim\(\)/g, 'HIDDEN') });
    assert.ok(JSON.stringify(r).includes('HIDDEN'));
    assert.ok(!JSON.stringify(r).includes('trim()'));
  });

  await run('a protected path callback keeps a file out of the graph', async () => {
    const r = await buildRelevantContext('useKey apiKey', root, undefined, { env, isProtectedPath: p => path.basename(p) === 'secrets.js' });
    assert.ok(!JSON.stringify(r).includes('sk-ant'), 'the secret never appears');
  });

  await run('bad project paths are unavailable, not errors and not walked', async () => {
    for (const p of [path.join(tmp, 'missing'), path.join(root, 'main.js'), path.parse(root).root, os.homedir()]) {
      const r = await buildRelevantContext('anything useful', p, undefined, { env });
      assert.strictEqual(r.status, 'unavailable', p);
      assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
    }
  });

  await run('a prompt with no usable words is ok with no files', async () => {
    const r = await buildRelevantContext('???', root, undefined, { env });
    assert.strictEqual(r.status, 'ok');
    assert.deepStrictEqual(r.files, []);
  });

  await run('a corrupt database is rebuilt once and the call still succeeds', async () => {
    const db = graphDbPath(fs.realpathSync(root), env);
    fs.writeFileSync(db, 'not sqlite '.repeat(200));
    const r = await buildRelevantContext('parseHelper', root, undefined, { env });
    assert.strictEqual(r.status, 'ok', JSON.stringify(r));
    assert.strictEqual(r.files[0].path, 'helper.js');
  });

  await run('two callers at once on a cold project both succeed', async () => {
    const cold = path.join(tmp, 'cold');
    fs.mkdirSync(cold);
    fs.writeFileSync(path.join(cold, 'a.js'), 'export function coldStart() { return 1; }\n');
    const [x, y] = await Promise.all([
      buildRelevantContext('coldStart', cold, undefined, { env }),
      buildRelevantContext('coldStart', cold, undefined, { env })
    ]);
    for (const r of [x, y]) assert.notStrictEqual(r.status, undefined);
    assert.ok([x, y].some(r => r.status === 'ok' && r.graph.build === 'ran'));
    for (const r of [x, y]) assert.ok(r.status === 'ok' || r.status === 'unavailable', JSON.stringify(r));
  });

  await run('orchestrate_task over stdio returns relevant_context and keeps its other fields', async () => {
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, [path.join(buildDir, 'index.js')], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    const pending = new Map();
    let buf = '';
    child.stdout.on('data', chunk => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        pending.get(msg.id)?.(msg);
      }
    });
    const rpc = (id, method, params) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout on ${method}`)), CLI_TIMEOUT_MS);
      pending.set(id, msg => { clearTimeout(timer); resolve(msg); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    try {
      await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const res = await rpc(2, 'tools/call', { name: 'orchestrate_task', arguments: { prompt: 'change parseHelper', project_path: root } });
      const body = JSON.parse(res.result.content[0].text);
      assert.ok(body.routing && body.context_reduction, 'existing fields are intact');
      assert.strictEqual(body.relevant_context.status, 'ok', JSON.stringify(body.relevant_context));
      assert.strictEqual(body.relevant_context.files[0].path, 'helper.js');
    } finally {
      await stop(child);
    }
  });

  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (err) {
    console.log(`  FAIL removing ${tmp}: ${err.message}`);
    failed++;
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
