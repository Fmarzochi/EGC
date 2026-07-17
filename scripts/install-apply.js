#!/usr/bin/env node
/**
 * Refactored EGC installer runtime.
 *
 * Keeps the legacy language-based install entrypoint intact while moving
 * target-specific mutation logic into testable Node code.
 */

const os = require('node:os');


const {
  SUPPORTED_INSTALL_TARGETS,
  listLegacyCompatibilityLanguages,
} = require('./lib/install-manifests');
const {
  LEGACY_INSTALL_TARGETS,
  normalizeInstallRequest,
  parseInstallArgs,
} = require('./lib/install/request');

function getHelpText() {
  const languages = listLegacyCompatibilityLanguages();

  return `
Usage: install.sh [--target <${LEGACY_INSTALL_TARGETS.join('|')}>] [--dry-run] [--json] <language> [<language> ...]
       install.sh [--target <${SUPPORTED_INSTALL_TARGETS.join('|')}>] [--dry-run] [--json] --profile <name> [--with <component>]... [--without <component>]...
       install.sh [--target <${SUPPORTED_INSTALL_TARGETS.join('|')}>] [--dry-run] [--json] --modules <id,id,...> [--with <component>]... [--without <component>]...
       install.sh [--dry-run] [--json] --config <path>

Targets (legacy language install):
  egc       (default) - Install EGC into ~/.gemini/
  cursor      - Install into ./.cursor/
  antigravity - Install into ./.agents/

Targets (profile / modules install: all supported targets):
  ${SUPPORTED_INSTALL_TARGETS.join(', ')}

Options:
  --profile <name>    Resolve and install a manifest profile
  --modules <ids>     Resolve and install explicit module IDs
  --with <component>  Include a user-facing install component
  --without <component>
                      Exclude a user-facing install component
  --config <path>     Load install intent from egc-install.json
  --dry-run    Show the install plan without copying files
  --json       Emit machine-readable plan/result JSON
  --help       Show this help text

Available languages:
${languages.map(language => `  - ${language}`).join('\n')}
`;
}

function showHelp(exitCode = 0) {
  console.log(getHelpText());
  process.exit(exitCode);
}

function printModulePlanDetails(plan) {
  if (plan.mode === 'legacy-compat') {
    console.log(`Legacy languages: ${plan.legacyLanguages.join(', ')}`);
  }
  console.log(`Profile: ${plan.profileId || '(custom modules)'}`); // NOSONAR jssecurity:S8689
  console.log(`Included components: ${plan.includedComponentIds.join(', ') || '(none)'}`);
  console.log(`Excluded components: ${plan.excludedComponentIds.join(', ') || '(none)'}`);
  console.log(`Requested modules: ${plan.requestedModuleIds.join(', ') || '(none)'}`);
  console.log(`Selected modules: ${plan.selectedModuleIds.join(', ') || '(none)'}`);
  if (plan.skippedModuleIds.length > 0) {
    console.log(`Skipped modules: ${plan.skippedModuleIds.join(', ')}`);
  }
  if (plan.excludedModuleIds.length > 0) {
    console.log(`Excluded modules: ${plan.excludedModuleIds.join(', ')}`);
  }
}

function printHumanPlan(plan, dryRun) {
  console.log(`${dryRun ? 'Dry-run install plan' : 'Applying install plan'}:\n`);
  console.log(`Mode: ${plan.mode}`);
  console.log(`Target: ${plan.target}`); // NOSONAR jssecurity:S8689
  console.log(`Adapter: ${plan.adapter.id}`);
  console.log(`Install root: ${plan.installRoot}`);
  console.log(`Install-state: ${plan.installStatePath}`);
  if (plan.mode === 'legacy') {
    console.log(`Languages: ${plan.languages.join(', ')}`);
  } else {
    printModulePlanDetails(plan);
    if (plan.selectedModuleIds.length === 0 && plan.skippedModuleIds.length > 0) {
      process.stderr.write(
        `Warning: all requested modules were skipped for target '${plan.target}'. ` +
        `The modules or their dependencies may not support this target.\n`
      );
    }
  }
  console.log(`Operations: ${plan.operations.length}`);

  if (plan.warnings.length > 0) {
    console.log('\nWarnings:');
    for (const warning of plan.warnings) {
      console.log(`- ${warning}`);
    }
  }

  console.log('\nPlanned file operations:');
  for (const operation of plan.operations) {
    console.log(`- ${operation.sourceRelativePath} -> ${operation.destinationPath}`);
  }

  if (!dryRun) {
    console.log(`\nDone. Install-state written to ${plan.installStatePath}`);
  }
}

function main() {
  try {
    const options = parseInstallArgs(process.argv);

    if (options.help) {
      showHelp(0);
    }

    const {
      findDefaultInstallConfigPath,
      loadInstallConfig,
    } = require('./lib/install/config');
    const { applyInstallPlan } = require('./lib/install-executor');
    const { createInstallPlanFromRequest } = require('./lib/install/runtime');
    const defaultConfigPath = options.configPath || options.languages.length > 0
      ? null
      : findDefaultInstallConfigPath({ cwd: process.cwd() });
    let config;
    if (options.configPath) {
      config = loadInstallConfig(options.configPath, { cwd: process.cwd() });
    } else if (defaultConfigPath) {
      config = loadInstallConfig(defaultConfigPath, { cwd: process.cwd() });
    } else {
      config = null;
    }
    const request = normalizeInstallRequest({
      ...options,
      config,
    });
    const plan = createInstallPlanFromRequest(request, {
      projectRoot: process.cwd(),
      homeDir: process.env.HOME || process.env.USERPROFILE || os.homedir(),
      claudeRulesDir: process.env.GEMINI_RULES_DIR || null,
    });

    if (options.dryRun) {
      if (options.json) {
        console.log(JSON.stringify({ dryRun: true, plan }, null, 2)); // NOSONAR jssecurity:S8689
      } else {
        printHumanPlan(plan, true);
      }
      return;
    }

    const result = applyInstallPlan(plan);

    // Regenerate the topology hot cache (runtime-map.json)
    try {
      const { discover } = require('./runtime/discovery');
      discover();
    } catch (err) {
      console.error(`Warning: Failed to regenerate topology cache: ${err.message}`);
    }

    if (options.json) {
      console.log(JSON.stringify({ dryRun: false, result }, null, 2)); // NOSONAR jssecurity:S8689
    } else {
      printHumanPlan(result, false);
    }
  } catch (error) {
    process.stderr.write(`Error: ${error.message}${getHelpText()}`);
    process.exit(1);
  }
}

main();
