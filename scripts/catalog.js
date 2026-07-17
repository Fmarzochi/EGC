#!/usr/bin/env node

const {
  getInstallComponent,
  listInstallComponents,
  listInstallProfiles,
} = require('./lib/install-manifests');

const FAMILY_ALIASES = Object.freeze({
  baseline: 'baseline',
  baselines: 'baseline',
  language: 'language',
  languages: 'language',
  lang: 'language',
  framework: 'framework',
  frameworks: 'framework',
  capability: 'capability',
  capabilities: 'capability',
  agent: 'agent',
  agents: 'agent',
  skill: 'skill',
  skills: 'skill',
});

function showHelp(exitCode = 0) {
  console.log(`
Discover EGC install components and profiles

Usage:
  egc catalog profiles [--json]
  egc catalog components [--family <family>] [--target <target>] [--json]
  egc catalog show <component-id> [--json]

Examples:
  egc catalog profiles
  egc catalog components --family language
  egc catalog show framework:nextjs
`);

  process.exit(exitCode);
}

function normalizeFamily(value) {
  if (!value) {
    return null;
  }

  const normalized = String(value).trim().toLowerCase();
  return FAMILY_ALIASES[normalized] || normalized;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    command: null,
    componentId: null,
    family: null,
    target: null,
    json: false,
    help: false,
  };

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    parsed.help = true;
    return parsed;
  }

  parsed.command = args[0];

  let index = 1;
  while (index < args.length) {
    index = processArg(args, index, parsed) + 1;
  }

  return parsed;
}

function processArg(args, index, parsed) {
  const arg = args[index];

  if (arg === '--help' || arg === '-h') {
    parsed.help = true;
    return index;
  }
  if (arg === '--json') {
    parsed.json = true;
    return index;
  }
  if (arg === '--family') {
    if (!args[index + 1]) {
      throw new Error('Missing value for --family');
    }
    parsed.family = normalizeFamily(args[index + 1]);
    return index + 1;
  }
  if (arg === '--target') {
    if (!args[index + 1]) {
      throw new Error('Missing value for --target');
    }
    parsed.target = args[index + 1];
    return index + 1;
  }
  if (parsed.command === 'show' && !parsed.componentId) {
    parsed.componentId = arg;
    return index;
  }
  throw new Error(`Unknown argument: ${arg}`);
}

function printProfiles(profiles) {
  console.log('Install profiles:\n');
  for (const profile of profiles) {
    console.log(`- ${profile.id} (${profile.moduleCount} modules)`);
    console.log(`  ${profile.description}`);
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

function printComponent(component) {
  console.log(`Install component: ${component.id}\n`);
  console.log(`Family: ${component.family}`);
  console.log(`Targets: ${component.targets.join(', ')}`);
  console.log(`Modules: ${component.moduleIds.join(', ')}`);
  console.log(`Description: ${component.description}`);

  if (component.modules.length > 0) {
    console.log('\nResolved modules:');
    for (const module of component.modules) {
      console.log(`- ${module.id} [${module.kind}]`);
      console.log(
        `  targets=${module.targets.join(', ')} default=${module.defaultInstall} cost=${module.cost} stability=${module.stability}`
      );
      console.log(`  ${module.description}`);
    }
  }
}

function main() {
  try {
    const options = parseArgs(process.argv);

    if (options.help) {
      showHelp(0);
    }

    executeCommand(options);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

function executeCommand(options) {
  if (options.command === 'profiles') {
    handleProfiles(options);
    return;
  }

  if (options.command === 'components') {
    handleComponents(options);
    return;
  }

  if (options.command === 'show') {
    handleShow(options);
    return;
  }

  throw new Error(`Unknown catalog command: ${options.command}`);
}

function handleProfiles(options) {
  const profiles = listInstallProfiles();
  if (options.json) {
    console.log(JSON.stringify({ profiles }, null, 2));
  } else {
    printProfiles(profiles);
  }
}

function handleComponents(options) {
  const components = listInstallComponents({
    family: options.family,
    target: options.target,
  });
  if (options.json) {
    console.log(JSON.stringify({ components }, null, 2));
  } else {
    printComponents(components);
  }
}

function handleShow(options) {
  if (!options.componentId) {
    throw new Error('Catalog show requires an install component ID');
  }
  const component = getInstallComponent(options.componentId);
  if (options.json) {
    console.log(JSON.stringify(component, null, 2));
  } else {
    printComponent(component);
  }
}

main();
