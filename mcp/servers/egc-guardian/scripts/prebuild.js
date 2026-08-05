#!/usr/bin/env node
'use strict';

// The catalog index is generated from the skill files at the repository
// root, which only exist in a git checkout. The published package ships the
// generated src/catalog-index.ts instead, so a build run from anywhere but
// the repo (a copied server directory, an installed runtime, a vendored
// tree) must not fail on a path that climbs out of this package.
//
// This replaces `node ../../../scripts/build-skill-index.js` in the build
// script, which broke the moment the server was built outside the monorepo.

// ESM, because this package declares "type": "module".
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(packageRoot, '..', '..', '..');
const generator = path.join(repoRoot, 'scripts', 'build-skill-index.js');
const generated = path.join(packageRoot, 'src', 'catalog-index.ts');

if (!fs.existsSync(generator)) {
  if (fs.existsSync(generated)) {
    console.log('prebuild: catalog index generator not available; using the checked-in src/catalog-index.ts');
    process.exit(0);
  }
  console.error('prebuild: no catalog index and no generator to build one from');
  process.exit(1);
}

const result = spawnSync(process.execPath, [generator], { stdio: 'inherit' });
if (result.error) {
  console.error(`prebuild: could not run the catalog index generator: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
