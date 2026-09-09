'use strict';

// Summaries for the first steps of `egc init`. The cognitive bootstrap and
// the state-store bootstrap are child scripts that print one line per tool
// or per result; init used to inherit those lines as they were, so the top
// of the run read as a log while the tail was a set of check lines. These
// helpers turn each child's output into the same shape the tail uses: one
// line per step, details only when something changed or failed. They are
// pure so the tests can drive them with recorded output.

const COGNITIVE_LINE_RE = /^\s*\[cognitive\] (.+?): (.+)$/;
const ALREADY_RE = /^already configured(?: \(v(\w+)\))?$/;
const INSTALLED_RE = /^(?:memory protocol|session hooks) installed(?: \((.+)\))?$/;
const UPGRADED_RE = /^memory protocol upgraded(?: v(\w+) -> v(\d+))?(?: \((.+)\))?$/;
const ERROR_RE = /^unexpected error: (.+)$/;
const STATE_DB_OK_RE = /^\[bootstrap-state-db\] OK (.+) \((\d+) migrations?\)$/;
const STATE_DB_WARNING_RE = /^\[bootstrap-state-db\] WARNING: (.+)$/;
const STATE_DB_FAILED_RE = /^\[bootstrap-state-db\] FAILED: (.+)$/;

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function joinNames(names) {
  if (names.length <= 1) return names.join('');
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function classifyCognitiveMessage(message) {
  let match = ALREADY_RE.exec(message);
  if (match) return { status: 'up-to-date', version: /^\d+$/.test(match[1] || '') ? Number(match[1]) : null };
  match = INSTALLED_RE.exec(message);
  if (match) return { status: 'installed', path: match[1] || null };
  match = UPGRADED_RE.exec(message);
  if (match) return { status: 'upgraded', from: match[1] || null, version: match[2] ? Number(match[2]) : null, path: match[3] || null };
  match = ERROR_RE.exec(message);
  if (match) return { status: 'error', reason: match[1] };
  if (message.endsWith('skipping')) return { status: 'skipped', reason: message.replace(/: skipping$/, '') };
  return { status: 'other' };
}

// Reads the lines bootstrap-cognitive.js printed and groups the tools by
// what happened to each one. Lines that are not `[cognitive]` lines are kept
// so nothing the child said is dropped.
function summarizeCognitiveOutput(text) {
  const tools = [];
  const other = [];
  let version = null;
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const match = COGNITIVE_LINE_RE.exec(line);
    if (!match) { other.push(line.trim()); continue; }
    const [, label, message] = match;
    const info = classifyCognitiveMessage(message);
    if (info.version && (version === null || info.version > version)) version = info.version;
    tools.push({ label, message, ...info });
  }
  const byStatus = status => tools.filter(tool => tool.status === status);
  return {
    tools,
    other,
    version,
    upToDate: byStatus('up-to-date'),
    installed: byStatus('installed'),
    upgraded: byStatus('upgraded'),
    skipped: byStatus('skipped'),
    errors: byStatus('error'),
    unknown: byStatus('other'),
  };
}

// Turns the grouped result into one check line plus its detail lines.
// level: 'ok' when every detected tool carries the protocol, 'warn' when a
// tool was skipped or failed (the protocol is not in that tool), 'skip'
// when no tool was detected at all. Only a recognised "already configured"
// counts as up to date; a line the parser does not know stays visible as a
// detail instead of being counted as current.
function describeCognitiveSummary(summary) {
  const details = [];
  const versionSuffix = summary.version ? ` (v${summary.version})` : '';
  if (summary.tools.length === 0 && summary.other.length === 0) {
    return { level: 'skip', detail: 'no supported tool detected', details };
  }

  const parts = [];
  if (summary.installed.length > 0) parts.push(`installed in ${joinNames(summary.installed.map(t => t.label))}`);
  if (summary.upgraded.length > 0) parts.push(`upgraded in ${joinNames(summary.upgraded.map(t => t.label))}`);
  const changed = summary.installed.length + summary.upgraded.length;
  const settled = summary.upToDate.length;
  if (changed > 0) {
    let detail = parts.join(', ') + versionSuffix;
    if (settled > 0) detail += `; ${plural(settled, 'tool')} already up to date`;
    for (const tool of [...summary.installed, ...summary.upgraded]) details.push(`${tool.label}  ${tool.message}`);
    return finishCognitive(detail, details, summary);
  }
  if (settled > 0) {
    return finishCognitive(`${plural(settled, 'tool')} up to date${versionSuffix}`, details, summary);
  }
  return finishCognitive('nothing to update', details, summary);
}

function finishCognitive(detail, details, summary) {
  let finalLevel = 'ok';
  let finalDetail = detail;
  if (summary.skipped.length > 0) {
    finalLevel = 'warn';
    finalDetail += `; ${plural(summary.skipped.length, 'tool')} skipped`;
    for (const tool of summary.skipped) details.push(`${tool.label}  ${tool.reason}`);
  }
  if (summary.errors.length > 0) {
    finalLevel = 'warn';
    finalDetail += `; ${plural(summary.errors.length, 'tool')} failed`;
    for (const tool of summary.errors) details.push(`${tool.label}  ${tool.reason}`);
  }
  for (const tool of summary.unknown) details.push(`${tool.label}  ${tool.message}`);
  for (const line of summary.other) details.push(line);
  return { level: finalLevel, detail: finalDetail, details };
}

// Reads the stderr of bootstrap-state-db.js: one OK line with the store path
// and the migration count, a WARNING block, or a FAILED line.
function parseStateDbOutput(text) {
  const lines = String(text || '').split('\n').map(line => line.trim()).filter(Boolean);
  for (const line of lines) {
    let match = STATE_DB_OK_RE.exec(line);
    if (match) return { status: 'ok', dbPath: match[1], migrations: Number(match[2]), lines };
    match = STATE_DB_WARNING_RE.exec(line);
    if (match) return { status: 'warning', reason: match[1], lines };
    match = STATE_DB_FAILED_RE.exec(line);
    if (match) return { status: 'failed', reason: match[1], lines };
  }
  return { status: 'unknown', lines };
}

// One line for the MCP registration step from the per-target callbacks:
// registered (newly written), unchanged (both servers already present) and
// warned (the file could not be updated, with the reason).
function describeRegistration({ registered = [], unchanged = [], warned = [] }) {
  const details = [
    ...registered.map(entry => `${entry.name}  ${entry.path}`),
    ...warned.map(entry => `${entry.name}  ${entry.reason}`),
  ];
  const total = registered.length + unchanged.length + warned.length;
  if (total === 0) return { level: 'skip', detail: 'no supported tool detected', details };
  const parts = [];
  if (registered.length > 0) parts.push(`registered in ${joinNames(registered.map(entry => entry.name))}`);
  if (unchanged.length > 0) parts.push(`${plural(unchanged.length, 'tool')} already registered`);
  if (warned.length > 0) parts.push(`${plural(warned.length, 'tool')} could not be updated`);
  return { level: warned.length > 0 ? 'warn' : 'ok', detail: parts.join('; '), details };
}

module.exports = {
  summarizeCognitiveOutput,
  describeCognitiveSummary,
  parseStateDbOutput,
  describeRegistration,
  joinNames,
  plural,
};
