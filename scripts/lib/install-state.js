const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'schemas', 'install-state.schema.json');

let cachedValidator = null;

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to read ${label}: ${error.message}`);
  }
}

function getValidator() {
  if (cachedValidator) {
    return cachedValidator;
  }

  const schema = readJson(SCHEMA_PATH, 'install-state schema');
  const ajv = new Ajv({ allErrors: true });
  cachedValidator = ajv.compile(schema);
  return cachedValidator;
}

function formatValidationErrors(errors = []) {
  return errors
    .map(error => `${error.instancePath || '/'} ${error.message}`)
    .join('; ');
}

function validateInstallState(state) {
  const validator = getValidator();
  const valid = validator(state);
  return {
    valid,
    errors: validator.errors || [],
  };
}

function assertValidInstallState(state, label) {
  const result = validateInstallState(state);
  if (!result.valid) {
    throw new Error(`Invalid install-state${label ? ` (${label})` : ''}: ${formatValidationErrors(result.errors)}`);
  }
}

function createInstallState(options) {
  const installedAt = options.installedAt || new Date().toISOString();
  const state = {
    schemaVersion: 'ecc.install.v1',
    installedAt,
    target: {
      id: options.adapter.id,
      target: options.adapter.target || undefined,
      kind: options.adapter.kind || undefined,
      root: options.targetRoot,
      installStatePath: options.installStatePath,
    },
    request: {
      profile: options.request.profile || null,
      modules: Array.isArray(options.request.modules) ? [...options.request.modules] : [],
      includeComponents: Array.isArray(options.request.includeComponents)
        ? [...options.request.includeComponents]
        : [],
      excludeComponents: Array.isArray(options.request.excludeComponents)
        ? [...options.request.excludeComponents]
        : [],
      legacyLanguages: Array.isArray(options.request.legacyLanguages)
        ? [...options.request.legacyLanguages]
        : [],
      legacyMode: Boolean(options.request.legacyMode),
    },
    resolution: {
      selectedModules: Array.isArray(options.resolution.selectedModules)
        ? [...options.resolution.selectedModules]
        : [],
      skippedModules: Array.isArray(options.resolution.skippedModules)
        ? [...options.resolution.skippedModules]
        : [],
    },
    source: {
      repoVersion: options.source.repoVersion || null,
      repoCommit: options.source.repoCommit || null,
      manifestVersion: options.source.manifestVersion,
    },
    operations: Array.isArray(options.operations)
      ? options.operations.map(operation => ({ ...operation }))
      : [],
  };

  if (options.lastValidatedAt) {
    state.lastValidatedAt = options.lastValidatedAt;
  }

  assertValidInstallState(state, 'create');
  return state;
}

function readInstallState(filePath) {
  const state = readJson(filePath, 'install-state');
  assertValidInstallState(state, filePath);
  return state;
}

function writeInstallState(filePath, state) {
  assertValidInstallState(state, filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

module.exports = {
  createInstallState,
  readInstallState,
  validateInstallState,
  writeInstallState,
};
