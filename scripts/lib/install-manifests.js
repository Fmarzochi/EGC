const fs = require('fs');
const os = require('os');
const path = require('path');
const { planInstallTargetScaffold } = require('./install-targets/registry');

const DEFAULT_REPO_ROOT = path.join(__dirname, '../..');
const SUPPORTED_INSTALL_TARGETS = ['claude', 'cursor', 'antigravity', 'codex', 'opencode'];
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
    throw new Error(`Failed to read ${label}: ${error.message}`);
  }
}

function dedupeStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(value => String(value).trim()).filter(Boolean))];
}

function intersectTargets(modules) {
  if (!Array.isArray(modules) || modules.length === 0) {
    return [];
  }

  return SUPPORTED_INSTALL_TARGETS.filter(target => (
    modules.every(module => Array.isArray(module.targets) && module.targets.includes(target))
  ));
}

function getManifestPaths(repoRoot = DEFAULT_REPO_ROOT) {
  return {
    modulesPath: path.join(repoRoot, 'manifests', 'install-modules.json'),
    profilesPath: path.join(repoRoot, 'manifests', 'install-profiles.json'),
    componentsPath: path.join(repoRoot, 'manifests', 'install-components.json'),
  };
}

function loadInstallManifests(options = {}) {
  const repoRoot = options.repoRoot || DEFAULT_REPO_ROOT;
  const { modulesPath, profilesPath, componentsPath } = getManifestPaths(repoRoot);

  if (!fs.existsSync(modulesPath) || !fs.existsSync(profilesPath)) {
    throw new Error(`Install manifests not found under ${repoRoot}`);
  }

  const modulesData = readJson(modulesPath, 'install-modules.json');
  const profilesData = readJson(profilesPath, 'install-profiles.json');
  const componentsData = fs.existsSync(componentsPath)
    ? readJson(componentsPath, 'install-components.json')
    : { version: null, components: [] };
  const modules = Array.isArray(modulesData.modules) ? modulesData.modules : [];
  const profiles = profilesData && typeof profilesData.profiles === 'object'
    ? profilesData.profiles
    : {};
  const components = Array.isArray(componentsData.components) ? componentsData.components : [];
  const modulesById = new Map(modules.map(module => [module.id, module]));
  const componentsById = new Map(components.map(component => [component.id, component]));

  return {
    repoRoot,
    modulesPath,
    profilesPath,
    componentsPath,
    modules,
    profiles,
    components,
    modulesById,
    componentsById,
    modulesVersion: modulesData.version,
    profilesVersion: profilesData.version,
    componentsVersion: componentsData.version,
  };
}

function listInstallProfiles(options = {}) {
  const manifests = loadInstallManifests(options);
  return Object.entries(manifests.profiles).map(([id, profile]) => ({
    id,
    description: profile.description,
    moduleCount: Array.isArray(profile.modules) ? profile.modules.length : 0,
  }));
}

function listInstallModules(options = {}) {
  const manifests = loadInstallManifests(options);
  return manifests.modules.map(module => ({
    id: module.id,
    kind: module.kind,
    description: module.description,
    targets: module.targets,
    defaultInstall: module.defaultInstall,
    cost: module.cost,
    stability: module.stability,
    dependencyCount: Array.isArray(module.dependencies) ? module.dependencies.length : 0,
  }));
}

function listInstallComponents(options = {}) {
  const manifests = loadInstallManifests(options);
  const family = options.family || null;
  const target = options.target || null;

  if (family && !Object.hasOwn(COMPONENT_FAMILY_PREFIXES, family)) {
    throw new Error(
      `Unknown component family: ${family}. Expected one of ${Object.keys(COMPONENT_FAMILY_PREFIXES).join(', ')}`
    );
  }

  if (target && !SUPPORTED_INSTALL_TARGETS.includes(target)) {
    throw new Error(
      `Unknown install target: ${target}. Expected one of ${SUPPORTED_INSTALL_TARGETS.join(', ')}`
    );
  }

  return manifests.components
    .filter(component => !family || component.family === family)
    .map(component => {
      const moduleIds = dedupeStrings(component.modules);
      const modules = moduleIds
        .map(moduleId => manifests.modulesById.get(moduleId))
        .filter(Boolean);
      const targets = intersectTargets(modules);

      return {
        id: component.id,
        family: component.family,
        description: component.description,
        moduleIds,
        moduleCount: moduleIds.length,
        targets,
      };
    })
    .filter(component => !target || component.targets.includes(target));
}

function expandComponentIdsToModuleIds(componentIds, manifests) {
  const expandedModuleIds = [];

  for (const componentId of dedupeStrings(componentIds)) {
    const component = manifests.componentsById.get(componentId);
    if (!component) {
      throw new Error(`Unknown install component: ${componentId}`);
    }
    expandedModuleIds.push(...component.modules);
  }

  return dedupeStrings(expandedModuleIds);
}

