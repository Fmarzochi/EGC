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
// the person happens to be in, so a project target (Amazon Q, Cursor) would
// land in the wrong place.
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
  kimi: ['kimi'],
});

// Codex, Goose and OpenHands share the ~/.agents root, so that root says
// nothing about which of the three is present; each is recognized by a
// directory of its own instead.
const HOME_TARGET_DIRS = Object.freeze({
  codex: ['.codex'],
  goose: ['.config/goose'],
  openhands: ['.openhands'],
});

// Trae and CodeBuddy only have project adapters, and both tools read their
// directory under the home as well. Their retired install scripts took `~`
// as the project; the loop does the same by running the project adapter with
// the home directory as the working directory.
const PROJECT_TARGETS_AT_HOME = Object.freeze({
  trae: { dirs: ['.trae', '.trae-cn'], commands: ['trae'] },
  codebuddy: { dirs: ['.codebuddy'], commands: ['codebuddy'] },
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

function labelFor(target) {
  return TARGET_LABELS[target] || target;
}

function resolveHomeDir(homeDir) {
  return typeof homeDir === 'string' && homeDir.length > 0 ? homeDir : os.homedir();
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

function detectPromptLibraryTargets({ homeDir, commandExists = defaultCommandExists } = {}) {
  const base = resolveHomeDir(homeDir);
  return homeTargets().filter(target => isDetected(target, { homeDir: base, commandExists }));
}

// The Chinese edition of Trae lives under .trae-cn. When only that edition
// is present and the environment says nothing, the install goes there.
function projectTargetEnv(target, homeDir) {
  if (target !== 'trae' || process.env.TRAE_ENV) {
    return {};
  }
  const cn = fs.existsSync(path.join(homeDir, '.trae-cn'));
  const plain = fs.existsSync(path.join(homeDir, '.trae'));
  return cn && !plain ? { TRAE_ENV: 'cn' } : {};
}

function detectProjectTargetsAtHome({ homeDir, commandExists = defaultCommandExists } = {}) {
  const base = resolveHomeDir(homeDir);
  return Object.entries(PROJECT_TARGETS_AT_HOME)
    .filter(([, entry]) => (
      entry.dirs.some(dir => fs.existsSync(path.join(base, ...dir.split('/'))))
      || entry.commands.some(command => commandExists(command))
    ))
    .map(([target]) => target);
}

function planPromptLibraryInstall({ homeDir, commandExists = defaultCommandExists } = {}) {
  return {
    targets: detectPromptLibraryTargets({ homeDir, commandExists }),
    homeProjectTargets: detectProjectTargetsAtHome({ homeDir, commandExists }),
  };
}

function runPromptLibraryInstall({
  repoRoot,
  homeDir,
  commandExists = defaultCommandExists,
  spawn = spawnSync,
  log = console.log,
} = {}) {
  const base = resolveHomeDir(homeDir);
  const plan = planPromptLibraryInstall({ homeDir: base, commandExists });
  const installApply = path.join(repoRoot, 'scripts', 'install-apply.js');
  const env = { ...process.env, HOME: base, USERPROFILE: base };
  const installed = [];
  const failed = [];

  if (plan.targets.length === 0 && plan.homeProjectTargets.length === 0) {
    log('  no supported tool detected on this machine; the prompt library was not installed anywhere.');
    log("  Install a tool, then run 'egc install --target <tool> --profile full'.");
    return { installed, failed, homeProjectTargets: [] };
  }

  const runs = [
    ...plan.targets.map(target => ({ target, cwd: repoRoot, extraEnv: {} })),
    ...plan.homeProjectTargets.map(target => ({ target, cwd: base, extraEnv: projectTargetEnv(target, base) })),
  ];
  for (const { target, cwd, extraEnv } of runs) {
    log(`  installing the prompt library to ${labelFor(target)}...`);
    const result = spawn(process.execPath, [installApply, '--target', target, '--profile', 'full'], {
      cwd,
      env: { ...env, ...extraEnv },
      stdio: 'inherit',
    });
    if (result?.status === 0) {
      installed.push(target);
    } else {
      failed.push(target);
      log(`  note: the prompt library did not install to ${labelFor(target)}. Run 'egc install --target ${target} --profile full' to retry.`);
    }
  }

  return {
    installed,
    failed,
    homeProjectTargets: plan.homeProjectTargets,
  };
}

module.exports = {
  HOME_TARGET_COMMANDS,
  HOME_TARGET_DIRS,
  PROJECT_TARGETS_AT_HOME,
  detectPromptLibraryTargets,
  detectProjectTargetsAtHome,
  planPromptLibraryInstall,
  projectTargetEnv,
  runPromptLibraryInstall,
};
