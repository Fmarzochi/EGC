#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { inspectSessionTarget } = require('./lib/session-adapters/registry');

function usage() {
  console.log([
    'Usage:',
    '  node scripts/session-inspect.js <target> [--adapter <id>] [--write <output.json>]',
    '',
    'Targets:',
    '  <plan.json>          Dmux/orchestration plan file',
    '  <session-name>       Dmux session name when the coordination directory exists',
    '  claude:latest        Most recent Claude session history entry',
    '  claude:<id|alias>    Specific Claude session or alias',
    '  <session.tmp>        Direct path to a Claude session file',
    '',
    'Examples:',
    '  node scripts/session-inspect.js .claude/plan/workflow.json',
    '  node scripts/session-inspect.js workflow-visual-proof',
    '  node scripts/session-inspect.js claude:latest',
    '  node scripts/session-inspect.js claude:a1b2c3d4 --write /tmp/session.json'
  ].join('\n'));
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const target = args.find(argument => !argument.startsWith('--'));

  const adapterIndex = args.indexOf('--adapter');
  const adapterId = adapterIndex >= 0 ? args[adapterIndex + 1] : null;

  const writeIndex = args.indexOf('--write');
  const writePath = writeIndex >= 0 ? args[writeIndex + 1] : null;

  return { target, adapterId, writePath };
}

function main() {
  const { target, adapterId, writePath } = parseArgs(process.argv);

  if (!target) {
    usage();
    process.exit(1);
  }

  const snapshot = inspectSessionTarget(target, {
    cwd: process.cwd(),
    adapterId
  });
  const payload = JSON.stringify(snapshot, null, 2);

  if (writePath) {
    const absoluteWritePath = path.resolve(writePath);
    fs.mkdirSync(path.dirname(absoluteWritePath), { recursive: true });
    fs.writeFileSync(absoluteWritePath, payload + '\n', 'utf8');
  }

  console.log(payload);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[session-inspect] ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  main,
  parseArgs
};
