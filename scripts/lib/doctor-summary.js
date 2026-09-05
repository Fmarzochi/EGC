'use strict';

const path = require('node:path');

// Turns a doctor JSON report into the few lines `egc init` shows: one
// headline, one line per target that needs attention, and the exact
// command to run. The full report stays with `egc doctor`.

const REINSTALL_CODES = new Set([
  'missing-target-root',
  'missing-managed-files',
  'missing-source-files',
  'invalid-install-state',
  'resolution-unavailable',
]);

function targetName(adapter = {}) {
  if (adapter.target) return adapter.target;
  return String(adapter.id || '').replace(/-(home|project)$/, '') || '<target>';
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function describeIssue(issue) {
  const message = String(issue.message || issue.code || 'unknown issue');
  if (issue.code === 'repo-version-mismatch') {
    const match = /Recorded repo version (\S+) differs from current repo version (\S+)/.exec(message);
    if (match) return `recorded version ${match[1]}, current ${match[2]}`;
  }
  if (issue.code === 'missing-target-root') {
    return message.replace(/^Target root does not exist:/, 'target folder does not exist:');
  }
  if (issue.code === 'missing-source-files') {
    return message.replace(/\s*\(run 'egc repair'[^)]*\)\s*$/, '');
  }
  return message;
}

// One line per target that needs attention, however many issues it has.
function issueLines(results) {
  const lines = [];
  for (const result of results) {
    if (result.status === 'ok') continue;
    const issues = Array.isArray(result.issues) ? result.issues : [];
    lines.push({
      adapterId: result.adapter.id,
      status: result.status,
      codes: issues.map(issue => issue.code),
      text: issues.length === 0 ? `status ${result.status}` : issues.map(describeIssue).join('; '),
    });
  }
  return lines;
}

function stateStoreNotes(stateDb, repoRoot) {
  if (!stateDb) return [];
  const notes = [];
  const consolidate = `node "${path.join(repoRoot, 'scripts', 'maintenance', 'merge-fragmented-state-dbs.js')}"`;
  if (stateDb.missing) {
    notes.push(`state store not found at ${stateDb.dbPath}; run egc init again`);
  }
  if (stateDb.cliStoreMisplaced) {
    notes.push(`the CLI event store landed in a harness directory (${stateDb.dbPath}); consolidate it with: ${consolidate}`);
  }
  if (Array.isArray(stateDb.fragments) && stateDb.fragments.length > 0) {
    notes.push(`${pluralize(stateDb.fragments.length, 'stray state.db copy', 'stray state.db copies')} left by older versions; consolidate with: ${consolidate}`);
  }
  return notes;
}

function errorCommands(results) {
  const commands = [];
  const notes = [];
  let missingRoot = false;
  for (const result of results) {
    if (result.status !== 'error') continue;
    const codes = (result.issues || []).map(issue => issue.code);
    if (codes.includes('missing-target-root')) missingRoot = true;
    if (codes.some(code => REINSTALL_CODES.has(code)) || codes.length === 0) {
      const command = `egc install --target ${targetName(result.adapter)} --profile full`;
      if (!commands.includes(command)) commands.push(command);
    }
  }
  if (missingRoot) {
    notes.push('No longer using one of these tools? Run: egc uninstall --target <name>');
  }
  return { commands, notes };
}

function headlineFor(checked, ok, warnings, errors, afterRepair) {
  if (errors > 0) {
    const tail = afterRepair ? ' still broken after automatic repair' : ' with errors';
    return `${ok} of ${checked} targets healthy, ${errors}${tail}`;
  }
  if (warnings > 0) {
    return `${ok} of ${checked} targets healthy, ${warnings} need an update`;
  }
  return `${pluralize(checked, 'target')} healthy`;
}

