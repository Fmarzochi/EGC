'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listInstallTargetAdapters, planInstallTargetScaffold } = require('./install-targets/registry');

const TABLE_RELATIVE_PATH = path.join('manifests', 'tool-paths.json');
const DOC_RELATIVE_PATH = path.join('docs', 'spec', 'tool-paths.md');
const OVERRIDE_VARIABLES = ['XDG_CONFIG_HOME', 'CRUSH_GLOBAL_CONFIG', 'KIMI_CODE_HOME', 'TRAE_ENV'];

function loadToolPaths(repoRoot) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, TABLE_RELATIVE_PATH), 'utf8'));
}

function rowVariant(row) {
  return row.variant || 'default';
}

function rowMatches(row, destination) {
  if (row.path.endsWith('/')) {
    return destination === row.path.slice(0, -1) || destination.startsWith(row.path);
  }
  return destination === row.path;
}

function findRow(rows, adapterId, variantId, destination) {
  let best = null;
  for (const row of rows) {
    if (row.adapter !== adapterId) continue;
    const variant = rowVariant(row);
    if (variant !== 'default' && variant !== variantId) continue;
    if (!rowMatches(row, destination)) continue;
    if (!best || row.path.length > best.path.length) best = row;
  }
  return best;
}

function toTablePath(destination, roots) {
  const resolved = path.resolve(destination);
  for (const [prefix, root] of roots) {
    const base = path.resolve(root);
    if (resolved === base) return prefix;
    if (resolved.startsWith(base + path.sep)) {
      return `${prefix}/${path.relative(base, resolved).split(path.sep).join('/')}`;
    }
  }
  return resolved.split(path.sep).join('/');
}

function withPlatformAndEnv(platform, env, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const saved = Object.fromEntries(OVERRIDE_VARIABLES.map(name => [name, process.env[name]]));
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  for (const name of OVERRIDE_VARIABLES) delete process.env[name];
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
    for (const name of OVERRIDE_VARIABLES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

function planAdapterDestinations({ repoRoot, adapter, modules, homeDir, projectRoot }) {
  const targetModules = modules.filter(module => module.targets.includes(adapter.target));
  const plan = planInstallTargetScaffold({ target: adapter.id, repoRoot, projectRoot, homeDir, modules: targetModules });
  return [
    ...plan.operations.map(operation => operation.destinationPath),
    plan.installStatePath,
    ...(plan.legacyInstallStatePaths || []),
  ].filter(Boolean);
}

function variantEnv(variant, scratch) {
  const env = {};
  const placeholders = [];
  for (const [name, value] of Object.entries(variant.env || {})) {
    if (value.startsWith('$')) {
      const dir = path.join(scratch, name.toLowerCase());
      env[name] = dir;
      placeholders.push([value, dir]);
    } else {
      env[name] = value;
    }
  }
  return { env, placeholders };
}

// Plans every registered adapter in every variant of the table and returns
// the planned paths no row covers and the rows no planned path reaches.
function checkToolPathsContract({ repoRoot, table = loadToolPaths(repoRoot), adapters = listInstallTargetAdapters() }) {
  const modules = JSON.parse(fs.readFileSync(path.join(repoRoot, 'manifests', 'install-modules.json'), 'utf8')).modules;
  const unmatched = [];
  const hit = new Set();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-tool-paths-'));
  try {
    const homeDir = path.join(scratch, 'home');
    const projectRoot = path.join(scratch, 'project');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    for (const variant of table.variants) {
      const { env, placeholders } = variantEnv(variant, scratch);
      const roots = [...placeholders, ['~', homeDir], ['<project>', projectRoot]];
      const selected = adapters.filter(adapter => !variant.adapters || variant.adapters.includes(adapter.id));
      withPlatformAndEnv(variant.platform, env, () => {
        for (const adapter of selected) {
          for (const destination of planAdapterDestinations({ repoRoot, adapter, modules, homeDir, projectRoot })) {
            const tablePath = toTablePath(destination, roots);
            const row = findRow(table.rows, adapter.id, variant.id, tablePath);
            if (row) hit.add(row);
            else unmatched.push({ adapter: adapter.id, variant: variant.id, path: tablePath });
          }
        }
      });
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const unhit = table.rows.filter(row => !hit.has(row));
  return { unmatched: dedupe(unmatched), unhit };
}

function dedupe(entries) {
  const seen = new Set();
  return entries.filter(entry => {
    const key = `${entry.adapter}|${entry.variant}|${entry.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeCell(value) {
  return String(value).replaceAll('|', String.raw`\|`);
}

function renderToolPathsMarkdown(table) {
  const lines = [
    '# Install paths per tool',
    '',
    `Generated from \`manifests/tool-paths.json\` by \`node scripts/ci/generate-tool-paths-doc.js\`; edit the table, not this file. \`tests/ci/tool-paths-contract.test.js\` plans every install target in every variant below and fails when a planned path is missing from the table or a row of the table matches no planned path. Sources checked on ${table.checkedOn}.`,
    '',
    'Status: **documented** paths are read by the tool per the linked docs; **egc** paths are files of EGC itself under the tool root (hook scripts, install state, library copies the tool does not load); **unverified** paths are planned today but not confirmed by the tool\'s current docs, with the reason in the note.',
    '',
    '## Variants',
    '',
    '| Variant | Platform | Environment | Adapters |',
    '| --- | --- | --- | --- |',
  ];
  for (const variant of table.variants) {
    const env = Object.entries(variant.env || {})
      .map(([name, value]) => (value.startsWith('$') ? `\`${name}\` set to a directory, shown as \`${value}\` in the paths` : `\`${name}=${value}\``))
      .join(', ') || 'none';
    lines.push(`| ${variant.id} | ${variant.platform} | ${env} | ${variant.adapters ? variant.adapters.join(', ') : 'all'} |`);
  }
  const adapters = [...new Set(table.rows.map(row => row.adapter))];
  for (const adapter of adapters) {
    lines.push('', `## ${adapter}`, '', '| Surface | Path | Variant | Status | Source | Note |', '| --- | --- | --- | --- | --- | --- |');
    for (const row of table.rows.filter(candidate => candidate.adapter === adapter)) {
      const source = row.source ? `<${row.source}>` : '';
      lines.push(`| ${row.surface} | \`${row.path}\` | ${rowVariant(row)} | ${row.status} | ${source} | ${escapeCell(row.note || '')} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

module.exports = {
  DOC_RELATIVE_PATH,
  TABLE_RELATIVE_PATH,
  checkToolPathsContract,
  findRow,
  loadToolPaths,
  renderToolPathsMarkdown,
};
