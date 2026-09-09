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
const { checkedDestinations, findLegacyLinks, refuseLinkedDestination, removeLegacyLinks, writeGuardianCliMarker, writeManagedText } = require('../../scripts/lib/install/apply');

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

        // resolvedTo is a real path; on macOS the temp directory sits behind a link.
        const realManaged = fs.realpathSync.native(managed);
        const listed = findLegacyLinks({ targetRoot: home, installStatePath: path.join(home, 'egc', 'install-state.json'), operations: [{ destinationPath: destination }, { destinationPath: path.join(link, 'other.md') }] });
        assert.deepStrictEqual(listed, [{ linkPath: link, resolvedTo: realManaged }], 'the dry run lists the link once');
        assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the dry run touches nothing');

        const migrate = [];
        assert.doesNotThrow(() => refuseLinkedDestination(destination, home, { migrate }));
        assert.deepStrictEqual(migrate, [{ linkPath: link, resolvedTo: realManaged }]);
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
        const plan = { targetRoot: home, installStatePath: path.join(home, 'egc', 'install-state.json'), operations: [{ destinationPath: path.join(elsewhere, 'SKILL.md') }] };
        assert.deepStrictEqual(findLegacyLinks(plan), [], 'the dry run lists nothing for it');
        assert.throws(() => findLegacyLinks(plan, { strict: true }), /symbolic link/, 'the strict pass refuses it before anything is removed');
      })) passed++; else failed++;

      if (test('a managed skills directory that is itself a link elsewhere is not EGC\'s copy: links into it keep the refusal', () => {
        const home = path.join(dir, 'linked-managed-home');
        const elsewhere = path.join(dir, 'elsewhere-copy');
        fs.mkdirSync(path.join(elsewhere, 'demo'), { recursive: true });
        fs.mkdirSync(path.join(home, 'skills'), { recursive: true });
        fs.symlinkSync(elsewhere, path.join(home, 'skills', 'egc'), 'dir');
        const cliSkills = path.join(home, 'antigravity-cli', 'skills');
        fs.mkdirSync(cliSkills, { recursive: true });
        fs.symlinkSync(path.join(home, 'skills', 'egc', 'demo'), path.join(cliSkills, 'demo'), 'dir');
        const migrate = [];
        assert.throws(() => refuseLinkedDestination(path.join(cliSkills, 'demo', 'SKILL.md'), home, { migrate }), /symbolic link/);
        assert.deepStrictEqual(migrate, []);
        assert.ok(fs.lstatSync(path.join(cliSkills, 'demo')).isSymbolicLink(), 'nothing removed');
      })) passed++; else failed++;

      if (test('a link that changed after the scan is refused at removal time, and nothing is removed', () => {
        const home = path.join(dir, 'swap-home');
        const managed = path.join(home, 'skills', 'egc', 'demo');
        fs.mkdirSync(managed, { recursive: true });
        const cliSkills = path.join(home, 'antigravity-cli', 'skills');
        fs.mkdirSync(cliSkills, { recursive: true });
        const link = path.join(cliSkills, 'demo');
        fs.symlinkSync(managed, link, 'dir');
        const migrate = [];
        refuseLinkedDestination(path.join(link, 'SKILL.md'), home, { migrate, dryRun: true });
        assert.strictEqual(migrate.length, 1);
        // A second legacy link, collected too, must survive when the first
        // one turns out to have changed: nothing is removed at all.
        const other = path.join(cliSkills, 'other');
        fs.symlinkSync(managed, other, 'dir');
        refuseLinkedDestination(path.join(other, 'SKILL.md'), home, { migrate, dryRun: true });
        assert.strictEqual(migrate.length, 2);
        // Swapped for a link the person made, between the scan and the removal.
        fs.unlinkSync(link);
        fs.symlinkSync(outside, link, 'dir');
        assert.throws(() => removeLegacyLinks(migrate, home), /changed during the install/);
        assert.ok(fs.lstatSync(link).isSymbolicLink() && fs.realpathSync.native(link) === fs.realpathSync.native(outside), 'the foreign link stays');
        assert.ok(fs.lstatSync(other).isSymbolicLink(), 'the other legacy link was not removed either');
      })) passed++; else failed++;

      if (test('nested legacy links are removed deepest first, whatever order the scan produced', () => {
        const home = path.join(dir, 'nested-home');
        const managed = path.join(home, 'skills', 'egc');
        fs.mkdirSync(path.join(managed, 'real'), { recursive: true });
        // Inside the managed copy, demo is itself a link to a sibling directory.
        fs.symlinkSync(path.join(managed, 'real'), path.join(managed, 'demo'), 'dir');
        const cli = path.join(home, 'antigravity-cli');
        fs.mkdirSync(cli, { recursive: true });
        // The skills directory is a link to the managed copy, so skills/demo is seen through it.
        fs.symlinkSync(managed, path.join(cli, 'skills'), 'dir');
        const migrate = [];
        refuseLinkedDestination(path.join(cli, 'skills', 'demo', 'SKILL.md'), home, { migrate, dryRun: true });
        assert.deepStrictEqual(migrate.map(entry => entry.linkPath), [path.join(cli, 'skills', 'demo'), path.join(cli, 'skills')]);
        // Shallowest first would remove skills and then fail on skills/demo.
        assert.doesNotThrow(() => removeLegacyLinks([...migrate].reverse(), home));
        assert.ok(!fs.existsSync(path.join(cli, 'skills')), 'the outer link is gone');
        assert.ok(!fs.existsSync(path.join(managed, 'demo')), 'the inner link is gone');
        assert.ok(fs.existsSync(path.join(managed, 'real')), 'what it pointed at stays');
      })) passed++; else failed++;

      if (test('the dry run walks the install-state path too, so a legacy link above it is listed', () => {
        const home = path.join(dir, 'state-home');
        const managed = path.join(home, 'skills', 'egc', 'egc');
        fs.mkdirSync(managed, { recursive: true });
        fs.symlinkSync(managed, path.join(home, 'egc'), 'dir');
        const plan = { targetRoot: home, installStatePath: path.join(home, 'egc', 'install-state.json'), operations: [] };
        assert.deepStrictEqual(checkedDestinations(plan), [plan.installStatePath]);
        assert.deepStrictEqual(findLegacyLinks(plan).map(entry => entry.linkPath), [path.join(home, 'egc')]);
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
