'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  appendSkillObservation,
  createSkillObservation,
  getSkillObservationsPath,
  readSkillObservations
} = require('../../scripts/lib/skill-improvement/observations');
const { buildSkillHealthReport } = require('../../scripts/lib/skill-improvement/health');
const { proposeSkillAmendment } = require('../../scripts/lib/skill-improvement/amendify');
const { buildSkillEvaluationScaffold } = require('../../scripts/lib/skill-improvement/evaluate');

console.log('=== Testing skill-improvement ===\n');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`  ✗ ${name}: ${error.message}`);
    failed += 1;
  }
}

function makeProjectRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

test('observation layer writes and reads structured skill outcomes', () => {
  const projectRoot = makeProjectRoot('egc-skill-observe-');

  try {
    const observation = createSkillObservation({
      task: 'Fix flaky Playwright test',
      skill: {
        id: 'e2e-testing',
        path: 'skills/testing/e2e-testing/SKILL.md'
      },
      success: false,
      error: 'playwright timeout',
      feedback: 'Timed out waiting for locator',
      sessionId: 'sess-1234'
    });

    appendSkillObservation(observation, { projectRoot });
    const records = readSkillObservations({ projectRoot });

    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].schemaVersion, 'egc.skill-observation.v1');
    assert.strictEqual(records[0].task, 'Fix flaky Playwright test');
    assert.strictEqual(records[0].skill.id, 'e2e-testing');
    assert.strictEqual(records[0].outcome.success, false);
    assert.strictEqual(records[0].outcome.error, 'playwright timeout');
    assert.strictEqual(getSkillObservationsPath({ projectRoot }), path.join(projectRoot, '.egc', 'skills', 'observations.jsonl'));
  } finally {
    cleanup(projectRoot);
  }
});

test('observations recorded under the old .gemini/egc/skills of a project are still read, before the current ones', () => {
  const projectRoot = makeProjectRoot('egc-skill-observe-legacy-');

  try {
    const legacyDir = path.join(projectRoot, '.gemini', 'egc', 'skills');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'observations.jsonl'), JSON.stringify({
      schemaVersion: 'egc.skill-observation.v1',
      observationId: 'obs-legacy',
      timestamp: '2026-09-01T00:00:00.000Z',
      task: 'Recorded before the move',
      skill: { id: 'e2e-testing', path: 'skills/testing/e2e-testing/SKILL.md' },
      outcome: { success: true, status: 'success', error: null, feedback: null },
      run: { variant: 'baseline', amendmentId: null, sessionId: 'sess-legacy' }
    }) + '\n');

    appendSkillObservation(createSkillObservation({
      task: 'Recorded after the move',
      skill: { id: 'e2e-testing', path: 'skills/testing/e2e-testing/SKILL.md' },
      success: true,
      sessionId: 'sess-current'
    }), { projectRoot });

    const records = readSkillObservations({ projectRoot });
    assert.deepStrictEqual(records.map(record => record.task), ['Recorded before the move', 'Recorded after the move']);
    assert.ok(fs.existsSync(path.join(projectRoot, '.egc', 'skills', 'observations.jsonl')), 'the new observation lands in .egc/skills');
    assert.strictEqual(fs.readFileSync(path.join(legacyDir, 'observations.jsonl'), 'utf8').split('\n').filter(Boolean).length, 1, 'the old file is read, never written');
  } finally {
    cleanup(projectRoot);
  }
});

test('health inspector traces recurring failures for a skill across runs', () => {
  const projectRoot = makeProjectRoot('egc-skill-health-');

  try {
    [
      createSkillObservation({
        task: 'Ship Next.js auth middleware',
        skill: { id: 'security-review', path: 'skills/security/security-review/SKILL.md' },
        success: false,
        error: 'missing csrf guidance',
        feedback: 'Did not mention CSRF'
      }),
      createSkillObservation({
        task: 'Harden Next.js auth middleware',
        skill: { id: 'security-review', path: 'skills/security/security-review/SKILL.md' },
        success: false,
        error: 'missing csrf guidance',
        feedback: 'Repeated omission'
      }),
      createSkillObservation({
        task: 'Review payment webhook security',
        skill: { id: 'security-review', path: 'skills/security/security-review/SKILL.md' },
        success: true
      })
    ].forEach(record => appendSkillObservation(record, { projectRoot }));

    const report = buildSkillHealthReport(readSkillObservations({ projectRoot }), {
      minFailureCount: 2
    });
    const skill = report.skills.find(entry => entry.skill.id === 'security-review');

    assert.ok(skill, 'security-review should appear in the report');
    assert.strictEqual(skill.totalRuns, 3);
    assert.strictEqual(skill.failures, 2);
    assert.strictEqual(skill.status, 'failing');
    assert.strictEqual(skill.recurringErrors[0].error, 'missing csrf guidance');
    assert.strictEqual(skill.recurringErrors[0].count, 2);
  } finally {
    cleanup(projectRoot);
  }
});

test('amendify proposes SKILL.md patch content from failure evidence', () => {
  const records = [
    createSkillObservation({
      task: 'Add API rate limiting',
      skill: { id: 'api-design', path: 'skills/backend/api-design/SKILL.md' },
      success: false,
      error: 'missing rate limiting guidance',
      feedback: 'No rate-limit section'
    }),
    createSkillObservation({
      task: 'Design public API error envelopes',
      skill: { id: 'api-design', path: 'skills/backend/api-design/SKILL.md' },
      success: false,
      error: 'missing error response examples',
      feedback: 'Need explicit examples'
    })
  ];

  const proposal = proposeSkillAmendment('api-design', records);

  assert.strictEqual(proposal.schemaVersion, 'egc.skill-amendment-proposal.v1');
  assert.strictEqual(proposal.skill.id, 'api-design');
  assert.strictEqual(proposal.status, 'proposed');
  assert.ok(proposal.patch.preview.includes('## Failure-Driven Amendments'));
  assert.ok(proposal.patch.preview.includes('rate limiting'));
  assert.ok(proposal.patch.preview.includes('error response'));
});

test('evaluation scaffold compares amended and baseline performance', () => {
  const records = [
    createSkillObservation({
      task: 'Fix flaky login test',
      skill: { id: 'e2e-testing', path: 'skills/testing/e2e-testing/SKILL.md' },
      success: false,
      variant: 'baseline'
    }),
    createSkillObservation({
      task: 'Fix flaky checkout test',
      skill: { id: 'e2e-testing', path: 'skills/testing/e2e-testing/SKILL.md' },
      success: true,
      variant: 'baseline'
    }),
    createSkillObservation({
      task: 'Fix flaky login test',
      skill: { id: 'e2e-testing', path: 'skills/testing/e2e-testing/SKILL.md' },
      success: true,
      variant: 'amended',
      amendmentId: 'amend-1'
    }),
    createSkillObservation({
      task: 'Fix flaky checkout test',
      skill: { id: 'e2e-testing', path: 'skills/testing/e2e-testing/SKILL.md' },
      success: true,
      variant: 'amended',
      amendmentId: 'amend-1'
    })
  ];

  const evaluation = buildSkillEvaluationScaffold('e2e-testing', records, {
    amendmentId: 'amend-1',
    minimumRunsPerVariant: 2
  });

  assert.strictEqual(evaluation.schemaVersion, 'egc.skill-evaluation.v1');
  assert.strictEqual(evaluation.baseline.runs, 2);
  assert.strictEqual(evaluation.amended.runs, 2);
  assert.strictEqual(evaluation.delta.successRate, 0.5);
  assert.strictEqual(evaluation.recommendation, 'promote-amendment');
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
