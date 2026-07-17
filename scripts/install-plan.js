#!/usr/bin/env node
/**
 * Inspect selective-install profiles and module plans without mutating targets.
 */

const {
  listInstallComponents,
  listInstallModules,
  listInstallProfiles,
  resolveInstallPlan,
} = require('./lib/install-manifests');
const {
  findDefaultInstallConfigPath,
  loadInstallConfig,
} = require('./lib/install/config');
const { normalizeInstallRequest } = require('./lib/install/request');

function showHelp() {
  console.log(`
Inspect EGC selective-install manifests

Usage:
  node scripts/install-plan.js --list-profiles
  node scripts/install-plan.js --list-modules
  node scripts/install-plan.js --list-components [--family <family>] [--target <target>] [--json]
  node scripts/install-plan.js --profile <name> [--with <component>]... [--without <component>]... [--target <target>] [--json]
  node scripts/install-plan.js --modules <id,id,...> [--with <component>]... [--without <component>]... [--target <target>] [--json]
  node scripts/install-plan.js --config <path> [--json]

Options:
  --list-profiles     List available install profiles
  --list-modules      List install modules
  --list-components   List user-facing install components
  --family <family>   Filter listed components by family
  --profile <name>    Resolve an install profile
  --modules <ids>     Resolve explicit module IDs (comma-separated)
  --with <component>  Include a user-facing install component
  --without <component>
                      Exclude a user-facing install component
  --config <path>     Load install intent from egc-install.json
  --target <target>   Filter plan for a specific target
  --json              Emit machine-readable JSON
  --help              Show this help text
`);
}

const BOOLEAN_FLAGS = new Map([
  ['--help', 'help'],
  ['-h', 'help'],
  ['--json', 'json'],
  ['--list-profiles', 'listProfiles'],
  ['--list-modules', 'listModules'],
  ['--list-components', 'listComponents'],
]);

const VALUE_FLAGS = new Map([
  ['--family', 'family'],
  ['--profile', 'profileId'],
  ['--config', 'configPath'],
  ['--target', 'target'],
]);

const LIST_FLAGS = new Set(['--modules', '--with', '--without']);

