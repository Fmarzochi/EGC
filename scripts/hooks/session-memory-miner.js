#!/usr/bin/env node
/**
 * Guardian Session Memory Miner (SessionEnd, PreCompact)
 *
 * Extracts decisions, failures, preferences, and next steps from the
 * session transcript via the guardian CLI and merges them into the
 * project state file sections, so the semantic layer of memory no
 * longer depends on the AI calling update_state voluntarily.
 *
 * Requires a provider API key; without one the CLI reports skip and
 * nothing changes (the mechanical snapshot from egc-memory-save still
 * runs). Set EGC_MEMORY_MINER=0 to disable.
 *
 * Never blocks: on any failure the hook passes through and exits 0.
 */

'use strict';

const { spawnSync } = require('node:child_process');
const { resolveGuardianCli } = require('../lib/guardian-bin');
const { applyMinedMemory } = require('../lib/state-snapshot');
const { parseInput, runStandalone } = require('../lib/hook-io');

const MINE_TIMEOUT_MS = 15000;

function run(inputOrRaw) {
  if (/^(0|false|no)$/i.test(String(process.env.EGC_MEMORY_MINER || ''))) return { exitCode: 0 };

  const input = parseInput(inputOrRaw);
  const transcriptPath = input?.transcript_path;
  if (!transcriptPath || typeof transcriptPath !== 'string') return { exitCode: 0 };

  const cli = resolveGuardianCli();
  if (!cli) return { exitCode: 0 };

  const result = spawnSync(process.execPath, [cli, 'mine', transcriptPath], { // NOSONAR jssecurity:S8705
    encoding: 'utf8',
    timeout: MINE_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0 || !result.stdout) return { exitCode: 0 };

  let mined;
  try {
    mined = JSON.parse(result.stdout);
  } catch {
    return { exitCode: 0 };
  }
  if (!mined || mined.skip) return { exitCode: 0 };

  try {
    const projectPath = input?.cwd || process.env.PWD || process.cwd();
    applyMinedMemory(projectPath, mined);
  } catch { /* state write failure must never block session lifecycle */ }

  return { exitCode: 0 };
}

module.exports = { run };

if (require.main === module) {
  runStandalone(run);
}
