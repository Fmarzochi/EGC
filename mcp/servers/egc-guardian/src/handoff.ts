import { Bm25Index, tokenize } from './file-ranker.js';
import { runCompressionPipeline } from './compression-pipeline.js';

export const DEFAULT_CONTEXT_BUDGET_TOKENS = 2000;
export const MIN_CONTEXT_BUDGET_TOKENS = 200;
export const MAX_CONTEXT_BUDGET_TOKENS = 32000;
export const MIN_OUTPUT_BUDGET_TOKENS = 50;
export const MAX_OUTPUT_BUDGET_TOKENS = 8000;

const CHARS_PER_TOKEN = 4;
const PARENT_SUMMARY_SHARE = 0.25;
const NEAR_DUPLICATE_JACCARD = 0.9;
const SCOPE_PATH_BOOST = 1.5;
const MIN_PARTIAL_CHUNK_TOKENS = 50;
const TRUNCATION_MARKER = '[truncated]';

export const ESTIMATION_NOTE = 'Token counts are estimates (characters / 4), not tokenizer or provider usage.';
export const OUTPUT_NOTE = 'The output budget is a prompt-level target; a hard limit exists only if the host enforces one.';

export interface HandoffChunk {
  text: string;
  source?: string;
  critical?: boolean;
}

export interface HandoffInput {
  objective: string;
  chunks?: HandoffChunk[];
  scope_paths?: string[];
  constraints?: string[];
  completion_criteria?: string[];
  parent_summary?: string;
  context_budget_tokens?: number;
  output_budget_tokens?: number;
}

export interface HandoffMetrics {
  estimation: string;
  tokens_before_estimate: number;
  tokens_after_estimate: number;
  reduction_pct: number;
  context_budget_tokens: number;
  context_tokens_used_estimate: number;
  output_budget_tokens: number | null;
  output_budget_note: string;
  chunks_received: number;
  chunks_included: number;
  chunks_excluded: number;
  chunks_truncated: number;
  critical_chunks: number;
  duplicates_removed: number;
  parent_summary_truncated: boolean;
  context_truncated: boolean;
  budget_exceeded_by_critical_tokens: number;
  actual_usage: 'not_observed';
  overhead_ms: number;
}

export interface HandoffResult {
  packet: string;
  metrics: HandoffMetrics;
  omitted_sources: string[];
  warnings: string[];
}

interface Prepared {
  index: number;
  source: string | undefined;
  critical: boolean;
  text: string;
}

export function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function truncateToTokens(text: string, tokens: number): string {
  const maxChars = Math.max(0, tokens * CHARS_PER_TOKEN - TRUNCATION_MARKER.length - 1);
  if (text.length <= tokens * CHARS_PER_TOKEN) return text;
  const slice = text.slice(0, maxChars);
  const lastBreak = slice.lastIndexOf('\n');
  const cut = lastBreak > maxChars / 2 ? slice.slice(0, lastBreak) : slice;
  return `${cut}\n${TRUNCATION_MARKER}`;
}

function resolveBudget(value: number | undefined, fallback: number | null, min: number, max: number, name: string): number | null {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function renderChunk(chunk: Prepared): string {
  const label = chunk.source ?? 'excerpt';
  const suffix = chunk.critical ? ' (critical)' : '';
  return `### ${label}${suffix}\n${chunk.text}`;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const term of a) if (b.has(term)) shared++;
  return shared / (a.size + b.size - shared);
}

function dedupe(chunks: Prepared[]): { kept: Prepared[]; removed: number } {
  // Critical chunks are examined first so a critical copy always outlives a non-critical twin.
  const ordered = [...chunks].sort((x, y) => Number(y.critical) - Number(x.critical) || x.index - y.index);
  const exact = new Set<string>();
  const keptSets: Array<Set<string>> = [];
  const kept: Prepared[] = [];
  let removed = 0;
  for (const chunk of ordered) {
    const key = chunk.text.replaceAll(/\s+/g, ' ').trim().toLowerCase();
    const terms = new Set(tokenize(chunk.text, { stem: false }));
    const isDuplicate = exact.has(key) || keptSets.some(other => jaccard(terms, other) >= NEAR_DUPLICATE_JACCARD);
    if (isDuplicate) {
      removed++;
      continue;
    }
    exact.add(key);
    keptSets.push(terms);
    kept.push(chunk);
  }
  return { kept: kept.sort((x, y) => x.index - y.index), removed };
}

function rank(chunks: Prepared[], objective: string, criteria: string[], scopePaths: string[]): Prepared[] {
  if (chunks.length === 0) return [];
  const docs = chunks.map(chunk => ({
    path: chunk.source ?? '',
    fields: { path: tokenize(chunk.source), symbols: [], keywords: [], summary: tokenize(chunk.text) },
  }));
  const index = Bm25Index.build(docs);
  const weighted = index.expand(tokenize([objective, ...criteria].join(' ')));
  const scope = new Set(scopePaths);
  const scored = chunks.map((chunk, i) => ({
    chunk,
    score: index.score(i, weighted) + (chunk.source && scope.has(chunk.source) ? SCOPE_PATH_BOOST : 0),
  }));
  return scored.sort((x, y) => y.score - x.score || x.chunk.index - y.chunk.index).map(entry => entry.chunk);
}

