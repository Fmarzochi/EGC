#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const GIT_BIN = [
  '/usr/bin/git',
  '/usr/local/bin/git',
  '/opt/homebrew/bin/git',
  String.raw`C:\Program Files\Git\cmd\git.exe`,
].find(candidate => fs.existsSync(candidate)) || 'git';

const LINTED_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts']);
const SKIPPED_SEGMENTS = new Set(['build', 'dist']);
const RELAUNCH_MARKER = 'EGC_PREFLIGHT_MODULE_PATH';
const USAGE = 'Usage: npm run preflight [-- --base <ref>]';

function git(args, cwd) {
  return execFileSync(GIT_BIN, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function parseArgs(argv) {
  const options = { base: 'origin/main', defaultProject: null };
  const flags = { '--base': 'base', '--default-project': 'defaultProject' };
  for (let index = 0; index < argv.length; index++) {
    const key = flags[argv[index]];
    if (!key || !argv[index + 1]) throw new Error(`unknown argument ${argv[index]}. ${USAGE}`);
    options[key] = argv[++index];
  }
  return options;
}

function mainCheckoutOf(root) {
  const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], root).trim();
  return path.basename(commonDir) === '.git' ? path.dirname(commonDir) : root;
}

function sharedNodeModules(root, mainCheckout) {
  if (fs.existsSync(path.join(root, 'node_modules'))) return null;
  const candidate = path.join(mainCheckout, 'node_modules');
  return fs.existsSync(candidate) ? candidate : null;
}

function relaunchWithSharedModules(nodeModules) {
  if (!nodeModules || process.env[RELAUNCH_MARKER] === '1') return null;
  const nodePath = [nodeModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  const result = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, NODE_PATH: nodePath, [RELAUNCH_MARKER]: '1' },
  });
  return result.status ?? 2;
}

function resolveFrom(request, searchPaths) {
  try {
    return require.resolve(request, { paths: searchPaths });
  } catch {
    return null;
  }
}

function sonarConfigs(searchPaths) {
  const resolved = resolveFrom('eslint-plugin-sonarjs', searchPaths);
  if (!resolved) return [];
  const loaded = require(resolved);
  const recommended = (loaded.default || loaded).configs?.recommended;
  return recommended ? [recommended] : [];
}

function isLintable(relativePath) {
  if (!LINTED_EXTENSIONS.has(path.extname(relativePath))) return false;
  return !relativePath.split('/').some(segment => SKIPPED_SEGMENTS.has(segment));
}

function changedEntries(diffOutput) {
  const tokens = diffOutput.split('\0').filter(Boolean);
  const entries = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index];
    if (status.startsWith('R') || status.startsWith('C')) {
      entries.push({ path: tokens[index + 2], basePath: status.startsWith('R') ? tokens[index + 1] : null });
      index += 3;
    } else {
      entries.push({ path: tokens[index + 1], basePath: status.startsWith('A') ? null : tokens[index + 1] });
      index += 2;
    }
  }
  return entries;
}

function changedFiles(root, mergeBase) {
  const tracked = changedEntries(git(['diff', '-z', '--name-status', '-M', '--diff-filter=ACMR', mergeBase, '--'], root));
  const untracked = git(['ls-files', '-z', '--others', '--exclude-standard'], root)
    .split('\0')
    .filter(Boolean)
    .map(file => ({ path: file, basePath: null }));
  return [...tracked, ...untracked].filter(entry => isLintable(entry.path));
}

function ruleOf(message) {
  if (message.ruleId) return message.ruleId;
  return message.fatal ? 'parse-error' : 'eslint';
}

function keyOf(message) {
  return `${ruleOf(message)}\u0000${message.message}`;
}

function splitFindings(headMessages, baseMessages) {
  const remaining = new Map();
  for (const message of baseMessages) remaining.set(keyOf(message), (remaining.get(keyOf(message)) || 0) + 1);
  const added = [];
  const existing = [];
  for (const message of [...headMessages].sort((a, b) => (a.line || 0) - (b.line || 0))) {
    const left = remaining.get(keyOf(message)) || 0;
    if (left > 0) {
      remaining.set(keyOf(message), left - 1);
      existing.push(message);
    } else {
      added.push(message);
    }
  }
  return { added, existing };
}

function isProjectServiceError(message) {
  return Boolean(message.fatal) && /project service|allowDefaultProject|not included in the project/i.test(message.message);
}

async function lintText(engine, text, filePath) {
  const results = await engine.lintText(text, { filePath, warnIgnored: false });
  return results.flatMap(result => result.messages);
}

