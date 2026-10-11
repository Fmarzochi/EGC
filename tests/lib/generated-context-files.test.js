'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  GENERATE_CONTEXT_FILE_KIND,
  PROJECT_MEMORY_HEADING,
  createGeneratedContextOperation,
  generatedContextTemplate,
  hasProjectMemorySection,
  isGeneratedContextSource,
  nextGeneratedContextContent,
} = require('../../scripts/lib/generated-context-files');

const REPO_ROOT = path.join(__dirname, '..', '..');
const EGC_START = '<!-- egc:start -->';
const EGC_END = '<!-- egc:end -->';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    failed += 1;
  }
}

// The checkout of a maintainer keeps these files populated by propagation;
// only the marked block differs from the tracked text, so the comparison
// puts the template's own empty block in its place.
function withCanonicalBlock(content, template) {
  const blockOf = text => text.slice(text.indexOf(EGC_START), text.indexOf(EGC_END) + EGC_END.length);
  assert.ok(content.includes(EGC_START) && content.includes(EGC_END), 'the tracked file carries the propagation markers');
  return content.replace(blockOf(content), blockOf(template));
}

console.log('\n=== Testing generated context files ===\n');

test('the templates are the tracked AGENTS.md and Cursor rule, byte for byte outside the propagation block', () => {
  for (const source of ['AGENTS.md', '.cursor/rules/egc-context.mdc']) {
    const template = generatedContextTemplate(source);
    // A Windows checkout with core.autocrlf lands the tracked file with CRLF.
    const tracked = fs.readFileSync(path.join(REPO_ROOT, ...source.split('/')), 'utf8').replaceAll('\r\n', '\n');
    assert.strictEqual(withCanonicalBlock(tracked, template), template, `${source} matches its template`);
    assert.ok(template.endsWith('\n'), `${source} template ends with a newline`);
    assert.ok(template.includes(PROJECT_MEMORY_HEADING), `${source} template carries the project-memory heading`);
  }
});

test('the catalog template is the Antigravity AGENTS.md and the Cursor template is a rule with frontmatter', () => {
  assert.ok(generatedContextTemplate('AGENTS.md').startsWith('# EGC: Agent Catalog\n'));
  assert.ok(generatedContextTemplate('.cursor/rules/egc-context.mdc').startsWith('---\ndescription: EGC project memory (auto-updated)\nalwaysApply: true\n---\n'));
  assert.ok(generatedContextTemplate('.cursor/rules/egc-context.mdc').includes('## EGC Natural Language Interface'));
});

test('only the two propagation-filled context sources are generated, whichever separator names them', () => {
  assert.strictEqual(isGeneratedContextSource('AGENTS.md'), true);
  assert.strictEqual(isGeneratedContextSource('.cursor/rules/egc-context.mdc'), true);
  assert.strictEqual(isGeneratedContextSource('.cursor\\rules\\egc-context.mdc'), true);
  assert.strictEqual(isGeneratedContextSource('.agents/AGENTS.md'), false);
  assert.strictEqual(isGeneratedContextSource('.trae/rules/egc-context.md'), false);
  assert.strictEqual(isGeneratedContextSource(''), false);
  assert.strictEqual(isGeneratedContextSource(undefined), false);
  assert.throws(() => generatedContextTemplate('.agents/AGENTS.md'), /No generated context template/);
});

test('a destination without the project-memory section receives the template, one with it is left alone', () => {
  const operation = { sourceRelativePath: '.cursor/rules/egc-context.mdc' };
  const template = generatedContextTemplate(operation.sourceRelativePath);
  assert.strictEqual(nextGeneratedContextContent(null, operation), template, 'a missing file is generated');
  assert.strictEqual(nextGeneratedContextContent('', operation), template, 'an empty file is generated');
  assert.strictEqual(nextGeneratedContextContent('# notes of my own\n', operation), template, 'a file without the section is rewritten');
  const populated = template.replace(`${EGC_START}\n`, `${EGC_START}\n## EGC Project Memory\n- decided: keep the cache\n`);
  assert.strictEqual(nextGeneratedContextContent(populated, operation), null, 'a populated file is never touched');
  assert.strictEqual(nextGeneratedContextContent(template, operation), null, 'the freshly generated file is never rewritten');
  const cutBeforeBlock = template.slice(0, template.indexOf(EGC_START));
  assert.ok(cutBeforeBlock.includes(PROJECT_MEMORY_HEADING), 'the Cursor rule carries the heading above its instructions too');
  assert.strictEqual(nextGeneratedContextContent(cutBeforeBlock, operation), template, 'a file cut off before the propagation block is rewritten');
  assert.strictEqual(nextGeneratedContextContent(`${EGC_START}\n${EGC_END}\n`, operation), template, 'a block without the heading is rewritten');
  assert.strictEqual(hasProjectMemorySection(`${PROJECT_MEMORY_HEADING}\n`), false, 'the heading counts only inside the block');
  assert.strictEqual(hasProjectMemorySection(populated), true);
  assert.strictEqual(hasProjectMemorySection(undefined), false);
});

test('the planned operation carries the generated kind and a normalized source', () => {
  const operation = createGeneratedContextOperation({
    moduleId: 'platform-configs',
    sourceRelativePath: '.cursor\\rules\\egc-context.mdc',
    destinationPath: path.join(path.sep, 'home', 'person', 'project', '.cursor', 'rules', 'egc-context.mdc'),
  });
  assert.deepStrictEqual(operation, {
    kind: GENERATE_CONTEXT_FILE_KIND,
    moduleId: 'platform-configs',
    sourceRelativePath: '.cursor/rules/egc-context.mdc',
    destinationPath: path.join(path.sep, 'home', 'person', 'project', '.cursor', 'rules', 'egc-context.mdc'),
    strategy: GENERATE_CONTEXT_FILE_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
  });
  assert.throws(() => createGeneratedContextOperation({
    moduleId: 'agents-core',
    sourceRelativePath: '.agents/AGENTS.md',
    destinationPath: path.join(path.sep, 'home', 'person', 'AGENTS.md'),
  }), /No generated context template/);
});

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
