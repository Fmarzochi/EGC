'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { escapeCSVCell, sessionsToCSV, sessionsToJSON, exportFilename } = require('../dashboard/public/export.js');

test('escapeCSVCell returns empty string for null and undefined', () => {
  assert.equal(escapeCSVCell(null), '');
  assert.equal(escapeCSVCell(undefined), '');
});

test('escapeCSVCell wraps value with comma in double quotes', () => {
  assert.equal(escapeCSVCell('claude-3,5-sonnet'), '"claude-3,5-sonnet"');
});

test('escapeCSVCell doubles internal double quotes', () => {
  assert.equal(escapeCSVCell('say "hi"'), '"say ""hi"""');
});

test('escapeCSVCell returns plain string when no special characters', () => {
  assert.equal(escapeCSVCell('claude'), 'claude');
  assert.equal(escapeCSVCell(42), '42');
});

test('sessionsToCSV generates correct header and row', () => {
  const sessions = [{
    timestamp: 1751500000000,
    ide: 'claude',
    model: 'claude-sonnet-4-6',
    input_tokens: 1000,
    output_tokens: 200,
    total_tokens: 1200,
    cost: 0.0042,
    duration_s: 30
  }];
  const csv = sessionsToCSV(sessions);
  const [header, row] = csv.split('\r\n');
  assert.equal(header, 'timestamp,timestamp_iso,ide,model,input_tokens,output_tokens,total_tokens,cost,duration_s');
  assert.ok(row.includes('claude'));
  assert.ok(row.includes('1200'));
  assert.ok(row.includes('0.0042'));
});

test('sessionsToCSV produces empty row fields when session values are missing', () => {
  const csv = sessionsToCSV([{}]);
  const row = csv.split('\r\n')[1];
  assert.equal(row, ',,,,,,,,');
});

test('sessionsToJSON produces valid parseable JSON', () => {
  const sessions = [{ ide: 'cursor', cost: 0.01 }];
  const result = sessionsToJSON(sessions);
  assert.deepEqual(JSON.parse(result), sessions);
});

test('exportFilename formats date-stamped name correctly', () => {
  const date = new Date('2026-07-02T10:00:00Z');
  assert.equal(exportFilename('csv', date), 'egc-sessions-2026-07-02.csv');
  assert.equal(exportFilename('json', date), 'egc-sessions-2026-07-02.json');
});
