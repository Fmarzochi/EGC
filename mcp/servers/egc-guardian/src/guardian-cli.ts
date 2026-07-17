#!/usr/bin/env node
import fs from 'node:fs';
import { validateCommand, validateWrite } from './validator.js';
import { llmRoute, keywordRoute } from './llm-router.js';
import { detectIntent, digestTranscript, mineTranscript } from './intuition.js';
import { autoLearn } from './learn-writer.js';

// Thin CLI over the guardian engine so harness hooks can enforce the same
// rules the MCP tools expose, without requiring the MCP server to be running.
// Output is a single JSON line on stdout; the process always exits 0 and the
// caller decides how to act on the verdict.

const MAX_ROUTE_ITEMS = { agents: 3, skills: 5 };

function commandBatch(payload: string): unknown {
  let commands: string[] = [];
  let cwd: string | undefined;
  try {
    const parsed = JSON.parse(payload);
    if (Array.isArray(parsed)) {
      // Legacy shape: a bare array of command strings, no cwd available.
      commands = parsed.filter((c): c is string => typeof c === 'string');
    } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.commands)) {
      commands = parsed.commands.filter((c: unknown): c is string => typeof c === 'string');
      if (typeof parsed.cwd === 'string') cwd = parsed.cwd;
    }
  } catch { /* malformed batch payload: validate nothing, return empty */ }
  return commands.map(c => validateCommand(c, cwd));
}

async function route(payload: string): Promise<unknown> {
  const useLlm = process.argv.includes('--llm');
  let routed: { agents: string[]; skills: string[]; provider: string } | null = null;
  if (useLlm) routed = await llmRoute(payload);
  if (!routed) {
    const kw = keywordRoute(payload);
    routed = { agents: kw.agents, skills: kw.skills, provider: 'keyword' };
  }
  return {
    agents: routed.agents.slice(0, MAX_ROUTE_ITEMS.agents),
    skills: routed.skills.slice(0, MAX_ROUTE_ITEMS.skills),
    provider: routed.provider,
  };
}

async function mine(payload: string): Promise<unknown> {
  let jsonl = '';
  try {
    jsonl = fs.readFileSync(payload, 'utf8'); // NOSONAR tssecurity:S8707
  } catch {
    return { skip: true, reason: 'transcript unreadable' };
  }
  const mined = await mineTranscript(digestTranscript(jsonl));
  return mined ?? { skip: true, reason: 'nothing mined or no provider key' };
}

async function learn(payload: string): Promise<unknown> {
  try {
    return await autoLearn({ project_path: payload });
  } catch (err) {
    return { skip: true, reason: err instanceof Error ? err.message : String(err) };
  }
}

const MODES: Record<string, (payload: string) => unknown> = {
  'command': payload => validateCommand(payload),
  'command-batch': commandBatch,
  'write': payload => validateWrite(payload),
  'route': route,
  'intent': payload => detectIntent(payload),
  'mine': mine,
  'learn': learn,
};

// Payload arrives on stdin, never as a command-line argument. Untrusted
// content (user prompts, commands, paths) must not flow into argv, where a
// leading dash could be parsed as a flag by this or any wrapped process.
// Only the fixed mode and literal flags travel in argv.
function readStdin(): string {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

async function main() {
  const mode = process.argv[2] ?? '';
  const payload = readStdin();
  const handler = MODES[mode];
  const result = handler ? await handler(payload) : { error: `unknown mode: ${mode}` };
  process.stdout.write(JSON.stringify(result));
}

main().catch(err => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
});
