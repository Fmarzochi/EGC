/**
 * `egc plugin install` inspects a package archive before extracting it and
 * keeps every plugin under the store (security audit 2026-08-17, day 12): an
 * entry that climbs, an absolute name or a link is refused, a plugin name is
 * one directory segment, and a link inside a plugin is never copied.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');


function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function tarAvailable() {
  const probe = spawnSync('tar', ['--version'], { encoding: 'utf-8', stdio: 'pipe' });
  return probe.status === 0;
}

// An archive built from `entries` ({ name, content } for files, { name } for
// directories, { name, link } for symbolic links), all under package/.
// Null when a link entry cannot be created here (a platform without
// symbolic links for this user), so the caller skips instead of failing.
function stageEntry(stage, entry) {
  const target = path.join(stage, entry.name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (entry.link !== undefined) {
    try {
      fs.symlinkSync(entry.link, target);
    } catch {
      return false;
    }
  } else if (entry.content !== undefined) {
    fs.writeFileSync(target, entry.content);
  } else {
    fs.mkdirSync(target, { recursive: true });
  }
  return true;
}

function buildArchive(dir, archiveName, entries) {
  const stage = path.join(dir, `stage-${archiveName}`);
  fs.mkdirSync(path.join(stage, 'package'), { recursive: true });
  for (const entry of entries) {
    if (!stageEntry(stage, entry)) return null;
  }

  const archivePath = path.join(dir, archiveName);
  const packed = spawnSync('tar', ['-czf', archivePath, '-C', stage, 'package'], { encoding: 'utf-8', stdio: 'pipe' });
  assert.strictEqual(packed.status, 0, packed.stderr);
  return archivePath;
}

// A ustar header for one plain file, written by hand: tar itself refuses to
// create an entry whose name climbs, so the archive a hostile publisher
// would craft is assembled byte by byte here.
function ustarEntry(name, content) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'utf8');
  header.write('0000000\0', 108, 8, 'utf8');
  header.write('0000000\0', 116, 8, 'utf8');
  header.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
  header.write('00000000000\0', 136, 12, 'utf8');
  header.write('        ', 148, 8, 'utf8');
  header.write('0', 156, 1, 'utf8');
  header.write('ustar\0', 257, 6, 'utf8');
  header.write('00', 263, 2, 'utf8');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
  const body = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  body.write(content, 0, 'utf8');
  return Buffer.concat([header, body]);
}

function craftArchive(archivePath, entries) {
  const blocks = entries.map(([name, content]) => ustarEntry(name, content));
  fs.writeFileSync(archivePath, zlib.gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)])));
}

function runTests() {
  console.log('\n=== Testing plugin archive inspection and store containment ===\n');
  let passed = 0;
  let failed = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-plugin-archive-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete require.cache[require.resolve('../../scripts/lib/plugin-registry')];
  const registry = require('../../scripts/lib/plugin-registry');
  const validPlugin = [
    { name: 'package/plugin.json', content: JSON.stringify({ name: 'demo', version: '1.0.0', description: 'demo', egcPeerVersion: '>=1.1.0' }) },
    { name: 'package/skills/demo/SKILL.md', content: '# demo' },
  ];
  try {
    if (test('a scope and a plugin of the same name never share a store path', () => {
      const scoped = registry.getPluginDir('@scope/plugin');
      const plain = registry.getPluginDir('scope');
      assert.strictEqual(path.dirname(scoped), path.dirname(plain), 'both sit directly under the store');
      assert.notStrictEqual(scoped, plain);
      assert.ok(!scoped.startsWith(plain + path.sep), 'the scoped plugin is not inside the plain one');
      assert.ok(registry.pluginNameError('@scope'), 'a bare scope is not a name');
      assert.strictEqual(registry.pluginNameError('scope__plugin'), null, 'the stored spelling is itself a valid plain name and lands in its own directory');
      assert.notStrictEqual(registry.getPluginDir('scope__plugin'), scoped);
    })) passed++; else failed++;

    if (test('a plugin recorded under a name the store no longer accepts fails per plugin instead of throwing', () => {
      const lockPath = registry.PLUGINS_LOCK_PATH;
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, JSON.stringify({ schemaVersion: 'egc.plugins.v1', installed: { '../legacy': { name: '../legacy', version: '1.0.0' } } }));
      assert.strictEqual(registry.removePlugin('../legacy').success, false);
      assert.strictEqual(registry.updatePlugin('../legacy').success, false);
      const results = registry.reinstallAllPlugins();
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].success, false);
      assert.ok(results[0].errors[0].includes('no longer accepts'), JSON.stringify(results[0]));
      fs.writeFileSync(lockPath, JSON.stringify({ schemaVersion: 'egc.plugins.v1', installed: {} }));
    })) passed++; else failed++;

    if (test('a plugin whose required entry is a link is refused, not installed incomplete', () => {
      const source = path.join(dir, 'linked-required');
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(path.join(source, 'plugin.json'), JSON.stringify({ name: 'lr', version: '1.0.0', description: 'lr', egcPeerVersion: '>=1.1.0' }));
      fs.mkdirSync(path.join(dir, 'real-skills', 'demo'), { recursive: true });
      try {
        fs.symlinkSync(path.join(dir, 'real-skills'), path.join(source, 'skills'), 'dir');
      } catch (error) {
        console.log(`  - links not available here (${error.code}); skipped`);
        return;
      }
      const result = registry.installPluginFromDir(source, 'lr');
      assert.strictEqual(result.success, false, JSON.stringify(result));
      assert.ok(result.errors.some(error => error.includes('not a link')), JSON.stringify(result.errors));
      assert.ok(!fs.existsSync(path.join(home, '.egc', 'plugins', 'installed', 'lr')), 'nothing is recorded or left behind');
    })) passed++; else failed++;

    if (test('a plugin name is one directory segment, optionally scoped', () => {
      assert.strictEqual(registry.pluginNameError('egc-plugin-docker'), null);
      assert.strictEqual(registry.pluginNameError('@scope/plugin'), null);
      for (const bad of ['../escape', '..', 'a/b', '/abs', 'name\\evil', '@scope/../x', '@a/b/c', '@scope', '']) {
        assert.ok(registry.pluginNameError(bad), `${bad} must be refused`);
      }
      const result = registry.installPluginFromDir(dir, '../escape');
      assert.strictEqual(result.success, false);
      assert.ok(result.errors[0].includes('Invalid plugin name'), JSON.stringify(result.errors));
    })) passed++; else failed++;

    if (tarAvailable()) {
      if (test('an archive whose entries stay under package/ passes the inspection', () => {
        const archive = buildArchive(dir, 'ok.tgz', validPlugin);
        assert.deepStrictEqual(registry.archiveInspectionErrors(archive), []);
      })) passed++; else failed++;

      if (test('an archive with a symbolic link is refused before extraction', () => {
        const archive = buildArchive(dir, 'link.tgz', [...validPlugin, { name: 'package/rules/out.md', link: path.join(dir, 'outside.md') }]);
        if (archive === null) {
          console.log('  - links not available here; listing check skipped');
          return;
        }
        const errors = registry.archiveInspectionErrors(archive);
        assert.ok(errors.some(error => error.includes('not a plain file or directory')), JSON.stringify(errors));
      })) passed++; else failed++;

      if (test('the extracted tree is judged on disk, whatever the listing looked like', () => {
        const extracted = path.join(dir, 'extracted-tree');
        fs.mkdirSync(path.join(extracted, 'package', 'skills'), { recursive: true });
        fs.writeFileSync(path.join(extracted, 'package', 'plugin.json'), '{}');
        assert.deepStrictEqual(registry.extractedTreeErrors(extracted), []);
        try {
          fs.symlinkSync(dir, path.join(extracted, 'package', 'skills', 'escape'), 'dir');
        } catch (error) {
          console.log(`  - links not available here (${error.code}); clean tree only`);
          return;
        }
        const errors = registry.extractedTreeErrors(extracted);
        assert.ok(errors.some(error => error.includes('not a plain file or directory')), JSON.stringify(errors));
      })) passed++; else failed++;


      if (test('an archive with a climbing entry is refused before extraction', () => {
        const archive = path.join(dir, 'climb.tgz');
        craftArchive(archive, [['package/plugin.json', '{}'], ['package/../../escaped.md', 'x']]);
        const errors = registry.archiveInspectionErrors(archive);
        assert.ok(errors.some(error => error.includes('climbs out')), JSON.stringify(errors));
      })) passed++; else failed++;

      if (test('an archive with an absolute entry is refused before extraction', () => {
        const archive = path.join(dir, 'absolute.tgz');
        craftArchive(archive, [['package/plugin.json', '{}'], ['/tmp/escaped.md', 'x']]);
        const errors = registry.archiveInspectionErrors(archive);
        assert.ok(errors.some(error => error.includes('absolute name')), JSON.stringify(errors));
      })) passed++; else failed++;
    } else {
      console.log('  - skipped: tar is not available here');
    }

    if (test('a link inside a local plugin is never copied into the store', () => {
      const source = path.join(dir, 'local-plugin');
      fs.mkdirSync(path.join(source, 'skills', 'demo'), { recursive: true });
      fs.writeFileSync(path.join(source, 'plugin.json'), JSON.stringify({ name: 'local', version: '1.0.0', description: 'local', egcPeerVersion: '>=1.1.0' }));
      fs.writeFileSync(path.join(source, 'skills', 'demo', 'SKILL.md'), '# demo');
      fs.writeFileSync(path.join(dir, 'secret.md'), 'secret');
      let linked = true;
      try {
        fs.symlinkSync(path.join(dir, 'secret.md'), path.join(source, 'skills', 'demo', 'linked.md'));
        fs.symlinkSync(dir, path.join(source, 'skills', 'demo', 'linked-dir'), 'dir');
      } catch (error) {
        linked = false;
        console.log(`  - links not available here (${error.code}); copy check only`);
      }
      const result = registry.installPluginFromDir(source, 'local');
      assert.strictEqual(result.success, true, JSON.stringify(result.errors));
      const installed = path.join(home, '.egc', 'plugins', 'installed', 'local');
      assert.ok(fs.existsSync(path.join(installed, 'skills', 'demo', 'SKILL.md')));
      if (linked) {
        assert.ok(!fs.existsSync(path.join(installed, 'skills', 'demo', 'linked.md')), 'the linked file is not copied');
        assert.ok(!fs.existsSync(path.join(installed, 'skills', 'demo', 'linked-dir')), 'the linked directory is not copied');
      }

    })) passed++; else failed++;
  } finally {
    process.env.HOME = previousHome.HOME;
    process.env.USERPROFILE = previousHome.USERPROFILE;
    if (previousHome.USERPROFILE === undefined) delete process.env.USERPROFILE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
