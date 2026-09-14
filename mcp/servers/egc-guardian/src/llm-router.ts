import { CATALOG } from './catalog-index.js';
import { scanForInjection } from './prompt-injection-scanner.js';


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
  // Function words of Portuguese and Spanish prompts, which otherwise collide with fragments of English descriptions.
  'com', 'para', 'por', 'que', 'nao', 'uma', 'das', 'dos', 'nos', 'nas', 'mais', 'como', 'esse', 'essa', 'isso', 'meu', 'minha', 'seu', 'sua', 'voce', 'ele', 'ela', 'aqui', 'onde', 'quando', 'sobre', 'entre', 'sem', 'tem', 'ser', 'esta', 'sao', 'foi', 'bom', 'dia', 'faz', 'fazer', 'vamos', 'agora', 'depois', 'antes', 'tudo', 'todo', 'toda', 'cada', 'ainda', 'tambem', 'muito', 'pouco', 'bem', 'assim', 'entao', 'mas', 'pela', 'pelo', 'con', 'los', 'las', 'del', 'pero', 'este', 'eso', 'muy', 'hacer', 'ahora',
]);

// A light stem so "tests" meets "test" and "linting" meets "lint": the same
// reduction is applied to prompts and to entries, so both sides agree.
function stem(token: string): string {
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

export function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .split(/[\s,.\-_/()[\]{}|:;!?'"]+/)
      .filter(t => t.length > 2 && !STOP_WORDS.has(t))
      .map(stem)
  );
}

interface CatalogFields {
  name: Set<string>;
  triggers: Set<string>;
  description: Set<string>;
}

// The catalog is immutable at runtime, so an entry's token sets never change.
// Memoize them per entry object (weakly keyed so ad-hoc entries stay GC-able)
// instead of re-tokenizing all ~400 catalog entries on every routing query.
const entryFieldsCache = new WeakMap<object, CatalogFields>();

function fieldsFor(entry: { name: string; description: string; triggers?: string }): CatalogFields {
  let fields = entryFieldsCache.get(entry);
  if (!fields) {
    fields = { name: tokenize(entry.name), triggers: tokenize(entry.triggers ?? ''), description: tokenize(entry.description) };
    entryFieldsCache.set(entry, fields);
  }
  return fields;
}

// Inverse document frequency over the catalog: a token most entries share
// weighs little, a token few entries carry weighs a lot. A token the catalog
// does not know keeps a weight of one.
let idfCache: Map<string, number> | null = null;

function inverseFrequency(total: number, count: number): number {
  return Math.log((total + 1) / (count + 1)) + 1;
}

function idfFor(): Map<string, number> {
  if (idfCache) return idfCache;
  const documentFrequency = new Map<string, number>();
  for (const entry of CATALOG) {
    const fields = fieldsFor(entry);
    for (const token of new Set([...fields.name, ...fields.triggers, ...fields.description])) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  const total = CATALOG.length;
  idfCache = new Map();
  for (const [token, count] of documentFrequency) idfCache.set(token, inverseFrequency(total, count));
  return idfCache;
}

// Both bars follow the size of the catalog: rare means carried by at most
// one entry in sixty, and a pair of matches must weigh at least twice a
// token carried by one entry in ten.
const RARE_SHARE = 60;
const PAIR_SHARE = 10;

function thresholds(): { rareIdf: number; minScore: number } {
  const total = CATALOG.length;
  return {
    rareIdf: inverseFrequency(total, Math.max(2, Math.floor(total / RARE_SHARE))),
    minScore: 2 * inverseFrequency(total, Math.max(1, Math.floor(total / PAIR_SHARE))),
  };
}

const NAME_WEIGHT = 2;
const TRIGGER_WEIGHT = 1;
const DESCRIPTION_WEIGHT = 1;
// A candidate needs a discriminating match: two distinct tokens whose
// weights add up, or one rare token (carried by few entries). A word half the
// catalog shares never clears the bar on its own, whatever field it hits.
const MIN_DISTINCT_MATCHES = 2;
const RELATIVE_CUTOFF = 0.35;

export function keywordScore(
  promptTokens: Set<string>,
  entry: { name: string; description: string; triggers?: string },
): number {
  const fields = fieldsFor(entry);
  const idf = idfFor();
  let score = 0;
  let matched = 0;
  let rarest = 0;
  for (const token of promptTokens) {
    const weight = idf.get(token) ?? 1;
    let field = 0;
    if (fields.name.has(token)) field = NAME_WEIGHT;
    else if (fields.triggers.has(token)) field = TRIGGER_WEIGHT;
    else if (fields.description.has(token)) field = DESCRIPTION_WEIGHT;
    if (field === 0) continue;
    score += field * weight;
    matched += 1;
    rarest = Math.max(rarest, weight);
  }
  const bar = thresholds();
  const discriminating = (matched >= MIN_DISTINCT_MATCHES && score >= bar.minScore) || rarest >= bar.rareIdf;
  return discriminating ? Math.round(score * 100) / 100 : 0;
}

function pickCandidates(promptTokens: Set<string>) {
  return CATALOG
    .map(e => ({ ...e, score: keywordScore(promptTokens, e) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES);
}

const MAX_DESCRIPTION_CHARS = 200;

// The text with every format character (Unicode Cf: zero-width joiners
// and spaces, bidi marks, invisible operators, the byte order mark) removed,
// every control character (Cc) turned into a space and runs of whitespace
// collapsed: one line of printable text, so a description can neither open
// a second catalog line nor split a word the scan looks for.
function printable(text: string): string {
  let out = '';
  for (const ch of text) {
    if (/\p{Cf}/u.test(ch)) continue;
    out += /\p{Cc}/u.test(ch) ? ' ' : ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}

// A catalog description as the router's prompt carries it: one bounded line
// of printable text, and never a description that reads as an instruction
// to the model (the catalog is data the router chooses from, not text that
// steers it). An entry whose description is withheld keeps its name, so it
// can still be chosen by name.
export function promptDescription(description: string): string {
  const line = printable(description);
  // Both spellings are scanned: the original catches invisible characters
  // clustered around a keyword, the printable line catches the keyword
  // they were splitting.
  if (scanForInjection(description).length > 0 || scanForInjection(line).length > 0) return '[description withheld]';

  return line.length > MAX_DESCRIPTION_CHARS ? `${line.slice(0, MAX_DESCRIPTION_CHARS - 3)}...` : line;
}

export function buildCatalogBlock(
  candidates: Array<{ kind: string; name: string; description: string }>,
): string {
  return candidates.map(e => `${e.kind}:${printable(e.name)} - ${promptDescription(e.description)}`).join('\n');
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
    // Same span the previous greedy regex captured (first "{" through last
    // "}"), without the super-linear backtracking on adversarial input.
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end < start) return null;
    return JSON.parse(raw.slice(start, end + 1));
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

// Sending a task prompt to a third-party provider is an explicit choice, not
// a side effect of having a key in the environment: EGC_LLM_ROUTING must be
// switched on as well.
export function llmRoutingEnabled(): boolean {
  const flag = (process.env.EGC_LLM_ROUTING || '').trim().toLowerCase();
  return flag === '1' || flag === 'on' || flag === 'true' || flag === 'yes';
}

export function hasProviderKey(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
    || process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY
  );
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

  const top = Math.max(0, ...Object.values(scores));
  const ranked = [...CATALOG]
    .filter(e => (scores[e.name] ?? 0) > 0 && (scores[e.name] ?? 0) >= top * RELATIVE_CUTOFF)
    .sort((a, b) => (scores[b.name] ?? 0) - (scores[a.name] ?? 0));

  return {
    agents: ranked.filter(e => e.kind === 'agent').slice(0, MAX_AGENTS_OUT).map(e => e.name),
    skills: ranked.filter(e => e.kind === 'skill' || e.kind === 'rule').slice(0, MAX_SKILLS_OUT).map(e => e.name),
    scores,
    rejected: [],
  };
}
