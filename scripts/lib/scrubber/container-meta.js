'use strict';

// Scrubber container metadata: strip AI-provenance metadata from structured
// text containers (Markdown frontmatter, HTML head, SVG). Targeted and
// conservative: only provenance keys/blocks are removed, ordinary content and
// unrelated metadata are left intact. Text in, text out; the caller runs the
// Layer A Unicode pass on the body separately.

// Frontmatter / meta keys that name an AI generation provenance (not content
// tags). Matched case-insensitively against the key name only.
const AI_PROVENANCE_KEYS = new Set([
  'generator', 'generated_by', 'generated-by', 'generatedby',
  'ai_generated', 'ai-generated', 'aigenerated',
  'ai_model', 'ai-model', 'ai_provider', 'ai-provider',
  'ai_tool', 'ai-tool', 'llm', 'llm_model', 'x_ai', 'x-ai',
]);

const BOM = 0xfeff;

function stripBom(text) {
  return text.charCodeAt(0) === BOM ? text.slice(1) : text;
}

function detectContainerFormat(name, text) {
  const lower = String(name || '').toLowerCase();
  if (/\.(md|markdown|mdx)$/.test(lower)) return 'markdown';
  if (/\.(html?|xhtml)$/.test(lower)) return 'html';
  if (/\.svg$/.test(lower)) return 'svg';
  // Fall back to a light content sniff for extension-less input.
  const head = stripBom(String(text || '')).slice(0, 512).trimStart();
  if (head.startsWith('<svg') || head.includes('<svg ')) return 'svg';
  if (/^<!doctype html|^<html|<head[\s>]/i.test(head)) return 'html';
  return null;
}

// --- Markdown -------------------------------------------------------------

// The frontmatter key on a top-level line: a bare, single-quoted, or
// double-quoted key followed by a colon. Returns the key name, or null.
function frontmatterKey(line) {
  const m = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*:/.exec(line);
  return m ? (m[1] || m[2] || m[3]) : null;
}

// A frontmatter fence is an unindented line of exactly `---` (trailing
// whitespace allowed). An indented `---` inside a block scalar is not a fence.
function isFence(line) {
  return /^---[ \t]*\r?$/.test(line);
}

function cleanMarkdown(text) {
  const removed = [];
  const lines = text.split('\n');
  if (lines.length < 2 || !isFence(lines[0])) return { cleaned: text, removed };

  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (isFence(lines[i])) { close = i; break; }
  }
  if (close < 0) return { cleaned: text, removed };

  const frontmatter = lines.slice(1, close);
  const kept = [];
  let dropping = false;
  for (const line of frontmatter) {
    // Only a real top-level key line (unindented `key:`) starts or ends a drop.
    // Comments, unindented `-` sequence entries, blank lines, and indented
    // values are continuations of whatever key precedes them.
    const topLevelKey = /^\S/.test(line) ? frontmatterKey(line) : null;
    if (topLevelKey !== null) {
      if (AI_PROVENANCE_KEYS.has(topLevelKey.toLowerCase())) {
        removed.push(topLevelKey);
        dropping = true;
        continue;
      }
      dropping = false;
      kept.push(line);
      continue;
    }
    // Continuation line: drop it with its key, or keep it otherwise.
    if (dropping) continue;
    kept.push(line);
  }

  if (removed.length === 0) return { cleaned: text, removed };

  const body = lines.slice(close + 1).join('\n');
  const meaningful = kept.filter(l => l.trim());
  const rebuilt = meaningful.length === 0 ? '' : `---\n${kept.join('\n')}\n---\n`;
  return { cleaned: rebuilt + body, removed };
}

// --- HTML -----------------------------------------------------------------

// A tag body segment that consumes quoted attribute values whole, so a `>`
// inside a quoted value does not end the scan early.
const TAG_BODY = '(?:"[^"]*"|\'[^\']*\'|[^>])*';
const META_TAG = new RegExp(`<meta\\b${TAG_BODY}>\\s*`, 'gi');
const SCRIPT_BLOCK = new RegExp(`<script\\b(${TAG_BODY})>([\\s\\S]*?)<\\/script>\\s*`, 'gi'); // NOSONAR: repo/local file content, never network-controlled input
const DATA_AI_ATTR = /\s+data-ai-[\w-]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
// Explicit provenance FIELDS, not brand mentions: a JSON-LD block is only
// stripped when it declares AI provenance, so a legitimate Article that merely
// names a model or company survives.
const LD_PROVENANCE = /"(aiGenerated|generator|softwareAgent|trainedAlgorithmicMedia|compositeWithTrainedAlgorithmicMedia|digitalSourceType|provenance)"\s*:/i;

// Parse attribute tokens from a tag string. The name is bounded by whitespace
// or the tag start, so `data-name` is one token and never matches `name`.
function parseAttrs(tag) {
  const attrs = {};
  const re = /(?:^|\s)([a-zA-Z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m = re.exec(tag);
  while (m !== null) {
    const key = m[1].toLowerCase();
    // HTML honors the first occurrence of a repeated attribute; keep it so a
    // benign duplicate cannot hide a provenance value.
    if (!(key in attrs)) attrs[key] = m[3] ?? m[4] ?? m[5] ?? '';
    m = re.exec(tag);
  }
  return attrs;
}

function isProvenanceMetaValue(value) {
  if (!value) return false;
  const v = value.toLowerCase();
  return v === 'generator' || /^ai[:-]/.test(v);
}

function cleanHtml(text) {
  const removed = [];
  let out = text;

  out = out.replace(META_TAG, tag => {
    const attrs = parseAttrs(tag);
    // Evaluate name and property independently: an AI value on either removes it.
    if (isProvenanceMetaValue(attrs.name) || isProvenanceMetaValue(attrs.property)) {
      removed.push('meta:provenance');
      return '';
    }
    return tag;
  });

  out = out.replace(SCRIPT_BLOCK, (whole, attrs, body) => {
    const parsed = parseAttrs(attrs);
    if (parsed.type && parsed.type.toLowerCase() === 'application/ld+json' && LD_PROVENANCE.test(body)) {
      removed.push('json-ld');
      return '';
    }
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

function cleanContainer(name, rawText) {
  const text = stripBom(rawText);
  const kind = detectContainerFormat(name, text);
  if (kind === 'markdown') return { kind, ...cleanMarkdown(text) };
  if (kind === 'html') return { kind, ...cleanHtml(text) };
  if (kind === 'svg') return { kind, ...cleanSvg(text) };
  return { kind: null, cleaned: rawText, removed: [] };
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
  parseAttrs,
  stripBom,
  AI_PROVENANCE_KEYS,
};
