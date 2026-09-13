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
const { applyInstallPlan, checkedDestinations, collectShapeTransitions, findLegacyLinks, managedRootFor, refuseLinkedDestination, removeLegacyLinks, retirePlannedFiles, writeGuardianCliMarker, writeManagedText } = require('../../scripts/lib/install/apply');

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

      if (test('a destination under a declared second root is walked against that root: a linked ancestor there is refused before any write (#1412)', () => {
        const target = path.join(dir, 'two-roots-target');
        const second = path.join(dir, 'two-roots-config');
        fs.mkdirSync(path.join(target, 'skills'), { recursive: true });
        fs.mkdirSync(path.join(second, 'plugins'), { recursive: true });
        // The plugin directory under the second root replaced by a link elsewhere.
        fs.symlinkSync(outside, path.join(second, 'plugins', 'egc'), 'dir');
        const linked = path.join(second, 'plugins', 'egc', 'plugin.js');
        const plain = path.join(target, 'skills', 'SKILL.md');
        const plan = {
          targetRoot: target,
          managedRoots: [target, second],
          installStatePath: path.join(target, 'egc', 'install-state.json'),
          operations: [{ destinationPath: plain }, { destinationPath: linked }],
        };
        assert.strictEqual(managedRootFor(plan, linked), second, 'the plugin write belongs to the second root');
        assert.strictEqual(managedRootFor(plan, plain), target, 'the skill write belongs to the target root');
        assert.strictEqual(managedRootFor(plan, path.join(outside, 'x.md')), target, 'a path outside every root falls back to the target root');
        assert.throws(() => refuseLinkedDestination(linked, managedRootFor(plan, linked)), /symbolic link/, 'the walk against the second root finds the linked ancestor');
        assert.doesNotThrow(() => refuseLinkedDestination(linked, target), 'the same walk against the target root alone would have missed it');
        assert.throws(() => findLegacyLinks(plan, { strict: true }), /symbolic link/, 'the preflight refuses the plan before anything is written');
        assert.deepStrictEqual(findLegacyLinks(plan), [], 'and lists nothing to migrate: the legacy layout never lived under a second root');
        assert.ok(!fs.existsSync(path.join(outside, 'plugin.js')), 'nothing was written through the link');
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

    if (test('retirePlannedFiles removes only the files EGC wrote, inside the root, and drops the directories it empties (#1396)', () => {
      const root2 = path.join(dir, 'retire-root');
      const source = path.join(dir, 'retire-source');
      fs.mkdirSync(path.join(root2, 'tools'), { recursive: true });
      fs.mkdirSync(path.join(root2, 'plugins', 'lib'), { recursive: true });
      fs.mkdirSync(path.join(root2, 'dist'), { recursive: true });
      fs.mkdirSync(source, { recursive: true });
      // What EGC copied: the same bytes in the source and at the destination.
      for (const name of ['index.ts', 'helper.ts', 'package.json', 'edited.ts', 'orphan.ts']) fs.writeFileSync(path.join(source, name), `egc ${name}`);
      fs.writeFileSync(path.join(root2, 'tools', 'index.ts'), 'egc index.ts');
      fs.writeFileSync(path.join(root2, 'plugins', 'lib', 'helper.ts'), 'egc helper.ts');
      fs.writeFileSync(path.join(root2, 'package.json'), 'egc package.json');
      fs.writeFileSync(path.join(root2, 'plugins', 'real.js'), 'keep');
      // A file the person replaced since, and one whose source is gone.
      fs.writeFileSync(path.join(root2, 'tools', 'edited.ts'), 'mine now');
      fs.writeFileSync(path.join(root2, 'tools', 'orphan.ts'), 'egc orphan.ts');
      fs.writeFileSync(path.join(outside, 'theirs.json'), 'theirs');
      const entry = (rel, sourceName) => ({ destinationPath: path.join(root2, ...rel), sourcePath: sourceName ? path.join(source, sourceName) : undefined });
      const plan = {
        targetRoot: root2,
        retirements: [
          entry(['tools', 'index.ts'], 'index.ts'),
          entry(['plugins', 'lib', 'helper.ts'], 'helper.ts'),
          entry(['package.json'], 'package.json'),
          entry(['tools', 'edited.ts'], 'edited.ts'),
          entry(['tools', 'orphan.ts'], 'missing-source.ts'),
          entry(['dist'], 'index.ts'),
          entry(['missing.txt'], 'index.ts'),
          { destinationPath: path.join(outside, 'theirs.json'), sourcePath: path.join(source, 'index.ts') },
        ],
      };
      if (links) {
        fs.symlinkSync(path.join(outside, 'theirs.json'), path.join(root2, 'linked.json'));
        plan.retirements.push({ destinationPath: path.join(root2, 'linked.json'), sourcePath: path.join(source, 'index.ts') });
        // A regular file reached through a linked directory inside the root:
        // the unlink would land outside the root.
        fs.writeFileSync(path.join(outside, 'behind-link.ts'), 'egc index.ts');
        fs.symlinkSync(outside, path.join(root2, 'linked-dir'), 'dir');
        plan.retirements.push({ destinationPath: path.join(root2, 'linked-dir', 'behind-link.ts'), sourcePath: path.join(source, 'index.ts') });
      }
      const retired = retirePlannedFiles(plan);
      assert.deepStrictEqual(
        retired.map(item => item.destinationPath).sort(),
        [path.join(root2, 'package.json'), path.join(root2, 'plugins', 'lib', 'helper.ts'), path.join(root2, 'tools', 'index.ts')].sort()
      );
      assert.ok(fs.existsSync(path.join(root2, 'tools', 'edited.ts')), 'a file the person replaced stays');
      assert.ok(fs.existsSync(path.join(root2, 'tools', 'orphan.ts')), 'a file whose source is gone stays');
      assert.ok(fs.existsSync(path.join(root2, 'tools')), 'so the tools directory stays too');
      assert.ok(!fs.existsSync(path.join(root2, 'plugins', 'lib')), 'the emptied lib directory is gone');
      assert.ok(fs.existsSync(path.join(root2, 'plugins', 'real.js')), 'a file that stays keeps its directory');
      assert.ok(fs.existsSync(path.join(root2, 'dist')), 'a directory at a recorded path is not removed');
      assert.strictEqual(fs.readFileSync(path.join(outside, 'theirs.json'), 'utf8'), 'theirs', 'a path outside the root is never touched');
      if (links) {
        assert.ok(fs.lstatSync(path.join(root2, 'linked.json')).isSymbolicLink(), 'a link at a recorded path is left alone');
        assert.ok(fs.existsSync(path.join(outside, 'behind-link.ts')), 'a file behind a linked directory is left alone');
      }
      assert.ok(fs.existsSync(root2), 'the root itself stays');
    })) passed++; else failed++;

    if (test('retirePlannedFiles honors a second managed root the plan declares, and still refuses anything outside every root (#1412)', () => {
      const root4 = path.join(dir, 'retire-two-roots');
      const second = path.join(dir, 'retire-two-roots-config');
      const source4 = path.join(dir, 'retire-two-roots-source');
      fs.mkdirSync(path.join(root4, 'skills'), { recursive: true });
      fs.mkdirSync(path.join(second, 'plugins', 'egc'), { recursive: true });
      fs.mkdirSync(source4, { recursive: true });
      fs.writeFileSync(path.join(source4, 'plugin.js'), 'egc plugin.js');
      fs.writeFileSync(path.join(source4, 'SKILL.md'), 'egc SKILL.md');
      fs.writeFileSync(path.join(root4, 'skills', 'SKILL.md'), 'egc SKILL.md');
      fs.writeFileSync(path.join(second, 'plugins', 'egc', 'plugin.js'), 'egc plugin.js');
      fs.writeFileSync(path.join(second, 'plugins', 'keep.js'), 'keep');
      fs.writeFileSync(path.join(outside, 'elsewhere.js'), 'egc plugin.js');
      const plan = {
        targetRoot: root4,
        managedRoots: [root4, second],
        retirements: [
          { destinationPath: path.join(root4, 'skills', 'SKILL.md'), sourcePath: path.join(source4, 'SKILL.md') },
          { destinationPath: path.join(second, 'plugins', 'egc', 'plugin.js'), sourcePath: path.join(source4, 'plugin.js') },
          { destinationPath: path.join(outside, 'elsewhere.js'), sourcePath: path.join(source4, 'plugin.js') },
        ],
      };
      const retired = retirePlannedFiles(plan);
      assert.deepStrictEqual(
        retired.map(item => item.destinationPath).sort(),
        [path.join(root4, 'skills', 'SKILL.md'), path.join(second, 'plugins', 'egc', 'plugin.js')].sort(),
        'files under either declared root go; the one outside every root does not'
      );
      assert.ok(!fs.existsSync(path.join(second, 'plugins', 'egc')), 'the emptied directory under the second root is gone');
      assert.ok(fs.existsSync(path.join(second, 'plugins', 'keep.js')), 'a file that stays keeps its directory under the second root');
      assert.ok(fs.existsSync(second), 'the second root itself stays');
      assert.ok(fs.existsSync(path.join(outside, 'elsewhere.js')), 'a path outside every root is never touched');
      assert.ok(retired.every(item => !('root' in item)), 'the reported entries carry no bookkeeping field');
    })) passed++; else failed++;

    if (test('retirePlannedFiles retires a file whose recorded source is gone only when its bytes match a file the plan copies today (#1412)', () => {
      const root5 = path.join(dir, 'retire-renamed');
      const source5 = path.join(dir, 'retire-renamed-source');
      fs.mkdirSync(path.join(root5, 'commands'), { recursive: true });
      fs.mkdirSync(source5, { recursive: true });
      // The package renamed old.md to new.md: the old source is gone, the new
      // one carries the same bytes and is what the plan copies today.
      fs.writeFileSync(path.join(source5, 'new.md'), 'egc command');
      fs.writeFileSync(path.join(root5, 'commands', 'old.md'), 'egc command');
      // A dropped file whose bytes match nothing the plan writes, and one the
      // person edited after the rename: both stay.
      fs.writeFileSync(path.join(root5, 'commands', 'dropped.md'), 'egc dropped');
      fs.writeFileSync(path.join(root5, 'commands', 'edited.md'), 'mine now');
      const plan = {
        targetRoot: root5,
        operations: [
          { kind: 'copy-file', sourcePath: path.join(source5, 'new.md'), destinationPath: path.join(root5, 'commands', 'new.md') },
          { kind: 'merge-json', sourcePath: path.join(source5, 'missing.json'), destinationPath: path.join(root5, 'x.json') },
        ],
        retirements: [
          { destinationPath: path.join(root5, 'commands', 'old.md'), sourcePath: path.join(source5, 'old.md') },
          { destinationPath: path.join(root5, 'commands', 'dropped.md'), sourcePath: path.join(source5, 'dropped.md') },
          { destinationPath: path.join(root5, 'commands', 'edited.md'), sourcePath: path.join(source5, 'edited.md') },
        ],
      };
      const retired = retirePlannedFiles(plan);
      assert.deepStrictEqual(retired.map(item => item.destinationPath), [path.join(root5, 'commands', 'old.md')], 'only the renamed file goes');
      assert.ok(fs.existsSync(path.join(root5, 'commands', 'dropped.md')), 'a dropped file matching nothing the plan writes stays');
      assert.ok(fs.existsSync(path.join(root5, 'commands', 'edited.md')), 'a file the person edited stays');
      assert.deepStrictEqual(retirePlannedFiles({ targetRoot: root5, retirements: plan.retirements.slice(1) }), [], 'without plan operations nothing vouches for a missing source');
    })) passed++; else failed++;

    if (test('retirePlannedFiles stops climbing when a parent cannot be read after the removal', () => {
      const root3 = path.join(dir, 'retire-sealed');
      const sealed = path.join(root3, 'sealed');
      const source3 = path.join(dir, 'retire-sealed-source');
      fs.mkdirSync(sealed, { recursive: true });
      fs.mkdirSync(source3, { recursive: true });
      fs.writeFileSync(path.join(sealed, 'gone.ts'), 'x');
      fs.writeFileSync(path.join(source3, 'gone.ts'), 'x');
      const plan = { targetRoot: root3, retirements: [{ destinationPath: path.join(sealed, 'gone.ts'), sourcePath: path.join(source3, 'gone.ts') }] };
      // Write-only parent: the unlink still works, the readdir afterwards
      // does not. Whether the mode really seals the directory is checked,
      // not assumed: root, and any uid with CAP_DAC_OVERRIDE, reads it anyway.
      fs.chmodSync(sealed, 0o300);
      let unreadable = false;
      try {
        fs.readdirSync(sealed);
      } catch {
        unreadable = true;
      }
      if (!unreadable) {
        fs.chmodSync(sealed, 0o700);
        console.log('  - skipped: this process can read a mode 0300 directory');
        return;
      }
      try {
        const retired = retirePlannedFiles(plan);
        assert.strictEqual(retired.length, 1, 'the file itself is retired');
      } finally {
        if (fs.existsSync(sealed)) fs.chmodSync(sealed, 0o700);
      }
      assert.ok(fs.existsSync(sealed), 'a parent that could not be read is left where it is');
    })) passed++; else failed++;

    if (test('a destination file whose source became a directory is retired and replaced by the directory (file-to-dir)', () => {
      const base = path.join(dir, 'shape-f2d-ok');
      const sourceDir = path.join(base, 'source');
      const root = path.join(base, 'root');
      const statePath = path.join(base, 'egc', 'install-state.json');
      const adapter = { id: 'custom', target: 'custom', kind: 'home' };
      fs.mkdirSync(path.join(sourceDir, 'rules', 'foo.md'), { recursive: true });
      fs.writeFileSync(path.join(sourceDir, 'rules', 'foo.md', 'index.md'), 'foo child');
      fs.mkdirSync(path.join(root, 'rules'), { recursive: true });
      // A previous install wrote rules/foo.md as a FILE whose bytes happen to
      // match the child the now-directory source carries today.
      fs.writeFileSync(path.join(root, 'rules', 'foo.md'), 'foo child');
      const copyOp = (sourcePath, sourceRelativePath, destinationPath) => ({
        kind: 'copy-file',
        moduleId: 'egc-universal',
        sourcePath,
        sourceRelativePath,
        destinationPath,
        strategy: 'preserve-relative-path',
        ownership: 'managed',
        scaffoldOnly: false,
      });
      const buildState = operations => createInstallState({
        adapter,
        targetRoot: root,
        installStatePath: statePath,
        request: { profile: null },
        resolution: {},
        source: { repoVersion: 'test', repoCommit: 'test', manifestVersion: 1 },
        operations,
      });
      writeInstallState(statePath, buildState([copyOp(
        path.join(sourceDir, 'rules', 'foo.md'),
        'rules/foo.md',
        path.join(root, 'rules', 'foo.md')
      )]));
      const operations = [copyOp(
        path.join(sourceDir, 'rules', 'foo.md', 'index.md'),
        'rules/foo.md/index.md',
        path.join(root, 'rules', 'foo.md', 'index.md')
      )];
      const plan = {
        adapter,
        targetRoot: root,
        managedRoots: [root],
        installStatePath: statePath,
        retirements: [],
        operations,
        statePreview: buildState(operations),
      };
      const result = applyInstallPlan(plan, { homeDir: base });
      assert.ok(fs.statSync(path.join(root, 'rules', 'foo.md')).isDirectory(), 'the old file becomes the directory');
      assert.strictEqual(fs.readFileSync(path.join(root, 'rules', 'foo.md', 'index.md'), 'utf8'), 'foo child', 'the child lands inside');
      assert.deepStrictEqual(result.shapeTransitions, [
        { type: 'file-to-dir', destinationPath: path.join(root, 'rules', 'foo.md'), sourceRelativePath: 'rules/foo.md' },
      ], 'the apply reports the transition');
    })) passed++; else failed++;

    if (test('a file in the way of a directory that is no longer a byte-identical EGC copy refuses the file-to-dir transition', () => {
      const base = path.join(dir, 'shape-f2d-edit');
      const sourceDir = path.join(base, 'source');
      const root = path.join(base, 'root');
      const statePath = path.join(base, 'egc', 'install-state.json');
      const adapter = { id: 'custom', target: 'custom', kind: 'home' };
      fs.mkdirSync(path.join(sourceDir, 'rules', 'foo.md'), { recursive: true });
      fs.writeFileSync(path.join(sourceDir, 'rules', 'foo.md', 'index.md'), 'foo child');
      fs.mkdirSync(path.join(root, 'rules'), { recursive: true });
      fs.writeFileSync(path.join(root, 'rules', 'foo.md'), 'user edited this, not EGC');
      const copyOp = (sourcePath, sourceRelativePath, destinationPath) => ({
        kind: 'copy-file',
        moduleId: 'egc-universal',
        sourcePath,
        sourceRelativePath,
        destinationPath,
        strategy: 'preserve-relative-path',
        ownership: 'managed',
        scaffoldOnly: false,
      });
      const buildState = operations => createInstallState({
        adapter,
        targetRoot: root,
        installStatePath: statePath,
        request: { profile: null },
        resolution: {},
        source: { repoVersion: 'test', repoCommit: 'test', manifestVersion: 1 },
        operations,
      });
      writeInstallState(statePath, buildState([copyOp(
        path.join(sourceDir, 'rules', 'foo.md'),
        'rules/foo.md',
        path.join(root, 'rules', 'foo.md')
      )]));
      const plan = {
        adapter,
        targetRoot: root,
        managedRoots: [root],
        installStatePath: statePath,
        retirements: [],
        operations: [copyOp(
          path.join(sourceDir, 'rules', 'foo.md', 'index.md'),
          'rules/foo.md/index.md',
          path.join(root, 'rules', 'foo.md', 'index.md')
        )],
        statePreview: buildState([]),
      };
      assert.throws(() => applyInstallPlan(plan, { homeDir: base }), /Shape transition refused/, 'nothing is written when the file would have to go');
      assert.strictEqual(fs.readFileSync(path.join(root, 'rules', 'foo.md'), 'utf8'), 'user edited this, not EGC', 'the file the person changed stays');
      assert.ok(!fs.existsSync(path.join(root, 'rules', 'foo.md', 'index.md')), 'nothing is written under it');
    })) passed++; else failed++;

    if (test('a destination directory whose source became a file is emptied and replaced by the file (dir-to-file)', () => {
      const base = path.join(dir, 'shape-d2f-ok');
      const sourceDir = path.join(base, 'source');
      const root = path.join(base, 'root');
      const statePath = path.join(base, 'egc', 'install-state.json');
      const adapter = { id: 'custom', target: 'custom', kind: 'home' };
      // The package flattened widget/use.md and widget/notes.md and turned
      // widget into a plain file: the old bytes survive at new destinations.
      fs.mkdirSync(sourceDir, { recursive: true });
      ['widget', 'widget-old-use.md', 'widget-old-notes.md'].forEach(name =>
        fs.writeFileSync(path.join(sourceDir, name), name === 'widget' ? 'new widget' : `${name} bytes`)
      );
      fs.mkdirSync(path.join(root, 'widget'), { recursive: true });
      fs.writeFileSync(path.join(root, 'widget', 'use.md'), 'widget-old-use.md bytes');
      fs.writeFileSync(path.join(root, 'widget', 'notes.md'), 'widget-old-notes.md bytes');
      const copyOp = (sourcePath, sourceRelativePath, destinationPath) => ({
        kind: 'copy-file',
        moduleId: 'egc-universal',
        sourcePath,
        sourceRelativePath,
        destinationPath,
        strategy: 'preserve-relative-path',
        ownership: 'managed',
        scaffoldOnly: false,
      });
      const buildState = operations => createInstallState({
        adapter,
        targetRoot: root,
        installStatePath: statePath,
        request: { profile: null },
        resolution: {},
        source: { repoVersion: 'test', repoCommit: 'test', manifestVersion: 1 },
        operations,
      });
      writeInstallState(statePath, buildState([
        copyOp(path.join(sourceDir, 'widget', 'use.md'), 'widget/use.md', path.join(root, 'widget', 'use.md')),
        copyOp(path.join(sourceDir, 'widget', 'notes.md'), 'widget/notes.md', path.join(root, 'widget', 'notes.md')),
      ]));
      const operations = [
        copyOp(path.join(sourceDir, 'widget'), 'widget', path.join(root, 'widget')),
        copyOp(path.join(sourceDir, 'widget-old-use.md'), 'widget-old-use.md', path.join(root, 'widget-old-use.md')),
        copyOp(path.join(sourceDir, 'widget-old-notes.md'), 'widget-old-notes.md', path.join(root, 'widget-old-notes.md')),
      ];
      const plan = {
        adapter,
        targetRoot: root,
        managedRoots: [root],
        installStatePath: statePath,
        retirements: [],
        operations,
        statePreview: buildState(operations),
      };
      const result = applyInstallPlan(plan, { homeDir: base });
      assert.ok(fs.statSync(path.join(root, 'widget')).isFile(), 'the directory becomes the file');
      assert.strictEqual(fs.readFileSync(path.join(root, 'widget'), 'utf8'), 'new widget', 'the file content is EGC\'s');
      assert.ok(!fs.existsSync(path.join(root, 'widget', 'use.md')), 'the moved-away child is gone');
      const transitions = result.shapeTransitions;
      assert.strictEqual(transitions.length, 1, 'one transition reported');
      assert.deepStrictEqual(transitions[0], {
        type: 'dir-to-file',
        destinationPath: path.join(root, 'widget'),
        children: [path.join(root, 'widget', 'use.md'), path.join(root, 'widget', 'notes.md')].sort((a, b) => a.localeCompare(b)),
        directories: [path.join(root, 'widget')],
      }, 'the apply reports the transition in a deterministic order');
    })) passed++; else failed++;

    if (test('a directory in the way of a file whose child is no longer a byte-identical EGC copy refuses the dir-to-file transition', () => {
      const base = path.join(dir, 'shape-d2f-edit');
      const sourceDir = path.join(base, 'source');
      const root = path.join(base, 'root');
      const statePath = path.join(base, 'egc', 'install-state.json');
      const adapter = { id: 'custom', target: 'custom', kind: 'home' };
      fs.mkdirSync(sourceDir, { recursive: true });
      ['widget', 'widget-old-use.md', 'widget-old-notes.md'].forEach(name =>
        fs.writeFileSync(path.join(sourceDir, name), name === 'widget' ? 'new widget' : `${name} bytes`)
      );
      fs.mkdirSync(path.join(root, 'widget'), { recursive: true });
      fs.writeFileSync(path.join(root, 'widget', 'use.md'), 'the person changed this child');
      fs.writeFileSync(path.join(root, 'widget', 'notes.md'), 'widget-old-notes.md bytes');
      const copyOp = (sourcePath, sourceRelativePath, destinationPath) => ({
        kind: 'copy-file',
        moduleId: 'egc-universal',
        sourcePath,
        sourceRelativePath,
        destinationPath,
        strategy: 'preserve-relative-path',
        ownership: 'managed',
        scaffoldOnly: false,
      });
      const buildState = operations => createInstallState({
        adapter,
        targetRoot: root,
        installStatePath: statePath,
        request: { profile: null },
        resolution: {},
        source: { repoVersion: 'test', repoCommit: 'test', manifestVersion: 1 },
        operations,
      });
      writeInstallState(statePath, buildState([
        copyOp(path.join(sourceDir, 'widget', 'use.md'), 'widget/use.md', path.join(root, 'widget', 'use.md')),
        copyOp(path.join(sourceDir, 'widget', 'notes.md'), 'widget/notes.md', path.join(root, 'widget', 'notes.md')),
      ]));
      // notes.md is planned again (flattened to widget-old-notes.md), so its
      // bytes reconcile; only the edited use.md can possibly refuse the whole
      // transition.
      const operations = [
        copyOp(path.join(sourceDir, 'widget'), 'widget', path.join(root, 'widget')),
        copyOp(path.join(sourceDir, 'widget-old-notes.md'), 'widget-old-notes.md', path.join(root, 'widget-old-notes.md')),
      ];
      const plan = {
        adapter,
        targetRoot: root,
        managedRoots: [root],
        installStatePath: statePath,
        retirements: [],
        operations,
        statePreview: buildState(operations),
      };
      assert.throws(() => applyInstallPlan(plan, { homeDir: base }), /Shape transition refused/, 'the whole directory refuses before anything goes');
      assert.ok(fs.statSync(path.join(root, 'widget')).isDirectory(), 'the directory stays intact');
      assert.strictEqual(fs.readFileSync(path.join(root, 'widget', 'use.md'), 'utf8'), 'the person changed this child', 'the changed child stays');
      assert.strictEqual(fs.readFileSync(path.join(root, 'widget', 'notes.md'), 'utf8'), 'widget-old-notes.md bytes', 'and so does the rest of it');
      assert.ok(!fs.existsSync(path.join(root, 'widget-old-notes.md')), 'even the reconcilable child is not written: the refusal precedes every operation');
      assert.ok(!fs.existsSync(path.join(root, 'widget-old-use.md')), 'nothing is written');
    })) passed++; else failed++;

    if (test('collectShapeTransitions is read-only: it lists the resolvable transitions and every refusal without touching the disk (the dry run)', () => {
      const base = path.join(dir, 'shape-dryrun');
      const sourceDir = path.join(base, 'source');
      const root = path.join(base, 'root');
      const statePath = path.join(base, 'egc', 'install-state.json');
      const adapter = { id: 'custom', target: 'custom', kind: 'home' };
      fs.mkdirSync(path.join(sourceDir, 'rules', 'foo.md'), { recursive: true });
      fs.writeFileSync(path.join(sourceDir, 'rules', 'foo.md', 'index.md'), 'foo child');
      ['widget', 'widget-old-use.md', 'widget-old-notes.md'].forEach(name =>
        fs.writeFileSync(path.join(sourceDir, name), name === 'widget' ? 'new widget' : `${name} bytes`)
      );
      fs.mkdirSync(path.join(root, 'rules'), { recursive: true });
      fs.writeFileSync(path.join(root, 'rules', 'foo.md'), 'hand-made, unrecorded, foreign');
      fs.mkdirSync(path.join(root, 'widget'), { recursive: true });
      fs.writeFileSync(path.join(root, 'widget', 'use.md'), 'widget-old-use.md bytes');
      fs.writeFileSync(path.join(root, 'widget', 'notes.md'), 'widget-old-notes.md bytes');
      const copyOp = (sourcePath, sourceRelativePath, destinationPath) => ({
        kind: 'copy-file',
        moduleId: 'egc-universal',
        sourcePath,
        sourceRelativePath,
        destinationPath,
        strategy: 'preserve-relative-path',
        ownership: 'managed',
        scaffoldOnly: false,
      });
      const buildState = operations => createInstallState({
        adapter,
        targetRoot: root,
        installStatePath: statePath,
        request: { profile: null },
        resolution: {},
        source: { repoVersion: 'test', repoCommit: 'test', manifestVersion: 1 },
        operations,
      });
      // The widget children are recorded; the rules/foo.md file is not: it
      // was never ours, so the listing refuses it instead of promising to
      // retire a foreign file.
      writeInstallState(statePath, buildState([
        copyOp(path.join(sourceDir, 'widget', 'use.md'), 'widget/use.md', path.join(root, 'widget', 'use.md')),
        copyOp(path.join(sourceDir, 'widget', 'notes.md'), 'widget/notes.md', path.join(root, 'widget', 'notes.md')),
      ]));
      const operations = [
        copyOp(path.join(sourceDir, 'rules', 'foo.md', 'index.md'), 'rules/foo.md/index.md', path.join(root, 'rules', 'foo.md', 'index.md')),
        copyOp(path.join(sourceDir, 'widget'), 'widget', path.join(root, 'widget')),
        copyOp(path.join(sourceDir, 'widget-old-use.md'), 'widget-old-use.md', path.join(root, 'widget-old-use.md')),
        copyOp(path.join(sourceDir, 'widget-old-notes.md'), 'widget-old-notes.md', path.join(root, 'widget-old-notes.md')),
      ];
      const plan = {
        adapter,
        targetRoot: root,
        managedRoots: [root],
        installStatePath: statePath,
        retirements: [],
        operations,
        statePreview: buildState(operations),
      };
      const { transitions, refusals } = collectShapeTransitions(plan);
      assert.strictEqual(transitions.length, 1, 'the resolvable dir-to-file transition is listed');
      assert.strictEqual(transitions[0].type, 'dir-to-file');
      assert.strictEqual(refusals.length, 1, 'the unrecorded file-to-dir is refused, not listed');
      assert.strictEqual(refusals[0].destinationPath, path.join(root, 'rules', 'foo.md'));
      assert.ok(fs.statSync(path.join(root, 'widget')).isDirectory(), 'nothing was removed by the listing');
      assert.ok(fs.existsSync(path.join(root, 'widget', 'use.md')), 'the children are all still there');
      assert.ok(fs.existsSync(path.join(root, 'widget', 'notes.md')), 'all of them');
      assert.strictEqual(fs.readFileSync(path.join(root, 'rules', 'foo.md'), 'utf8'), 'hand-made, unrecorded, foreign', 'and the refused file still holds its content');
    })) passed++; else failed++;

    if (links) {
      if (test('a non-legacy link in the way of a planned directory is refused by the scan and by the apply', () => {
        const base = path.join(dir, 'shape-link');
      const sourceDir = path.join(base, 'source');
      const root = path.join(base, 'root');
      const statePath = path.join(base, 'egc', 'install-state.json');
      const adapter = { id: 'custom', target: 'custom', kind: 'home' };
      fs.mkdirSync(path.join(sourceDir, 'rules', 'foo.md'), { recursive: true });
      fs.writeFileSync(path.join(sourceDir, 'rules', 'foo.md', 'index.md'), 'foo child');
      fs.mkdirSync(path.join(root, 'rules'), { recursive: true });
      fs.mkdirSync(path.join(base, 'elsewhere'), { recursive: true });
      fs.writeFileSync(path.join(base, 'elsewhere', 'ghost.md'), 'not EGC');
      fs.symlinkSync(path.join(base, 'elsewhere', 'ghost.md'), path.join(root, 'rules', 'foo.md'));
      const copyOp = (sourcePath, sourceRelativePath, destinationPath) => ({
        kind: 'copy-file',
        moduleId: 'egc-universal',
        sourcePath,
        sourceRelativePath,
        destinationPath,
        strategy: 'preserve-relative-path',
        ownership: 'managed',
        scaffoldOnly: false,
      });
      const buildState = operations => createInstallState({
        adapter,
        targetRoot: root,
        installStatePath: statePath,
        request: { profile: null },
        resolution: {},
        source: { repoVersion: 'test', repoCommit: 'test', manifestVersion: 1 },
        operations,
      });
      writeInstallState(statePath, buildState([]));
      const operations = [copyOp(
        path.join(sourceDir, 'rules', 'foo.md', 'index.md'),
        'rules/foo.md/index.md',
        path.join(root, 'rules', 'foo.md', 'index.md')
      )];
      const plan = {
        adapter,
        targetRoot: root,
        managedRoots: [root],
        installStatePath: statePath,
        retirements: [],
        operations,
        statePreview: buildState(operations),
      };
      const { transitions, refusals } = collectShapeTransitions(plan);
      assert.strictEqual(transitions.length, 0, 'a link is never a transition candidate');
      assert.strictEqual(refusals.length, 1, 'the scan refuses the link, like the apply would');
      assert.strictEqual(refusals[0].destinationPath, path.join(root, 'rules', 'foo.md'));
      assert.ok(refusals[0].reason.includes('symbolic link'), refusals[0].reason);
      assert.throws(() => applyInstallPlan(plan, { homeDir: base }), /Shape transition refused/, 'the apply refuses before writing behind the link');
      assert.ok(fs.lstatSync(path.join(root, 'rules', 'foo.md')).isSymbolicLink(), 'the link is untouched');
      assert.ok(!fs.existsSync(path.join(root, 'rules', 'foo.md', 'index.md')), 'nothing is written behind it');
      })) passed++; else failed++;

      if (test('a symbolic link inside the directory a dir-to-file wants refuses the transition', () => {
        const base = path.join(dir, 'shape-d2f-linkchild');
        const sourceDir = path.join(base, 'source');
        const root = path.join(base, 'root');
        const statePath = path.join(base, 'egc', 'install-state.json');
        const adapter = { id: 'custom', target: 'custom', kind: 'home' };
        fs.mkdirSync(sourceDir, { recursive: true });
        ['widget', 'widget-old-use.md'].forEach(name =>
          fs.writeFileSync(path.join(sourceDir, name), name === 'widget' ? 'new widget' : `${name} bytes`)
        );
        fs.mkdirSync(path.join(root, 'widget'), { recursive: true });
        fs.writeFileSync(path.join(root, 'widget', 'use.md'), 'widget-old-use.md bytes');
        const ghostDir = path.join(base, 'foreign');
        fs.mkdirSync(ghostDir, { recursive: true });
        fs.writeFileSync(path.join(ghostDir, 'ghost.md'), 'not EGC');
        fs.symlinkSync(path.join(ghostDir, 'ghost.md'), path.join(root, 'widget', 'link.md'));
        const copyOp = (sourcePath, sourceRelativePath, destinationPath) => ({
          kind: 'copy-file',
          moduleId: 'egc-universal',
          sourcePath,
          sourceRelativePath,
          destinationPath,
          strategy: 'preserve-relative-path',
          ownership: 'managed',
          scaffoldOnly: false,
        });
        const buildState = operations => createInstallState({
          adapter,
          targetRoot: root,
          installStatePath: statePath,
          request: { profile: null },
          resolution: {},
          source: { repoVersion: 'test', repoCommit: 'test', manifestVersion: 1 },
          operations,
        });
        writeInstallState(statePath, buildState([
          copyOp(path.join(sourceDir, 'widget', 'use.md'), 'widget/use.md', path.join(root, 'widget', 'use.md')),
        ]));
        const operations = [
          copyOp(path.join(sourceDir, 'widget'), 'widget', path.join(root, 'widget')),
          copyOp(path.join(sourceDir, 'widget-old-use.md'), 'widget-old-use.md', path.join(root, 'widget-old-use.md')),
        ];
        const plan = {
          adapter,
          targetRoot: root,
          managedRoots: [root],
          installStatePath: statePath,
          retirements: [],
          operations,
          statePreview: buildState(operations),
        };
        const { transitions, refusals } = collectShapeTransitions(plan);
        assert.strictEqual(transitions.length, 0, 'nothing is promised while a link sits inside the directory');
        assert.strictEqual(refusals.length, 1, 'the link refuses the dir-to-file transition');
        assert.strictEqual(refusals[0].destinationPath, path.join(root, 'widget'));
        assert.ok(refusals[0].reason.includes('symbolic link or special file'), refusals[0].reason);
        assert.ok(refusals[0].reason.includes('link.md'), 'the refusal names the blocking entry');
        assert.throws(() => applyInstallPlan(plan, { homeDir: base }), /Shape transition refused/, 'the apply refuses before anything changes');
        assert.ok(fs.statSync(path.join(root, 'widget')).isDirectory(), 'the directory stays');
        assert.strictEqual(fs.readFileSync(path.join(root, 'widget', 'use.md'), 'utf8'), 'widget-old-use.md bytes', 'the reconcilable child stays');
        assert.ok(fs.lstatSync(path.join(root, 'widget', 'link.md')).isSymbolicLink(), 'the link stays');
        assert.ok(!fs.existsSync(path.join(root, 'widget-old-use.md')), 'nothing is written');
      })) passed++; else failed++;
    }

    if (test('an empty subdirectory the person made inside a dir-to-file directory is dropped with the transition (settled in review)', () => {
      const base = path.join(dir, 'shape-d2f-emptydir');
      const sourceDir = path.join(base, 'source');
      const root = path.join(base, 'root');
      const statePath = path.join(base, 'egc', 'install-state.json');
      const adapter = { id: 'custom', target: 'custom', kind: 'home' };
      fs.mkdirSync(sourceDir, { recursive: true });
      ['widget', 'widget-old-use.md', 'widget-old-notes.md'].forEach(name =>
        fs.writeFileSync(path.join(sourceDir, name), name === 'widget' ? 'new widget' : `${name} bytes`)
      );
      fs.mkdirSync(path.join(root, 'widget', 'unused'), { recursive: true });
      fs.writeFileSync(path.join(root, 'widget', 'use.md'), 'widget-old-use.md bytes');
      fs.writeFileSync(path.join(root, 'widget', 'notes.md'), 'widget-old-notes.md bytes');
      const copyOp = (sourcePath, sourceRelativePath, destinationPath) => ({
        kind: 'copy-file',
        moduleId: 'egc-universal',
        sourcePath,
        sourceRelativePath,
        destinationPath,
        strategy: 'preserve-relative-path',
        ownership: 'managed',
        scaffoldOnly: false,
      });
      const buildState = operations => createInstallState({
        adapter,
        targetRoot: root,
        installStatePath: statePath,
        request: { profile: null },
        resolution: {},
        source: { repoVersion: 'test', repoCommit: 'test', manifestVersion: 1 },
        operations,
      });
      writeInstallState(statePath, buildState([
        copyOp(path.join(sourceDir, 'widget', 'use.md'), 'widget/use.md', path.join(root, 'widget', 'use.md')),
        copyOp(path.join(sourceDir, 'widget', 'notes.md'), 'widget/notes.md', path.join(root, 'widget', 'notes.md')),
      ]));
      // The widget children reconcile against the flattened old files the
      // plan still copies. The empty unused/ subdirectory the person made has
      // no recorded file beneath it; the review settled that it is
      // indistinguishable from a directory EGC itself made, so it goes with
      // the transition -- a file inside it would refuse it instead.
      const operations = [
        copyOp(path.join(sourceDir, 'widget'), 'widget', path.join(root, 'widget')),
        copyOp(path.join(sourceDir, 'widget-old-use.md'), 'widget-old-use.md', path.join(root, 'widget-old-use.md')),
        copyOp(path.join(sourceDir, 'widget-old-notes.md'), 'widget-old-notes.md', path.join(root, 'widget-old-notes.md')),
      ];
      const plan = {
        adapter,
        targetRoot: root,
        managedRoots: [root],
        installStatePath: statePath,
        retirements: [],
        operations,
        statePreview: buildState(operations),
      };
      const { transitions, refusals } = collectShapeTransitions(plan);
      assert.strictEqual(transitions.length, 1, 'the resolvable dir-to-file transition is listed');
      assert.strictEqual(refusals.length, 0, 'an empty unrecorded subdirectory does not refuse');
      assert.ok(transitions[0].directories.includes(path.join(root, 'widget', 'unused')), 'the dropped subdirectory is part of the transition');
      const result = applyInstallPlan(plan, { homeDir: base });
      assert.ok(fs.statSync(path.join(root, 'widget')).isFile(), 'the directory becomes the file');
      assert.strictEqual(fs.readFileSync(path.join(root, 'widget'), 'utf8'), 'new widget', 'the file content is EGC\'s');
      assert.ok(!fs.existsSync(path.join(root, 'widget', 'unused')), 'the empty subdirectory the person made is dropped with the transition');
      assert.strictEqual(result.shapeTransitions.length, 1, 'the apply reports the transition');
    })) passed++; else failed++;

    if (test('a destination the plan writes both as a file and a directory refuses on a fresh install, exactly once', () => {
      const base = path.join(dir, 'shape-both-shapes');
      const sourceDir = path.join(base, 'source');
      const root = path.join(base, 'root');
      const statePath = path.join(base, 'egc', 'install-state.json');
      const adapter = { id: 'custom', target: 'custom', kind: 'home' };
      fs.mkdirSync(path.join(sourceDir, 'rules', 'foo.md'), { recursive: true });
      fs.writeFileSync(path.join(sourceDir, 'rules', 'foo.md', 'index.md'), 'foo child');
      fs.writeFileSync(path.join(sourceDir, 'rules-file.md'), 'rules as a file');
      fs.mkdirSync(root, { recursive: true });
      const copyOp = (sourcePath, sourceRelativePath, destinationPath) => ({
        kind: 'copy-file',
        moduleId: 'egc-universal',
        sourcePath,
        sourceRelativePath,
        destinationPath,
        strategy: 'preserve-relative-path',
        ownership: 'managed',
        scaffoldOnly: false,
      });
      const buildState = operations => createInstallState({
        adapter,
        targetRoot: root,
        installStatePath: statePath,
        request: { profile: null },
        resolution: {},
        source: { repoVersion: 'test', repoCommit: 'test', manifestVersion: 1 },
        operations,
      });
      writeInstallState(statePath, buildState([]));
      // The same path is a planned file (root/rules) and a planned parent
      // (root/rules/foo.md/index.md writes into it): structurally impossible.
      const operations = [
        copyOp(path.join(sourceDir, 'rules-file.md'), 'rules-file.md', path.join(root, 'rules')),
        copyOp(path.join(sourceDir, 'rules', 'foo.md', 'index.md'), 'rules/foo.md/index.md', path.join(root, 'rules', 'foo.md', 'index.md')),
      ];
      const plan = {
        adapter,
        targetRoot: root,
        managedRoots: [root],
        installStatePath: statePath,
        retirements: [],
        operations,
        statePreview: buildState(operations),
      };
      // Fresh install: root/rules does not exist, and the refusal still fires,
      // because the plan is structurally broken no matter what is on disk.
      const fresh = collectShapeTransitions(plan);
      assert.strictEqual(fresh.transitions.length, 0, 'nothing is promised');
      assert.strictEqual(fresh.refusals.length, 1, 'the both-shapes path refuses once, not twice');
      assert.strictEqual(fresh.refusals[0].destinationPath, path.join(root, 'rules'));
      assert.ok(fresh.refusals[0].reason.includes('both a file and a directory'), fresh.refusals[0].reason);
      assert.throws(() => applyInstallPlan(plan, { homeDir: base }), /Shape transition refused/, 'the apply refuses on a fresh install too');
      assert.ok(!fs.existsSync(path.join(root, 'rules')), 'nothing was written before the refusal');
      // With the path present as a directory, the same single refusal holds:
      // the path is visited once across both planned sets.
      fs.mkdirSync(path.join(root, 'rules'), { recursive: true });
      fs.writeFileSync(path.join(root, 'rules', 'person.md'), 'mine');
      const existing = collectShapeTransitions(plan);
      assert.strictEqual(existing.transitions.length, 0, 'still nothing promised');
      assert.strictEqual(existing.refusals.length, 1, 'still exactly one refusal');
      assert.ok(existing.refusals[0].reason.includes('both a file and a directory'), existing.refusals[0].reason);
      assert.strictEqual(fs.readFileSync(path.join(root, 'rules', 'person.md'), 'utf8'), 'mine', 'the existing path was touched by nothing');
      assert.ok(fs.statSync(path.join(root, 'rules')).isDirectory(), 'the directory the person made stays');
    })) passed++; else failed++;

    if (test('a directory in the way of a file that cannot be listed refuses the dir-to-file transition', () => {
      const base = path.join(dir, 'shape-d2f-unlistable');
      const sourceDir = path.join(base, 'source');
      const root = path.join(base, 'root');
      const statePath = path.join(base, 'egc', 'install-state.json');
      const adapter = { id: 'custom', target: 'custom', kind: 'home' };
      fs.mkdirSync(sourceDir, { recursive: true });
      ['widget', 'widget-old-use.md'].forEach(name =>
        fs.writeFileSync(path.join(sourceDir, name), name === 'widget' ? 'new widget' : `${name} bytes`)
      );
      fs.mkdirSync(path.join(root, 'widget'), { recursive: true });
      fs.writeFileSync(path.join(root, 'widget', 'use.md'), 'widget-old-use.md bytes');
      fs.mkdirSync(path.join(root, 'widget', 'sealed'), { recursive: true });
      fs.writeFileSync(path.join(root, 'widget', 'sealed', 'gone.ts'), 'x');
      // A subdirectory the walk cannot list must refuse the whole transition,
      // never be silently emptied. Whether the mode really seals it is
      // checked, not assumed: root, and any uid with CAP_DAC_OVERRIDE, reads
      // it anyway.
      fs.chmodSync(path.join(root, 'widget', 'sealed'), 0o300);
      let unreadable = false;
      try {
        fs.readdirSync(path.join(root, 'widget', 'sealed'));
      } catch {
        unreadable = true;
      }
      if (!unreadable) {
        fs.chmodSync(path.join(root, 'widget', 'sealed'), 0o700);
        console.log('  - skipped: this process can read a mode 0300 directory');
        return;
      }
      const copyOp = (sourcePath, sourceRelativePath, destinationPath) => ({
        kind: 'copy-file',
        moduleId: 'egc-universal',
        sourcePath,
        sourceRelativePath,
        destinationPath,
        strategy: 'preserve-relative-path',
        ownership: 'managed',
        scaffoldOnly: false,
      });
      const buildState = operations => createInstallState({
        adapter,
        targetRoot: root,
        installStatePath: statePath,
        request: { profile: null },
        resolution: {},
        source: { repoVersion: 'test', repoCommit: 'test', manifestVersion: 1 },
        operations,
      });
      writeInstallState(statePath, buildState([
        copyOp(path.join(sourceDir, 'widget', 'use.md'), 'widget/use.md', path.join(root, 'widget', 'use.md')),
      ]));
      const operations = [
        copyOp(path.join(sourceDir, 'widget'), 'widget', path.join(root, 'widget')),
        copyOp(path.join(sourceDir, 'widget-old-use.md'), 'widget-old-use.md', path.join(root, 'widget-old-use.md')),
      ];
      const plan = {
        adapter,
        targetRoot: root,
        managedRoots: [root],
        installStatePath: statePath,
        retirements: [],
        operations,
        statePreview: buildState(operations),
      };
      try {
        const { transitions, refusals } = collectShapeTransitions(plan);
        assert.strictEqual(transitions.length, 0, 'nothing is promised while a directory cannot be listed');
        assert.strictEqual(refusals.length, 1, 'the unlistable directory refuses the transition');
        assert.strictEqual(refusals[0].destinationPath, path.join(root, 'widget'));
        assert.ok(refusals[0].reason.includes('could not be listed'), refusals[0].reason);
        assert.throws(() => applyInstallPlan(plan, { homeDir: base }), /Shape transition refused/, 'the apply refuses before anything changes');
        assert.ok(fs.statSync(path.join(root, 'widget')).isDirectory(), 'the directory stays');
        assert.strictEqual(fs.readFileSync(path.join(root, 'widget', 'use.md'), 'utf8'), 'widget-old-use.md bytes', 'the reconcilable child stays');
      } finally {
        try {
          fs.chmodSync(path.join(root, 'widget', 'sealed'), 0o700);
        } catch {
          /* restore best effort */
        }
      }
    })) passed++; else failed++;

    if (test('a flatten whose replacement matches none of the recorded children refuses: the honest outcome when the content is new', () => {
      const base = path.join(dir, 'shape-d2f-newcontent');
      const sourceDir = path.join(base, 'source');
      const root = path.join(base, 'root');
      const statePath = path.join(base, 'egc', 'install-state.json');
      const adapter = { id: 'custom', target: 'custom', kind: 'home' };
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.writeFileSync(path.join(sourceDir, 'widget'), 'brand new content');
      fs.mkdirSync(path.join(root, 'widget'), { recursive: true });
      fs.writeFileSync(path.join(root, 'widget', 'use.md'), 'use bytes');
      fs.writeFileSync(path.join(root, 'widget', 'notes.md'), 'notes bytes');
      const copyOp = (sourcePath, sourceRelativePath, destinationPath) => ({
        kind: 'copy-file',
        moduleId: 'egc-universal',
        sourcePath,
        sourceRelativePath,
        destinationPath,
        strategy: 'preserve-relative-path',
        ownership: 'managed',
        scaffoldOnly: false,
      });
      const buildState = operations => createInstallState({
        adapter,
        targetRoot: root,
        installStatePath: statePath,
        request: { profile: null },
        resolution: {},
        source: { repoVersion: 'test', repoCommit: 'test', manifestVersion: 1 },
        operations,
      });
      // The recorded sources (widget/use.md, widget/notes.md) belong to the
      // old directory layout and no longer exist; the flatten's contents are
      // new, so no recorded bytes and no planned bytes can prove the children
      // are obsolete. Refusing is the only honest outcome.
      writeInstallState(statePath, buildState([
        copyOp(path.join(sourceDir, 'widget', 'use.md'), 'widget/use.md', path.join(root, 'widget', 'use.md')),
        copyOp(path.join(sourceDir, 'widget', 'notes.md'), 'widget/notes.md', path.join(root, 'widget', 'notes.md')),
      ]));
      const operations = [copyOp(path.join(sourceDir, 'widget'), 'widget', path.join(root, 'widget'))];
      const plan = {
        adapter,
        targetRoot: root,
        managedRoots: [root],
        installStatePath: statePath,
        retirements: [],
        operations,
        statePreview: buildState(operations),
      };
      const { transitions, refusals } = collectShapeTransitions(plan);
      assert.strictEqual(transitions.length, 0, 'a flatten with unrecognizable children is not promised');
      assert.strictEqual(refusals.length, 1, 'it refuses and tells the person to sort the directory out manually');
      assert.strictEqual(refusals[0].destinationPath, path.join(root, 'widget'));
      assert.throws(() => applyInstallPlan(plan, { homeDir: base }), /Shape transition refused/, 'the apply refuses before anything changes');
      assert.strictEqual(fs.readFileSync(path.join(root, 'widget', 'use.md'), 'utf8'), 'use bytes', 'the directory and its contents stay exactly as they were');
      assert.strictEqual(fs.readFileSync(path.join(root, 'widget', 'notes.md'), 'utf8'), 'notes bytes');
    })) passed++; else failed++;

    if (test('a failing operation earlier in the plan leaves a resolved transition fully intact (all-or-nothing)', () => {
      const base = path.join(dir, 'shape-d2f-laterfail');
      const sourceDir = path.join(base, 'source');
      const root = path.join(base, 'root');
      const statePath = path.join(base, 'egc', 'install-state.json');
      const adapter = { id: 'custom', target: 'custom', kind: 'home' };
      fs.mkdirSync(sourceDir, { recursive: true });
      ['widget', 'widget-old-use.md', 'widget-old-notes.md'].forEach(name =>
        fs.writeFileSync(path.join(sourceDir, name), name === 'widget' ? 'new widget' : `${name} bytes`)
      );
      fs.mkdirSync(path.join(root, 'widget'), { recursive: true });
      fs.writeFileSync(path.join(root, 'widget', 'use.md'), 'widget-old-use.md bytes');
      fs.writeFileSync(path.join(root, 'widget', 'notes.md'), 'widget-old-notes.md bytes');
      fs.writeFileSync(path.join(root, 'config.json'), '{not json');
      const copyOp = (sourcePath, sourceRelativePath, destinationPath) => ({
        kind: 'copy-file',
        moduleId: 'egc-universal',
        sourcePath,
        sourceRelativePath,
        destinationPath,
        strategy: 'preserve-relative-path',
        ownership: 'managed',
        scaffoldOnly: false,
      });
      const buildState = operations => createInstallState({
        adapter,
        targetRoot: root,
        installStatePath: statePath,
        request: { profile: null },
        resolution: {},
        source: { repoVersion: 'test', repoCommit: 'test', manifestVersion: 1 },
        operations,
      });
      writeInstallState(statePath, buildState([
        copyOp(path.join(sourceDir, 'widget', 'use.md'), 'widget/use.md', path.join(root, 'widget', 'use.md')),
        copyOp(path.join(sourceDir, 'widget', 'notes.md'), 'widget/notes.md', path.join(root, 'widget', 'notes.md')),
      ]));
      // The dir-to-file transition is NOT the failing op: the malformed
      // config.json merge fails first, before the widget transition would run.
      const operations = [
        { kind: 'merge-json', moduleId: 'egc-universal', sourceRelativePath: 'config.json', destinationPath: path.join(root, 'config.json'), mergePayload: { app: 1 }, strategy: 'merge', ownership: 'managed', scaffoldOnly: false },
        copyOp(path.join(sourceDir, 'widget'), 'widget', path.join(root, 'widget')),
        copyOp(path.join(sourceDir, 'widget-old-use.md'), 'widget-old-use.md', path.join(root, 'widget-old-use.md')),
        copyOp(path.join(sourceDir, 'widget-old-notes.md'), 'widget-old-notes.md', path.join(root, 'widget-old-notes.md')),
      ];
      const plan = {
        adapter,
        targetRoot: root,
        managedRoots: [root],
        installStatePath: statePath,
        retirements: [],
        operations,
        statePreview: buildState(operations),
      };
      assert.throws(() => applyInstallPlan(plan, { homeDir: base }), /Failed to parse/, 'the merge fails before the transition would run');
      assert.ok(fs.statSync(path.join(root, 'widget')).isDirectory(), 'the directory that would have been transitioned is still there');
      assert.strictEqual(fs.readFileSync(path.join(root, 'widget', 'use.md'), 'utf8'), 'widget-old-use.md bytes', 'neither child was removed');
      assert.strictEqual(fs.readFileSync(path.join(root, 'widget', 'notes.md'), 'utf8'), 'widget-old-notes.md bytes');
      assert.ok(!fs.existsSync(path.join(root, 'widget-old-use.md')), 'nothing after the failure was written');
      assert.ok(!fs.existsSync(path.join(root, 'widget-old-notes.md')), 'any of it');
    })) passed++; else failed++;

    if (test('a planned destination outside every managed root never makes its ancestors transition candidates', () => {
      const base = path.join(dir, 'shape-outside');
      const root = path.join(base, 'root');
      const foreign = path.join(base, 'foreign');
      const statePath = path.join(base, 'egc', 'install-state.json');
      const adapter = { id: 'custom', target: 'custom', kind: 'home' };
      fs.mkdirSync(root, { recursive: true });
      // The plan writes under a FILE that lives outside every managed root.
      // That file is foreign territory: it must not be listed as a
      // file-to-dir candidate, let alone retired to make way for the copy.
      fs.mkdirSync(foreign, { recursive: true });
      fs.writeFileSync(path.join(foreign, 'x'), 'an unrelated file');
      const copyOp = (sourcePath, sourceRelativePath, destinationPath) => ({
        kind: 'copy-file',
        moduleId: 'egc-universal',
        sourcePath,
        sourceRelativePath,
        destinationPath,
        strategy: 'preserve-relative-path',
        ownership: 'managed',
        scaffoldOnly: false,
      });
      const buildState = operations => createInstallState({
        adapter,
        targetRoot: root,
        installStatePath: statePath,
        request: { profile: null },
        resolution: {},
        source: { repoVersion: 'test', repoCommit: 'test', manifestVersion: 1 },
        operations,
      });
      writeInstallState(statePath, buildState([copyOp(
        path.join(foreign, 'x', 'old.md'),
        'x/old.md',
        path.join(foreign, 'x', 'old.md')
      )]));
      const operations = [copyOp(
        path.join(foreign, 'src.md'),
        'x/child.md',
        path.join(foreign, 'x', 'child.md')
      )];
      const plan = {
        adapter,
        targetRoot: root,
        managedRoots: [root],
        installStatePath: statePath,
        retirements: [],
        operations,
        statePreview: buildState(operations),
      };
      const { transitions, refusals } = collectShapeTransitions(plan);
      assert.strictEqual(transitions.length, 0, 'no transition is offered on foreign territory');
      assert.strictEqual(refusals.length, 0, 'and nothing there is refused either');
      assert.strictEqual(fs.readFileSync(path.join(foreign, 'x'), 'utf8'), 'an unrelated file', 'the foreign file is untouched');
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
