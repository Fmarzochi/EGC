'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  escapeCSVCell,
  sessionsToCSV,
  sessionsToJSON,
  exportFilename
} = require('../dashboard/public/export.js');

test('escapeCSVCell escapes quotes, commas, and newlines', () => {
  // Standard values
  assert.equal(escapeCSVCell('hello'), 'hello');
  assert.equal(escapeCSVCell(123), '123');

  // Empty, null, undefined
  assert.equal(escapeCSVCell(null), '');
  assert.equal(escapeCSVCell(undefined), '');

  // Needs escaping
  assert.equal(escapeCSVCell('hello, world'), '"hello, world"');
  assert.equal(escapeCSVCell('say "hello"'), '"say ""hello"""');
  assert.equal(escapeCSVCell('hello\nworld'), '"hello\nworld"');
  assert.equal(escapeCSVCell('hello\rworld'), '"hello\rworld"');
});

test('sessionsToCSV converts empty array to only header', () => {
  const result = sessionsToCSV([]);
  const expectedHeader = 'timestamp,timestamp_iso,ide,model,input_tokens,output_tokens,total_tokens,cost,duration_s';
  assert.equal(result, expectedHeader);
});

test('sessionsToCSV converts sessions list to valid CSV rows', () => {
  const sessions = [
    {
      timestamp: 1719230700000,
      ide: 'claude',
      model: 'claude-3-5-sonnet',
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      cost: 0.00225,
      duration_s: 12.5
    },
    {
      timestamp: 1719230760000,
      ide: 'gemini',
      model: 'gemini-1.5-pro',
      input_tokens: 200,
      output_tokens: 100,
      total_tokens: 300,
      cost: 0.0015
    }
  ];

  const result = sessionsToCSV(sessions);
  const lines = result.split('\r\n');

  assert.equal(lines.length, 3);
  assert.equal(lines[0], 'timestamp,timestamp_iso,ide,model,input_tokens,output_tokens,total_tokens,cost,duration_s');
  
  // Row 1
  assert.equal(lines[1], '1719230700000,2024-06-24T12:05:00.000Z,claude,claude-3-5-sonnet,100,50,150,0.00225,12.5');

  // Row 2 (missing duration_s should default to empty string)
  assert.equal(lines[2], '1719230760000,2024-06-24T12:06:00.000Z,gemini,gemini-1.5-pro,200,100,300,0.0015,');
});

test('sessionsToCSV handles cells requiring escaping', () => {
  const sessions = [
    {
      timestamp: 1719230700000,
      ide: 'claude',
      model: 'claude-3,5-sonnet', // comma in model name
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      cost: 0.00225,
      duration_s: 12
    }
  ];

  const result = sessionsToCSV(sessions);
  const lines = result.split('\r\n');
  assert.equal(lines[1], '1719230700000,2024-06-24T12:05:00.000Z,claude,"claude-3,5-sonnet",100,50,150,0.00225,12');
});

test('sessionsToJSON matches expected JSON stringification', () => {
  const sessions = [
    { ide: 'claude', input_tokens: 100 }
  ];
  const result = sessionsToJSON(sessions);
  assert.equal(result, JSON.stringify(sessions, null, 2));
});

test('exportFilename generates filename correctly', () => {
  const testDate = new Date('2026-07-02T12:00:00Z');
  
  const csvFilename = exportFilename('csv', testDate);
  assert.equal(csvFilename, 'egc-sessions-2026-07-02.csv');

  const jsonFilename = exportFilename('json', testDate);
  assert.equal(jsonFilename, 'egc-sessions-2026-07-02.json');
});