function list(items: string[]): string {
  return items.map(item => `- ${item}`).join('\n');
}

function responseContract(outputBudget: number | null): string {
  const target = outputBudget === null
    ? 'Keep the reply as short as the task allows.'
    : `Aim for about ${outputBudget} tokens (a target in this prompt, not an enforced limit).`;
  return [
    'Reply with these sections only:',
    '- Status: completed, partial or blocked.',
    '- Findings: material findings for this task only.',
    '- Evidence: file paths, line references, errors, test results.',
    '- Changes: each file changed, one line each.',
    '- Verification: checks run and their results.',
    '- Blockers: what is unresolved or what extra context is needed.',
    'Do not paste tool transcripts or repeat source that is already in this packet.',
    target,
  ].join('\n');
}

interface NormalizedInput {
  objective: string;
  contextBudget: number;
  outputBudget: number | null;
  received: HandoffChunk[];
  constraints: string[];
  criteria: string[];
  scopePaths: string[];
  summaryRaw: string;
}

function normalizeInput(input: HandoffInput): NormalizedInput {
  const objective = input.objective.trim();
  if (objective.length === 0) throw new RangeError('objective must not be empty');
  return {
    objective,
    contextBudget: resolveBudget(input.context_budget_tokens, DEFAULT_CONTEXT_BUDGET_TOKENS, MIN_CONTEXT_BUDGET_TOKENS, MAX_CONTEXT_BUDGET_TOKENS, 'context_budget_tokens') as number,
    outputBudget: resolveBudget(input.output_budget_tokens, null, MIN_OUTPUT_BUDGET_TOKENS, MAX_OUTPUT_BUDGET_TOKENS, 'output_budget_tokens'),
    received: input.chunks ?? [],
    constraints: input.constraints ?? [],
    criteria: input.completion_criteria ?? [],
    scopePaths: [...new Set(input.scope_paths ?? [])],
    summaryRaw: (input.parent_summary ?? '').trim(),
  };
}

function estimateInputTokens(n: NormalizedInput): number {
  return estimateTokens(n.objective)
    + n.received.reduce((sum, chunk) => sum + estimateTokens(chunk.text), 0)
    + estimateTokens(n.summaryRaw)
    + n.constraints.reduce((sum, item) => sum + estimateTokens(item), 0)
    + n.criteria.reduce((sum, item) => sum + estimateTokens(item), 0);
}

function prepareChunks(received: HandoffChunk[]): Prepared[] {
  return received
    .map((chunk, index) => ({
      index,
      source: chunk.source,
      critical: chunk.critical === true,
      text: (runCompressionPipeline([chunk.text]).chunks[0] ?? '').trim(),
    }))
    .filter(chunk => chunk.text.length > 0);
}

interface CriticalFit {
  remaining: number;
  overrun: number;
  summary: string;
  summaryTruncated: boolean;
}

function fitCriticalAndSummary(critical: Prepared[], summaryRaw: string, contextBudget: number, warnings: string[]): CriticalFit {
  const criticalTokens = critical.reduce((sum, chunk) => sum + estimateTokens(renderChunk(chunk)), 0);
  const overrun = Math.max(0, criticalTokens - contextBudget);
  if (overrun > 0) {
    warnings.push(`Critical context alone is about ${overrun} tokens over context_budget_tokens; it was kept in full. Raise the budget or trim the critical chunks.`);
  }

  let remaining = Math.max(0, contextBudget - criticalTokens);
  let summary = summaryRaw;
  let summaryTruncated = false;
  if (summary.length > 0) {
    const cap = Math.min(Math.floor(contextBudget * PARENT_SUMMARY_SHARE), remaining);
    if (estimateTokens(summary) > cap) {
      summaryTruncated = true;
      summary = cap > 0 ? truncateToTokens(summary, cap) : '';
      warnings.push(cap > 0 ? 'parent_summary was truncated to fit the budget.' : 'parent_summary was omitted: no budget was left after the critical context.');
    }
    remaining -= estimateTokens(summary);
  }
  return { remaining, overrun, summary, summaryTruncated };
}

interface OptionalFit {
  included: Prepared[];
  excluded: Prepared[];
  truncatedChunks: number;
  remaining: number;
}

