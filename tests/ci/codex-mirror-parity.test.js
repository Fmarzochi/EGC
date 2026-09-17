#!/usr/bin/env node
/**
 * The Codex-facing copies in .agents/skills are derived from the catalog:
 * same body, frontmatter reduced to the keys Codex accepts. This test fails
 * when a copy drifts from what scripts/ci/codex-mirror.js would write.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  CODEX_FRONTMATTER_KEYS,
  checkCodexMirror,
  listMirrorSkills,
  toCodexSkill,
  writeCodexMirror,
} = require('../../scripts/ci/codex-mirror');

const REPO_ROOT = path.join(__dirname, '..', '..');

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

function run() {
  console.log('\n=== Testing Codex mirror parity ===\n');
  let passed = 0;
  let failed = 0;

  if (test('toCodexSkill keeps the Codex keys with their nested lines and drops the others, body untouched', () => {
    const source = [
      '---',
      'name: demo',
      'description: >',
      '  a folded',
      '  description',
      'origin: EGC',
      'version: 1.2.0',
      'metadata:',
      '  author: someone',
      '  tags: [a, b]',
      'tools: Read, Write',
      'license: MIT',
      '---',
      '',
      '# Demo',
      '',
      'body with --- inside',
      '',
    ].join('\n');
    const expected = [
      '---',
      'name: demo',
      'description: >',
      '  a folded',
      '  description',
      'metadata:',
      '  author: someone',
      '  tags: [a, b]',
      'license: MIT',
      '---',
      '',
      '# Demo',
      '',
      'body with --- inside',
      '',
    ].join('\n');
    assert.strictEqual(toCodexSkill(source), expected);
    assert.strictEqual(toCodexSkill('no frontmatter\n'), 'no frontmatter\n');
    assert.strictEqual(toCodexSkill('---\r\nname: crlf\r\norigin: EGC\r\n---\r\nbody\r\n'), '---\nname: crlf\n---\r\nbody\r\n');
    assert.deepStrictEqual([...CODEX_FRONTMATTER_KEYS].sort(), ['allowed-tools', 'description', 'license', 'metadata', 'name']);
  })) passed++; else failed++;

  if (test('every real mirror directory with a catalog counterpart matches what the generator writes', () => {
    const skills = listMirrorSkills(REPO_ROOT);
    assert.ok(skills.length > 0, 'the mirror has catalog-backed entries');
    for (const skill of skills) {
      assert.ok(skill.files.includes('SKILL.md'), `${skill.name} carries a SKILL.md`);
    }
    const { drifted } = checkCodexMirror(REPO_ROOT);
    assert.deepStrictEqual(drifted, [], `run 'node scripts/ci/codex-mirror.js --write' to regenerate:\n${drifted.join('\n')}`);
  })) passed++; else failed++;

  if (test('the generator regenerates a drifted copy in place and leaves the rest alone', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mirror-'));
    try {
      const catalog = path.join(root, 'skills', 'testing', 'demo');
      const mirror = path.join(root, '.agents', 'skills', 'demo');
      const lone = path.join(root, '.agents', 'skills', 'lone');
      fs.mkdirSync(catalog, { recursive: true });
      fs.mkdirSync(path.join(mirror, 'agents'), { recursive: true });
      fs.mkdirSync(path.join(lone, 'agents'), { recursive: true });
      fs.writeFileSync(path.join(catalog, 'SKILL.md'), '---\nname: demo\ndescription: d\norigin: EGC\n---\nnew body\n');
      fs.writeFileSync(path.join(catalog, 'NOTES.md'), 'notes v2\n');
      fs.writeFileSync(path.join(mirror, 'SKILL.md'), '---\nname: demo\ndescription: d\n---\nold body\n');
      fs.writeFileSync(path.join(mirror, 'NOTES.md'), 'notes v1\n');
      fs.writeFileSync(path.join(mirror, 'agents', 'openai.yaml'), 'interface: {}\n');
      fs.writeFileSync(path.join(lone, 'SKILL.md'), '---\nname: lone\ndescription: only here\n---\nkept\n');
      fs.writeFileSync(path.join(lone, 'agents', 'openai.yaml'), 'interface: {}\n');

      assert.deepStrictEqual(checkCodexMirror(root).drifted, ['.agents/skills/demo/NOTES.md', '.agents/skills/demo/SKILL.md']);
      const { written } = writeCodexMirror(root);
      assert.deepStrictEqual(written, ['.agents/skills/demo/NOTES.md', '.agents/skills/demo/SKILL.md']);
      assert.strictEqual(fs.readFileSync(path.join(mirror, 'SKILL.md'), 'utf8'), '---\nname: demo\ndescription: d\n---\nnew body\n');
      assert.strictEqual(fs.readFileSync(path.join(mirror, 'NOTES.md'), 'utf8'), 'notes v2\n');
      assert.strictEqual(fs.readFileSync(path.join(mirror, 'agents', 'openai.yaml'), 'utf8'), 'interface: {}\n', 'the Codex metadata is not the catalog\'s to write');
      assert.strictEqual(fs.readFileSync(path.join(lone, 'SKILL.md'), 'utf8'), '---\nname: lone\ndescription: only here\n---\nkept\n', 'a skill without a catalog counterpart stays hand-maintained');
      assert.deepStrictEqual(checkCodexMirror(root).drifted, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  run();
}

module.exports = { run };
