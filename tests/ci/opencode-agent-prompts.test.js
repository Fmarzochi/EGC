'use strict';
/**
 * Every agent under agents/ has its OpenCode prompt under
 * .opencode/prompts/agents, and that prompt is the body of the definition:
 * a new agent without a prompt, or a prompt edited away from its source,
 * fails here until node scripts/opencode-agent-prompts.js runs (#2141).
 *
 * Run with: node tests/ci/opencode-agent-prompts.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  agentPromptBody, driftReport, writePrompts,
  agentFrontmatter, registryEntry, registryDrift, writeRegistry, CONFIG_FILE,
} = require('../../scripts/opencode-agent-prompts');

const ROOT = path.join(__dirname, '..', '..');
let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

console.log('\n=== OpenCode agent prompts in step with agents/ ===\n');

test('the prompt is the agent body without the frontmatter, with one final newline', () => {
  assert.strictEqual(agentPromptBody('---\nname: x\ntools: ["Read"]\n---\n\nYou are x.\n\n## Role\n- a\n'), 'You are x.\n\n## Role\n- a\n');
  assert.strictEqual(agentPromptBody('---\r\nname: x\r\n---\r\nYou are x.\r\n'), 'You are x.\n');
  assert.strictEqual(agentPromptBody('No frontmatter at all'), 'No frontmatter at all\n');
  assert.strictEqual(agentPromptBody(String.fromCharCode(0xFEFF) + '---\nname: x\n---\nYou are x.\n'), 'You are x.\n', 'a BOM before the dashes is still frontmatter');
  assert.strictEqual(agentPromptBody('---\nname: x\n---'), '\n', 'a frontmatter that ends with the file leaves an empty prompt, not the YAML');
});

test('every agent has a prompt, no prompt drifted and no prompt is without an agent', () => {
  const report = driftReport(ROOT);
  assert.ok(report.total >= 60, `expected the agent library, found ${report.total}`);
  assert.deepStrictEqual(report.missing, [], `agents without a prompt: ${report.missing.join(', ')}`);
  assert.deepStrictEqual(report.drifted, [], `prompts drifted from agents/: ${report.drifted.join(', ')}`);
  assert.deepStrictEqual(report.orphans, [], `prompts without an agent: ${report.orphans.join(', ')}`);
});

test('writePrompts creates a missing prompt and rewrites a drifted one, and leaves the rest untouched', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-opencode-prompts-'));
  try {
    fs.mkdirSync(path.join(root, 'agents'));
    fs.writeFileSync(path.join(root, 'agents', 'one.md'), '---\nname: one\n---\nYou are one.\n');
    fs.writeFileSync(path.join(root, 'agents', 'two.md'), '---\nname: two\n---\nYou are two.\n');
    const promptsDir = path.join(root, '.opencode', 'prompts', 'agents');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, 'two.txt'), 'edited by hand\n');
    fs.writeFileSync(path.join(promptsDir, 'stray.txt'), 'no agent\n');

    const before = driftReport(root);
    assert.deepStrictEqual(before, { missing: ['one'], drifted: ['two'], orphans: ['stray'], total: 2 });

    assert.deepStrictEqual(writePrompts(root), { written: 2, total: 2 });
    assert.strictEqual(fs.readFileSync(path.join(promptsDir, 'one.txt'), 'utf8'), 'You are one.\n');
    assert.strictEqual(fs.readFileSync(path.join(promptsDir, 'two.txt'), 'utf8'), 'You are two.\n');
    assert.deepStrictEqual(writePrompts(root), { written: 0, total: 2 }, 'a second run writes nothing');
    assert.deepStrictEqual(driftReport(root).orphans, ['stray'], 'a stray prompt is reported, never deleted');

    fs.writeFileSync(path.join(promptsDir, 'one.txt'), 'You are one.\r\n');
    assert.deepStrictEqual(driftReport(root).drifted, [], 'a checkout that converted the line endings is not a drift');
    assert.deepStrictEqual(writePrompts(root), { written: 0, total: 2 }, 'and nothing is rewritten for it');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a registry entry carries the description, the model tier, the prompt file and the tool toggles of its definition', () => {
  const pro = registryEntry('x', '---\nname: x\ndescription: Does x. Use for x.\ntools: ["Read", "Grep", "Glob", "Bash"]\nmodel: gemini-3.1-pro\n---\nYou are x.\n');
  assert.deepStrictEqual(pro, {
    description: 'Does x. Use for x.',
    mode: 'subagent',
    model: 'pro',
    prompt: '{file:prompts/agents/x.txt}',
    tools: { read: true, bash: true, write: false, edit: false },
  });
  const flash = registryEntry('y', '---\nname: y\ndescription: Does y\ntools: [Read, Write, Edit]\nmodel: gemini-3.6-flash\n---\nYou are y.\n');
  assert.strictEqual(flash.model, 'flash', 'a flash model is the fast tier');
  assert.deepStrictEqual(flash.tools, { read: true, bash: false, write: true, edit: true }, 'an unquoted list reads the same as a quoted one');
  const bare = registryEntry('z', '---\nname: z\ndescription: Does z\nmodel: sonnet\n---\nYou are z.\n');
  assert.strictEqual(bare.model, 'pro', 'any other model is the pro tier');
  assert.ok(!Object.hasOwn(bare, 'tools'), 'no tools field leaves the toggles to OpenCode');
  const mcp = registryEntry('docs', '---\nname: docs\ndescription: "Looks things up."\ntools: ["Read", "Grep", "mcp__context7__resolve-library-id", "mcp__context7__query-docs"]\n---\nYou look up.\n');
  assert.strictEqual(mcp.description, 'Looks things up.', 'a quoted description loses its quotes');
  assert.deepStrictEqual(mcp.tools, {
    read: true, bash: false, write: false, edit: false,
    'mcp__context7__resolve-library-id': true, 'mcp__context7__query-docs': true,
  }, 'an MCP tool the definition names stays enabled under its own key');
  const block = registryEntry('b', '---\nname: b\ndescription: Block list\ntools:\n  - Read\n  - "Bash"\n  - mcp__github__get_issue\nmodel: gemini-3.1-pro\n---\nYou are b.\n');
  assert.deepStrictEqual(block.tools, { read: true, bash: true, write: false, edit: false, mcp__github__get_issue: true }, 'a tools list written in block form reads like the flow form');
  assert.deepStrictEqual(agentFrontmatter('No frontmatter at all'), {});
  assert.deepStrictEqual(agentFrontmatter("---\nname: 'q'\ntools:\n---\nBody\n"), { name: 'q', tools: [] }, 'single quotes drop too, and an empty block list is empty');
});

test('writeRegistry keeps the primary agents and the other sections, registers every definition and drops an entry without an agent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-opencode-registry-'));
  try {
    fs.mkdirSync(path.join(root, 'agents'));
    fs.writeFileSync(path.join(root, 'agents', 'one.md'), '---\nname: one\ndescription: Does one\ntools: ["Read", "Bash"]\nmodel: gemini-3.1-pro\n---\nYou are one.\n');
    fs.writeFileSync(path.join(root, 'agents', 'two.md'), '---\nname: two\ndescription: Does two\ntools: ["Read", "Write", "Edit", "Bash"]\n---\nYou are two.\n');
    fs.mkdirSync(path.join(root, '.opencode'), { recursive: true });
    const build = { description: 'Primary coding agent', mode: 'primary', model: 'flash', tools: { write: true, edit: true, bash: true, read: true } };
    fs.writeFileSync(path.join(root, CONFIG_FILE), JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      model: 'flash',
      agent: {
        build,
        two: { description: 'edited by hand', mode: 'subagent', model: 'pro', prompt: '{file:prompts/agents/two.txt}' },
        gone: { description: 'no agent', mode: 'subagent', model: 'pro', prompt: '{file:prompts/agents/gone.txt}' },
      },
      command: { plan: { description: 'p', template: 't', agent: 'planner' } },
      permission: { 'mcp_*': 'ask' },
    }, null, 2));

    assert.deepStrictEqual(registryDrift(root), { missing: ['one'], drifted: ['two'], orphans: ['gone'], total: 3 });
    assert.deepStrictEqual(writeRegistry(root), { written: true, total: 3 });

    const config = JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), 'utf8'));
    assert.deepStrictEqual(Object.keys(config), ['$schema', 'model', 'agent', 'command', 'permission'], 'the other sections stay in their place');
    assert.strictEqual(config.$schema, 'https://opencode.ai/config.json');
    assert.strictEqual(config.model, 'flash');
    assert.deepStrictEqual(config.permission, { 'mcp_*': 'ask' }, 'the permission section is kept as written');
    assert.deepStrictEqual(Object.keys(config.agent), ['build', 'one', 'two'], 'the primary agent first, then one entry per definition, the stray one gone');
    assert.deepStrictEqual(config.agent.build, build, 'the primary agent is kept as written');
    assert.strictEqual(config.agent.two.description, 'Does two');
    assert.deepStrictEqual(config.agent.one.tools, { read: true, bash: true, write: false, edit: false });
    assert.deepStrictEqual(config.command, { plan: { description: 'p', template: 't', agent: 'planner' } });
    assert.deepStrictEqual(writeRegistry(root), { written: false, total: 3 }, 'a second run writes nothing');
    assert.deepStrictEqual(registryDrift(root), { missing: [], drifted: [], orphans: [], total: 3 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('every agent is registered in opencode.json, no entry drifted and no entry is without an agent', () => {
  const report = registryDrift(ROOT);
  const definitions = fs.readdirSync(path.join(ROOT, 'agents')).filter(name => name.endsWith('.md')).length;
  assert.strictEqual(report.total, definitions + 1, `expected the ${definitions} agents plus the primary build agent, found ${report.total}`);
  assert.ok(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(ROOT, CONFIG_FILE), 'utf8')).agent, 'build'), 'the primary build agent stays registered');
  assert.deepStrictEqual(report.missing, [], `agents without a registry entry: ${report.missing.join(', ')}`);
  assert.deepStrictEqual(report.drifted, [], `registry entries drifted from agents/: ${report.drifted.join(', ')}`);
  assert.deepStrictEqual(report.orphans, [], `registry entries without an agent: ${report.orphans.join(', ')}`);
});

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