function fitOptionalChunks(optional: Prepared[], remainingBudget: number): OptionalFit {
  const included: Prepared[] = [];
  const excluded: Prepared[] = [];
  let truncatedChunks = 0;
  let usedOptional = 0;
  let remaining = remainingBudget;
  for (const chunk of optional) {
    const cost = estimateTokens(renderChunk(chunk));
    if (cost <= remaining) {
      included.push(chunk);
      remaining -= cost;
      usedOptional += cost;
    } else if (usedOptional === 0 && remaining >= MIN_PARTIAL_CHUNK_TOKENS) {
      const partial = { ...chunk, text: truncateToTokens(chunk.text, remaining - estimateTokens(renderChunk({ ...chunk, text: '' }))) };
      included.push(partial);
      truncatedChunks++;
      usedOptional += remaining;
      remaining = 0;
    } else {
      excluded.push(chunk);
    }
  }
  return { included, excluded, truncatedChunks, remaining };
}

interface PacketParts {
  objective: string;
  scope: string[];
  constraints: string[];
  summary: string;
  included: Prepared[];
  omittedSources: string[];
  criteria: string[];
  outputBudget: number | null;
  warnings: string[];
}

function buildPacket(parts: PacketParts): string {
  const sections: string[] = [`# Handoff\n\n## Objective\n${parts.objective}`];
  if (parts.scope.length > 0) sections.push(`## Scope\n${list(parts.scope)}`);
  if (parts.constraints.length > 0) sections.push(`## Constraints and decisions to preserve\n${list(parts.constraints)}`);
  if (parts.summary.length > 0) sections.push(`## Parent summary\n${parts.summary}`);
  if (parts.included.length > 0) sections.push(`## Context\n${parts.included.map(renderChunk).join('\n\n')}`);
  if (parts.omittedSources.length > 0) sections.push(`## Not included, read on demand\n${list(parts.omittedSources)}`);
  if (parts.criteria.length > 0) sections.push(`## Completion criteria\n${list(parts.criteria)}`);
  sections.push(`## Response format\n${responseContract(parts.outputBudget)}`);
  if (parts.warnings.length > 0) sections.push(`## Handoff notes\n${list(parts.warnings)}`);
  return sections.join('\n\n');
}

export function prepareHandoff(input: HandoffInput): HandoffResult {
  const started = performance.now();
  const n = normalizeInput(input);
  const warnings: string[] = [];
  const tokensBefore = estimateInputTokens(n);

  const prepared = prepareChunks(n.received);
  const { kept, removed: duplicatesRemoved } = dedupe(prepared);
  const critical = kept.filter(chunk => chunk.critical);
  const optional = rank(kept.filter(chunk => !chunk.critical), n.objective, n.criteria, n.scopePaths);

  const criticalFit = fitCriticalAndSummary(critical, n.summaryRaw, n.contextBudget, warnings);
  const { included: optionalIncluded, excluded, truncatedChunks, remaining } = fitOptionalChunks(optional, criticalFit.remaining);
  if (excluded.length > 0) warnings.push(`${excluded.length} lower-ranked chunk(s) did not fit the budget; their sources are listed for on-demand reading.`);
  if (truncatedChunks > 0) warnings.push(`${truncatedChunks} chunk(s) were cut to fit the budget.`);

  const included = [...critical, ...optionalIncluded];
  const includedSources = new Set(included.map(chunk => chunk.source).filter((s): s is string => Boolean(s)));
  const omittedSources = [...new Set(excluded.map(chunk => chunk.source).filter((s): s is string => Boolean(s) && !includedSources.has(s as string)))];
  const scope = [...new Set([...n.scopePaths, ...includedSources])];

  const packet = buildPacket({
    objective: n.objective,
    scope,
    constraints: n.constraints,
    summary: criticalFit.summary,
    included,
    omittedSources,
    criteria: n.criteria,
    outputBudget: n.outputBudget,
    warnings,
  });

  const tokensAfter = estimateTokens(packet);
  return {
    packet,
    omitted_sources: omittedSources,
    warnings,
    metrics: {
      estimation: ESTIMATION_NOTE,
      tokens_before_estimate: tokensBefore,
      tokens_after_estimate: tokensAfter,
      reduction_pct: tokensBefore === 0 ? 0 : Math.round((1 - tokensAfter / tokensBefore) * 100),
      context_budget_tokens: n.contextBudget,
      context_tokens_used_estimate: Math.max(0, n.contextBudget - remaining),
      output_budget_tokens: n.outputBudget,
      output_budget_note: OUTPUT_NOTE,
      chunks_received: n.received.length,
      chunks_included: included.length,
      chunks_excluded: excluded.length,
      chunks_truncated: truncatedChunks,
      critical_chunks: critical.length,
      duplicates_removed: duplicatesRemoved,
      parent_summary_truncated: criticalFit.summaryTruncated,
      context_truncated: criticalFit.summaryTruncated || truncatedChunks > 0 || excluded.length > 0,
      budget_exceeded_by_critical_tokens: criticalFit.overrun,
      actual_usage: 'not_observed',
      overhead_ms: Math.round((performance.now() - started) * 100) / 100,
    },
  };
}
