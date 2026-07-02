#!/usr/bin/env node
/**
 * Guardian Session Auto-Learn (SessionEnd)
 *
 * Runs the guardian auto_learn miner automatically when the session
 * ends: recurring tool failures from session history become actionable
 * recommendations written to the project's AI config files, without
 * waiting for the AI to call the auto_learn MCP tool.
 *
 * auto_learn skips gracefully when no failures are found. Set
 * EGC_AUTO_LEARN=0 to disable.
 *
 * Never blocks: on any failure the hook passes through and exits 0.
 */

'use strict';

const { spawnSync } = require('node:child_process');
const { resolveGuardianCli } = require('../lib/guardian-bin');
const { runStandalone } = require('../lib/hook-io');

const LEARN_TIMEOUT_MS = 10000;

function run(_inputOrRaw) {
  if (/^(0|false|no)$/i.test(String(process.env.EGC_AUTO_LEARN || ''))) return { exitCode: 0 };

  const cli = resolveGuardianCli();
  if (!cli) return { exitCode: 0 };

  const projectPath = process.env.PWD || process.cwd();
  spawnSync(process.execPath, [cli, 'learn', projectPath], { // NOSONAR jssecurity:S8705
    encoding: 'utf8',
    timeout: LEARN_TIMEOUT_MS,
  });

  return { exitCode: 0 };
}

module.exports = { run };

if (require.main === module) {
  runStandalone(run);
}
