'use strict';

// Scrubber container metadata: Markdown frontmatter, HTML head, and SVG.
// Targeted removal of AI provenance only; ordinary content stays intact.

const assert = require('node:assert');
const {
  detectContainerFormat,
  cleanMarkdown,
  cleanHtml,
  cleanSvg,
  cleanContainer,
  inspectContainer,
} = require('../../scripts/lib/scrubber/container-meta');

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    return true;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    Error: ${err.stack}`);
    return false;
  }
}

let passed = 0;
let failed = 0;
function check(name, fn) {
  if (test(name, fn)) passed += 1;
  else failed += 1;
}

check('markdown drops AI provenance keys but keeps real frontmatter', () => {
  const md = '---\ntitle: Hello\ngenerator: GPT-4\nai_model: claude-3\n---\n\n# Body\ntext\n';
  const r = cleanMarkdown(md);
  assert.ok(r.removed.includes('generator'));
  assert.ok(r.removed.includes('ai_model'));
  assert.ok(/title: Hello/.test(r.cleaned));
  assert.ok(!/generator:/.test(r.cleaned));
  assert.ok(/# Body/.test(r.cleaned));
});

check('markdown without frontmatter is untouched', () => {
  const md = '# Just a title\n\nnormal text with the word generator in it\n';
  const r = cleanMarkdown(md);
  assert.strictEqual(r.removed.length, 0);
  assert.strictEqual(r.cleaned, md);
});

check('markdown drops the whole frontmatter when only AI keys remain', () => {
  const md = '---\ngenerator: some-ai\n---\n\n# Body\n';
  const r = cleanMarkdown(md);
  assert.ok(r.removed.includes('generator'));
  assert.ok(!/---/.test(r.cleaned));
  assert.ok(/# Body/.test(r.cleaned));
});

check('html removes generator meta and AI meta, keeps others', () => {
  const html = '<head><meta name="viewport" content="w"><meta name="generator" content="SomeAI 1.0"><meta name="ai-model" content="x"></head>';
  const r = cleanHtml(html);
  assert.ok(r.removed.includes('meta:generator'));
  assert.ok(r.removed.includes('meta:ai'));
  assert.ok(/viewport/.test(r.cleaned));
  assert.ok(!/generator/.test(r.cleaned));
});

check('html removes AI JSON-LD but keeps unrelated JSON-LD', () => {
  const aiLd = '<script type="application/ld+json">{"aiGenerated":true}</script>';
  const okLd = '<script type="application/ld+json">{"@type":"Article","name":"x"}</script>';
  assert.ok(cleanHtml(aiLd).removed.includes('json-ld'));
  assert.strictEqual(cleanHtml(okLd).removed.length, 0);
  assert.ok(/@type/.test(cleanHtml(okLd).cleaned));
});

check('html strips data-ai attributes', () => {
  const html = '<div data-ai-model="claude" data-role="main">x</div>';
  const r = cleanHtml(html);
  assert.ok(r.removed.includes('attr:data-ai'));
  assert.ok(!/data-ai-model/.test(r.cleaned));
  assert.ok(/data-role="main"/.test(r.cleaned));
});

check('svg removes metadata, xmpmeta, and generator comments', () => {
  const svg = '<svg><!-- Generator: SomeAI --><metadata><foo/></metadata><x:xmpmeta>...</x:xmpmeta><path d="M0 0"/></svg>';
  const r = cleanSvg(svg);
  assert.ok(r.removed.includes('svg:metadata'));
  assert.ok(r.removed.includes('svg:xmpmeta'));
  assert.ok(r.removed.includes('svg:generator-comment'));
  assert.ok(/<path d="M0 0"\/>/.test(r.cleaned));
  assert.ok(!/metadata/.test(r.cleaned));
});

check('detectContainerFormat routes by extension and content', () => {
  assert.strictEqual(detectContainerFormat('a.md', ''), 'markdown');
  assert.strictEqual(detectContainerFormat('a.html', ''), 'html');
  assert.strictEqual(detectContainerFormat('a.svg', ''), 'svg');
  assert.strictEqual(detectContainerFormat('noext', '<svg xmlns="...">'), 'svg');
  assert.strictEqual(detectContainerFormat('a.txt', 'plain'), null);
});

check('cleanContainer dispatches and inspectContainer reports', () => {
  const md = '---\ngenerator: ai\ntitle: t\n---\nbody\n';
  const c = cleanContainer('post.md', md);
  assert.strictEqual(c.kind, 'markdown');
  assert.ok(c.removed.includes('generator'));
  const i = inspectContainer('post.md', md);
  assert.strictEqual(i.suspicious, true);
  assert.strictEqual(inspectContainer('x.txt', 'plain').suspicious, false);
});

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
