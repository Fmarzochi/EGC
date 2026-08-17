'use strict';

// Scrubber container metadata: strip AI-provenance metadata from structured
// text containers (Markdown frontmatter, HTML head, SVG). Targeted and
// conservative: only provenance keys/blocks are removed, ordinary content and
// unrelated metadata are left intact. Text in, text out; the caller runs the
// Layer A Unicode pass on the body separately.

// Frontmatter / meta keys that name an AI generation provenance (not content
// tags). Matched case-insensitively against the key name only.
const AI_PROVENANCE_KEYS = new Set([
  'generator',
  'generated_by',
  'generated-by',
  'generatedby',
  'ai_generated',
  'ai-generated',
  'aigenerated',
  'ai_model',
  'ai-model',
  'ai_provider',
  'ai-provider',
  'ai_tool',
  'ai-tool',
  'llm',
  'llm_model',
  'x_ai',
  'x-ai',
]);

function detectContainerFormat(name, text) {
  const lower = String(name || '').toLowerCase();
  if (/\.(md|markdown|mdx)$/.test(lower)) return 'markdown';
  if (/\.(html?|xhtml)$/.test(lower)) return 'html';
  if (/\.svg$/.test(lower)) return 'svg';
  // Fall back to a light content sniff for extension-less input.
  const head = String(text || '').slice(0, 512).trimStart();
  if (head.startsWith('<svg') || head.includes('<svg ')) return 'svg';
  if (/^<!doctype html|^<html|<head[\s>]/i.test(head)) return 'html';
  return null;
}

// --- Markdown -------------------------------------------------------------

function frontmatterBounds(text) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return null;
  const afterFence = text.indexOf('\n', end + 1);
  return { start: 0, bodyStart: afterFence < 0 ? text.length : afterFence + 1, block: text.slice(0, end + 1) };
}

function cleanMarkdown(text) {
  const bounds = frontmatterBounds(text);
  const removed = [];
  if (!bounds) return { cleaned: text, removed };

  const lines = bounds.block.split('\n');
  const kept = lines.filter(line => {
    const match = /^([A-Za-z0-9_-]+)\s*:/.exec(line);
    if (match && AI_PROVENANCE_KEYS.has(match[1].toLowerCase())) {
      removed.push(match[1]);
      return false;
    }
    return true;
  });

  if (removed.length === 0) return { cleaned: text, removed };

  const body = text.slice(bounds.bodyStart);
  // Drop the frontmatter entirely if only the fences remain.
  const meaningful = kept.filter(l => l.trim() && l.trim() !== '---');
  const rebuilt = meaningful.length === 0 ? '' : `${kept.join('\n')}\n---\n`;
  return { cleaned: rebuilt + body, removed };
}

// --- HTML -----------------------------------------------------------------

const META_GENERATOR = /<meta\b[^>]*\bname\s*=\s*["']generator["'][^>]*>\s*/gi;
const META_AI = /<meta\b[^>]*\b(?:name|property)\s*=\s*["']ai[:-][^"']*["'][^>]*>\s*/gi;
const JSONLD = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>\s*/gi; // NOSONAR: repo/local file content, never network-controlled input
const DATA_AI_ATTR = /\s+data-ai-[\w-]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const AI_MARKER = /\b(ai[_-]?generated|aigenerated|provenance|trainedalgorithmicmedia|digitalsourcetype|softwareagent|gpt|claude|anthropic|openai|gemini|copilot)\b/i;

function cleanHtml(text) {
  const removed = [];
  let out = text;

  out = out.replace(META_GENERATOR, () => { removed.push('meta:generator'); return ''; });
  out = out.replace(META_AI, () => { removed.push('meta:ai'); return ''; });
  out = out.replace(JSONLD, (whole, body) => {
    if (AI_MARKER.test(body)) { removed.push('json-ld'); return ''; }
    return whole;
  });
  out = out.replace(DATA_AI_ATTR, () => { removed.push('attr:data-ai'); return ''; });

  return { cleaned: out, removed };
}

// --- SVG ------------------------------------------------------------------

const SVG_METADATA = /<metadata\b[^>]*>[\s\S]*?<\/metadata>\s*/gi; // NOSONAR: repo/local file content, never network-controlled input
const SVG_XMP = /<([a-z0-9]+:)?xmpmeta\b[\s\S]*?<\/([a-z0-9]+:)?xmpmeta>\s*/gi; // NOSONAR: repo/local file content, never network-controlled input
const SVG_GENERATOR_COMMENT = /<!--\s*generator\s*:[\s\S]*?-->\s*/gi; // NOSONAR: repo/local file content, never network-controlled input

function cleanSvg(text) {
  const removed = [];
  let out = text;
  out = out.replace(SVG_METADATA, () => { removed.push('svg:metadata'); return ''; });
  out = out.replace(SVG_XMP, () => { removed.push('svg:xmpmeta'); return ''; });
  out = out.replace(SVG_GENERATOR_COMMENT, () => { removed.push('svg:generator-comment'); return ''; });
  return { cleaned: out, removed };
}

// --- Dispatch -------------------------------------------------------------

function cleanContainer(name, text) {
  const kind = detectContainerFormat(name, text);
  if (kind === 'markdown') return { kind, ...cleanMarkdown(text) };
  if (kind === 'html') return { kind, ...cleanHtml(text) };
  if (kind === 'svg') return { kind, ...cleanSvg(text) };
  return { kind: null, cleaned: text, removed: [] };
}

function inspectContainer(name, text) {
  const { kind, removed } = cleanContainer(name, text);
  return { kind, findings: removed, suspicious: removed.length > 0 };
}

module.exports = {
  detectContainerFormat,
  cleanMarkdown,
  cleanHtml,
  cleanSvg,
  cleanContainer,
  inspectContainer,
  AI_PROVENANCE_KEYS,
};
