import { CATALOG } from './catalog-index.js';

const ROUTE_TIMEOUT_MS = 5_000;
const MAX_CANDIDATES = 40;
const MAX_AGENTS_OUT = 5;
const MAX_SKILLS_OUT = 10;

const STOP_WORDS = new Set([
  'the','a','an','in','for','of','to','is','are','and','or','with','from',
  'on','by','as','at','be','it','its','this','that','use','used','using',
  'all','any','your','you','can','will','when','how','what','which','their',
  'they','we','has','have','had','do','does','did','but','not','no','if',
  'so','then','than','into','about','more','also','each','other','these',
  'patterns','best','practices','support','building','robust','production',
]);

export function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .split(/[\s,.\-_/()[\]{}|:;!?'"]+/)
      .filter(t => t.length > 2 && !STOP_WORDS.has(t))
  );
}

export function keywordScore(
  promptTokens: Set<string>,
  entry: { name: string; description: string },
): number {
  const entryTokens = tokenize(`${entry.name} ${entry.description}`);
  let matches = 0;
  for (const t of promptTokens) if (entryTokens.has(t)) matches++;
  return matches === 0 ? 0 : Math.round((matches / Math.sqrt(entryTokens.size)) * 100) / 100;
}

function pickCandidates(promptTokens: Set<string>) {
  return CATALOG
    .map(e => ({ ...e, score: keywordScore(promptTokens, e) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES);
}

function buildCatalogBlock(
  candidates: Array<{ kind: string; name: string; description: string }>,
): string {
  return candidates.map(e => `${e.kind}:${e.name} - ${e.description}`).join('\n');
}

const SYSTEM_PROMPT =
  'You are a routing assistant for EGC. Given a task description, select the most relevant items ' +
  'from the catalog below. Respond ONLY with valid JSON: {"agents":["..."],"skills":["..."]}. ' +
  `Max ${MAX_AGENTS_OUT} agents and ${MAX_SKILLS_OUT} skills. Only use names that appear in the catalog exactly as written.`;

function buildUserMessage(prompt: string, catalogBlock: string): string {
  return `Task: "${prompt}"\n\nCatalog:\n${catalogBlock}`;
}

function extractJsonBlock(raw: string): unknown {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function anthropicText(key: string, system: string, user: string, maxTokens: number, timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    }, timeoutMs);
    if (!res.ok) return null;
    const data = await res.json() as { content?: Array<{ text?: string }> };
    return data.content?.[0]?.text ?? null;
  } catch { return null; }
}

async function geminiText(key: string, system: string, user: string, maxTokens: number, timeoutMs: number): Promise<string | null> {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${key}`;
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: maxTokens, responseMimeType: 'application/json' },
      }),
    }, timeoutMs);
    if (!res.ok) return null;
    const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  } catch { return null; }
}

async function openAICompatText(key: string, baseUrl: string, model: string, system: string, user: string, maxTokens: number, timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    }, timeoutMs);
    if (!res.ok) return null;
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch { return null; }
}

export interface CompletionResult {
  json: unknown;
  provider: string;
}

type ProviderCall = (system: string, user: string, maxTokens: number, timeoutMs: number) => Promise<string | null>;

function providerChain(): Array<{ name: string; call: ProviderCall }> {
  const chain: Array<{ name: string; call: ProviderCall }> = [];

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    chain.push({ name: 'anthropic', call: (s, u, m, t) => anthropicText(anthropicKey, s, u, m, t) });
  }

  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (geminiKey) {
    chain.push({ name: 'gemini', call: (s, u, m, t) => geminiText(geminiKey, s, u, m, t) });
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    chain.push({ name: 'openai', call: (s, u, m, t) => openAICompatText(openaiKey, 'https://api.openai.com/v1', 'gpt-4o-mini', s, u, m, t) });
  }

  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (openrouterKey) {
    const model = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
    chain.push({ name: 'openrouter', call: (s, u, m, t) => openAICompatText(openrouterKey, 'https://openrouter.ai/api/v1', model, s, u, m, t) });
  }

  return chain;
}

export async function completeJson(
  system: string,
  user: string,
  maxTokens = 256,
  timeoutMs = ROUTE_TIMEOUT_MS,
): Promise<CompletionResult | null> {
  for (const provider of providerChain()) {
    const text = await provider.call(system, user, maxTokens, timeoutMs);
    const json = text ? extractJsonBlock(text) : null;
    if (json) return { json, provider: provider.name };
  }
  return null;
}

function validNames(names: unknown, kind: 'agent' | 'skill'): string[] {
  if (!Array.isArray(names)) return [];
  const strings = names.filter((x): x is string => typeof x === 'string');
  const valid = new Set(CATALOG.filter(e => e.kind === kind).map(e => e.name));
  const ruleValid = new Set(CATALOG.filter(e => e.kind === 'rule').map(e => e.name));
  return strings.filter(n => valid.has(n) || (kind === 'skill' && ruleValid.has(n)));
}

interface LlmRouteResult {
  agents: string[];
  skills: string[];
  provider: string;
}

export async function llmRoute(prompt: string): Promise<LlmRouteResult | null> {
  const promptTokens = tokenize(prompt);
  if (promptTokens.size === 0) return null;

  const candidates = pickCandidates(promptTokens);
  if (candidates.length === 0) return null;

  const userMsg = buildUserMessage(prompt, buildCatalogBlock(candidates));
  const completion = await completeJson(SYSTEM_PROMPT, userMsg, 256, ROUTE_TIMEOUT_MS);
  if (!completion) return null;

  const parsed = completion.json as { agents?: unknown; skills?: unknown };
  return {
    agents: validNames(parsed.agents, 'agent').slice(0, MAX_AGENTS_OUT),
    skills: validNames(parsed.skills, 'skill').slice(0, MAX_SKILLS_OUT),
    provider: completion.provider,
  };
}

export function keywordRoute(prompt: string): {
  agents: string[]; skills: string[]; scores: Record<string, number>; rejected: string[];
} {
  const promptTokens = tokenize(prompt);
  if (promptTokens.size === 0) return { agents: [], skills: [], scores: {}, rejected: [] };

  const scores: Record<string, number> = {};
  for (const entry of CATALOG) {
    scores[entry.name] = keywordScore(promptTokens, entry);
  }

  const ranked = [...CATALOG]
    .filter(e => (scores[e.name] ?? 0) > 0)
    .sort((a, b) => (scores[b.name] ?? 0) - (scores[a.name] ?? 0));

  return {
    agents: ranked.filter(e => e.kind === 'agent').slice(0, MAX_AGENTS_OUT).map(e => e.name),
    skills: ranked.filter(e => e.kind === 'skill' || e.kind === 'rule').slice(0, MAX_SKILLS_OUT).map(e => e.name),
    scores,
    rejected: [],
  };
}