function applyListFlag(parsed, arg, rawValue) {
  if (arg === '--modules') {
    parsed.moduleIds = rawValue.split(',').map(value => value.trim()).filter(Boolean);
    return;
  }
  const componentId = rawValue.trim();
  if (!componentId) return;
  if (arg === '--with') {
    parsed.includeComponentIds.push(componentId);
  } else {
    parsed.excludeComponentIds.push(componentId);
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    json: false,
    help: false,
    profileId: null,
    moduleIds: [],
    includeComponentIds: [],
    excludeComponentIds: [],
    configPath: null,
    target: null,
    family: null,
    listProfiles: false,
    listModules: false,
    listComponents: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (BOOLEAN_FLAGS.has(arg)) {
      parsed[BOOLEAN_FLAGS.get(arg)] = true;
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      parsed[VALUE_FLAGS.get(arg)] = args[index + 1] || null;
      index += 1;
      continue;
    }
    if (LIST_FLAGS.has(arg)) {
      applyListFlag(parsed, arg, args[index + 1] || '');
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function printProfiles(profiles) {
  console.log('Install profiles:\n');
  for (const profile of profiles) {
    console.log(`- ${profile.id} (${profile.moduleCount} modules)`);
    console.log(`  ${profile.description}`);
  }
}

function printModules(modules) {
  console.log('Install modules:\n');
  for (const module of modules) {
    console.log(`- ${module.id} [${module.kind}]`);
    console.log(
      `  targets=${module.targets.join(', ')} default=${module.defaultInstall} cost=${module.cost} stability=${module.stability}`
    );
    console.log(`  ${module.description}`);
  }
}

function printComponents(components) {
  console.log('Install components:\n');
  for (const component of components) {
    console.log(`- ${component.id} [${component.family}]`);
    console.log(`  targets=${component.targets.join(', ')} modules=${component.moduleIds.join(', ')}`);
    console.log(`  ${component.description}`);
  }
}

function printPlan(plan) {
  console.log('Install plan:\n');
  console.log(
    'Note: target filtering and operation output currently reflect scaffold-level adapter planning, not a byte-for-byte mirror of legacy install.sh copy paths.\n'
  );
  console.log(`Profile: ${plan.profileId || '(custom modules)'}`); // NOSONAR jssecurity:S8689
  console.log(`Target: ${plan.target || '(all targets)'}`); // NOSONAR jssecurity:S8689
  console.log(`Included components: ${plan.includedComponentIds.join(', ') || '(none)'}`);
  console.log(`Excluded components: ${plan.excludedComponentIds.join(', ') || '(none)'}`);
  console.log(`Requested: ${plan.requestedModuleIds.join(', ')}`);
  if (plan.targetAdapterId) {
    console.log(`Adapter: ${plan.targetAdapterId}`);
    console.log(`Target root: ${plan.targetRoot}`);
    console.log(`Install-state: ${plan.installStatePath}`);
  }
  console.log('');
  console.log(`Selected modules (${plan.selectedModuleIds.length}):`);
  for (const module of plan.selectedModules) {
    console.log(`- ${module.id} [${module.kind}]`);
  }

  if (plan.skippedModuleIds.length > 0) {
    console.log('');
    console.log(`Skipped for target ${plan.target} (${plan.skippedModuleIds.length}):`); // NOSONAR jssecurity:S8689
    for (const module of plan.skippedModules) {
      console.log(`- ${module.id} [${module.kind}]`);
    }
  }

  if (plan.excludedModuleIds.length > 0) {
    console.log('');
    console.log(`Excluded by selection (${plan.excludedModuleIds.length}):`);
    for (const module of plan.excludedModules) {
      console.log(`- ${module.id} [${module.kind}]`);
    }
  }

  if (plan.operations.length > 0) {
    console.log('');
    console.log(`Operation plan (${plan.operations.length}):`);
    for (const operation of plan.operations) {
      console.log(
        `- ${operation.moduleId}: ${operation.sourceRelativePath} -> ${operation.destinationPath} [${operation.strategy}]`
      );
    }
  }
}

function outputListing(useJson, payloadKey, items, printer) {
  if (useJson) {
    console.log(JSON.stringify({ [payloadKey]: items }, null, 2));
  } else {
    printer(items);
  }
}

function maybeHandleListing(options) {
  if (options.listProfiles) {
    outputListing(options.json, 'profiles', listInstallProfiles(), printProfiles);
    return true;
  }
  if (options.listModules) {
    outputListing(options.json, 'modules', listInstallModules(), printModules);
    return true;
  }
  if (options.listComponents) {
    const components = listInstallComponents({
      family: options.family,
      target: options.target,
    });
    outputListing(options.json, 'components', components, printComponents);
    return true;
  }
  return false;
}

function resolveInstallConfig(options) {
  if (options.configPath) {
    return loadInstallConfig(options.configPath, { cwd: process.cwd() });
  }
  const defaultConfigPath = findDefaultInstallConfigPath({ cwd: process.cwd() });
  if (defaultConfigPath) {
    return loadInstallConfig(defaultConfigPath, { cwd: process.cwd() });
  }
  return null;
}

function main() {
  try {
    const options = parseArgs(process.argv);

    if (options.help) {
      showHelp();
      process.exit(0);
    }

    if (maybeHandleListing(options)) {
      return;
    }

    const config = resolveInstallConfig(options);

    if (process.argv.length <= 2 && !config) {
      showHelp();
      process.exit(0);
    }

    const request = normalizeInstallRequest({
      ...options,
      languages: [],
      config,
    });
    const plan = resolveInstallPlan({
      profileId: request.profileId,
      moduleIds: request.moduleIds,
      includeComponentIds: request.includeComponentIds,
      excludeComponentIds: request.excludeComponentIds,
      target: request.target,
    });

    if (options.json) {
      console.log(JSON.stringify(plan, null, 2)); // NOSONAR jssecurity:S8689
    } else {
      printPlan(plan);
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
