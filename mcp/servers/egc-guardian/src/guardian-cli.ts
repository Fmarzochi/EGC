#!/usr/bin/env node
import fs from 'node:fs';
import { validateCommand, validateCommittedScriptCommand, validateWrite } from './validator.js';
import { scanForInjection } from './prompt-injection-scanner.js';
import { llmRoute, keywordRoute } from './llm-router.js';
import { detectIntent, digestTranscript, mineTranscript } from './intuition.js';
import { autoLearn } from './learn-writer.js';

// Thin CLI over the guardian engine so harness hooks can enforce the same
// rules the MCP tools expose, without requiring the MCP server to be running.
// Output is a single JSON line on stdout; the process always exits 0 and the
// caller decides how to act on the verdict.

const MAX_ROUTE_ITEMS = { agents: 3, skills: 5 };

// One command of a batch, and whether it was read out of a script committed
// in git and unchanged since (`committed[i]` in the payload: exactly true, or
// an object whose `bound` maps the variables that script sets to the values
// it sets them to), which holds it to the grave denials only. `dirs`
// (`cwds[i]`) are the directories the command can run in, when the line
// moves before it; otherwise it runs where the batch does.
interface BatchEntry {
  command: string;
  committed: { bound: Record<string, string[]> } | null;
  dirs: string[] | null;
  // The variables the line that runs the command sets (`bound[i]`), each
  // with every literal value it takes: a target spelled with one of them is
  // judged by the files those values name. Null when the payload named
  // bindings this reader could not take, which refuses the entry.
  bound: Record<string, string[]> | null;
}

// A map of variable names to their values, or null for any other shape.
function boundMap(given: unknown): Record<string, string[]> | null {
  if (given === null || typeof given !== 'object' || Array.isArray(given)) return null;
  // No prototype, so a variable named `__proto__` is kept like any other.
  const bound = Object.create(null) as Record<string, string[]>;
  for (const [name, values] of Object.entries(given)) {
    if (!Array.isArray(values) || !values.every((value): value is string => typeof value === 'string')) return null;
    bound[name] = values;
  }
  return bound;
}

// The line bindings of one entry: an index into the table of maps the
// payload carries, or a map itself; null for anything else, which refuses
// the entry rather than judging it without its bindings.
function lineBoundAt(given: unknown, table: unknown[]): Record<string, string[]> | null {
  return boundMap(typeof given === 'number' ? table[given] : given);
}

const MALFORMED_BOUND: ReturnType<typeof validateCommand> = {
  allowed: false,
  reason: 'malformed line bindings in the command-batch payload',
  trust_level: 'DANGEROUS',
  advisory: false,
};

function batchDirs(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.every((dir): dir is string => typeof dir === 'string') ? value : null;
}

// A marker of any other shape is not one: the entry is judged as typed,
// under every rule.
function committedMark(flag: unknown): BatchEntry['committed'] {
  if (flag === true) return { bound: {} };
  if (flag === null || typeof flag !== 'object' || Array.isArray(flag)) return null;
  const bound = boundMap((flag as { bound?: unknown }).bound);
  return bound === null ? null : { bound };
}

function batchEntries(values: unknown[], committed: unknown, cwds?: unknown, lineBound?: unknown, boundTable?: unknown): BatchEntry[] {
  const flags = Array.isArray(committed) ? committed : [];
  const places = Array.isArray(cwds) ? cwds : [];
  // A payload without `bound` predates the bindings: every entry is judged
  // as typed. One with it must name readable bindings for every entry.
  const bounds = Array.isArray(lineBound) ? lineBound : null;
  const table = Array.isArray(boundTable) ? boundTable : [];
  return values
    .map((value, i) => ({ command: value, committed: committedMark(flags[i]), dirs: batchDirs(places[i]), bound: bounds === null ? {} : lineBoundAt(bounds[i], table) }))
    .filter((entry): entry is BatchEntry => typeof entry.command === 'string');
}

// A command that can run in several directories is refused if it is
// refused in any of them, one read out of a committed script as well.
function judgeEntry(entry: BatchEntry, cwd: string | undefined): ReturnType<typeof validateCommand> {
  if (entry.bound === null) return MALFORMED_BOUND;
  const { committed } = entry;
  const judge = (dir: string | undefined) => (committed ? validateCommittedScriptCommand(entry.command, dir, committed.bound, entry.bound) : validateCommand(entry.command, dir, entry.bound));
  const verdicts = (entry.dirs ?? [cwd]).map(judge);
  return verdicts.find(verdict => !verdict.allowed && !verdict.advisory) ?? verdicts.find(verdict => !verdict.allowed) ?? verdicts[0];
}

function commandBatch(payload: string): unknown {
  let entries: BatchEntry[] = [];
  let cwd: string | undefined;
  try {
    const parsed = JSON.parse(payload);
    if (Array.isArray(parsed)) {
      // Legacy shape: a bare array of command strings, no cwd available.
      entries = batchEntries(parsed, undefined);
    } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.commands)) {
      entries = batchEntries(parsed.commands, parsed.committed, parsed.cwds, parsed.bound, parsed.bounds);
      if (typeof parsed.cwd === 'string') cwd = parsed.cwd;
    }
  } catch {
    return [{ allowed: false, reason: 'malformed command-batch payload', trust_level: 'DANGEROUS' }];
  }
  if (entries.length === 0) {
    // Fail closed: an empty verdict array reads to the caller as "nothing to
    // check", which allows the batch through instead of blocking it. The
    // only caller (pre-bash-guardian-validate.js) already short-circuits
    // before ever sending an empty batch on purpose, so this is never a
    // false positive -- it only fires for malformed JSON (caught above) or
    // valid JSON in an unrecognized shape ({}, {"commands": "not an array"},
    // a bare string/number, etc.), both of which used to fall through here
    // silently.
    return [{ allowed: false, reason: 'malformed command-batch payload', trust_level: 'DANGEROUS' }];
  }
  return entries.map(entry => judgeEntry(entry, cwd));
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
  let jsonl: string;
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
  'content': payload => scanForInjection(payload),
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

try {
  await main();
} catch (err) {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
}
