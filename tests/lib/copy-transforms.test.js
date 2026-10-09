/**
 * Tests for scripts/lib/install/copy-transforms.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ANTIGRAVITY_AGENT_FRONTMATTER_TRANSFORM,
  ANTIGRAVITY_MANUAL_RULE_FRONTMATTER_TRANSFORM,
  ANTIGRAVITY_RULE_FRONTMATTER_TRANSFORM,
  CLAUDE_AGENT_FRONTMATTER_TRANSFORM,
  plannedFileContent,
  toAntigravityAgentFrontmatter,
  toAntigravityRule,
  toClaudeAgentFrontmatter,
  transformContent,
  toOpenCodeAgentFrontmatter,
} = require('../../scripts/lib/install/copy-transforms');
const { planAntigravityRuleFiles } = require('../../scripts/lib/antigravity-rules');
const { planAntigravityAgentFiles } = require('../../scripts/lib/antigravity-agents');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

const AGENT = [
  '---',
  'name: Code-Reviewer',
  'description: Expert code review specialist. MUST BE USED for all code changes.',
  'tools: ["Read", "Grep", "Glob", "Bash"]',
  'model: gemini-3.1-pro',
  'stack: ["*"]',
  'color: blue',
  '---',
  '',
  '# Code Reviewer',
  '',
  'tools: ["not", "frontmatter"]',
  '',
].join('\n');

const ANTIGRAVITY_TOOLS = new Set(['view_file', 'grep_search', 'run_command', 'write_to_file', 'replace_file_content', 'multi_replace_file_content']);

function assertAntigravityAgent(repoRoot, agent) {
  assert.strictEqual(agent.transform, ANTIGRAVITY_AGENT_FRONTMATTER_TRANSFORM, agent.sourceRelativePath);
  const text = plannedFileContent(path.join(repoRoot, agent.sourceRelativePath), agent.transform).toString('utf8');
  const frontmatter = text.split('\n---\n')[0];
  assert.ok(/^---\nname: \S/.test(frontmatter), `${agent.sourceRelativePath}: name`);
  assert.ok(/\ndescription: \S/.test(frontmatter), `${agent.sourceRelativePath}: description`);
  for (const [, tool] of frontmatter.matchAll(/\n {2}- (\S+)/g)) {
    assert.ok(ANTIGRAVITY_TOOLS.has(tool), `${agent.sourceRelativePath}: tool ${tool}`);
  }
  const model = /\nmodel: (\S+)/.exec(frontmatter)?.[1];
  assert.ok(model === undefined || ['inherit', 'flash', 'pro'].includes(model), `${agent.sourceRelativePath}: model ${model}`);
  assert.ok(!/\n(stack|color):/.test(frontmatter), `${agent.sourceRelativePath}: no stack or color`);
}

function runTests() {
  console.log('\n=== Testing copy-transforms.js ===\n');

  let passed = 0;
  let failed = 0;

  if (test('rewrites the tools list as the comma-separated string Claude Code reads', () => {
    const output = toClaudeAgentFrontmatter(AGENT);
    assert.ok(output.includes('\ntools: Read, Grep, Glob, Bash\n'), output);
    assert.ok(!output.includes('tools: ["Read"'), 'the flow sequence must be gone from the frontmatter');
  })) passed++; else failed++;

  if (test('drops a model Claude Code cannot run and keeps one it can', () => {
    const output = toClaudeAgentFrontmatter(AGENT);
    assert.ok(!output.includes('gemini-3.1-pro'), 'a Gemini model id must not reach ~/.claude/agents');
    const kept = toClaudeAgentFrontmatter(AGENT.replace('model: gemini-3.1-pro', 'model: sonnet'));
    assert.ok(kept.includes('\nmodel: sonnet\n'), kept);
  })) passed++; else failed++;

  if (test('drops the catalog-only stack field, keeps color, lowercases the name', () => {
    const output = toClaudeAgentFrontmatter(AGENT);
    assert.ok(!output.includes('stack:'), 'stack is EGC catalog metadata');
    assert.ok(output.includes('\ncolor: blue\n'), 'color is a Claude Code field');
    assert.ok(output.includes('\nname: code-reviewer\n'), output);
  })) passed++; else failed++;

  if (test('leaves the body untouched, including a tools line in prose', () => {
    const output = toClaudeAgentFrontmatter(AGENT);
    assert.ok(output.endsWith('\n# Code Reviewer\n\ntools: ["not", "frontmatter"]\n'), output);
  })) passed++; else failed++;

  if (test('accepts an unquoted flow sequence', () => {
    const output = toClaudeAgentFrontmatter(AGENT.replace('tools: ["Read", "Grep", "Glob", "Bash"]', 'tools: [Read, Grep]'));
    assert.ok(output.includes('\ntools: Read, Grep\n'), output);
  })) passed++; else failed++;

  if (test('recognizes the frontmatter through a byte order mark and CRLF line endings', () => {
    const windowsAgent = '\uFEFF' + AGENT.replaceAll('\n', '\r\n');
    const output = toClaudeAgentFrontmatter(windowsAgent);
    assert.ok(output.includes('\ntools: Read, Grep, Glob, Bash\n'), output);
    assert.ok(!output.includes('gemini-3.1-pro') && !output.includes('stack:'), output);
    assert.ok(!output.includes('\uFEFF') && !output.includes('\r'), 'the transformed file is written with LF and no mark');
  })) passed++; else failed++;

  if (test('returns text without frontmatter unchanged', () => {
    const plain = '# No frontmatter\n\ntools: [x]\n';
    assert.strictEqual(toClaudeAgentFrontmatter(plain), plain);
  })) passed++; else failed++;

  if (test('OpenCode: the tools list becomes an object, model, stack and color are dropped, mode subagent is added', () => {
    const source = '---\nname: architect\ndescription: d\ntools: ["Read", "Grep", "Glob"]\nmodel: gemini-3.1-pro\nstack: ["*"]\ncolor: teal\n---\n# body\n';
    assert.strictEqual(toOpenCodeAgentFrontmatter(source), '---\nname: architect\ndescription: d\ntools:\n  read: true\n  grep: true\n  glob: true\nmode: subagent\n---\n# body\n', 'tool ids are lowercase, the way OpenCode names them');
    assert.strictEqual(toOpenCodeAgentFrontmatter('---\ndescription: d\ntools:\n  - Read\n  - "WebFetch"\n  - mcp__context7__query-docs\nstack: ["*"]\n---\nbody\n'), '---\ndescription: d\ntools:\n  read: true\n  webfetch: true\n  mcp__context7__query-docs: true\nmode: subagent\n---\nbody\n', 'a block-style list converts too and an MCP tool keeps its name');
    assert.strictEqual(toOpenCodeAgentFrontmatter('---\ndescription: d\ntools:\n  - Read\n  -\n  - Grep\n---\nbody\n'), '---\ndescription: d\ntools:\n  read: true\n  -\n  - Grep\nmode: subagent\n---\nbody\n', 'a bare dash ends the list, as the pattern did');
    assert.strictEqual(toOpenCodeAgentFrontmatter('---\ndescription: d\nmode: primary\n---\nbody\n'), '---\ndescription: d\nmode: primary\n---\nbody\n', 'an explicit mode is kept');
    assert.strictEqual(toOpenCodeAgentFrontmatter('no frontmatter\n'), 'no frontmatter\n');
    assert.strictEqual(toOpenCodeAgentFrontmatter('\uFEFF---\r\nname: x\r\ntools: [Read]\r\n---\r\nbody\r\n'), '---\nname: x\ntools:\n  read: true\nmode: subagent\n---\nbody\n');
  })) passed++; else failed++;

  if (test('transformContent applies a named transform and refuses an unknown one', () => {
    const output = transformContent(Buffer.from(AGENT, 'utf8'), CLAUDE_AGENT_FRONTMATTER_TRANSFORM);
    assert.ok(Buffer.isBuffer(output));
    assert.ok(output.toString('utf8').includes('tools: Read, Grep, Glob, Bash'));
    assert.throws(() => transformContent(Buffer.from('x'), 'no-such-transform'), /Unknown copy transform/);
  })) passed++; else failed++;

  if (test('plannedFileContent reads the source and applies the transform, or none', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-transforms-'));
    try {
      const source = path.join(dir, 'agent.md');
      fs.writeFileSync(source, AGENT);
      assert.strictEqual(plannedFileContent(source).toString('utf8'), AGENT);
      assert.ok(plannedFileContent(source, CLAUDE_AGENT_FRONTMATTER_TRANSFORM).toString('utf8').includes('tools: Read, Grep, Glob, Bash'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('an Antigravity rule with paths becomes a glob rule over them, described by its heading (#1668)', () => {
    const source = '---\npaths:\n  - "**/*.go"\n  - "**/go.mod"\n---\n# Go Hooks\n\nbody\n';
    assert.strictEqual(
      toAntigravityRule(source),
      '---\ntrigger: glob\ndescription: "Go Hooks"\nglobs: "**/*.go, **/go.mod"\n---\n# Go Hooks\n\nbody\n'
    );
    assert.strictEqual(
      toAntigravityRule('---\npaths: ["*.ts", "*.tsx"]\n---\n# TS\n'),
      '---\ntrigger: glob\ndescription: "TS"\nglobs: "*.ts, *.tsx"\n---\n# TS\n'
    );
  })) passed++; else failed++;

  if (test('an Antigravity rule without paths is always_on, and a manual rule never loads by itself (#1668)', () => {
    assert.strictEqual(
      toAntigravityRule('# Coding Style\n\nx\n'),
      '---\ntrigger: always_on\ndescription: "Coding Style"\n---\n# Coding Style\n\nx\n'
    );
    assert.strictEqual(
      toAntigravityRule('---\npaths:\n  - "**/*.go"\n---\n# 编码风格\n', { manual: true }),
      '---\ntrigger: manual\ndescription: "编码风格"\n---\n# 编码风格\n'
    );
    assert.strictEqual(
      toAntigravityRule('\uFEFF# T\r\nx\r\n'),
      '---\ntrigger: always_on\ndescription: "T"\n---\n# T\nx\n',
      'a byte order mark and CRLF line endings are handled'
    );
    assert.strictEqual(
      toAntigravityRule('no heading\n'),
      '---\ntrigger: always_on\n---\nno heading\n',
      'a rule without a heading has no description'
    );
  })) passed++; else failed++;

  if (test('an Antigravity rule links to the flat names of the rules it extends (#1668)', () => {
    const source = '# Go\n> extends [common/hooks.md](../common/hooks.md), see [git](./git-workflow.md), [perf](performance.md), [site](https://example.com/a.md)\n';
    assert.strictEqual(
      toAntigravityRule(source, { directory: 'web' }),
      '---\ntrigger: always_on\ndescription: "Go"\n---\n# Go\n> extends [common/hooks.md](common-hooks.md), see [git](web-git-workflow.md), [perf](web-performance.md), [site](https://example.com/a.md)\n'
    );
  })) passed++; else failed++;

  if (test('an Antigravity rule resolves links from its own directory, at any depth (#1668)', () => {
    assert.strictEqual(
      toAntigravityRule('# A\n[b](b.md) [c](../common/c.md) [up](../../x.md) [abs](/etc/y.md)\n', { directory: 'zh/sub' }),
      '---\ntrigger: always_on\ndescription: "A"\n---\n# A\n[b](zh-sub-b.md) [c](zh-common-c.md) [up](x.md) [abs](/etc/y.md)\n'
    );
    assert.strictEqual(
      toAntigravityRule('# A\n[b](b.md)\n', { directory: '' }),
      '---\ntrigger: always_on\ndescription: "A"\n---\n# A\n[b](b.md)\n',
      'a rule at the top of rules/ links to the top-level flat name'
    );
    assert.strictEqual(
      toAntigravityRule('# A\n[b](../../../out.md)\n', { directory: 'zh' }),
      '---\ntrigger: always_on\ndescription: "A"\n---\n# A\n[b](../../../out.md)\n',
      'a link that leaves rules/ is kept as it is'
    );
  })) passed++; else failed++;

  if (test('an Antigravity glob rule keeps a quoted comma inside a glob and expands its braces (#1668)', () => {
    assert.strictEqual(
      toAntigravityRule('---\npaths: ["**/*.{js,ts}", \'src/**\']\n---\n# X\n'),
      '---\ntrigger: glob\ndescription: "X"\nglobs: "**/*.js, **/*.ts, src/**"\n---\n# X\n'
    );
    assert.strictEqual(
      toAntigravityRule('---\npaths:\n  - "**/*.{c,h}{,pp}"\n---\n# C\n'),
      '---\ntrigger: glob\ndescription: "C"\nglobs: "**/*.c, **/*.cpp, **/*.h, **/*.hpp"\n---\n# C\n'
    );
  })) passed++; else failed++;

  if (test('no rule file is planned without a source root, so nothing depends on the working directory (#1668)', () => {
    assert.deepStrictEqual(planAntigravityRuleFiles(undefined, 'rules'), []);
    assert.deepStrictEqual(planAntigravityRuleFiles('', 'rules'), []);
  })) passed++; else failed++;

  if (test('every shipped rule reaches Antigravity with a valid trigger and under its 24,000-byte limit (#1668)', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const rules = planAntigravityRuleFiles(repoRoot, 'rules');
    assert.ok(rules.length > 100, 'the catalog rules are planned');
    assert.strictEqual(new Set(rules.map(rule => rule.fileName)).size, rules.length, 'no two rules share a file name');
    assert.ok(!rules.some(rule => rule.fileName.toLowerCase() === 'readme.md'), 'the rules README is not a rule');
    const names = new Set(rules.map(rule => rule.fileName));
    for (const rule of rules) {
      const content = plannedFileContent(path.join(repoRoot, rule.sourceRelativePath), rule.transform);
      const text = content.toString('utf8');
      const trigger = /^---\ntrigger: (\w+)\n/.exec(text)?.[1];
      const zh = rule.sourceRelativePath.startsWith('rules/zh/');
      assert.strictEqual(rule.transform, zh ? ANTIGRAVITY_MANUAL_RULE_FRONTMATTER_TRANSFORM : ANTIGRAVITY_RULE_FRONTMATTER_TRANSFORM, rule.sourceRelativePath);
      assert.ok(['always_on', 'glob', 'manual'].includes(trigger), `${rule.sourceRelativePath}: trigger ${trigger}`);
      if (trigger === 'glob') {
        assert.ok(/\nglobs: "[^"]+"\n/.test(text), `${rule.sourceRelativePath}: a glob rule names its globs`);
      }
      assert.ok(content.length <= 24000, `${rule.sourceRelativePath}: ${content.length} bytes`);
      for (const [, target] of text.matchAll(/\]\(([^)#:]+\.md)\)/g)) {
        assert.ok(names.has(target), `${rule.sourceRelativePath}: the link to ${target} reaches a planned rule`);
      }
    }
  })) passed++; else failed++;

  const agentResults = runAntigravityAgentTests();
  passed += agentResults.passed;
  failed += agentResults.failed;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) {
    process.exit(1);
  }
}

