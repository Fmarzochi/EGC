import { completeJson } from './llm-router.js';

// Intent detection for the auto-intuition hook. Understanding is semantic
// only: a provider LLM classifies the message in whatever language the
// user writes. There is deliberately no phrase list; EGC is global and
// intent cannot be pre-programmed as vocabulary. Without a provider key
// this returns none and the lifecycle hooks carry the state guarantees.
// The length gate exists because session-level intent lives in short
// conversational messages; long task prompts skip classification cost.

export type Intent = 'session_end' | 'session_resume' | 'remember' | 'history_query' | 'none';

const MAX_LLM_PROMPT_CHARS = 200;

const CLASSIFIER_SYSTEM =
  'Classify the user message into exactly one intent. Respond ONLY with JSON: {"intent":"..."}. ' +
  'Intents: "session_end" (user is stopping work, saying goodbye, going to sleep), ' +
  '"session_resume" (user is greeting or asking to pick up previous work), ' +
  '"remember" (user asks to persist a decision or fact), ' +
  '"history_query" (user asks what failed or was decided before), ' +
  '"none" (anything else, including all task requests). Any language.';

const VALID_INTENTS = new Set<Intent>(['session_end', 'session_resume', 'remember', 'history_query', 'none']);

function hasProviderKey(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY ||
    process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY ||
    process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY,
  );
}

export async function detectIntent(prompt: string): Promise<{ intent: Intent; source: 'llm' | 'none' }> {
  const llmDisabled = /^(0|false|no)$/i.test(String(process.env.EGC_INTUITION_LLM || ''));
  if (llmDisabled || prompt.length > MAX_LLM_PROMPT_CHARS || !hasProviderKey()) {
    return { intent: 'none', source: 'none' };
  }

  const completion = await completeJson(CLASSIFIER_SYSTEM, `Message: "${prompt}"`, 64, 3000);
  if (!completion) return { intent: 'none', source: 'none' };

  const parsed = completion.json as { intent?: unknown };
  const intent = typeof parsed.intent === 'string' && VALID_INTENTS.has(parsed.intent as Intent)
    ? parsed.intent as Intent
    : 'none';
  return { intent, source: 'llm' };
}

const MINER_SYSTEM =
  'You extract project memory from an AI coding session transcript. Respond ONLY with JSON: ' +
  '{"decisions":[{"what":"...","why":"..."}],"avoid":[{"what":"...","why":"..."}],"preferences":["..."],"next":["..."]}. ' +
  'decisions: choices made this session. avoid: things that failed or were rejected. ' +
  'preferences: workflow or style preferences the user expressed. next: concrete items to pick up next session. ' +
  'Be terse. Max 5 items per list. Empty arrays when nothing qualifies. Use the language the user wrote in.';

const MAX_DIGEST_CHARS = 14_000;

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((c: { type?: string }) => c?.type === 'text')
    .map((c: { text?: string }) => c.text || '')
    .join(' ')
    .trim();
}

function turnOfLine(line: string): string | null {
  try {
    const entry = JSON.parse(line);
    const role = entry?.message?.role;
    if (role !== 'user' && role !== 'assistant') return null;
    const text = textOfContent(entry?.message?.content);
    return text ? `${role}: ${text.slice(0, 600)}` : null;
  } catch {
    return null;
  }
}

export function digestTranscript(jsonl: string): string {
  const turns = jsonl.split('\n')
    .filter(line => line.trim())
    .map(turnOfLine)
    .filter((t): t is string => t !== null);
  const digest = turns.join('\n');
  return digest.length > MAX_DIGEST_CHARS ? digest.slice(-MAX_DIGEST_CHARS) : digest;
}

export interface MinedMemory {
  decisions: Array<{ what: string; why?: string }>;
  avoid: Array<{ what: string; why?: string }>;
  preferences: string[];
  next: string[];
  provider: string;
}

function stringList(value: unknown, max = 5): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, max);
}

function pairList(value: unknown, max = 5): Array<{ what: string; why?: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ what: string; why?: string }> = [];
  for (const item of value) {
    if (item && typeof item === 'object' && typeof (item as { what?: unknown }).what === 'string') {
      const what = String((item as { what: string }).what).trim();
      const whyRaw = (item as { why?: unknown }).why;
      if (what) out.push({ what, ...(typeof whyRaw === 'string' && whyRaw.trim() ? { why: whyRaw.trim() } : {}) });
    }
    if (out.length >= max) break;
  }
  return out;
}

export async function mineTranscript(digest: string): Promise<MinedMemory | null> {
  if (!digest.trim() || !hasProviderKey()) return null;

  const completion = await completeJson(MINER_SYSTEM, digest, 700, 12_000);
  if (!completion) return null;

  const parsed = completion.json as Record<string, unknown>;
  const mined: MinedMemory = {
    decisions: pairList(parsed.decisions),
    avoid: pairList(parsed.avoid),
    preferences: stringList(parsed.preferences),
    next: stringList(parsed.next),
    provider: completion.provider,
  };

  const total = mined.decisions.length + mined.avoid.length + mined.preferences.length + mined.next.length;
  return total > 0 ? mined : null;
}
