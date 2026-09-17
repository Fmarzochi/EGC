'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { getInstallTargetAdapter, listInstallTargetAdapters } = require('../install-targets/registry');
const { commandExists: defaultCommandExists } = require('../utils');

// The prompt library goes to every tool detected on the machine: a target
// counts as detected when one of its own directories exists or one of its
// commands is on PATH. Only targets whose default adapter installs under the
// home directory take part: the bare install runs from whatever directory
// the person happens to be in, so a project target (Amazon Q, Cursor, Trae)
// would land in the wrong place.
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
});

// Codex, Goose and OpenHands share the ~/.agents root, so that root says
// nothing about which of the three is present; each is recognized by a
// directory of its own instead.
const HOME_TARGET_DIRS = Object.freeze({
  codex: ['.codex'],
  goose: ['.config/goose'],
  openhands: ['.openhands'],
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

function homeTargets() {
  const targets = [];
  for (const adapter of listInstallTargetAdapters()) {
    if (targets.includes(adapter.target)) {
      continue;
    }
    if (getInstallTargetAdapter(adapter.target).kind === 'home') {
      targets.push(adapter.target);
    }
  }
  return targets;
}

function detectionDirs(target, homeDir) {
  const own = HOME_TARGET_DIRS[target];
  if (own) {
    return own.map(dir => path.join(homeDir, ...dir.split('/')));
  }
  return [getInstallTargetAdapter(target).resolveRoot({ homeDir })];
}

function isDetected(target, { homeDir, commandExists }) {
  return detectionDirs(target, homeDir).some(dir => fs.existsSync(dir))
    || (HOME_TARGET_COMMANDS[target] || []).some(command => commandExists(command));
}

function resolveHomeDir(homeDir) {
  return typeof homeDir === 'string' && homeDir.length > 0 ? homeDir : os.homedir();
}

function detectPromptLibraryTargets({ homeDir, commandExists = defaultCommandExists } = {}) {
  const base = resolveHomeDir(homeDir);
  return homeTargets().filter(target => isDetected(target, { homeDir: base, commandExists }));
}

function detectLegacyScripts({ homeDir, commandExists = defaultCommandExists }) {
  const base = resolveHomeDir(homeDir);
  return LEGACY_LIBRARY_SCRIPTS.filter(entry => (
    entry.dirs.some(dir => fs.existsSync(path.join(base, dir)))
    || entry.commands.some(command => commandExists(command))
  ));
}

function planPromptLibraryInstall({ homeDir, commandExists = defaultCommandExists, bashAvailable } = {}) {
  const legacy = detectLegacyScripts({ homeDir, commandExists }).map(entry => ({ target: entry.target, script: entry.script }));
  return {
    targets: detectPromptLibraryTargets({ homeDir, commandExists }),
    legacyScripts: bashAvailable ? legacy : [],
    skippedLegacyScripts: bashAvailable ? [] : legacy,
  };
}

function runPromptLibraryInstall({
  repoRoot,
  homeDir,
  commandExists = defaultCommandExists,
  bashAvailable = defaultCommandExists('bash'),
  spawn = spawnSync,
  log = console.log,
} = {}) {
  const base = resolveHomeDir(homeDir);
  const plan = planPromptLibraryInstall({ homeDir: base, commandExists, bashAvailable });
  const installApply = path.join(repoRoot, 'scripts', 'install-apply.js');
  const env = { ...process.env, HOME: base, USERPROFILE: base };
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
    if (result?.status === 0) {
      installed.push(target);
    } else {
      failed.push(target);
      log(`  note: the prompt library did not install to ${labelFor(target)}. Run 'egc install --target ${target} --profile full' to retry.`);
    }
  }

  for (const entry of plan.legacyScripts) {
    log(`  installing the prompt library to ${labelFor(entry.target)}...`);
    const result = spawn('bash', [path.join(repoRoot, ...entry.script.split('/')), base], {
      cwd: repoRoot,
      env,
      stdio: 'inherit',
    });
    if (result?.status === 0) {
      installed.push(entry.target);
    } else {
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
  HOME_TARGET_DIRS,
  LEGACY_LIBRARY_SCRIPTS,
  detectPromptLibraryTargets,
  planPromptLibraryInstall,
  runPromptLibraryInstall,
};
