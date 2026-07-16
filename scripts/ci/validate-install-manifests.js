#!/usr/bin/env node
/**
 * Validate selective-install manifests and profile/module relationships.
 * Module paths are curated repo paths only. Generated/imported skill roots
 * (~/.gemini/skills/learned, etc.) are never in manifests.
 */

const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');

const REPO_ROOT = path.join(__dirname, '../..');
const MODULES_MANIFEST_PATH = path.join(REPO_ROOT, 'manifests/install-modules.json');
const PROFILES_MANIFEST_PATH = path.join(REPO_ROOT, 'manifests/install-profiles.json');
const COMPONENTS_MANIFEST_PATH = path.join(REPO_ROOT, 'manifests/install-components.json');
const MODULES_SCHEMA_PATH = path.join(REPO_ROOT, 'schemas/install-modules.schema.json');
const PROFILES_SCHEMA_PATH = path.join(REPO_ROOT, 'schemas/install-profiles.schema.json');
const COMPONENTS_SCHEMA_PATH = path.join(REPO_ROOT, 'schemas/install-components.schema.json');
const COMPONENT_FAMILY_PREFIXES = {
  baseline: 'baseline:',
  language: 'lang:',
  framework: 'framework:',
  capability: 'capability:',
};

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid JSON in ${label}: ${error.message}`, { cause: error });
  }
}

function normalizeRelativePath(relativePath) {
  return String(relativePath).replace(/\\/g, '/').replace(/\/+$/, '');
}

function validateSchema(ajv, schemaPath, data, label) {
  const schema = readJson(schemaPath, `${label} schema`);
  const validate = ajv.compile(schema);
  const valid = validate(data);

  if (!valid) {
    for (const error of validate.errors) {
      console.error(
        `ERROR: ${label} schema: ${error.instancePath || '/'} ${error.message}`
      );
    }
    return true;
  }

  return false;
}

function validateModulePaths(module, claimedPaths) {
  let hasErrors = false;

  for (const relativePath of module.paths) {
    const normalizedPath = normalizeRelativePath(relativePath);
    const absolutePath = path.join(REPO_ROOT, normalizedPath);

    if (!fs.existsSync(absolutePath)) {
      const strict = process.env.EGC_MANIFEST_STRICT === '1';
      const level = strict ? 'ERROR' : 'WARN';
      console[strict ? 'error' : 'warn'](
        `${level}: Module ${module.id} references missing path: ${normalizedPath}`
      );
      if (strict) hasErrors = true;
    }

    if (claimedPaths.has(normalizedPath)) {
      console.error(
        `ERROR: Install path ${normalizedPath} is claimed by both ${claimedPaths.get(normalizedPath)} and ${module.id}`
      );
      hasErrors = true;
    } else {
      claimedPaths.set(normalizedPath, module.id);
    }
  }

  return hasErrors;
}

function validateModuleDependencies(module, modules) {
  let hasErrors = false;

  for (const dependency of module.dependencies) {
    if (!modules.some(candidate => candidate.id === dependency)) {
      console.error(`ERROR: Module ${module.id} depends on unknown module ${dependency}`);
      hasErrors = true;
    }
    if (dependency === module.id) {
      console.error(`ERROR: Module ${module.id} cannot depend on itself`);
      hasErrors = true;
    }
  }

  return hasErrors;
}

function validateModules(modules) {
  let hasErrors = false;
  const moduleIds = new Set();
  const claimedPaths = new Map();

  for (const module of modules) {
    if (moduleIds.has(module.id)) {
      console.error(`ERROR: Duplicate install module id: ${module.id}`);
      hasErrors = true;
    }
    moduleIds.add(module.id);

    if (validateModuleDependencies(module, modules)) hasErrors = true;
    if (validateModulePaths(module, claimedPaths)) hasErrors = true;
  }

  return { hasErrors, moduleIds };
}

function validateRequiredProfiles(profiles) {
  let hasErrors = false;
  const expectedProfileIds = ['core', 'developer', 'security', 'research', 'full'];

  for (const profileId of expectedProfileIds) {
    if (!profiles[profileId]) {
      console.error(`ERROR: Missing required install profile: ${profileId}`);
      hasErrors = true;
    }
  }

  return hasErrors;
}

function validateProfileModules(profileId, profile, moduleIds) {
  let hasErrors = false;
  const seenModules = new Set();

  for (const moduleId of profile.modules) {
    if (!moduleIds.has(moduleId)) {
      console.error(`ERROR: Profile ${profileId} references unknown module ${moduleId}`);
      hasErrors = true;
    }

    if (seenModules.has(moduleId)) {
      console.error(`ERROR: Profile ${profileId} contains duplicate module ${moduleId}`);
      hasErrors = true;
    }
    seenModules.add(moduleId);
  }

  return hasErrors;
}

function validateFullProfileCoverage(profiles, moduleIds) {
  let hasErrors = false;

  if (!profiles.full) return hasErrors;

  const fullModules = new Set(profiles.full.modules);
  for (const moduleId of moduleIds) {
    if (!fullModules.has(moduleId)) {
      console.error(`ERROR: full profile is missing module ${moduleId}`);
      hasErrors = true;
    }
  }

  return hasErrors;
}

function validateProfiles(profiles, moduleIds) {
  let hasErrors = false;

  if (validateRequiredProfiles(profiles)) hasErrors = true;

  for (const [profileId, profile] of Object.entries(profiles)) {
    if (validateProfileModules(profileId, profile, moduleIds)) hasErrors = true;
  }

  if (validateFullProfileCoverage(profiles, moduleIds)) hasErrors = true;

  return hasErrors;
}

function validateComponentModules(component, moduleIds) {
  let hasErrors = false;
  const seenModules = new Set();

  for (const moduleId of component.modules) {
    if (!moduleIds.has(moduleId)) {
      console.error(`ERROR: Component ${component.id} references unknown module ${moduleId}`);
      hasErrors = true;
    }

    if (seenModules.has(moduleId)) {
      console.error(`ERROR: Component ${component.id} contains duplicate module ${moduleId}`);
      hasErrors = true;
    }
    seenModules.add(moduleId);
  }

  return hasErrors;
}

function validateComponents(components, moduleIds) {
  let hasErrors = false;
  const componentIds = new Set();

  for (const component of components) {
    if (componentIds.has(component.id)) {
      console.error(`ERROR: Duplicate install component id: ${component.id}`);
      hasErrors = true;
    }
    componentIds.add(component.id);

    const expectedPrefix = COMPONENT_FAMILY_PREFIXES[component.family];
    if (expectedPrefix && !component.id.startsWith(expectedPrefix)) {
      console.error(
        `ERROR: Component ${component.id} does not match expected ${component.family} prefix ${expectedPrefix}`
      );
      hasErrors = true;
    }

    if (validateComponentModules(component, moduleIds)) hasErrors = true;
  }

  return hasErrors;
}

function validateInstallManifests() {
  if (!fs.existsSync(MODULES_MANIFEST_PATH) || !fs.existsSync(PROFILES_MANIFEST_PATH)) {
    console.log('Install manifests not found, skipping validation');
    process.exit(0);
  }

  let hasErrors = false;
  let modulesData;
  let profilesData;
  let componentsData = { version: null, components: [] };

  try {
    modulesData = readJson(MODULES_MANIFEST_PATH, 'install-modules.json');
    profilesData = readJson(PROFILES_MANIFEST_PATH, 'install-profiles.json');
    if (fs.existsSync(COMPONENTS_MANIFEST_PATH)) {
      componentsData = readJson(COMPONENTS_MANIFEST_PATH, 'install-components.json');
    }
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }

  const ajv = new Ajv({ allErrors: true });
  hasErrors = validateSchema(ajv, MODULES_SCHEMA_PATH, modulesData, 'install-modules.json') || hasErrors;
  hasErrors = validateSchema(ajv, PROFILES_SCHEMA_PATH, profilesData, 'install-profiles.json') || hasErrors;
  if (fs.existsSync(COMPONENTS_MANIFEST_PATH)) {
    hasErrors = validateSchema(ajv, COMPONENTS_SCHEMA_PATH, componentsData, 'install-components.json') || hasErrors;
  }

  if (hasErrors) {
    process.exit(1);
  }

  const modules = Array.isArray(modulesData.modules) ? modulesData.modules : [];
  const { hasErrors: moduleErrors, moduleIds } = validateModules(modules);
  if (moduleErrors) hasErrors = true;

  const profiles = profilesData.profiles || {};
  if (validateProfiles(profiles, moduleIds)) hasErrors = true;

  const components = Array.isArray(componentsData.components) ? componentsData.components : [];
  if (validateComponents(components, moduleIds)) hasErrors = true;

  if (hasErrors) {
    process.exit(1);
  }

  console.log(
    `Validated ${modules.length} install modules, ${components.length} install components, and ${Object.keys(profiles).length} profiles`
  );
}

validateInstallManifests();
