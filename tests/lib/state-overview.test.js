/**
 * Tests for scripts/lib/state-overview.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  collectProjectStates,
  parseStateFile,
  renderOverviewMarkdown,
} = require('../../scripts/lib/state-overview');

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

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function stateDocument({ project, branch, updated, context, next }) {
  return [
    '# Project State',
    `project: ${project}`,
    `branch: ${branch}`,
    `updated: ${updated}`,
    '',
    '## Context',
    context,
    '',
    '## Active Decisions',
    '- decided one: because',
    '- decided two: because',
    '',
    '## Do Not Repeat',
    '- avoid this: it failed',
    '',
    '## Preferences',
    '- keep output in English',
    '',
    '## Next Session',
    ...next.map(item => `- ${item}`),
    '',
  ].join('\n');
}

function main() {
  let passed = 0;
  let failed = 0;

  console.log('Testing state-overview...\n');

  if (test('parseStateFile extracts header fields and sections', () => {
    const parsed = parseStateFile(stateDocument({
      project: '/tmp/demo',
      branch: 'main',
      updated: '2026-07-07T00:00:00.000Z',
      context: 'Demo project in phase one.',
      next: ['ship the overview command'],
    }));
    assert.strictEqual(parsed.header.project, '/tmp/demo');
    assert.strictEqual(parsed.header.branch, 'main');
    assert.strictEqual(parsed.header.updated, '2026-07-07T00:00:00.000Z');
    assert.strictEqual(parsed.sections.Context, 'Demo project in phase one.');
    assert.ok(parsed.sections['Next Session'].includes('ship the overview command'));
  })) passed++; else failed++;

  if (test('collects branch-layout and flat-layout projects together', () => {
    const stateDir = createTempDir('egc-overview-');
    try {
      fs.mkdirSync(path.join(stateDir, 'Projetos--alpha'));
      fs.writeFileSync(
        path.join(stateDir, 'Projetos--alpha', 'main.md'),
        stateDocument({
          project: '/home/user/Projetos/alpha',
          branch: 'main',
          updated: '2026-07-07T10:00:00.000Z',
          context: 'Alpha context.',
          next: ['alpha next step'],
        })
      );
      fs.writeFileSync(
        path.join(stateDir, 'Projetos--alpha', 'feat-x.md'),
        stateDocument({
          project: '/home/user/Projetos/alpha',
          branch: 'feat-x',
          updated: '2026-07-06T10:00:00.000Z',
          context: 'Alpha feature branch context.',
          next: [],
        })
      );
      fs.writeFileSync(
        path.join(stateDir, 'legacy-project.md'),
        stateDocument({
          project: '/home/user/legacy-project',
          branch: 'main',
          updated: '2026-07-05T10:00:00.000Z',
          context: 'Legacy flat file context.',
          next: ['migrate to branch layout'],
        })
      );
      fs.writeFileSync(path.join(stateDir, 'notes.json'), '{}');

      const overview = collectProjectStates({ stateDir });
      assert.strictEqual(overview.entries.length, 2);

      const alpha = overview.entries.find(entry => entry.slug === 'Projetos--alpha');
      assert.ok(alpha);
      assert.strictEqual(alpha.layout, 'branch');
      assert.strictEqual(alpha.branch, 'main');
      assert.strictEqual(alpha.branchStateCount, 2);
      assert.strictEqual(alpha.context, 'Alpha context.');
      assert.deepStrictEqual(alpha.next, ['alpha next step']);
      assert.strictEqual(alpha.decisionCount, 2);
      assert.strictEqual(alpha.avoidCount, 1);
      assert.strictEqual(alpha.preferenceCount, 1);

      const legacy = overview.entries.find(entry => entry.slug === 'legacy-project');
      assert.ok(legacy);
      assert.strictEqual(legacy.layout, 'flat');

      assert.strictEqual(overview.entries[0].slug, 'Projetos--alpha');
    } finally {
      cleanup(stateDir);
    }
  })) passed++; else failed++;

  if (test('branch directory takes precedence over same-slug flat file', () => {
    const stateDir = createTempDir('egc-overview-');
    try {
      fs.mkdirSync(path.join(stateDir, 'Projetos--beta'));
      fs.writeFileSync(
        path.join(stateDir, 'Projetos--beta', 'main.md'),
        stateDocument({
          project: '/home/user/Projetos/beta',
          branch: 'main',
          updated: '2026-07-07T10:00:00.000Z',
          context: 'Beta branch layout.',
          next: [],
        })
      );
      fs.writeFileSync(
        path.join(stateDir, 'Projetos--beta.md'),
        stateDocument({
          project: '/home/user/Projetos/beta',
          branch: 'main',
          updated: '2026-01-01T00:00:00.000Z',
          context: 'Beta stale flat file.',
          next: [],
        })
      );

      const overview = collectProjectStates({ stateDir });
      assert.strictEqual(overview.entries.length, 1);
      assert.strictEqual(overview.entries[0].layout, 'branch');
      assert.strictEqual(overview.entries[0].context, 'Beta branch layout.');
    } finally {
      cleanup(stateDir);
    }
  })) passed++; else failed++;

  if (test('falls back to newest branch file when main.md is absent', () => {
    const stateDir = createTempDir('egc-overview-');
    try {
      const dirPath = path.join(stateDir, 'Projetos--gamma');
      fs.mkdirSync(dirPath);
      fs.writeFileSync(path.join(dirPath, 'feat-old.md'), stateDocument({
        project: '/home/user/Projetos/gamma',
        branch: 'feat-old',
        updated: '2026-07-01T00:00:00.000Z',
        context: 'Old branch.',
        next: [],
      }));
      fs.writeFileSync(path.join(dirPath, 'feat-new.md'), stateDocument({
        project: '/home/user/Projetos/gamma',
        branch: 'feat-new',
        updated: '2026-07-07T00:00:00.000Z',
        context: 'New branch.',
        next: [],
      }));
      const past = new Date(Date.now() - 60000);
      fs.utimesSync(path.join(dirPath, 'feat-old.md'), past, past);

      const overview = collectProjectStates({ stateDir });
      assert.strictEqual(overview.entries.length, 1);
      assert.strictEqual(overview.entries[0].branch, 'feat-new');
    } finally {
      cleanup(stateDir);
    }
  })) passed++; else failed++;

  if (test('handles missing state root and malformed files without throwing', () => {
    const missing = collectProjectStates({
      stateDir: path.join(os.tmpdir(), 'egc-overview-does-not-exist'),
    });
    assert.deepStrictEqual(missing.entries, []);

    const stateDir = createTempDir('egc-overview-');
    try {
      fs.writeFileSync(path.join(stateDir, 'broken.md'), 'not a state file at all');
      const overview = collectProjectStates({ stateDir });
      assert.strictEqual(overview.entries.length, 1);
      assert.strictEqual(overview.entries[0].error, null);
      assert.strictEqual(overview.entries[0].context, null);
      assert.deepStrictEqual(overview.entries[0].next, []);
    } finally {
      cleanup(stateDir);
    }
  })) passed++; else failed++;

  if (test('renderOverviewMarkdown produces the aggregated document', () => {
    const stateDir = createTempDir('egc-overview-');
    try {
      fs.mkdirSync(path.join(stateDir, 'Projetos--delta'));
      fs.writeFileSync(
        path.join(stateDir, 'Projetos--delta', 'main.md'),
        stateDocument({
          project: '/home/user/Projetos/delta',
          branch: 'main',
          updated: '2026-07-07T10:00:00.000Z',
          context: 'Delta context line.',
          next: ['delta task'],
        })
      );

      const overview = collectProjectStates({ stateDir });
      const markdown = renderOverviewMarkdown(overview);
      assert.ok(markdown.startsWith('# EGC State Overview'));
      assert.ok(markdown.includes('Projects: 1'));
      assert.ok(markdown.includes('## /home/user/Projetos/delta'));
      assert.ok(markdown.includes('- Context: Delta context line.'));
      assert.ok(markdown.includes('  - delta task'));
      assert.ok(markdown.includes('2 decisions, 1 avoid rules, 1 preferences'));
    } finally {
      cleanup(stateDir);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
