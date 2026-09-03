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
  return text.codePointAt(0) === BOM ? text.slice(1) : text;
}

function detectContainerFormat(name, text) {
  const lower = String(name || '').toLowerCase();
  if (/\.(md|markdown|mdx)$/.test(lower)) return 'markdown';
  if (/\.(html?|xhtml)$/.test(lower)) return 'html';
  if (lower.endsWith('.svg')) return 'svg';
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

// A value that is fully contained on this one line: a bare scalar, or a quoted
// scalar closed by its matching quote. A value that opens a quote or a flow
// collection ([ or {) may continue on later lines, so it is not complete and
// the key is left intact rather than removing only its first line.
function isCompleteScalar(value) {
  const first = value.charAt(0);
  if (first === '"' || first === "'") {
    return value.length >= 2 && value.charAt(value.length - 1) === first;
  }
  return first !== '[' && first !== '{';
}

// The provenance key a frontmatter line carries when it is safe to drop, or
// null. Only a single-line scalar value is removable: `key: value` with a
// non-empty, non-block-scalar value and no indented continuation next.
// Anything with a nested / multiline value is left intact (a safe miss):
// removing it reliably needs a full YAML parse and could drop unrelated
// lines (comments, merge keys, sibling entries).
function removableProvenanceKey(line, next) {
  const key = /^\S/.test(line) ? frontmatterKey(line) : null;
  if (key === null || !AI_PROVENANCE_KEYS.has(key.toLowerCase())) return null;
  const value = line.slice(line.indexOf(':') + 1).trim();
  const nextIndented = next !== undefined && /^\s/.test(next) && next.trim() !== '';
  const blockScalar = /^[|>]/.test(value);
  const removable = value !== '' && !blockScalar && !nextIndented && isCompleteScalar(value);
  return removable ? key : null;
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
  for (let i = 0; i < frontmatter.length; i += 1) {
    const line = frontmatter[i];
    const key = removableProvenanceKey(line, frontmatter[i + 1]);
    if (key === null) {
      kept.push(line);
    } else {
      removed.push(key);
    }
  }

  if (removed.length === 0) return { cleaned: text, removed };

  const body = lines.slice(close + 1).join('\n');
  const meaningful = kept.filter(l => l.trim());
  const rebuilt = meaningful.length === 0 ? '' : `---\n${kept.join('\n')}\n---\n`;
  return { cleaned: rebuilt + body, removed };
}

// --- HTML -----------------------------------------------------------------

// A tag body segment that consumes quoted attribute values whole, so a `>`
// inside a quoted value does not end the scan early. The unquoted branch
// excludes quote characters so the three branches never overlap: an
// unbalanced quote makes the tag unrecognizable (a safe miss) instead of
// giving the engine an ambiguity to backtrack through.
const TAG_BODY = `(?:"[^"]*"|'[^']*'|[^>"'])*`;
const META_TAG = new RegExp(String.raw`<meta\b${TAG_BODY}>\s*`, 'gi');
// Only the opening tag is matched by pattern; the block body runs to the next
// closing tag found by plain search, so no repetition ever competes with the
// terminator.
const SCRIPT_OPEN = new RegExp(String.raw`<script\b(${TAG_BODY})>`, 'gi');
// Searched in the original text (not a lowercased copy, whose length can
// differ for some Unicode characters), so every index stays aligned.
const SCRIPT_CLOSE = /<\/script>/gi;
const DATA_AI_ATTR = /\s+data-ai-[\w-]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
// Explicit provenance FIELDS, not brand mentions: a JSON-LD block is only
// stripped when it declares AI provenance, so a legitimate Article that merely
// names a model or company survives.
const LD_PROVENANCE = /"(aiGenerated|generator|softwareAgent|trainedAlgorithmicMedia|compositeWithTrainedAlgorithmicMedia|digitalSourceType|provenance)"\s*:/i;

// Parse attribute tokens from a tag string. Quote-aware: the scanner skips over
// quoted values whole (the second/third alternatives), so `name=generator`
// inside a quoted value is never mistaken for a real attribute. The name
// alternative matches the maximal attribute-name token, so `data-name` is one
// token and never collapses to `name`. Uses a null-prototype object so a name
// like `constructor` or `toString` records correctly and first-wins holds.
function unquote(value) {
  const first = value.charAt(0);
  if ((first === '"' || first === "'") && value.charAt(value.length - 1) === first) {
    return value.slice(1, -1);
  }
  return value;
}

// Sticky (y) so each token is matched exactly at the scan position: an
// attribute first, then a bare quoted value to skip over whole; anything else
// advances one character.
const ATTR_TOKEN = /([a-zA-Z_:][\w:.-]*)\s*=\s*("[^"]*"|'[^']*'|[^\s>"'][^\s>]*)/y;
const QUOTED_TOKEN = /"[^"]*"|'[^']*'/y;

function parseAttrs(tag) {
  const attrs = Object.create(null);
  let i = 0;
  while (i < tag.length) {
    ATTR_TOKEN.lastIndex = i;
    const attr = ATTR_TOKEN.exec(tag);
    if (attr !== null) {
      const key = attr[1].toLowerCase();
      // HTML honors the first occurrence of a repeated attribute.
      if (!(key in attrs)) attrs[key] = unquote(attr[2]);
      i = ATTR_TOKEN.lastIndex;
      continue;
    }
    QUOTED_TOKEN.lastIndex = i;
    i = QUOTED_TOKEN.exec(tag) === null ? i + 1 : QUOTED_TOKEN.lastIndex;
  }
  return attrs;
}

function isProvenanceMetaValue(value) {
  if (!value) return false;
  const v = value.toLowerCase();
  return v === 'generator' || /^ai[:-]/.test(v);
}

// Removes every <script type="application/ld+json"> block that declares AI
// provenance, together with the whitespace that followed it; every other
// script block is kept byte for byte.
function stripProvenanceScripts(html, removed) {
  let result = '';
  let last = 0;
  SCRIPT_OPEN.lastIndex = 0;
  let m = SCRIPT_OPEN.exec(html);
  while (m !== null) {
    const bodyStart = m.index + m[0].length;
    SCRIPT_CLOSE.lastIndex = bodyStart;
    const closeMatch = SCRIPT_CLOSE.exec(html);
    if (closeMatch === null) break;
    const close = closeMatch.index;
    let end = close + closeMatch[0].length;
    const parsed = parseAttrs(m[1]);
    if (parsed.type?.toLowerCase() === 'application/ld+json' && LD_PROVENANCE.test(html.slice(bodyStart, close))) {
      removed.push('json-ld');
      while (end < html.length && /\s/.test(html[end])) end += 1;
      result += html.slice(last, m.index);
      last = end;
    }
    SCRIPT_OPEN.lastIndex = end;
    m = SCRIPT_OPEN.exec(html);
  }
  return result + html.slice(last);
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

  out = stripProvenanceScripts(out, removed);

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