function resolveInstallPlan(options = {}) {
  const manifests = loadInstallManifests(options);
  const profileId = options.profileId || null;
  const explicitModuleIds = dedupeStrings(options.moduleIds);
  const includedComponentIds = dedupeStrings(options.includeComponentIds);
  const excludedComponentIds = dedupeStrings(options.excludeComponentIds);
  const requestedModuleIds = [];

  if (profileId) {
    const profile = manifests.profiles[profileId];
    if (!profile) {
      throw new Error(`Unknown install profile: ${profileId}`);
    }
    requestedModuleIds.push(...profile.modules);
  }

  requestedModuleIds.push(...explicitModuleIds);
  requestedModuleIds.push(...expandComponentIdsToModuleIds(includedComponentIds, manifests));

  const excludedModuleIds = expandComponentIdsToModuleIds(excludedComponentIds, manifests);
  const excludedModuleOwners = new Map();
  for (const componentId of excludedComponentIds) {
    const component = manifests.componentsById.get(componentId);
    if (!component) {
      throw new Error(`Unknown install component: ${componentId}`);
    }
    for (const moduleId of component.modules) {
      const owners = excludedModuleOwners.get(moduleId) || [];
      owners.push(componentId);
      excludedModuleOwners.set(moduleId, owners);
    }
  }

  const target = options.target || null;
  if (target && !SUPPORTED_INSTALL_TARGETS.includes(target)) {
    throw new Error(
      `Unknown install target: ${target}. Expected one of ${SUPPORTED_INSTALL_TARGETS.join(', ')}`
    );
  }

  const effectiveRequestedIds = dedupeStrings(
    requestedModuleIds.filter(moduleId => !excludedModuleOwners.has(moduleId))
  );

  if (requestedModuleIds.length === 0) {
    throw new Error('No install profile, module IDs, or included component IDs were provided');
  }

  if (effectiveRequestedIds.length === 0) {
    throw new Error('Selection excludes every requested install module');
  }

  const selectedIds = new Set();
  const skippedTargetIds = new Set();
  const excludedIds = new Set(excludedModuleIds);
  const visitingIds = new Set();
  const resolvedIds = new Set();

  function resolveModule(moduleId, dependencyOf) {
    const module = manifests.modulesById.get(moduleId);
    if (!module) {
      throw new Error(`Unknown install module: ${moduleId}`);
    }

    if (excludedModuleOwners.has(moduleId)) {
      if (dependencyOf) {
        const owners = excludedModuleOwners.get(moduleId) || [];
        throw new Error(
          `Module ${dependencyOf} depends on excluded module ${moduleId}${owners.length > 0 ? ` (excluded by ${owners.join(', ')})` : ''}`
        );
      }
      return;
    }

    if (target && !module.targets.includes(target)) {
      if (dependencyOf) {
        throw new Error(
          `Module ${dependencyOf} depends on ${moduleId}, which does not support target ${target}`
        );
      }
      skippedTargetIds.add(moduleId);
      return;
    }

    if (resolvedIds.has(moduleId)) {
      return;
    }

    if (visitingIds.has(moduleId)) {
      throw new Error(`Circular install dependency detected at ${moduleId}`);
    }

    visitingIds.add(moduleId);
    for (const dependencyId of module.dependencies) {
      resolveModule(dependencyId, moduleId);
    }
    visitingIds.delete(moduleId);
    resolvedIds.add(moduleId);
    selectedIds.add(moduleId);
  }

  for (const moduleId of effectiveRequestedIds) {
    resolveModule(moduleId, null);
  }

  const selectedModules = manifests.modules.filter(module => selectedIds.has(module.id));
  const skippedModules = manifests.modules.filter(module => skippedTargetIds.has(module.id));
  const excludedModules = manifests.modules.filter(module => excludedIds.has(module.id));
  const scaffoldPlan = target
    ? planInstallTargetScaffold({
      target,
      repoRoot: manifests.repoRoot,
      projectRoot: options.projectRoot || manifests.repoRoot,
      homeDir: options.homeDir || os.homedir(),
      modules: selectedModules,
    })
    : null;

  return {
    repoRoot: manifests.repoRoot,
    profileId,
    target,
    requestedModuleIds: effectiveRequestedIds,
    explicitModuleIds,
    includedComponentIds,
    excludedComponentIds,
    selectedModuleIds: selectedModules.map(module => module.id),
    skippedModuleIds: skippedModules.map(module => module.id),
    excludedModuleIds: excludedModules.map(module => module.id),
    selectedModules,
    skippedModules,
    excludedModules,
    targetAdapterId: scaffoldPlan ? scaffoldPlan.adapter.id : null,
    targetRoot: scaffoldPlan ? scaffoldPlan.targetRoot : null,
    installStatePath: scaffoldPlan ? scaffoldPlan.installStatePath : null,
    operations: scaffoldPlan ? scaffoldPlan.operations : [],
  };
}

module.exports = {
  DEFAULT_REPO_ROOT,
  SUPPORTED_INSTALL_TARGETS,
  getManifestPaths,
  loadInstallManifests,
  listInstallComponents,
  listInstallModules,
  listInstallProfiles,
  resolveInstallPlan,
};
