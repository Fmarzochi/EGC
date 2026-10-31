#!/usr/bin/env node
'use strict';

/**
 * The dependency audit the repository runs for itself.
 *
 * Dependabot alerts reach a repository through GitHub's advisory fan-out, and
 * on 23 October 2026 GitHub throttled that fan-out after it saturated alert
 * processing; the advisories of 27 to 30 October (msgpack, @hono/node-server,
 * re2js, pyasn1) produced no alert here while main still carried the
 * vulnerable versions, and each surfaced as a red lane on the next pull
 * request instead. .github/workflows/dependency-audit.yml runs this script on
 * a schedule: npm audit on every lockfile and pip-audit on the Python
 * requirements, one report, and the exit code the workflow turns into an
 * issue. tests/ci/dependency-audit.test.js covers the report and the verdict.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const USAGE = 'Usage: node scripts/ci/dependency-audit.js [--report <file>] [--sha <commit>]';

// Every manifest an advisory can turn red: the seven npm lockfiles the
// repository tracks and the hashed Python requirements the Python Tests job
// audits. Every severity counts, as it does for a Dependabot alert; the one
// exception is fuzz/, a development harness outside the published package
// whose nyc, glob 7 and minimatch 3 chain has no patched line to move to, so
// it is held to high and above.
const npmAudit = (cwd, level) => ({
  label: `npm audit: ${cwd === '.' ? '' : `${cwd}/`}package-lock.json`,
  command: 'npm',
  args: level ? ['audit', `--audit-level=${level}`] : ['audit'],
  cwd,
});

const AUDITS = Object.freeze([
  npmAudit('.'),
  npmAudit('mcp/servers/egc-guardian'),
  npmAudit('mcp/servers/egc-memory'),
  npmAudit('.opencode'),
  npmAudit('dashboard'),
  npmAudit('docker'),
  npmAudit('fuzz', 'high'),
  { label: 'pip-audit: tests/requirements.txt', command: 'pip-audit', args: ['-r', 'tests/requirements.txt'], cwd: '.' },
]);

function defaultRunner(audit) {
  const result = spawnSync(audit.command, audit.args, {
    cwd: path.join(REPO_ROOT, audit.cwd),
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: { ...process.env, NPM_CONFIG_FUND: 'false' },
  });
  if (result.error) return { status: null, output: result.error.message };
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

// One entry per audit: ok when the tool exited 0, red otherwise. A tool that
// could not run at all (status null) counts as red: a missing auditor is not
// a clean audit.
function runAudits(run = defaultRunner, audits = AUDITS) {
  const results = audits.map(audit => {
    const { status, output } = run(audit);
    return { label: audit.label, ok: status === 0, status, output: String(output || '').trim() };
  });
  return { red: results.some(result => !result.ok), results };
}

function renderReport({ red, results }, sha) {
  const lines = [
    `## Dependency audit on ${sha || 'main'}: ${red ? 'RED' : 'clean'}`,
    '',
  ];
  for (const result of results) {
    lines.push(`### ${result.ok ? 'clean' : 'RED'}: ${result.label}`);
    if (!result.ok) {
      lines.push('', '```text', result.output || `exit status ${result.status}`, '```');
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function parseArgs(argv) {
  const options = { report: null, sha: '' };
  const flags = { '--report': 'report', '--sha': 'sha' };
  for (let index = 0; index < argv.length; index += 1) {
    const key = flags[argv[index]];
    if (!key) throw new Error(`unknown argument ${argv[index]}. ${USAGE}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('-')) throw new Error(`missing value for ${argv[index]}. ${USAGE}`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function appendIfSet(file, text) {
  if (!file) return;
  fs.appendFileSync(file, text);
}

function main(argv, env = process.env, run = defaultRunner) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  const verdict = runAudits(run);
  const report = renderReport(verdict, options.sha || env.GITHUB_SHA);
  process.stdout.write(report);
  if (options.report) fs.writeFileSync(options.report, report);
  appendIfSet(env.GITHUB_STEP_SUMMARY, report);
  appendIfSet(env.GITHUB_OUTPUT, `red=${verdict.red ? 1 : 0}${os.EOL}`);
  return verdict.red ? 1 : 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { AUDITS, runAudits, renderReport, parseArgs, main };
