import { scanVolatile } from './egc-volatile-scanner.js';
import { classifyChunk } from './egc-chunk-router.js';
import { reduceJsonArray } from './egc-array-crusher.js';

// The marker the Token Crusher stamps at the start of the trailer line of
// output it already compressed (scripts/lib/crusher/engine.js keeps the
// same literal): a chunk that carries it at the start of a line is handed
// back as it is, so reduce_context never compresses the same text twice,
// while a chunk that merely quotes the marker mid-line is treated like any
// other (#1682).
export const CRUSH_MARKER = '[egc-crusher]';

export interface PipelineResult {
  chunks: string[];
  bytes_before: number;
  bytes_after: number;
  savings_pct: number;
  volatile_findings: number;
  chunks_crushed: number;
}

export function isAlreadyCrushed(chunk: string): boolean {
  return chunk.startsWith(CRUSH_MARKER) || chunk.includes(`\n${CRUSH_MARKER}`);
}

// Keeps the chunks the Crusher already compressed apart from the ones a
// later phase may still compress, each list in its original order.
export function splitAlreadyCrushed(chunks: string[]): { fresh: string[]; crushed: string[] } {
  const fresh: string[] = [];
  const crushed: string[] = [];
  for (const chunk of chunks) (isAlreadyCrushed(chunk) ? crushed : fresh).push(chunk);
  return { fresh, crushed };
}

// Scans each chunk for volatile tokens, crushes the JSON arrays, drops
// exact duplicates, and leaves a chunk the Crusher already compressed
// untouched and uncounted.
export function runCompressionPipeline(chunks: string[]): PipelineResult {
  const bytesBefore = chunks.reduce((a, c) => a + Buffer.byteLength(c, 'utf8'), 0);
  let volatileFindings = 0;
  let chunksCrushed = 0;
  const seen = new Set<string>();
  const result: string[] = [];

  for (const chunk of chunks) {
    let processed = chunk;

    if (!isAlreadyCrushed(chunk)) {
      volatileFindings += scanVolatile(chunk).length;
      if (classifyChunk(chunk) === 'json_array') {
        const reduced = reduceJsonArray(chunk);
        if (reduced !== null) {
          processed = reduced.crushed;
          chunksCrushed++;
        }
      }
    }

    // Exact-match dedup as final safety net
    const key = processed.trim();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(processed);
    }
  }

  const bytesAfter = result.reduce((a, c) => a + Buffer.byteLength(c, 'utf8'), 0);
  const savingsPct = bytesBefore === 0 ? 0 : Math.round((1 - bytesAfter / bytesBefore) * 100);

  return { chunks: result, bytes_before: bytesBefore, bytes_after: bytesAfter, savings_pct: savingsPct, volatile_findings: volatileFindings, chunks_crushed: chunksCrushed };
}