function runAntigravityAgentTests() {
  const results = [];
  results.push(test('an Antigravity subagent names only the tools Antigravity maps, with a model it accepts (#1669)', () => {
    assert.strictEqual(
      toAntigravityAgentFrontmatter('---\nname: architect\ndescription: Designs.\ntools: ["Read", "Grep", "Glob", "Bash", "Edit", "Write", "WebFetch", "mcp__context7__query-docs"]\nmodel: gemini-3.1-pro\ncolor: teal\nstack: ["*"]\n---\n\nBody\n'),
      '---\nname: architect\ndescription: Designs.\ntools:\n  - view_file\n  - grep_search\n  - run_command\n  - replace_file_content\n  - write_to_file\nmodel: pro\n---\n\nBody\n'
    );
    assert.strictEqual(
      toAntigravityAgentFrontmatter('---\nname: a\ndescription: d\ntools:\n  - Read\n  - MultiEdit\nmodel: gemini-3.6-flash\n---\nx\n'),
      '---\nname: a\ndescription: d\ntools:\n  - view_file\n  - multi_replace_file_content\nmodel: flash\n---\nx\n',
      'a block list and a flash model'
    );
    assert.strictEqual(
      toAntigravityAgentFrontmatter('---\nname: a\ndescription: d\ntools: ["Glob"]\nmodel: sonnet\n---\nx\n'),
      '---\nname: a\ndescription: d\n---\nx\n',
      'no mapped tool leaves the default, and a model Antigravity does not name inherits'
    );
    assert.strictEqual(
      toAntigravityAgentFrontmatter('---\nname: a\ndescription: d\ntools: [Read,\n  Grep,\n  Bash]\nmodel: pro\n---\nx\n'),
      '---\nname: a\ndescription: d\ntools:\n  - view_file\n  - grep_search\n  - run_command\nmodel: pro\n---\nx\n',
      'a flow list over several lines is read whole'
    );
    assert.strictEqual(toAntigravityAgentFrontmatter('# no frontmatter\n'), '# no frontmatter\n');
  }));

  results.push(test('every shipped agent reaches Antigravity with a name, a description, mapped tools and a valid model (#1669)', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const agents = planAntigravityAgentFiles(repoRoot, 'agents');
    assert.ok(agents.length > 50, 'the catalog agents are planned');
    assert.strictEqual(new Set(agents.map(agent => agent.fileName)).size, agents.length, 'no two agents share a file name');
    for (const agent of agents) {
      assertAntigravityAgent(repoRoot, agent);
    }
  }));

  return { passed: results.filter(Boolean).length, failed: results.filter(result => !result).length };
}

if (require.main === module) {
  runTests();
}

module.exports = { runTests };