// options.afterRepair: the report comes from the re-check that follows the
// automatic repair, so whatever is still broken needs the person's hand.
// Counts are targets, not issues: the doctor's own summary adds up issues
// per target, which would overstate how many tools need attention.
function summarizeDoctorReport(report, options = {}) {
  const repoRoot = options.repoRoot || path.join(__dirname, '..', '..');
  const results = Array.isArray(report?.results) ? report.results : [];
  const checked = results.length;
  const ok = results.filter(result => result.status === 'ok').length;
  const warnings = results.filter(result => result.status === 'warning').length;
  const errors = results.filter(result => result.status === 'error').length;
  const notes = stateStoreNotes(report?.stateDb, repoRoot);

  if (report?.manifestError) {
    return {
      status: 'error', checked, ok, warnings, errors: Math.max(errors, 1),
      headline: `install manifests refused: ${report.manifestError}`,
      details: [], commands: [], notes,
    };
  }

  if (results.length === 0) {
    return {
      status: notes.length > 0 ? 'warning' : 'empty', bare: true, checked: 0, ok: 0, warnings: 0, errors: 0,
      headline: 'core runtime healthy; no managed target profile installed yet',
      hint: 'Managed content (rules, skills, hooks) is optional; add it for your tool anytime with:',
      details: [],
      commands: ['egc install --target <target> --profile full'],
      notes,
    };
  }

  const details = issueLines(results);

  if (errors > 0) {
    const residual = options.afterRepair ? errorCommands(results) : { commands: [], notes: [] };
    // Warnings that sit next to residual errors still have their own fix.
    const commands = options.afterRepair && warnings > 0 ? [...residual.commands, 'egc repair'] : residual.commands;
    return {
      status: 'error', checked, ok, warnings, errors,
      headline: headlineFor(checked, ok, warnings, errors, Boolean(options.afterRepair)),
      details, commands, notes: [...residual.notes, ...notes],
    };
  }

  if (warnings > 0) {
    return {
      status: 'warning', checked, ok, warnings, errors,
      headline: headlineFor(checked, ok, warnings, errors, false),
      details, commands: ['egc repair'], notes,
    };
  }

  return {
    status: notes.length > 0 ? 'warning' : 'ok', checked, ok, warnings, errors,
    headline: headlineFor(checked, ok, warnings, errors, false),
    details: [], commands: [], notes,
  };
}

// The repair JSON carries one entry per target; init needs the files it
// restored (the repair summary's repairedCount counts targets), whether
// anything stayed unrepairable, and whether a plugin reinstall failed.
function summarizeRepairResult(result) {
  const entries = Array.isArray(result?.results) ? result.results : [];
  const count = (entry, field) => (Array.isArray(entry[field]) ? entry[field].length : 0);
  const repaired = entries.reduce((total, entry) => total + count(entry, 'repairedPaths'), 0);
  const pruned = entries.reduce((total, entry) => total + count(entry, 'prunedPaths'), 0);
  const unrepairable = entries.reduce((total, entry) => total + count(entry, 'unrepairable'), 0);
  const errors = entries.filter(entry => entry.status === 'error' || entry.status === 'partial').length;
  const touched = entries.filter(entry => count(entry, 'repairedPaths') > 0 || count(entry, 'prunedPaths') > 0).length;
  const pluginFailures = (Array.isArray(result?.pluginRepairs) ? result.pluginRepairs : []).filter(plugin => !plugin.success).length;
  const parts = [];
  if (repaired > 0) parts.push(`restored ${pluralize(repaired, 'file')}`);
  if (pruned > 0) parts.push(`pruned ${pluralize(pruned, 'stale entry', 'stale entries')}`);
  if (parts.length === 0) parts.push('nothing to restore');
  let text = parts.join(', ');
  if (touched > 0) text += ` in ${pluralize(touched, 'target')}`;
  if (unrepairable > 0) text += `; ${unrepairable} unrepairable`;
  if (pluginFailures > 0) text += `; ${pluralize(pluginFailures, 'plugin reinstall')} failed`;
  return { repaired, pruned, unrepairable, errors, pluginFailures, text, failed: errors > 0 || unrepairable > 0 || pluginFailures > 0 };
}

module.exports = { summarizeDoctorReport, summarizeRepairResult, describeIssue, targetName };
