'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');

const DEFAULT_INSTALL_CONFIG = 'egc-install.json';
const CONFIG_SCHEMA_PATH = path.join(__dirname, '..', '..', '..', 'schemas', 'egc-install-config.schema.json');

let cachedValidator = null;

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid JSON in ${label}: ${error.message}`, { cause: error });
  }
}

function getValidator() {
  if (cachedValidator) {
    return cachedValidator;
  }

  const schema = readJson(CONFIG_SCHEMA_PATH, 'egc-install-config.schema.json');
  const ajv = new Ajv({ allErrors: true });
  cachedValidator = ajv.compile(schema);
  return cachedValidator;
}

function dedupeStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(value => String(value).trim()).filter(Boolean))];
}

function formatValidationErrors(errors = []) {
  return errors.map(error => `${error.instancePath || '/'} ${error.message}`).join('; ');
}

function resolveInstallConfigPath(configPath, options = {}) {
  if (!configPath) {
    throw new Error('An install config path is required');
  }

  const cwd = options.cwd || process.cwd();
  return path.isAbsolute(configPath)
    ? configPath
    : path.normalize(path.join(cwd, configPath));
}

function findDefaultInstallConfigPath(options = {}) {
  const cwd = options.cwd || process.cwd();
  const candidatePath = path.join(cwd, DEFAULT_INSTALL_CONFIG);
  return fs.existsSync(candidatePath) ? candidatePath : null;
}

function loadInstallConfig(configPath, options = {}) {
  const resolvedPath = resolveInstallConfigPath(configPath, options);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Install config not found: ${resolvedPath}`);
  }

  const raw = readJson(resolvedPath, path.basename(resolvedPath));
  const validator = getValidator();

  if (!validator(raw)) {
    throw new Error(
      `Invalid install config ${resolvedPath}: ${formatValidationErrors(validator.errors)}`
    );
  }

  return {
    path: resolvedPath,
    version: raw.version,
    target: raw.target || null,
    profileId: raw.profile || null,
    moduleIds: dedupeStrings(raw.modules),
    includeComponentIds: dedupeStrings(raw.include),
    excludeComponentIds: dedupeStrings(raw.exclude),
    options: raw.options && typeof raw.options === 'object' ? { ...raw.options } : {},
  };
}

module.exports = {
  DEFAULT_INSTALL_CONFIG,
  findDefaultInstallConfigPath,
  loadInstallConfig,
  resolveInstallConfigPath,
};
