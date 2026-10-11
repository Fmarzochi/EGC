#!/usr/bin/env node
/**
 * The release workflow attests the SBOM with actions/attest, pinned by commit.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const WORKFLOW_PATH = path.join(__dirname, '..', '..', '.github', 'workflows', 'release.yml');
const DEPRECATED_ACTION = 'actions/attest-sbom';
const ATTEST_ACTION = 'actions/attest';
const SBOM_GENERATOR = 'anchore/sbom-action';
const PROVENANCE_ACTION = 'actions/attest-build-provenance';
const PACKED_TARBALL = '${{ steps.pack.outputs.tarball }}';
const COMMIT_SHA_PIN = /^actions\/attest@[0-9a-f]{40}$/;
const PIN_LINE_WITH_VERSION_COMMENT = /^uses: actions\/attest@[0-9a-f]{40} # v\d+\.\d+\.\d+$/;

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

function loadWorkflow() {
  const text = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const doc = yaml.load(text);
  const steps = Object.values(doc.jobs || {}).flatMap(job => job.steps || []);
  return { text, steps };
}

function usesAction(step, action) {
  return typeof step.uses === 'string' && step.uses.startsWith(`${action}@`);
}

function findStep(steps, action) {
  const step = steps.find(candidate => usesAction(candidate, action));
  assert.ok(step, `no step uses ${action}`);
  return step;
}

function run() {
  console.log('\n=== Testing release SBOM attestation ===\n');

  let passed = 0;
  let failed = 0;

  const { text, steps } = loadWorkflow();

  if (test('no step uses the deprecated actions/attest-sbom', () => {
    const deprecated = steps.filter(step => usesAction(step, DEPRECATED_ACTION));
    assert.deepStrictEqual(deprecated.map(step => step.uses), []);
    assert.ok(!text.includes(DEPRECATED_ACTION), `${DEPRECATED_ACTION} is still mentioned in release.yml`);
  })) passed++; else failed++;

  if (test('the SBOM attestation uses actions/attest pinned by a 40-character commit SHA with its version comment', () => {
    const attest = findStep(steps, ATTEST_ACTION);
    assert.match(attest.uses, COMMIT_SHA_PIN, `expected a commit pin, got ${attest.uses}`);
    const pinLine = text.split(/\r?\n/).map(line => line.trim()).find(line => line.startsWith(`uses: ${ATTEST_ACTION}@`));
    assert.ok(pinLine, `no "uses: ${ATTEST_ACTION}@" line in release.yml`);
    assert.match(pinLine, PIN_LINE_WITH_VERSION_COMMENT, 'the pin has no "# vX.Y.Z" comment next to it');
  })) passed++; else failed++;

  if (test('the attestation reads the SBOM the previous step generated and keeps the tarball as its subject', () => {
    const generator = findStep(steps, SBOM_GENERATOR);
    const attest = findStep(steps, ATTEST_ACTION);
    const provenance = findStep(steps, PROVENANCE_ACTION);

    const sbomFile = generator.with && generator.with['output-file'];
    assert.ok(sbomFile, 'the SBOM generator declares no output-file');
    assert.ok(steps.indexOf(generator) < steps.indexOf(attest), 'the SBOM must be generated before it is attested');
    assert.strictEqual(attest.with && attest.with['sbom-path'], sbomFile);
    assert.strictEqual(attest.with['subject-path'], PACKED_TARBALL);
    assert.strictEqual(provenance.with['subject-path'], PACKED_TARBALL);
    assert.ok(!('predicate-type' in attest.with), 'sbom-path and predicate-type cannot be combined');
    assert.ok(!('predicate-path' in attest.with), 'sbom-path and predicate-path cannot be combined');
  })) passed++; else failed++;

  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);

  process.exit(failed > 0 ? 1 : 0);
}

run();
