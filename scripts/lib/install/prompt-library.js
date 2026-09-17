'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { listInstallTargetAdapters } = require('../install-targets/registry');
const { commandExists: defaultCommandExists } = require('../utils');

// The prompt library goes to every tool detected on the machine: a home
// target counts as detected when its config directory exists or one of its
// commands is on PATH. Project targets are never installed from here, since
// the bare install runs from whatever directory the person happens to be in.
const HOME_TARGET_COMMANDS = Object.freeze({
  egc: ['gemini', 'agy'],
  claude: ['claude'],
  codex: ['codex'],
  opencode: ['opencode'],
  windsurf: ['windsurf'],
  amp: ['amp'],
  copilot: ['copilot'],
  zed: ['zed'],
  kiro: ['kiro'],
  junie: ['junie'],
  goose: ['goose'],
  openhands: ['openhands'],
  amazonq: ['q'],
});

const TARGET_LABELS = Object.freeze({
  egc: 'Gemini / AGY',
  claude: 'Claude Code',
  codex: 'Codex CLI',
  opencode: 'OpenCode',
  windsurf: 'Windsurf',
  amp: 'Amp',
  copilot: 'VS Code Copilot',
  zed: 'Zed',
  kiro: 'Kiro',
  junie: 'JetBrains Junie',
  goose: 'Goose',
  openhands: 'OpenHands',
  amazonq: 'Amazon Q Developer CLI',
  trae: 'Trae',
  codebuddy: 'CodeBuddy',
});

// Tools whose library still ships through a shell script of their own.
const LEGACY_LIBRARY_SCRIPTS = Object.freeze([
  { target: 'kiro', script: '.kiro/install.sh', dirs: ['.kiro'], commands: ['kiro'] },
  { target: 'trae', script: '.trae/install.sh', dirs: ['.trae', '.trae-cn'], commands: ['trae'] },
  { target: 'codebuddy', script: '.codebuddy/install.sh', dirs: ['.codebuddy'], commands: ['codebuddy'] },
]);

function labelFor(target) {
  return TARGET_LABELS[target] || target;
}

function homeAdapters(adapters) {
  return (Array.isArray(adapters) ? adapters : listInstallTargetAdapters())
    .filter(adapter => adapter.kind === 'home');
}

function detectPromptLibraryTargets({ homeDir, commandExists = defaultCommandExists, adapters } = {}) {
  const seen = new Set();
  const targets = [];
  for (const adapter of homeAdapters(adapters)) {
    if (seen.has(adapter.target)) {
      continue;
    }
    const root = adapter.resolveRoot({ homeDir });
    const commands = HOME_TARGET_COMMANDS[adapter.target] || [];
    if (fs.existsSync(root) || commands.some(command => commandExists(command))) {
      seen.add(adapter.target);
      targets.push(adapter.target);
    }
  }
  return targets;
}

function detectLegacyScripts({ homeDir, commandExists = defaultCommandExists }) {
  return LEGACY_LIBRARY_SCRIPTS.filter(entry => (
    entry.dirs.some(dir => fs.existsSync(path.join(homeDir, dir)))
    || entry.commands.some(command => commandExists(command))
  ));
}

function planPromptLibraryInstall({ homeDir, commandExists = defaultCommandExists, bashAvailable, adapters } = {}) {
  const legacy = detectLegacyScripts({ homeDir, commandExists }).map(entry => ({ target: entry.target, script: entry.script }));
  return {
    targets: detectPromptLibraryTargets({ homeDir, commandExists, adapters }),
    legacyScripts: bashAvailable ? legacy : [],
    skippedLegacyScripts: bashAvailable ? [] : legacy,
  };
}

function runPromptLibraryInstall({
  repoRoot,
  homeDir,
  commandExists = defaultCommandExists,
  bashAvailable = defaultCommandExists('bash'),
  adapters,
  spawn = spawnSync,
  log = console.log,
} = {}) {
  const plan = planPromptLibraryInstall({ homeDir, commandExists, bashAvailable, adapters });
  const installApply = path.join(repoRoot, 'scripts', 'install-apply.js');
  const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
  const installed = [];
  const failed = [];

  if (plan.targets.length === 0 && plan.legacyScripts.length === 0 && plan.skippedLegacyScripts.length === 0) {
    log('  no supported tool detected on this machine; the prompt library was not installed anywhere.');
    log("  Install a tool, then run 'egc install --target <tool> --profile full'.");
    return { installed, failed, legacyScripts: [], skippedLegacyScripts: [] };
  }

  for (const target of plan.targets) {
    log(`  installing the prompt library to ${labelFor(target)}...`);
    const result = spawn(process.execPath, [installApply, '--target', target, '--profile', 'full'], {
      cwd: repoRoot,
      env,
      stdio: 'inherit',
    });
    if (result && result.status === 0) {
      installed.push(target);
    } else {
      failed.push(target);
      log(`  note: the prompt library did not install to ${labelFor(target)}. Run 'egc install --target ${target} --profile full' to retry.`);
    }
  }

  for (const entry of plan.legacyScripts) {
    log(`  installing the prompt library to ${labelFor(entry.target)}...`);
    const result = spawn('bash', [path.join(repoRoot, ...entry.script.split('/')), homeDir], {
      cwd: repoRoot,
      env,
      stdio: 'inherit',
    });
    if (!result || result.status !== 0) {
      failed.push(entry.target);
      log(`  note: the ${labelFor(entry.target)} script did not finish. Run 'bash ${entry.script} ~' to retry.`);
    }
  }

  for (const entry of plan.skippedLegacyScripts) {
    log(`  note: ${labelFor(entry.target)} detected but bash is not available. Run manually: bash ${entry.script} ~`);
  }

  return {
    installed,
    failed,
    legacyScripts: plan.legacyScripts,
    skippedLegacyScripts: plan.skippedLegacyScripts,
  };
}

module.exports = {
  HOME_TARGET_COMMANDS,
  LEGACY_LIBRARY_SCRIPTS,
  detectPromptLibraryTargets,
  planPromptLibraryInstall,
  runPromptLibraryInstall,
};
