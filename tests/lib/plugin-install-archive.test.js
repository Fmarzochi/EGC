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
function buildArchive(dir, archiveName, entries) {
  const stage = path.join(dir, `stage-${archiveName}`);
  fs.mkdirSync(path.join(stage, 'package'), { recursive: true });
  for (const entry of entries) {
    const target = path.join(stage, entry.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (entry.link !== undefined) fs.symlinkSync(entry.link, target);
    else if (entry.content !== undefined) fs.writeFileSync(target, entry.content);
    else fs.mkdirSync(target, { recursive: true });
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
    if (test('a plugin name is one directory segment, optionally scoped', () => {
      assert.strictEqual(registry.pluginNameError('egc-plugin-docker'), null);
      assert.strictEqual(registry.pluginNameError('@scope/plugin'), null);
      for (const bad of ['../escape', '..', 'a/b', '/abs', 'name\\evil', '@scope/../x', '@a/b/c', '']) {
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
        const errors = registry.archiveInspectionErrors(archive);
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
        fs.symlinkSync(dir, path.join(source, 'rules'), 'dir');
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
        assert.ok(!fs.existsSync(path.join(installed, 'rules')), 'the linked directory is not copied');
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
