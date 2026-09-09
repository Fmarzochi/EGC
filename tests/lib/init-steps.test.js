/**
 * Tests for the step summaries of `egc init`: the cognitive bootstrap and
 * the state-store bootstrap output read into one check line each, and the
 * MCP registration line built from the per-target callbacks.
 */

const assert = require('node:assert');
const path = require('node:path');

const {
  summarizeCognitiveOutput,
  describeCognitiveSummary,
  parseStateDbOutput,
  describeRegistration,
  joinNames,
  plural,
} = require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'init-steps.js'));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (error) {
    console.log(`  \u2717 ${name}`);
    console.log(`    Error: ${error.message}`);
    failed++;
  }
}

const UP_TO_DATE = [
  '  [cognitive] Claude Code: already configured (v6)',
  '  [cognitive] Antigravity (Gemini home): already configured (v6)',
  '  [cognitive] Codex: already configured (v6)',
  '  [cognitive] Kiro: already configured',
  '  [cognitive] Windsurf: already configured (v6)',
  '  [cognitive] Zed: already configured (v6)',
  '',
].join('\n');

const MIXED = [
  '  [cognitive] Claude Code: memory protocol upgraded v5 -> v6 (~/.claude/CLAUDE.md)',
  '  [cognitive] Antigravity (Gemini home): already configured (v6)',
  '  [cognitive] Cursor: memory protocol installed (~/.cursor/rules)',
  '  [cognitive] Codex: memory protocol upgraded v5 -> v6 (~/.codex/config.toml)',
  '  [cognitive] Kiro: session hooks installed (~/.kiro/hooks/)',
  '  [cognitive] Windsurf: already configured (v6)',
  '  [cognitive] Zed: already configured (v6)',
].join('\n');

test('summarizeCognitiveOutput groups every tool by what happened to it', () => {
  const summary = summarizeCognitiveOutput(MIXED);
  assert.strictEqual(summary.tools.length, 7);
  assert.deepStrictEqual(summary.upToDate.map(t => t.label), ['Antigravity (Gemini home)', 'Windsurf', 'Zed']);
  assert.deepStrictEqual(summary.installed.map(t => t.label), ['Cursor', 'Kiro']);
  assert.deepStrictEqual(summary.upgraded.map(t => t.label), ['Claude Code', 'Codex']);
  assert.strictEqual(summary.upgraded[0].from, '5');
  assert.strictEqual(summary.upgraded[0].path, '~/.claude/CLAUDE.md');
  assert.strictEqual(summary.version, 6);
  assert.deepStrictEqual(summary.errors, []);
  assert.deepStrictEqual(summary.other, []);
});

test('summarizeCognitiveOutput keeps skips, errors and foreign lines', () => {
  const summary = summarizeCognitiveOutput([
    '  [cognitive] Codex: persistent_instructions multiline: skipping',
    '  [cognitive] Cursor: settings.json is not valid JSON (JSONC?): skipping',
    '  [cognitive] Zed: unexpected error: EACCES: permission denied',
    '  [cognitive] Trae (.trae): already configured (vlegacy)',
    'something the child printed on its own',
  ].join('\n'));
  assert.deepStrictEqual(summary.skipped.map(t => t.reason), ['persistent_instructions multiline', 'settings.json is not valid JSON (JSONC?)']);
  assert.deepStrictEqual(summary.errors.map(t => t.reason), ['EACCES: permission denied']);
  assert.strictEqual(summary.upToDate.length, 1, 'a legacy block without a version still counts as configured');
  assert.strictEqual(summary.version, null, 'vlegacy is not a version number');
  assert.deepStrictEqual(summary.other, ['something the child printed on its own']);
});

test('describeCognitiveSummary is one line when every tool is up to date', () => {
  const result = describeCognitiveSummary(summarizeCognitiveOutput(UP_TO_DATE));
  assert.strictEqual(result.level, 'ok');
  assert.strictEqual(result.detail, '6 tools up to date (v6)');
  assert.deepStrictEqual(result.details, []);
});

test('describeCognitiveSummary names the tools that changed and details each one', () => {
  const result = describeCognitiveSummary(summarizeCognitiveOutput(MIXED));
  assert.strictEqual(result.level, 'ok');
  assert.strictEqual(result.detail, 'installed in Cursor and Kiro, upgraded in Claude Code and Codex (v6); 3 tools already up to date');
  assert.deepStrictEqual(result.details, [
    'Cursor  memory protocol installed (~/.cursor/rules)',
    'Kiro  session hooks installed (~/.kiro/hooks/)',
    'Claude Code  memory protocol upgraded v5 -> v6 (~/.claude/CLAUDE.md)',
    'Codex  memory protocol upgraded v5 -> v6 (~/.codex/config.toml)',
  ]);
});

test('describeCognitiveSummary warns when a tool failed and lists skips and foreign lines', () => {
  const result = describeCognitiveSummary(summarizeCognitiveOutput([
    '  [cognitive] Claude Code: already configured (v6)',
    '  [cognitive] Codex: persistent_instructions multiline: skipping',
    '  [cognitive] Zed: unexpected error: EACCES: permission denied',
    'stray line',
  ].join('\n')));
  assert.strictEqual(result.level, 'warn');
  assert.strictEqual(result.detail, '1 tool up to date (v6); 1 tool skipped; 1 tool failed');
  assert.deepStrictEqual(result.details, [
    'Codex  persistent_instructions multiline',
    'Zed  EACCES: permission denied',
    'stray line',
  ]);
});

