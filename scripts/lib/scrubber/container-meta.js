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

// A frontmatter key line: a bare, single-quoted, or double-quoted key followed
// by a colon. Returns the key name, or null.
function frontmatterKey(line) {
  const m = /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*:/.exec(line);
  return m ? (m[1] || m[2] || m[3]) : null;
}

function cleanMarkdown(text) {
  const removed = [];
  const lines = text.split('\n');
  // The opening fence must be a whole line of exactly `---`, not merely a `---`
  // prefix, so ordinary Markdown starting with a horizontal rule is untouched.
  if (lines.length < 2 || lines[0].trim() !== '---') return { cleaned: text, removed };

  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') { close = i; break; }
  }
  if (close < 0) return { cleaned: text, removed };

  const frontmatter = lines.slice(1, close);
  const kept = frontmatter.filter(line => {
    const key = frontmatterKey(line);
    if (key && AI_PROVENANCE_KEYS.has(key.toLowerCase())) {
      removed.push(key);
      return false;
    }
    return true;
  });

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
const LD_JSON_TYPE = /\btype\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json'|application\/ld\+json\b)/i;
// Explicit provenance FIELDS, not brand mentions: a JSON-LD block is only
// stripped when it declares AI provenance, so a legitimate Article that merely
// names a model or company survives.
const LD_PROVENANCE = /"(aiGenerated|generator|softwareAgent|trainedAlgorithmicMedia|compositeWithTrainedAlgorithmicMedia|digitalSourceType|provenance)"\s*:/i;

// Read an attribute value (quoted or unquoted) from a tag string.
function tagAttr(tag, attr) {
  const m = new RegExp(`\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? '';
}

function cleanHtml(text) {
  const removed = [];
  let out = text;

  out = out.replace(META_TAG, tag => {
    const name = String(tagAttr(tag, 'name') || tagAttr(tag, 'property') || '').toLowerCase();
    if (name === 'generator') { removed.push('meta:generator'); return ''; }
    if (/^ai[:-]/.test(name)) { removed.push('meta:ai'); return ''; }
    return tag;
  });

  out = out.replace(SCRIPT_BLOCK, (whole, attrs, body) => {
    if (LD_JSON_TYPE.test(attrs) && LD_PROVENANCE.test(body)) {
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
  // Not a container: hand back the original bytes (BOM included) untouched;
  // the caller's Layer A pass handles any BOM.
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
  stripBom,
  AI_PROVENANCE_KEYS,
};
