#!/usr/bin/env node
/**
 * Guardian Prompt Router Hook (UserPromptSubmit)
 *
 * Routes every user prompt through the guardian catalog and injects the
 * recommended skills and agents into context, so component selection
 * happens on every prompt at the harness level.
 *
 * Keyword routing runs by default (local, no network). Set
 * EGC_ROUTING_LLM=1 to use semantic LLM routing when a provider key is
 * available; without a key it falls back to keyword automatically.
 *
 * Never blocks: on any failure the hook stays silent and exits 0.
 */

'use strict';

const { spawnSync } = require('child_process');
const { resolveGuardianCli } = require('../lib/guardian-bin');

const MAX_STDIN = 1024 * 1024;
const KEYWORD_TIMEOUT_MS = 3000;
const LLM_TIMEOUT_MS = 8000;
const MIN_PROMPT_LENGTH = 12;

function parseInput(inputOrRaw) {
  if (typeof inputOrRaw === 'string') {
    try {
      return inputOrRaw.trim() ? JSON.parse(inputOrRaw) : {};
    } catch {
      return {};
    }
  }
  return inputOrRaw && typeof inputOrRaw === 'object' ? inputOrRaw : {};
}

function routeViaCli(cli, prompt) {
  const useLlm = /^(1|true|yes)$/i.test(String(process.env.EGC_ROUTING_LLM || ''));
  const args = [cli, 'route', prompt];
  if (useLlm) args.push('--llm');

  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: useLlm ? LLM_TIMEOUT_MS : KEYWORD_TIMEOUT_MS,
  });

  if (result.error || result.status !== 0 || !result.stdout) return null;

  try {
    const routing = JSON.parse(result.stdout);
    return {
      agents: Array.isArray(routing.agents) ? routing.agents : [],
      skills: Array.isArray(routing.skills) ? routing.skills : [],
    };
  } catch {
    return null;
  }
}

function run(inputOrRaw) {
  const input = parseInput(inputOrRaw);
  const prompt = input?.prompt || input?.user_prompt || '';
  if (typeof prompt !== 'string' || prompt.trim().length < MIN_PROMPT_LENGTH) {
    return { exitCode: 0, stdout: '' };
  }

  const cli = resolveGuardianCli();
  if (!cli) return { exitCode: 0, stdout: '' };

  const routing = routeViaCli(cli, prompt);
  if (!routing || (routing.agents.length === 0 && routing.skills.length === 0)) {
    return { exitCode: 0, stdout: '' };
  }

  const lines = ['=== EGC Routing ==='];
  if (routing.skills.length > 0) lines.push(`Skills: ${routing.skills.join(', ')}`);
  if (routing.agents.length > 0) lines.push(`Agents: ${routing.agents.join(', ')}`);
  lines.push('Apply the matching components above if they fit this task.');

  return { exitCode: 0, stdout: lines.join('\n') };
}

module.exports = { run };

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (raw.length < MAX_STDIN) {
      raw += chunk.substring(0, MAX_STDIN - raw.length);
    }
  });
  process.stdin.on('end', () => {
    const result = run(raw);
    if (result.stdout) process.stdout.write(result.stdout + '\n');
    process.exit(0);
  });
}
