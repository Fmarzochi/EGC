#!/usr/bin/env node
/**
 * Guardian Auto-Intuition Hook (UserPromptSubmit)
 *
 * Detects session-level intent in every user prompt and acts on it by
 * code before the AI responds:
 *   session_end    -> saves the state snapshot, mines the transcript for
 *                     decisions when a provider key exists, and tells the
 *                     AI the state is already saved
 *   session_resume -> injects next steps and active decisions from the
 *                     project state so the AI greets with them
 *   remember       -> records the user's words verbatim into Active
 *                     Decisions before the AI even sees the prompt
 *   history_query  -> injects Do Not Repeat and Active Decisions so the
 *                     AI answers from project memory
 *
 * Intent detection is semantic only: a provider LLM classifies short
 * messages in any language, with no phrase lists. Without a provider
 * key nothing is detected and the lifecycle hooks carry the state
 * guarantees (EGC_INTUITION_LLM=0 disables the classifier).
 *
 * Never blocks: on any failure the hook stays silent and exits 0.
 */

'use strict';

const { spawnSync } = require('node:child_process');
const { resolveGuardianCli } = require('../lib/guardian-bin');
const { parseInput, runStandalone } = require('../lib/hook-io');
const {
  loadState, saveState, appendToSection, extractSection,
  writeSnapshotToDisk, applyMinedMemory,
} = require('../lib/state-snapshot');

const INTENT_TIMEOUT_MS = 6000;
const MINE_TIMEOUT_MS = 15000;
const MAX_REMEMBER_CHARS = 400;
const MAX_INJECT_CHARS = 1600;

function cliJson(cli, args, timeout) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout }); // NOSONAR jssecurity:S8705
  if (result.error || result.status !== 0 || !result.stdout) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function handleSessionEnd(cli, projectPath, transcriptPath) {
  const savedTo = writeSnapshotToDisk(projectPath);

  let minedNote = '';
  if (transcriptPath) {
    const mined = cliJson(cli, ['mine', transcriptPath], MINE_TIMEOUT_MS);
    if (mined && !mined.skip) {
      const result = applyMinedMemory(projectPath, mined);
      if (result.added > 0) minedNote = ` ${result.added} decisions and lessons from this session were extracted and merged.`;
    }
  }

  return [
    '=== EGC Session ===',
    `Project state already saved to ${savedTo}.${minedNote}`,
    'The user is ending the session: acknowledge briefly, confirm the state is saved, and do not start new work.',
  ].join('\n');
}

function handleSessionResume(projectPath) {
  const state = loadState(projectPath);
  const next = extractSection(state.content, '## Next Session');
  const decisions = extractSection(state.content, '## Active Decisions');
  if (!next && !decisions) return '';

  const parts = ['=== EGC Resume ==='];
  if (next) parts.push('Next steps:', clip(next, MAX_INJECT_CHARS));
  if (decisions) parts.push('Active decisions:', clip(decisions, MAX_INJECT_CHARS));
  parts.push('Greet the user and present these next steps from project memory.');
  return parts.join('\n');
}

function handleRemember(projectPath, prompt) {
  const state = loadState(projectPath);
  const entry = `- ${state.ts.slice(0, 10)}: ${clip(prompt.trim().replace(/\s+/g, ' '), MAX_REMEMBER_CHARS)}`;
  const result = appendToSection(state.content, '## Active Decisions', [entry]);
  if (result.added > 0) saveState(state.filePath, result.content);

  return [
    '=== EGC Memory ===',
    'The decision above was already recorded verbatim into the project state by EGC.',
    'Confirm to the user it is saved, and refine the wording via update_state if useful.',
  ].join('\n');
}

function handleHistoryQuery(projectPath) {
  const state = loadState(projectPath);
  const avoid = extractSection(state.content, '## Do Not Repeat');
  const decisions = extractSection(state.content, '## Active Decisions');
  if (!avoid && !decisions) return '';

  const parts = ['=== EGC History ==='];
  if (avoid) parts.push('Do not repeat:', clip(avoid, MAX_INJECT_CHARS));
  if (decisions) parts.push('Active decisions:', clip(decisions, MAX_INJECT_CHARS));
  parts.push('Answer the user from this project memory.');
  return parts.join('\n');
}

function run(inputOrRaw) {
  const input = parseInput(inputOrRaw);
  const prompt = input?.prompt || input?.user_prompt || '';
  if (typeof prompt !== 'string' || prompt.trim().length < 2) return { exitCode: 0, stdout: '' };

  const cli = resolveGuardianCli();
  if (!cli) return { exitCode: 0, stdout: '' };

  const detection = cliJson(cli, ['intent', prompt], INTENT_TIMEOUT_MS);
  const intent = detection?.intent;
  if (!intent || intent === 'none') return { exitCode: 0, stdout: '' };

  const projectPath = input?.cwd || process.env.PWD || process.cwd();
  const transcriptPath = typeof input?.transcript_path === 'string' ? input.transcript_path : '';

  try {
    let stdout = '';
    if (intent === 'session_end') stdout = handleSessionEnd(cli, projectPath, transcriptPath);
    else if (intent === 'session_resume') stdout = handleSessionResume(projectPath);
    else if (intent === 'remember') stdout = handleRemember(projectPath, prompt);
    else if (intent === 'history_query') stdout = handleHistoryQuery(projectPath);
    return { exitCode: 0, stdout };
  } catch {
    return { exitCode: 0, stdout: '' };
  }
}

module.exports = { run };

if (require.main === module) {
  runStandalone(run);
}