function lintInDefaultProject(root, relativePath) {
  const result = spawnSync(process.execPath, [__filename, '--default-project', relativePath], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

async function defaultProjectMessages(ESLint, root, overrideConfig, relativePath) {
  const filePath = path.join(root, relativePath);
  const resolved = await new ESLint({ cwd: root, overrideConfig }).calculateConfigForFile(filePath);
  const parserOptions = resolved?.languageOptions?.parserOptions || {};
  const service = typeof parserOptions.projectService === 'object' ? parserOptions.projectService : {};
  const fromRoot = path.relative(parserOptions.tsconfigRootDir || root, filePath).split(path.sep).join('/');
  const projectService = { ...service, allowDefaultProject: [...(service.allowDefaultProject || []), fromRoot] };
  const engine = new ESLint({
    cwd: root,
    overrideConfig: [...overrideConfig, { files: [relativePath], languageOptions: { parserOptions: { projectService } } }],
  });
  const messages = await lintText(engine, fs.readFileSync(filePath, 'utf8'), filePath);
  return messages.map(({ ruleId, message, line, fatal }) => ({ ruleId, message, line, fatal }));
}

function readBase(root, mergeBase, basePath) {
  if (!basePath) return null;
  try {
    return git(['show', `${mergeBase}:${basePath}`], root);
  } catch {
    return null;
  }
}

async function headMessages(engine, root, relativePath) {
  const filePath = path.join(root, relativePath);
  const messages = await lintText(engine, fs.readFileSync(filePath, 'utf8'), filePath);
  if (!messages.some(isProjectServiceError)) return messages;
  return lintInDefaultProject(root, relativePath) || messages;
}

async function checkFile(engine, root, mergeBase, entry) {
  const base = readBase(root, mergeBase, entry.basePath);
  const head = await headMessages(engine, root, entry.path);
  const baseMessages = base === null ? [] : await lintText(engine, base, path.join(root, entry.path));
  const { added, existing } = splitFindings(head, baseMessages);
  const describe = message => `${entry.path}:${message.line || 0} ${ruleOf(message)} ${message.message}`;
  return { added: added.map(describe), existing: existing.map(describe) };
}

function printSection(title, lines) {
  if (lines.length === 0) return;
  console.log(`\n${title}:`);
  for (const line of lines) console.log(line);
}

function mergeBaseOf(root, base) {
  try {
    return git(['merge-base', 'HEAD', base], root).trim();
  } catch {
    throw new Error(`no merge base with ${base}; run git fetch origin first`);
  }
}

function loadLinting(root, mainCheckout) {
  const searchPaths = [root, mainCheckout, __dirname];
  const eslintPath = resolveFrom('eslint', searchPaths);
  if (!eslintPath) throw new Error('ESLint is not installed here or in the main checkout; run npm ci first');
  return { ESLint: require(eslintPath).ESLint, sonar: sonarConfigs(searchPaths) };
}

async function report(ESLint, sonar, root, options) {
  const mergeBase = mergeBaseOf(root, options.base);
  const files = changedFiles(root, mergeBase);
  const mode = sonar.length > 0 ? 'eslint.config.js + eslint-plugin-sonarjs recommended' : 'eslint.config.js only (eslint-plugin-sonarjs is not installed)';
  console.log(`preflight: ${files.length} changed file(s) against ${options.base} (${mergeBase.slice(0, 8)}), rules: ${mode}`);

  const engine = new ESLint({ cwd: root, overrideConfig: sonar });
  const added = [];
  const existing = [];
  for (const entry of files) {
    const findings = await checkFile(engine, root, mergeBase, entry);
    added.push(...findings.added);
    existing.push(...findings.existing);
  }

  printSection('Findings this branch adds', added);
  printSection('Findings already at the merge base (informational)', existing);
  console.log(added.length > 0 ? `\npreflight: ${added.length} new finding(s)` : '\npreflight: no new findings');
  return added.length > 0 ? 1 : 0;
}

async function run(options) {
  const root = git(['rev-parse', '--show-toplevel'], process.cwd()).trim();
  const mainCheckout = mainCheckoutOf(root);
  const relaunched = relaunchWithSharedModules(sharedNodeModules(root, mainCheckout));
  if (relaunched !== null) return relaunched;

  const { ESLint, sonar } = loadLinting(root, mainCheckout);
  if (options.defaultProject) {
    process.stdout.write(JSON.stringify(await defaultProjectMessages(ESLint, root, sonar, options.defaultProject)));
    return 0;
  }
  return report(ESLint, sonar, root, options);
}

if (require.main === module) {
  Promise.resolve()
    .then(() => run(parseArgs(process.argv.slice(2))))
    .then(code => { process.exitCode = code; })
    .catch(error => {
      console.error(`preflight: ${error.message}`);
      process.exitCode = 2;
    });
}

module.exports = { changedEntries, isLintable, parseArgs, splitFindings };
