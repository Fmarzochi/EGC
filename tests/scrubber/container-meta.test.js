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
  parseAttrs,
} = require('../../scripts/lib/scrubber/container-meta');

const BOM = String.fromCodePoint(0xfeff);

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
  assert.strictEqual(r.removed.filter(x => x === 'meta:provenance').length, 2);
  assert.ok(/viewport/.test(r.cleaned));
  assert.ok(!/generator/.test(r.cleaned));
  assert.ok(!/ai-model/.test(r.cleaned));
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

check('cleanContainer strips a BOM before detecting markdown frontmatter', () => {
  const md = `${BOM}---\ngenerator: ai\ntitle: t\n---\nbody\n`;
  const c = cleanContainer('post.md', md);
  assert.ok(c.removed.includes('generator'));
  assert.ok(!/generator/.test(c.cleaned));
  assert.ok(/title: t/.test(c.cleaned));
});

check('html meta with a > inside a quoted value is not corrupted', () => {
  const html = '<meta name="description" content="a>b"><meta name="generator" content="AI">tail';
  const r = cleanHtml(html);
  assert.ok(r.removed.includes('meta:provenance'));
  assert.ok(/content="a>b"/.test(r.cleaned));
  assert.ok(/tail/.test(r.cleaned));
  assert.ok(!/generator/.test(r.cleaned));
});

check('json-ld keeps a block that merely mentions an AI brand', () => {
  const ok = '<script type="application/ld+json">{"headline":"OpenAI releases a model"}</script>';
  const r = cleanHtml(ok);
  assert.strictEqual(r.removed.length, 0);
  assert.ok(/OpenAI releases/.test(r.cleaned));
});

check('json-ld removes a block with an explicit provenance field, quoted or not', () => {
  assert.ok(cleanHtml('<script type="application/ld+json">{"aiGenerated":true}</script>').removed.includes('json-ld'));
  assert.ok(cleanHtml('<script type=application/ld+json>{"digitalSourceType":"x"}</script>').removed.includes('json-ld'));
});

check('meta and yaml accept unquoted and quoted forms', () => {
  assert.ok(cleanHtml('<meta name=generator content=x>').removed.includes('meta:provenance'));
  assert.ok(cleanHtml('<meta name=ai-model content=x>').removed.includes('meta:provenance'));
  assert.ok(cleanMarkdown('---\n"generator": ai\ntitle: t\n---\nb\n').removed.includes('generator'));
});

check('markdown starting with a non-fence --- line is untouched', () => {
  const md = '---foo\ngenerator: not-frontmatter\n';
  const r = cleanMarkdown(md);
  assert.strictEqual(r.removed.length, 0);
  assert.strictEqual(r.cleaned, md);
});

check('does not mistake data-type or data-name for real attributes', () => {
  const script = '<script data-type="application/ld+json">{"aiGenerated":true}</script>';
  assert.strictEqual(cleanHtml(script).removed.length, 0);
  const meta = '<meta data-name="generator" content="x">keep';
  assert.strictEqual(cleanHtml(meta).removed.length, 0);
});

check('meta with a non-AI name and an AI property is removed', () => {
  const meta = '<meta name="twitter:card" property="ai:model" content="x">';
  assert.ok(cleanHtml(meta).removed.includes('meta:provenance'));
});

check('markdown leaves a provenance key with a nested value intact (conservative)', () => {
  // Removing a nested/multiline value reliably needs a full YAML parse, so the
  // conservative contract keeps it rather than risk dropping unrelated lines.
  const md = '---\ngenerator:\n  name: SomeAI\n  version: 2\ntitle: t\n---\nbody\n';
  const r = cleanMarkdown(md);
  assert.strictEqual(r.removed.length, 0);
  assert.strictEqual(r.cleaned, md);
});

check('an indented --- inside a block scalar is not treated as the fence', () => {
  const md = '---\nnote: |\n  a line\n  ---\n  more\ngenerator: ai\n---\nbody\n';
  const r = cleanMarkdown(md);
  assert.ok(r.removed.includes('generator'));
  assert.ok(/note:/.test(r.cleaned));
  assert.ok(/body/.test(r.cleaned));
});

check('markdown leaves a provenance key with an unindented sequence value intact', () => {
  const md = '---\ngenerator:\n- item1\n- item2\ntitle: t\n---\nbody\n';
  const r = cleanMarkdown(md);
  assert.strictEqual(r.removed.length, 0);
  assert.ok(/item1/.test(r.cleaned));
});

check('markdown removes a scalar provenance key without touching a following comment or merge key', () => {
  const md = '---\ngenerator: ai\n# keep this author note\n<<: *base\ntitle: t\n---\nbody\n';
  const r = cleanMarkdown(md);
  assert.ok(r.removed.includes('generator'));
  assert.ok(/keep this author note/.test(r.cleaned));
  assert.ok(/<<: \*base/.test(r.cleaned));
  assert.ok(/title: t/.test(r.cleaned));
});

check('parseAttrs is quote-aware and ignores attribute text inside quoted values', () => {
  const meta = '<meta data-x="junk name=generator more" content="ok">';
  assert.strictEqual(cleanHtml(meta).removed.length, 0);
  const attrs = parseAttrs('<meta data-x="a name=generator b">');
  assert.strictEqual(attrs.name, undefined);
});

check('parseAttrs records a prototype-colliding attribute name correctly', () => {
  const attrs = parseAttrs('<meta constructor="x" name="viewport">');
  assert.strictEqual(attrs.name, 'viewport');
  assert.strictEqual(attrs.constructor, 'x');
});

check('markdown leaves an unclosed quoted or flow scalar intact, removes a closed one', () => {
  const multiline = '---\ngenerator: "start\n\nend"\ntitle: t\n---\nbody\n';
  const r = cleanMarkdown(multiline);
  assert.strictEqual(r.removed.length, 0);
  assert.ok(/end"/.test(r.cleaned));
  assert.strictEqual(cleanMarkdown('---\ngenerator: [a,\n b]\ntitle: t\n---\nb\n').removed.length, 0);
  assert.ok(cleanMarkdown('---\ngenerator: "SomeAI"\ntitle: t\n---\nb\n').removed.includes('generator'));
});

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
