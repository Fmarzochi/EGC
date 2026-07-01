'use strict';

const fs = require('fs');
const path = require('path');
const { getStateDir, detectBranch, resolveStateRead, resolveStateWrite } = require('../lib/branch-state');

const MARKER_RE = /^- \[session-snapshot [^\]]+\]\n?/gm;

function updateTimestamp(content, ts) {
  if (/^updated: /m.test(content)) {
    return content.replace(/^updated: .*/m, `updated: ${ts}`);
  }
  return content.replace(/^(project: [^\n]*\n(?:branch: [^\n]*\n)?)/m, `$1updated: ${ts}\n`);
}

function injectSessionMarker(content, ts) {
  const marker = `- [session-snapshot ${ts}]`;
  const withoutStale = content.replace(MARKER_RE, '');
  if (/^## Next Session$/m.test(withoutStale)) {
    return withoutStale.replace(/^(## Next Session\n)/m, `$1${marker}\n`);
  }
  return withoutStale + `\n## Next Session\n${marker}\n`;
}

function buildSkeleton(projectPath, branch, ts) {
  return [
    '# Project State',
    `project: ${projectPath}`,
    ...(branch ? [`branch: ${branch}`] : []),
    `updated: ${ts}`,
    '',
    '## Context',
    '',
    '## Active Decisions',
    '',
    '## Do Not Repeat',
    '',
    '## Preferences',
    '',
    '## Next Session',
    '',
  ].join('\n');
}

function writeSnapshotToDisk() {
  const projectPath = process.env.PWD || process.cwd();
  const branch = detectBranch(projectPath);
  const stateDir = getStateDir(process.env.HOME);
  const resolved = resolveStateRead(stateDir, projectPath, branch);
  const filePath = resolveStateWrite(stateDir, projectPath, branch);
  const ts = new Date().toISOString();

  let content = (resolved.source !== 'none' && fs.existsSync(resolved.filePath))
    ? fs.readFileSync(resolved.filePath, 'utf-8')
    : buildSkeleton(projectPath, branch, ts);

  content = updateTimestamp(content, ts);
  content = injectSessionMarker(content, ts);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  try { fs.chmodSync(filePath, 0o600); } catch { /* chmod not supported on Windows */ }
}

function main() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (_) { process.stdout.write('{}'); process.exit(0); }

  let input = {};
  try { input = JSON.parse(raw); } catch (_) { process.stdout.write(raw); process.exit(0); }

  // Direct write: guaranteed snapshot regardless of AI or tool availability.
  // Non-fatal: a write failure must never block the session from stopping.
  try { writeSnapshotToDisk(); } catch (_) { /* non-fatal */ }

  // Prompt: lets a cooperative AI enrich the snapshot with synthesized
  // decisions, preferences, and next steps via update_state.
  const prompt =
    'Call update_state via the egc-memory MCP tool with the decisions, '
    + 'preferences, and next steps from this session. '
    + 'project_path is optional: omit it and it uses PWD automatically.';

  process.stdout.write(JSON.stringify(Object.assign({}, input, { promptForAssistant: prompt })));
  process.exit(0);
}

main();
