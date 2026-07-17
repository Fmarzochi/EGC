#!/usr/bin/env node

const path = require('node:path');
const {
  installPluginFromDir,
  installPluginFromNpm,
  listInstalledPlugins,
  getInstalledPlugin,
  removePlugin,
  updatePlugin,
} = require('./lib/plugin-registry');

function showHelp() {
  console.log(`
EGC Plugin Registry — Install, list, remove, or update EGC plugins

Usage:
  egc plugin install <name> [--source <path>]
  egc plugin list
  egc plugin remove <name>
  egc plugin update [<name>]

Commands:
  install    Install a plugin from npm or local path
  list       Show all installed plugins
  remove     Uninstall a plugin
  update     Reinstall a plugin (or all plugins if no name given)

Options:
  --source   Install from a local directory path instead of npm

Examples:
  egc plugin install egc-plugin-docker
  egc plugin install my-plugin --source ./my-plugin
  egc plugin list
  egc plugin remove egc-plugin-docker
  egc plugin update egc-plugin-docker
  egc plugin update
`);
}

async function handleInstall(args) {
  const pluginName = args[1];
  if (!pluginName) {
    console.error('Error: Usage: egc plugin install <name> [--source <path>]');
    process.exit(1);
  }

  const sourceIdx = args.indexOf('--source');
  let result;

  if (sourceIdx !== -1 && args[sourceIdx + 1]) {
    const sourcePath = path.resolve(args[sourceIdx + 1]);
    if (!require('node:fs').existsSync(sourcePath)) {
      console.error(`Error: Source path does not exist: ${sourcePath}`);
      process.exit(1);
    }
    console.log(`Installing plugin "${pluginName}" from ${sourcePath}...`);
    result = installPluginFromDir(sourcePath, pluginName);
  } else {
    console.log(`Installing plugin "${pluginName}" from npm...`);
    result = installPluginFromNpm(pluginName, pluginName);
  }

  if (result.success) {
    console.log(`Plugin "${pluginName}" v${result.plugin.version} installed.`);
    if (result.plugin.skills.length) {
      console.log(`  Skills: ${result.plugin.skills.join(', ')}`);
    }
    if (result.plugin.agents.length) {
      console.log(`  Agents: ${result.plugin.agents.join(', ')}`);
    }
    if (result.plugin.rules.length) {
      console.log(`  Rules: ${result.plugin.rules.join(', ')}`);
    }
  } else {
    console.error(`Failed to install plugin "${pluginName}":`);
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }
}

function handleList() {
  const plugins = listInstalledPlugins();
  if (plugins.length === 0) {
    console.log('No plugins installed.');
    console.log('Install one with: egc plugin install <name>');
    process.exit(0);
  }

  console.log(`Installed plugins (${plugins.length}):\n`);
  for (const p of plugins) {
    console.log(`  ${p.name}`);
    console.log(`    Version:    ${p.version}`);
    console.log(`    Description: ${p.description || '-'}`);
    console.log(`    Installed:  ${p.installedAt}`);
    if (p.skills.length) console.log(`    Skills:     ${p.skills.join(', ')}`);
    if (p.agents.length) console.log(`    Agents:     ${p.agents.join(', ')}`);
    if (p.rules.length) console.log(`    Rules:      ${p.rules.join(', ')}`);
    console.log('');
  }
}

function handleRemove(args) {
  const pluginName = args[1];
  if (!pluginName) {
    console.error('Error: Usage: egc plugin remove <name>');
    process.exit(1);
  }

  const existing = getInstalledPlugin(pluginName);
  if (!existing) {
    console.error(`Plugin "${pluginName}" is not installed.`);
    process.exit(1);
  }

  const result = removePlugin(pluginName);
  if (result.success) {
    console.log(`Plugin "${pluginName}" removed.`);
  } else {
    console.error(`Failed to remove plugin: ${result.errors.join(', ')}`);
    process.exit(1);
  }
}

function handleUpdate(args) {
  const pluginName = args[1];

  if (pluginName) {
    const existing = getInstalledPlugin(pluginName);
    if (!existing) {
      console.error(`Plugin "${pluginName}" is not installed.`);
      process.exit(1);
    }
    console.log(`Updating plugin "${pluginName}"...`);
    const result = updatePlugin(pluginName);
    if (result.success) {
      console.log(`Plugin "${pluginName}" updated.`);
    } else {
      console.error(`Failed to update plugin: ${result.errors.join(', ')}`);
      process.exit(1);
    }
  } else {
    const { reinstallAllPlugins } = require('./lib/plugin-registry');
    console.log('Updating all plugins...');
    const results = reinstallAllPlugins();
    let ok = 0;
    let fail = 0;
    for (const r of results) {
      if (r.success) {
        console.log(`  \u2713 ${r.name}`);
        ok++;
      } else {
        console.log(`  \u2717 ${r.name}: ${(r.errors || []).join(', ')}`);
        fail++;
      }
    }
    console.log(`\n${ok} updated, ${fail} failed`);
    if (fail > 0) process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(3);
  const firstArg = args[0];

  if (!firstArg || firstArg === '--help' || firstArg === '-h') {
    showHelp();
    process.exit(0);
  }

  switch (firstArg) {
    case 'install':
      await handleInstall(args);
      break;

    case 'list':
      handleList();
      break;

    case 'remove':
      handleRemove(args);
      break;

    case 'update':
      handleUpdate(args);
      break;

    default:
      console.error(`Unknown plugin subcommand: ${firstArg}`);
      showHelp();
      process.exit(1);
  }
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
