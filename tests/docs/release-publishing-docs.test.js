'use strict';

// Releases publish through npm trusted publishing (OIDC), so no npm token
// exists, and npm never accepts a version number twice, so no workflow can
// unpublish a release and publish the same number again. The docs that
// describe publishing and verification must name the real package.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const workflowsDir = path.join(repoRoot, '.github', 'workflows');
const workflows = fs.readdirSync(workflowsDir).filter(file => /\.ya?ml$/.test(file)).map(file => ({
  file,
  source: fs.readFileSync(path.join(workflowsDir, file), 'utf8').split('\n').filter(line => !line.trim().startsWith('#')).join('\n'),
}));
const packageName = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).name;
const publishingDocs = ['docs/MAINTAINERS.md', '.github/SECURITY.md', 'docs/security/RELEASE-VERIFICATION.md'];

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

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

console.log('\n=== Testing the release publishing docs ===\n');

let passed = 0;
let failed = 0;

if (test('no workflow unpublishes a release from npm', () => {
  assert.ok(workflows.length > 0, '.github/workflows lists at least one workflow');
  for (const { file, source } of workflows) {
    assert.ok(!/npm\s+unpublish/.test(source), `.github/workflows/${file} runs npm unpublish`);
  }
})) passed++; else failed++;

if (test('no workflow reads an npm token secret', () => {
  for (const { file, source } of workflows) {
    assert.ok(!/secrets\.(NPM_TOKEN|NODE_AUTH_TOKEN)\b/.test(source), `.github/workflows/${file} reads an npm token secret`);
  }
})) passed++; else failed++;

if (test('the publishing docs name neither a stored npm token nor a package that does not exist', () => {
  for (const relativePath of publishingDocs) {
    const source = read(relativePath);
    assert.ok(!/\bNPM_TOKEN\b/.test(source), `${relativePath} mentions NPM_TOKEN`);
    assert.ok(!/\begc-universal\b/.test(source), `${relativePath} names egc-universal`);
  }
})) passed++; else failed++;

if (test('release verification uses the published package and its tarball name', () => {
  const source = read('docs/security/RELEASE-VERIFICATION.md');
  const tarball = `${packageName.replace(/^@/, '').replace('/', '-')}-<version>.tgz`;
  assert.ok(source.includes(`npm install ${packageName}`), `installs ${packageName} before npm audit signatures`);
  assert.ok(!/npm audit signatures[ \t]+[^\s-]/.test(source), 'npm audit signatures takes no package name');
  assert.ok(source.includes(`gh attestation verify ${tarball}`), `verifies ${tarball}`);
})) passed++; else failed++;

if (test('the maintainers guide explains how a broken version is handled', () => {
  const source = read('docs/MAINTAINERS.md');
  assert.ok(source.includes(`npm deprecate ${packageName}@`), 'shows the npm deprecate command');
  assert.ok(source.includes('https://docs.npmjs.com/policies/unpublish'), 'links the npm unpublish policy');
})) passed++; else failed++;

console.log(`\nPassed: ${passed}, Failed: ${failed}\n`);
process.exit(failed > 0 ? 1 : 0);
