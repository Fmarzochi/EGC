'use strict';
/**
 * A few files under scripts/hooks are written only to a host's own plugin
 * location by that host's adapter (Amp's plugins, Cline's PreToolUse shim,
 * OpenCode's plugin), and their relative requires resolve from there. The
 * hooks runtime copies the scripts/hooks directory into other targets, and
 * a copy of one of these under <root>/scripts/hooks could never load. This
 * materializes every target's full-profile plan and checks where each of
 * them lands.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createManifestInstallPlan } = require('../../scripts/lib/install-executor');
const { listInstallTargetAdapters } = require('../../scripts/lib/install-targets/registry');

const REPO_ROOT = path.join(__dirname, '..', '..');
const HOST_PLACED = new Set([
  'scripts/hooks/amp-guardian-crusher-plugin.ts',
  'scripts/hooks/amp-mesh-notice-plugin.ts',
  'scripts/hooks/cline-pretooluse-shim.js',
  'scripts/hooks/opencode-egc-plugin.js',
]);

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${error.message}`);
    failed++;
  }
}

const normalized = value => String(value || '').replaceAll('\\', '/');

console.log('\n=== Testing where the host-placed hook sources land ===\n');

const placed = new Map();
for (const target of [...new Set(listInstallTargetAdapters().map(adapter => adapter.target))]) {
  run(`${target}: no host-placed source is copied into scripts/hooks`, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `egc-host-placed-${target}-`));
    try {
      const plan = createManifestInstallPlan({ sourceRoot: REPO_ROOT, target, profileId: 'full', homeDir: home, projectRoot: home });
      const copies = plan.operations.filter(op => op.kind === 'copy-file' && HOST_PLACED.has(normalized(op.sourceRelativePath)));
      const misplaced = copies.filter(op => /\/scripts\/hooks\/[^/]+$/.test(normalized(op.destinationPath)));
      for (const op of copies.filter(copy => !misplaced.includes(copy))) {
        placed.set(normalized(op.sourceRelativePath), (placed.get(normalized(op.sourceRelativePath)) || 0) + 1);
      }
      assert.deepStrictEqual(misplaced.map(op => normalized(path.relative(home, op.destinationPath))), []);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

run('each host-placed source still reaches its own host', () => {
  for (const source of HOST_PLACED) {
    assert.ok(placed.get(source) > 0, `${source} is copied by no target`);
  }
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
