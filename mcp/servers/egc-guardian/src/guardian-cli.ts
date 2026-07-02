#!/usr/bin/env node
import { validateCommand, validateWrite } from './validator.js';
import { llmRoute, keywordRoute } from './llm-router.js';

// Thin CLI over the guardian engine so harness hooks can enforce the same
// rules the MCP tools expose, without requiring the MCP server to be running.
// Output is a single JSON line on stdout; the process always exits 0 and the
// caller decides how to act on the verdict.

const MAX_ROUTE_ITEMS = { agents: 3, skills: 5 };

async function main() {
  const mode = process.argv[2];
  const payload = process.argv[3] ?? '';

  if (mode === 'command') {
    const result = validateCommand(payload);
    process.stdout.write(JSON.stringify(result));
    return;
  }

  if (mode === 'command-batch') {
    let commands: string[] = [];
    try {
      const parsed = JSON.parse(payload);
      if (Array.isArray(parsed)) commands = parsed.filter((c): c is string => typeof c === 'string');
    } catch { /* malformed batch payload: validate nothing, return empty */ }
    process.stdout.write(JSON.stringify(commands.map(c => validateCommand(c))));
    return;
  }

  if (mode === 'write') {
    const result = validateWrite(payload);
    process.stdout.write(JSON.stringify(result));
    return;
  }

  if (mode === 'route') {
    const useLlm = process.argv.includes('--llm');
    let routed: { agents: string[]; skills: string[]; provider: string } | null = null;
    if (useLlm) routed = await llmRoute(payload);
    if (!routed) {
      const kw = keywordRoute(payload);
      routed = { agents: kw.agents, skills: kw.skills, provider: 'keyword' };
    }
    process.stdout.write(JSON.stringify({
      agents: routed.agents.slice(0, MAX_ROUTE_ITEMS.agents),
      skills: routed.skills.slice(0, MAX_ROUTE_ITEMS.skills),
      provider: routed.provider,
    }));
    return;
  }

  process.stdout.write(JSON.stringify({ error: `unknown mode: ${String(mode)}` }));
}

main().catch(err => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
});
