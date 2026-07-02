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

interface LlmRouteResult {
  agents: string[];
  skills: string[];
  provider: string;
}

function parseJsonResponse(raw: string): { agents: string[]; skills: string[] } | null {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as { agents?: unknown; skills?: unknown };
    const agents = Array.isArray(parsed.agents) ? (parsed.agents as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    const skills = Array.isArray(parsed.skills) ? (parsed.skills as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    return { agents, skills };
  } catch {
    return null;
  }
}

function validNames(names: string[], kind: 'agent' | 'skill' | 'rule'): string[] {
  const valid = new Set(CATALOG.filter(e => e.kind === kind).map(e => e.name));
  const ruleValid = new Set(CATALOG.filter(e => e.kind === 'rule').map(e => e.name));
  return names.filter(n => valid.has(n) || (kind === 'skill' && ruleValid.has(n)));
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROUTE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function callAnthropic(key: string, userMsg: string): Promise<LlmRouteResult | null> {
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
        max_tokens: 256,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { content?: Array<{ text?: string }> };
    const text = data.content?.[0]?.text ?? '';
    const parsed = parseJsonResponse(text);
    if (!parsed) return null;
    return {
      agents: validNames(parsed.agents, 'agent').slice(0, MAX_AGENTS_OUT),
      skills: validNames(parsed.skills, 'skill').slice(0, MAX_SKILLS_OUT),
      provider: 'anthropic',
    };
  } catch { return null; }
}

async function callGemini(key: string, userMsg: string): Promise<LlmRouteResult | null> {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${key}`;
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ parts: [{ text: userMsg }] }],
        generationConfig: { maxOutputTokens: 256, responseMimeType: 'application/json' },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const parsed = parseJsonResponse(text);
    if (!parsed) return null;
    return {
      agents: validNames(parsed.agents, 'agent').slice(0, MAX_AGENTS_OUT),
      skills: validNames(parsed.skills, 'skill').slice(0, MAX_SKILLS_OUT),
      provider: 'gemini',
    };
  } catch { return null; }
}

async function callOpenAICompat(
  key: string,
  baseUrl: string,
  model: string,
  providerName: string,
  userMsg: string,
): Promise<LlmRouteResult | null> {
  try {
    const res = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 256,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMsg },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content ?? '';
    const parsed = parseJsonResponse(text);
    if (!parsed) return null;
    return {
      agents: validNames(parsed.agents, 'agent').slice(0, MAX_AGENTS_OUT),
      skills: validNames(parsed.skills, 'skill').slice(0, MAX_SKILLS_OUT),
      provider: providerName,
    };
  } catch { return null; }
}

export async function llmRoute(prompt: string): Promise<LlmRouteResult | null> {
  const promptTokens = tokenize(prompt);
  if (promptTokens.size === 0) return null;

  const candidates = pickCandidates(promptTokens);
  if (candidates.length === 0) return null;

  const userMsg = buildUserMessage(prompt, buildCatalogBlock(candidates));

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;

  if (anthropicKey) {
    const result = await callAnthropic(anthropicKey, userMsg);
    if (result) return result;
  }

  if (geminiKey) {
    const result = await callGemini(geminiKey, userMsg);
    if (result) return result;
  }

  if (openaiKey) {
    const result = await callOpenAICompat(
      openaiKey, 'https://api.openai.com/v1', 'gpt-4o-mini', 'openai', userMsg
    );
    if (result) return result;
  }

  if (openrouterKey) {
    const model = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
    const result = await callOpenAICompat(
      openrouterKey, 'https://openrouter.ai/api/v1', model, 'openrouter', userMsg
    );
    if (result) return result;
  }

  return null;
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
