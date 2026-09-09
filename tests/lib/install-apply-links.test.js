/**
 * The installer refuses to write through a symbolic link at the destination
 * or under a linked directory inside the target root (security audit
 * 2026-08-17, day 11); the root itself may be a link the user made.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findLegacyLinks, refuseLinkedDestination, writeGuardianCliMarker, writeManagedText } = require('../../scripts/lib/install/apply');

const { createInstallState, writeInstallState } = require('../../scripts/lib/install-state');


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

function runTests() {
  console.log('\n=== Testing linked destinations in the installer ===\n');
  let passed = 0;
  let failed = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-apply-links-'));
  const root = path.join(dir, 'root');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  let links = true;
  try {
    fs.writeFileSync(path.join(outside, 'target.md'), 'outside');
    fs.symlinkSync(path.join(outside, 'target.md'), path.join(root, 'linked.md'));
    fs.symlinkSync(outside, path.join(root, 'linked-dir'), 'dir');
    fs.symlinkSync(root, path.join(dir, 'root-link'), 'dir');
  } catch (error) {
    links = false;
    console.log(`  - skipped: cannot create symlinks here (${error.code})`);
  }
  try {
    if (links) {
      if (test('a destination that is a link is refused', () => {
        assert.throws(() => refuseLinkedDestination(path.join(root, 'linked.md'), root), /symbolic link/);
      })) passed++; else failed++;

      if (test('a destination under a linked directory inside the root is refused, even when the file does not exist yet', () => {
        assert.throws(() => refuseLinkedDestination(path.join(root, 'linked-dir', 'deep', 'new.md'), root), /symbolic link/);
        assert.ok(!fs.existsSync(path.join(outside, 'deep')));
      })) passed++; else failed++;

      if (test('the Guardian marker is not written through a linked .egc directory', () => {
        const home = path.join(dir, 'home');
        fs.mkdirSync(home, { recursive: true });
        fs.symlinkSync(outside, path.join(home, '.egc'), 'dir');
        const warnings = [];
        writeGuardianCliMarker(message => warnings.push(message), home);
        assert.ok(warnings.some(message => message.includes('symbolic link')), JSON.stringify(warnings));
        assert.ok(!fs.existsSync(path.join(outside, 'guardian-cli-path.json')), 'nothing lands behind the link');
      })) passed++; else failed++;

      if (test('a link into the managed skills copy under the same root is EGC\'s legacy layout: listed by a dry run, replaced on apply (#1400)', () => {
        // The June 2026 Antigravity CLI layout: skills/<skill> under the
        // target root as a link into <root>/skills/egc/<skill>.
        const home = path.join(dir, 'legacy-home');
        const managed = path.join(home, 'skills', 'egc', 'demo');
        fs.mkdirSync(managed, { recursive: true });
        fs.writeFileSync(path.join(managed, 'SKILL.md'), 'managed copy');
        const cliSkills = path.join(home, 'antigravity-cli', 'skills');
        fs.mkdirSync(cliSkills, { recursive: true });
        const link = path.join(cliSkills, 'demo');
        fs.symlinkSync(managed, link, 'dir');
        const destination = path.join(link, 'SKILL.md');

        assert.throws(() => refuseLinkedDestination(destination, home), /symbolic link/, 'without migration the refusal stands');

        const listed = findLegacyLinks({ targetRoot: home, operations: [{ destinationPath: destination }, { destinationPath: path.join(link, 'other.md') }] });
        assert.deepStrictEqual(listed, [{ linkPath: link, resolvedTo: managed }], 'the dry run lists the link once');
        assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the dry run touches nothing');

        const migrate = [];
        assert.doesNotThrow(() => refuseLinkedDestination(destination, home, { migrate }));
        assert.deepStrictEqual(migrate, [{ linkPath: link, resolvedTo: managed }]);
        assert.ok(!fs.existsSync(link), 'the link is gone');
        assert.strictEqual(fs.readFileSync(path.join(managed, 'SKILL.md'), 'utf8'), 'managed copy', 'what it pointed at is untouched');
        assert.doesNotThrow(() => refuseLinkedDestination(destination, home, { migrate }), 'a second pass finds no link');
        assert.strictEqual(migrate.length, 1);
      })) passed++; else failed++;

      if (test('a link that resolves anywhere else is refused even when migration is on', () => {
        const home = path.join(dir, 'foreign-home');
        const cliSkills = path.join(home, 'antigravity-cli', 'skills');
        fs.mkdirSync(cliSkills, { recursive: true });
        fs.mkdirSync(path.join(home, 'skills', 'egc'), { recursive: true });
        const elsewhere = path.join(cliSkills, 'elsewhere');
        fs.symlinkSync(outside, elsewhere, 'dir');
        const dangling = path.join(cliSkills, 'dangling');
        fs.symlinkSync(path.join(home, 'skills', 'egc', 'missing'), dangling, 'dir');
        const migrate = [];
        assert.throws(() => refuseLinkedDestination(path.join(elsewhere, 'SKILL.md'), home, { migrate }), /symbolic link/);
        assert.throws(() => refuseLinkedDestination(path.join(dangling, 'SKILL.md'), home, { migrate }), /symbolic link/, 'a dangling link resolves nowhere');
        assert.deepStrictEqual(migrate, []);
        assert.ok(fs.lstatSync(elsewhere).isSymbolicLink() && fs.lstatSync(dangling).isSymbolicLink(), 'both links stay');
        assert.deepStrictEqual(findLegacyLinks({ targetRoot: home, operations: [{ destinationPath: path.join(elsewhere, 'SKILL.md') }] }), []);
      })) passed++; else failed++;

      if (test('a root that is itself a link is allowed', () => {
        const viaLink = path.join(dir, 'root-link');
        assert.doesNotThrow(() => refuseLinkedDestination(path.join(viaLink, 'rules', 'plain.md'), viaLink));
      })) passed++; else failed++;
    }

    if (test('a hard link at the destination is replaced and the aliased file keeps its content', () => {
      const aliased = path.join(outside, 'aliased.md');
      fs.writeFileSync(aliased, 'aliased content');
      fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
      const destination = path.join(root, 'notes', 'hard.md');
      try {
        fs.linkSync(aliased, destination);
      } catch (error) {
        console.log(`  - skipped: cannot create hard links here (${error.code})`);
        return;
      }
      assert.doesNotThrow(() => refuseLinkedDestination(destination, root), 'a hard link is a regular name to lstat');
      writeManagedText(destination, 'managed');
      assert.strictEqual(fs.readFileSync(aliased, 'utf8'), 'aliased content', 'the aliased file is untouched');
      assert.strictEqual(fs.readFileSync(destination, 'utf8'), 'managed');
      assert.strictEqual(fs.statSync(destination).nlink, 1, 'the destination is its own file now');
      const statePath = path.join(root, 'notes', 'egc-install-state.json');
      fs.linkSync(aliased, statePath);
      const state = createInstallState({
        adapter: { id: 'cursor-project' },
        targetRoot: root,
        installStatePath: statePath,
        request: { profile: 'developer', modules: [], legacyLanguages: [], legacyMode: false },
        resolution: { selectedModules: [], skippedModules: [] },
        operations: [],
        source: { repoVersion: require('../../package.json').version, repoCommit: 'abc123', manifestVersion: 1 },
      });
      writeInstallState(statePath, state);
      assert.strictEqual(fs.readFileSync(aliased, 'utf8'), 'aliased content', 'the state file never writes through a link either');
      assert.strictEqual(fs.statSync(statePath).nlink, 1);
      assert.strictEqual(fs.readdirSync(path.join(root, 'notes')).filter(name => name.endsWith('.tmp')).length, 0, 'no temporary survives');
    })) passed++; else failed++;

    if (test('a plain destination, existing or not, passes', () => {
      fs.mkdirSync(path.join(root, 'rules'), { recursive: true });
      fs.writeFileSync(path.join(root, 'rules', 'existing.md'), 'x');
      assert.doesNotThrow(() => refuseLinkedDestination(path.join(root, 'rules', 'existing.md'), root));
      assert.doesNotThrow(() => refuseLinkedDestination(path.join(root, 'rules', 'later.md'), root));
      assert.doesNotThrow(() => refuseLinkedDestination(path.join(outside, 'elsewhere.md'), root));
    })) passed++; else failed++;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