test('describeCognitiveSummary warns on a skipped tool alone: the protocol is not in that tool', () => {
  const result = describeCognitiveSummary(summarizeCognitiveOutput([
    '  [cognitive] Claude Code: already configured (v6)',
    '  [cognitive] Cursor: settings.json is not valid JSON (JSONC?): skipping',
  ].join('\n')));
  assert.strictEqual(result.level, 'warn');
  assert.strictEqual(result.detail, '1 tool up to date (v6); 1 tool skipped');
  assert.deepStrictEqual(result.details, ['Cursor  settings.json is not valid JSON (JSONC?)']);
});

test('describeCognitiveSummary never counts an unrecognised line as up to date', () => {
  const result = describeCognitiveSummary(summarizeCognitiveOutput([
    '  [cognitive] Claude Code: already configured (v6)',
    '  [cognitive] Zed: some wording this parser has never seen',
  ].join('\n')));
  assert.strictEqual(result.level, 'ok');
  assert.strictEqual(result.detail, '1 tool up to date (v6)', 'only the recognised tool is counted');
  assert.deepStrictEqual(result.details, ['Zed  some wording this parser has never seen'], 'the unknown line stays visible');

  const onlyUnknown = describeCognitiveSummary(summarizeCognitiveOutput('  [cognitive] Zed: some wording this parser has never seen'));
  assert.strictEqual(onlyUnknown.detail, 'nothing to update');
  assert.deepStrictEqual(onlyUnknown.details, ['Zed  some wording this parser has never seen']);
});

test('describeCognitiveSummary reports no tool when the child printed nothing', () => {
  const result = describeCognitiveSummary(summarizeCognitiveOutput(''));
  assert.strictEqual(result.level, 'skip');
  assert.strictEqual(result.detail, 'no supported tool detected');
});

test('parseStateDbOutput reads the OK line with its path and migration count', () => {
  const parsed = parseStateDbOutput('[bootstrap-state-db] OK /home/someone/.egc/egc/state.db (6 migrations)\n');
  assert.strictEqual(parsed.status, 'ok');
  assert.strictEqual(parsed.dbPath, '/home/someone/.egc/egc/state.db');
  assert.strictEqual(parsed.migrations, 6);
});

test('parseStateDbOutput reads one migration, the warning block and the failure line', () => {
  assert.strictEqual(parseStateDbOutput('[bootstrap-state-db] OK C:\\Users\\x\\.egc\\egc\\state.db (1 migration)').migrations, 1);
  const warning = parseStateDbOutput([
    '[bootstrap-state-db] WARNING: state store could not be initialized.',
    '  The EGC state store was not created. Hook-level memory persistence is disabled.',
    '  Run: egc init  to retry initialization.',
  ].join('\n'));
  assert.strictEqual(warning.status, 'warning');
  assert.strictEqual(warning.lines.length, 3);
  const failure = parseStateDbOutput('[bootstrap-state-db] FAILED: SQLITE_CANTOPEN');
  assert.strictEqual(failure.status, 'failed');
  assert.strictEqual(failure.reason, 'SQLITE_CANTOPEN');
  assert.strictEqual(parseStateDbOutput('').status, 'unknown');
});

test('describeRegistration is one line on a machine where every tool was already registered', () => {
  const result = describeRegistration({ unchanged: [{ name: 'Cursor', path: '/h/.cursor/mcp.json' }, { name: 'Zed', path: '/h/.config/zed/settings.json' }] });
  assert.strictEqual(result.level, 'ok');
  assert.strictEqual(result.detail, '2 tools already registered');
  assert.deepStrictEqual(result.details, []);
});

test('describeRegistration names the newly registered tools with their files', () => {
  const result = describeRegistration({
    registered: [{ name: 'Cursor', path: '/h/.cursor/mcp.json' }],
    unchanged: [{ name: 'Zed', path: '/h/.config/zed/settings.json' }, { name: 'Codex', path: '/h/.codex/config.toml' }],
  });
  assert.strictEqual(result.level, 'ok');
  assert.strictEqual(result.detail, 'registered in Cursor; 2 tools already registered');
  assert.deepStrictEqual(result.details, ['Cursor  /h/.cursor/mcp.json']);
});

test('describeRegistration warns with the reason when a tool could not be updated', () => {
  const result = describeRegistration({
    unchanged: [{ name: 'Zed', path: '/h/.config/zed/settings.json' }],
    warned: [{ name: 'Cursor', reason: 'mcp.json is not valid JSON' }],
  });
  assert.strictEqual(result.level, 'warn');
  assert.strictEqual(result.detail, '1 tool already registered; 1 tool could not be updated');
  assert.deepStrictEqual(result.details, ['Cursor  mcp.json is not valid JSON']);
});

test('describeRegistration reports no tool when nothing was gated', () => {
  const result = describeRegistration({});
  assert.strictEqual(result.level, 'skip');
  assert.strictEqual(result.detail, 'no supported tool detected');
});

test('joinNames and plural read as prose', () => {
  assert.strictEqual(joinNames([]), '');
  assert.strictEqual(joinNames(['A']), 'A');
  assert.strictEqual(joinNames(['A', 'B']), 'A and B');
  assert.strictEqual(joinNames(['A', 'B', 'C']), 'A, B and C');
  assert.strictEqual(plural(1, 'tool'), '1 tool');
  assert.strictEqual(plural(2, 'tool'), '2 tools');
  assert.strictEqual(plural(1, 'migration'), '1 migration');
});

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
