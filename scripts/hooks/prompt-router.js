#!/usr/bin/env node
/**
 * Guardian Prompt Router Hook (UserPromptSubmit)
 *
 * Injects component recommendations into context on every user prompt.
 *
 * Routing modes (EGC_ROUTING_MODE):
 *   catalog (default) - in-session routing: a local scorer shortlists
 *     catalog candidates the tool has installed and the session model
 *     makes the final pick by intent, in the prompt's own language. No
 *     network, no API key, and nothing is offered that is not installed.
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
const os = require('node:os');
const path = require('node:path');

const { resolveGuardianCli, callGuardian } = require('../lib/guardian-bin');
const { runStandalone } = require('../lib/hook-io');
const { installedComponentSources, splitByInstallation, INSTALL_HINT } = require('../lib/routing-installed');

const KEYWORD_TIMEOUT_MS = 3000;
const LLM_TIMEOUT_MS = 8000;
const MIN_PROMPT_LENGTH = 12;
const ROUTING_MODE_ENV = 'EGC_ROUTING_MODE';
const SKILL_INDEX_PATH_ENV = 'EGC_SKILL_INDEX_PATH';
const MAX_SKILL_CANDIDATES = 5;
const MAX_AGENT_CANDIDATES = 2;
const MAX_MISSING_NAMED = 4;
const MAX_DESCRIPTION_LENGTH = 110;
// A candidate needs a discriminating match: two distinct tokens whose
// weights add up, or one rare token (carried by few entries). A word half the
// catalog shares never clears this bar on its own, whatever field it hits.
// Both bars follow the size of the index: rare means carried by at most one
// entry in sixty, and a pair of matches must weigh at least twice a token
// carried by one entry in six.
const RARE_SHARE = 60;
const PAIR_SHARE = 6;
const MIN_DISTINCT_MATCHES = 2;
const RELATIVE_CUTOFF = 0.35;
const NAME_WEIGHT = 3;
const TRIGGER_WEIGHT = 1;
const DESCRIPTION_WEIGHT = 1;

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'when', 'what', 'which', 'your', 'you', 'can', 'will',
  'use', 'used', 'using', 'all', 'any', 'are', 'its', 'into', 'about', 'more', 'also', 'each', 'other', 'these',
  'their', 'they', 'has', 'have', 'had', 'does', 'did', 'but', 'not', 'then', 'than', 'how', 'who', 'where',
  'patterns', 'best', 'practices', 'support', 'building', 'robust', 'production', 'user', 'wants', 'asks',
  // Function words of Portuguese and Spanish prompts, which otherwise collide with fragments of English descriptions.
  'com', 'para', 'por', 'que', 'nao', 'uma', 'das', 'dos', 'nos', 'nas', 'mais', 'como', 'esse', 'essa', 'isso', 'meu', 'minha', 'seu', 'sua', 'voce', 'ele', 'ela', 'aqui', 'onde', 'quando', 'sobre', 'entre', 'sem', 'tem', 'ser', 'esta', 'sao', 'foi', 'bom', 'dia', 'faz', 'fazer', 'vamos', 'agora', 'depois', 'antes', 'tudo', 'todo', 'toda', 'cada', 'ainda', 'tambem', 'muito', 'pouco', 'bem', 'assim', 'entao', 'mas', 'pela', 'pelo', 'con', 'los', 'las', 'del', 'pero', 'este', 'eso', 'muy', 'hacer', 'ahora',
]);

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

// A light stem so "tests" meets "test" and "linting" meets "lint": the same
// reduction is applied to prompts and to entries, so both sides agree.
function stem(token) {
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

function tokenize(text) {
  const tokens = new Set();
  for (const token of String(text).toLowerCase().match(/[a-z0-9]{3,}/g) || []) {
    if (!STOP_WORDS.has(token)) tokens.add(stem(token));
  }
  return tokens;
}

function entryFields(entry) {
  return {
    name: tokenize(entry.name),
    triggers: tokenize(entry.triggers || ''),
    description: tokenize(entry.description),
  };
}

// Inverse document frequency over the index: a token shared by most of the
// catalog weighs little, a token few entries carry weighs a lot.
function inverseFrequency(total, count) {
  return Math.log((total + 1) / (count + 1)) + 1;
}

function buildIdf(fields) {
  const documentFrequency = new Map();
  for (const entry of fields) {
    const seen = new Set([...entry.name, ...entry.triggers, ...entry.description]);
    for (const token of seen) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
  }
  const total = fields.length;
  const idf = new Map();
  for (const [token, count] of documentFrequency) idf.set(token, inverseFrequency(total, count));
  return idf;
}

function thresholdsFor(total) {
  return {
    rareIdf: inverseFrequency(total, Math.max(2, Math.floor(total / RARE_SHARE))),
    minScore: 2 * inverseFrequency(total, Math.max(1, Math.floor(total / PAIR_SHARE))),
  };
}

function scoreFields(promptTokens, fields, idf, thresholds) {
  let score = 0;
  let matched = 0;
  let rarest = 0;
  for (const token of promptTokens) {
    const weight = idf.get(token);
    if (!weight) continue;
    let field = 0;
    if (fields.name.has(token)) field = NAME_WEIGHT;
    else if (fields.triggers.has(token)) field = TRIGGER_WEIGHT;
    else if (fields.description.has(token)) field = DESCRIPTION_WEIGHT;
    if (field === 0) continue;
    score += field * weight;
    matched += 1;
    rarest = Math.max(rarest, weight);
  }
  const discriminating = (matched >= MIN_DISTINCT_MATCHES && score >= thresholds.minScore) || rarest >= thresholds.rareIdf;
  return discriminating ? score : 0;
}

function shorten(text, limit) {
  const value = String(text);
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function rankEntries(entries, promptTokens) {
  const usable = entries.filter(entry => entry && entry.name && entry.description);
  const fields = usable.map(entryFields);
  const idf = buildIdf(fields);
  const thresholds = thresholdsFor(usable.length);
  const ranked = usable
    .map((entry, index) => ({ entry, score: scoreFields(promptTokens, fields[index], idf, thresholds) }))
    .filter(ranked => ranked.score > 0)
    .sort((a, b) => b.score - a.score);
  const top = ranked.length > 0 ? ranked[0].score : 0;
  return ranked.filter(ranked => ranked.score >= top * RELATIVE_CUTOFF).map(ranked => ranked.entry);
}

function sanitizeSessionKey(value) {
  const raw = String(value || '').trim();
  return raw ? raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) : '';
}

// The inventory line is written once per session: a marker in the temp
// directory remembers that this session already saw it.
function firstPromptOfSession(input) {
  const key = sanitizeSessionKey(input?.session_id || input?.sessionId);
  if (!key) return false;
  const marker = path.join(os.tmpdir(), `egc-router-${key}.seen`);
  try {
    fs.writeFileSync(marker, '', { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

function inventoryLine(entries, installed) {
  const count = (kind, onlyInstalled) => entries.filter(entry => entry.kind === kind && (!onlyInstalled || !entry.source || installed.sources.has(entry.source))).length;
  const skills = count('skill', true);
  const agents = count('agent', true);
  const catalogSkills = count('skill', false);
  const catalogAgents = count('agent', false);
  const line = `EGC on this tool: ${skills} of ${catalogSkills} catalog skills and ${agents} of ${catalogAgents} agents installed.`;
  if (skills < catalogSkills || agents < catalogAgents) {
    return `${line} What is not installed cannot be invoked; add it with: ${INSTALL_HINT}.`;
  }
  return line;
}

function pushCandidates(lines, label, candidates) {
  if (candidates.length === 0) return;
  lines.push(label);
  for (const entry of candidates) {
    lines.push(`- ${entry.name}: ${shorten(entry.description, MAX_DESCRIPTION_LENGTH)}`);
  }
}

function routeViaCatalog(prompt, input) {
  const entries = loadSkillIndex();
  if (!entries) {
    return { indexAvailable: false, block: null };
  }

  const promptTokens = tokenize(prompt);
  const installed = installedComponentSources({ cwd: typeof input?.cwd === 'string' && input.cwd ? input.cwd : process.cwd() });
  const ranked = rankEntries(entries, promptTokens);
  const { available, missing } = splitByInstallation(ranked, installed);
  const skills = available.filter(entry => entry.kind === 'skill').slice(0, MAX_SKILL_CANDIDATES);
  const agents = available.filter(entry => entry.kind === 'agent').slice(0, MAX_AGENT_CANDIDATES);
  const missingNamed = missing.filter(entry => entry.kind === 'skill' || entry.kind === 'agent').slice(0, MAX_MISSING_NAMED);
  const inventory = installed.known && firstPromptOfSession(input) ? inventoryLine(entries, installed) : null;

  if (skills.length === 0 && agents.length === 0 && missingNamed.length === 0 && !inventory) {
    return { indexAvailable: true, block: null };
  }

  const lines = ['=== EGC Catalog (in-session routing) ==='];
  if (inventory) lines.push(inventory);
  lines.push('Route by intent: judge the task in its own words; the candidates below are a local hint, not a verdict.');
  pushCandidates(lines, installed.known ? 'Installed skills:' : 'Skills:', skills);
  pushCandidates(lines, installed.known ? 'Installed agents:' : 'Agents:', agents);
  if (missingNamed.length > 0) {
    lines.push(`Not installed for this tool (catalog only, do not invoke): ${missingNamed.map(entry => entry.name).join(', ')}. Add with: ${INSTALL_HINT}.`);
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
    const catalog = routeViaCatalog(prompt, input);
    if (catalog.indexAvailable) {
      return { exitCode: 0, stdout: catalog.block || '' };
    }
    // No installed index: keyword routing keeps older installs working.
  }

  const block = routeViaCli(prompt, mode);
  return { exitCode: 0, stdout: block || '' };
}

module.exports = { run, rankEntries, tokenize };

if (require.main === module) {
  runStandalone(run);
}
