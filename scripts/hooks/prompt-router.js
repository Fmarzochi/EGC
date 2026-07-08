#!/usr/bin/env node
/**
 * Guardian Prompt Router Hook (UserPromptSubmit)
 *
 * Injects component recommendations into context on every user prompt.
 *
 * Routing modes (EGC_ROUTING_MODE):
 *   catalog (default) - in-session routing: a cheap local token match
 *     shortlists catalog candidates and the session model makes the final
 *     pick. No network, no API key, no false assertions.
 *   keyword - guardian CLI keyword scoring picks the components directly.
 *   llm     - guardian CLI semantic routing (needs a provider API key;
 *     falls back to keyword inside the CLI when the key is missing).
 *     EGC_ROUTING_LLM=1 is honored for backward compatibility.
 *
 * Catalog mode falls back to keyword when the skill index is not
 * installed. Never blocks: on any failure the hook stays silent, exit 0.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { resolveGuardianCli, callGuardian } = require('../lib/guardian-bin');
const { runStandalone } = require('../lib/hook-io');

const KEYWORD_TIMEOUT_MS = 3000;
const LLM_TIMEOUT_MS = 8000;
const MIN_PROMPT_LENGTH = 12;
const ROUTING_MODE_ENV = 'EGC_ROUTING_MODE';
const SKILL_INDEX_PATH_ENV = 'EGC_SKILL_INDEX_PATH';
const MAX_SKILL_CANDIDATES = 8;
const MAX_AGENT_CANDIDATES = 3;
const MAX_DESCRIPTION_LENGTH = 110;

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

function resolveMode() {
  const raw = String(process.env[ROUTING_MODE_ENV] || '').trim().toLowerCase();
  if (raw === 'catalog' || raw === 'keyword' || raw === 'llm') {
    return raw;
  }
  if (/^(1|true|yes)$/i.test(String(process.env.EGC_ROUTING_LLM || ''))) {
    return 'llm';
  }
  return 'catalog';
}

function loadSkillIndex() {
  const candidates = [process.env[SKILL_INDEX_PATH_ENV]];
  if (!/^(1|true|yes)$/i.test(String(process.env.EGC_ROUTER_DISABLE_BUNDLED_INDEX || ''))) {
    candidates.push(path.join(__dirname, '..', 'lib', 'skill-index.json'));
  }
  const files = candidates.filter(Boolean);

  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed?.entries)) {
        return parsed.entries;
      }
    } catch {
      // Try the next candidate; a missing index disables catalog mode.
    }
  }
  return null;
}

function tokenize(text) {
  return new Set(String(text).toLowerCase().match(/[a-z0-9]{3,}/g) || []);
}

function scoreEntry(promptTokens, entry) {
  let hits = 0;
  for (const token of tokenize(`${entry.name} ${entry.description}`)) {
    if (promptTokens.has(token)) {
      hits += 1;
    }
  }
  return hits;
}

function truncate(text, limit) {
  const value = String(text);
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function rankCandidates(entries, promptTokens, kind, limit) {
  return entries
    .filter(entry => entry && entry.kind === kind && entry.name && entry.description)
    .map(entry => ({ entry, score: scoreEntry(promptTokens, entry) }))
    .filter(ranked => ranked.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function routeViaCatalog(prompt) {
  const entries = loadSkillIndex();
  if (!entries) {
    return { indexAvailable: false, block: null };
  }

  const promptTokens = tokenize(prompt);
  const skills = rankCandidates(entries, promptTokens, 'skill', MAX_SKILL_CANDIDATES);
  const agents = rankCandidates(entries, promptTokens, 'agent', MAX_AGENT_CANDIDATES);
  if (skills.length === 0 && agents.length === 0) {
    return { indexAvailable: true, block: null };
  }

  const lines = ['=== EGC Catalog (in-session routing) ==='];
  lines.push('Candidate components for this prompt. Pick only what genuinely fits the task.');
  if (skills.length > 0) {
    lines.push('Skills:');
    for (const { entry } of skills) {
      lines.push(`- ${entry.name}: ${truncate(entry.description, MAX_DESCRIPTION_LENGTH)}`);
    }
  }
  if (agents.length > 0) {
    lines.push('Agents:');
    for (const { entry } of agents) {
      lines.push(`- ${entry.name}: ${truncate(entry.description, MAX_DESCRIPTION_LENGTH)}`);
    }
  }
  lines.push('If none fit, proceed without them.');

  return { indexAvailable: true, block: lines.join('\n') };
}

function routeViaCli(prompt, mode) {
  const cli = resolveGuardianCli();
  if (!cli) {
    return null;
  }

  const useLlm = mode === 'llm';
  const args = useLlm ? ['route', '--llm'] : ['route'];
  const routing = callGuardian(cli, args, prompt, useLlm ? LLM_TIMEOUT_MS : KEYWORD_TIMEOUT_MS);
  if (!routing) {
    return null;
  }

  const agents = Array.isArray(routing.agents) ? routing.agents : [];
  const skills = Array.isArray(routing.skills) ? routing.skills : [];
  if (agents.length === 0 && skills.length === 0) {
    return null;
  }

  const lines = ['=== EGC Routing ==='];
  if (skills.length > 0) lines.push(`Skills: ${skills.join(', ')}`);
  if (agents.length > 0) lines.push(`Agents: ${agents.join(', ')}`);
  lines.push('Apply the matching components above if they fit this task.');
  return lines.join('\n');
}

function run(inputOrRaw) {
  const input = parseInput(inputOrRaw);
  const prompt = input?.prompt || input?.user_prompt || '';
  if (typeof prompt !== 'string' || prompt.trim().length < MIN_PROMPT_LENGTH) {
    return { exitCode: 0, stdout: '' };
  }

  const mode = resolveMode();

  if (mode === 'catalog') {
    const catalog = routeViaCatalog(prompt);
    if (catalog.indexAvailable) {
      return { exitCode: 0, stdout: catalog.block || '' };
    }
    // No installed index: keyword routing keeps older installs working.
  }

  const block = routeViaCli(prompt, mode);
  return { exitCode: 0, stdout: block || '' };
}

module.exports = { run };

if (require.main === module) {
  runStandalone(run);
}
