'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Ajv = require('ajv');

const { discover } = require('../../scripts/runtime/discovery');
const { writeProvenance } = require('../../scripts/lib/skill-evolution/provenance');
const { setProjectPackageManager } = require('../../scripts/lib/package-manager');
const { createInstallState } = require('../../scripts/lib/install-state');

const repoRoot = path.resolve(__dirname, '..', '..');
const schemasDir = path.join(repoRoot, 'schemas');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    failed++;
  }
}

function createAjv() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  ajv.addFormat('date-time', value => /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value)));
  ajv.addFormat('uri', value => {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  });
  return ajv;
}

const readJson = filePath => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const repoJson = relative => readJson(path.join(repoRoot, relative));

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-schemas-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function assertValid(schemaFile, data, label) {
  const validate = createAjv().compile(readJson(path.join(schemasDir, schemaFile)));
  const errors = validate(data) ? [] : validate.errors.map(error => `${error.instancePath || '/'} ${error.message}`);
  assert.deepStrictEqual(errors, [], `${label} does not match schemas/${schemaFile}: ${errors.join('; ')}`);
}

function assertLoadedAtRuntime(schemaFile, modulePath) {
  const source = fs.readFileSync(path.join(repoRoot, modulePath), 'utf8');
  assert.ok(source.includes(schemaFile), `${modulePath} no longer loads ${schemaFile}`);
  assert.ok(/\.compile\(/.test(source), `${modulePath} no longer compiles a schema validator`);
  createAjv().compile(readJson(path.join(schemasDir, schemaFile)));
}

const CASES = {
  'hooks.schema.json': () => assertValid('hooks.schema.json', repoJson('hooks/hooks.json'), 'hooks/hooks.json'),
  'install-modules.schema.json': () => assertValid('install-modules.schema.json', repoJson('manifests/install-modules.json'), 'manifests/install-modules.json'),
  'install-profiles.schema.json': () => assertValid('install-profiles.schema.json', repoJson('manifests/install-profiles.json'), 'manifests/install-profiles.json'),
  'install-components.schema.json': () => assertValid('install-components.schema.json', repoJson('manifests/install-components.json'), 'manifests/install-components.json'),
  'plugin.schema.json': () => assertValid('plugin.schema.json', repoJson('.gemini-plugin/plugin.json'), '.gemini-plugin/plugin.json'),
  'runtime-map.schema.json': () => withTempDir(dir => {
    const outputPath = path.join(dir, 'runtime-map.json');
    discover({ outputPath });
    assertValid('runtime-map.schema.json', readJson(outputPath), 'the runtime map discovery.js writes');
  }),
  'provenance.schema.json': () => withTempDir(dir => {
    const skillDir = path.join(dir, 'skills', 'learned', 'example-skill');
    const written = writeProvenance(skillDir, {
      source: 'https://example.com/example-skill',
      created_at: '2026-10-08T12:00:00.000Z',
      confidence: 0.8,
      author: 'egc',
    }, { egcDir: dir });
    assertValid('provenance.schema.json', readJson(written.path), 'the provenance file provenance.js writes');
  }),
  'package-manager.schema.json': () => withTempDir(dir => {
    setProjectPackageManager('npm', dir);
    assertValid('package-manager.schema.json', readJson(path.join(dir, '.gemini', 'package-manager.json')), 'the package-manager.json package-manager.js writes');
  }),
  'install-state.schema.json': () => {
    const state = createInstallState({
      adapter: { id: 'cursor-project' },
      targetRoot: '/repo/.cursor',
      installStatePath: '/repo/.cursor/egc-install-state.json',
      request: { profile: 'core', modules: [], legacyLanguages: [], legacyMode: false },
      resolution: { selectedModules: ['rules-core'], skippedModules: [] },
      operations: [{
        kind: 'copy-path',
        moduleId: 'rules-core',
        sourceRelativePath: 'rules',
        destinationPath: '/repo/.cursor/rules',
        strategy: 'preserve-relative-path',
        ownership: 'managed',
        scaffoldOnly: false,
      }],
      source: { repoVersion: repoJson('package.json').version, repoCommit: 'abc123', manifestVersion: 1 },
    });
    assertValid('install-state.schema.json', state, 'the install state install-state.js creates');
  },
  'egc-install-config.schema.json': () => assertLoadedAtRuntime('egc-install-config.schema.json', 'scripts/lib/install/config.js'),
  'state-store.schema.json': () => assertLoadedAtRuntime('state-store.schema.json', 'scripts/lib/state-store/schema.js'),
};

console.log('\n=== Testing every schema in schemas/ against its data ===\n');

const schemaFiles = fs.readdirSync(schemasDir).filter(name => name.endsWith('.schema.json')).sort();

test('every schema in schemas/ has a case here, and every case has a schema', () => {
  assert.deepStrictEqual(Object.keys(CASES).sort(), schemaFiles);
});

for (const schemaFile of schemaFiles) {
  if (CASES[schemaFile]) {
    test(`${schemaFile} validates its data`, CASES[schemaFile]);
  }
}

test('the spec index lists only schemas that exist', () => {
  const spec = fs.readFileSync(path.join(repoRoot, 'docs', 'spec', 'README.md'), 'utf8');
  const named = [...new Set([...spec.matchAll(/schemas\/([\w.-]+\.schema\.json)/g)].map(match => match[1]))];
  const missing = named.filter(name => !schemaFiles.includes(name));
  assert.deepStrictEqual(missing, [], `docs/spec/README.md names schemas that do not exist: ${missing.join(', ')}`);
});

test('the spec index points only at documents that exist', () => {
  const spec = fs.readFileSync(path.join(repoRoot, 'docs', 'spec', 'README.md'), 'utf8');
  const missing = [...new Set([...spec.matchAll(/`((?:docs|tests|schemas|scripts)\/[^`\s{}]+)`/g)].map(match => match[1]))]
    .filter(relative => !fs.existsSync(path.join(repoRoot, relative)));
  assert.deepStrictEqual(missing, [], `docs/spec/README.md points at paths that do not exist: ${missing.join(', ')}`);
});

if (failed > 0) {
  console.log(`\nFailed: ${failed}`);
  process.exit(1);
}

console.log(`\nPassed: ${passed}`);
