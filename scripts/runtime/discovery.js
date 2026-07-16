#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { listInstallProfiles, listInstallModules, listInstallComponents } = require('../lib/install-manifests');

const REPO_ROOT = path.join(__dirname, '../..');
const OUTPUT_DIR = path.join(REPO_ROOT, 'internal', 'registry');
const OUTPUT_PATH = path.join(OUTPUT_DIR, 'runtime-map.json');

function discover(options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const outputPath = options.outputPath || OUTPUT_PATH;

  const profiles = listInstallProfiles({ repoRoot });
  const modules = listInstallModules({ repoRoot });
  const components = listInstallComponents({ repoRoot });

  const runtimeMap = {
    generatedAt: new Date().toISOString(),
    profiles: Object.fromEntries(profiles.map(p => [p.id, p])),
    modules: Object.fromEntries(modules.map(m => [m.id, m])),
    components: Object.fromEntries(components.map(c => [c.id, c])),
  };

  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(outputPath, JSON.stringify(runtimeMap, null, 2) + '\n');
  return runtimeMap;
}

module.exports = { discover };

if (require.main === module) {
  try {
    const map = discover();
    const profileCount = Object.keys(map.profiles).length;
    const moduleCount = Object.keys(map.modules).length;
    const componentCount = Object.keys(map.components).length;
    console.log(`Topology cache written to ${OUTPUT_PATH}`);
    console.log(`  Profiles: ${profileCount}, Modules: ${moduleCount}, Components: ${componentCount}`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
