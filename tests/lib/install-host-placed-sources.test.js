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
const { HOST_PLACED_SOURCES } = require('../../scripts/lib/install-source-filters');
const { listInstallTargetAdapters } = require('../../scripts/lib/install-targets/registry');

const REPO_ROOT = path.join(__dirname, '..', '..');
// Each host-placed source, the target that writes it and where it lands
// there (the host's own plugin location).
const HOSTS = {
  'scripts/hooks/amp-guardian-crusher-plugin.ts': { target: 'amp', destination: /\/plugins\/egc-guardian-crusher\.ts$/ },
  'scripts/hooks/amp-mesh-notice-plugin.ts': { target: 'amp', destination: /\/plugins\/egc-mesh-notice\.ts$/ },
  'scripts/hooks/cline-pretooluse-shim.js': { target: 'cline', destination: /\/hooks\/PreToolUse$/ },
  'scripts/hooks/opencode-egc-plugin.js': { target: 'opencode', destination: /\/plugins\/opencode-egc-plugin\.js$/ },
};

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

run('the filter and this test name the same host-placed sources', () => {
  assert.deepStrictEqual([...HOST_PLACED_SOURCES].sort(), Object.keys(HOSTS).sort());
});

const reached = new Set();
for (const target of [...new Set(listInstallTargetAdapters().map(adapter => adapter.target))]) {
  run(`${target}: a host-placed source is copied only to its host's plugin location`, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `egc-host-placed-${target}-`));
    try {
      const plan = createManifestInstallPlan({ sourceRoot: REPO_ROOT, target, profileId: 'full', homeDir: home, projectRoot: home });
      const wrong = [];
      for (const op of plan.operations) {
        const source = normalized(op.sourceRelativePath);
        if (op.kind !== 'copy-file' || !Object.hasOwn(HOSTS, source)) continue;
        const host = HOSTS[source];
        const destination = normalized(op.destinationPath);
        if (host.target === target && host.destination.test(destination)) reached.add(source);
        else wrong.push(`${source} -> ${normalized(path.relative(home, op.destinationPath))}`);
      }
      assert.deepStrictEqual(wrong, []);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

run('each host-placed source reaches its host', () => {
  assert.deepStrictEqual([...reached].sort(), Object.keys(HOSTS).sort());
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
