#!/usr/bin/env node
/**
 * Deterministic stand-in for the compiled guardian CLI, used by hook tests
 * so they do not depend on the egc-guardian build existing in the test
 * environment. Mirrors the CLI protocol (mode in argv, payload via stdin,
 * JSON verdict on stdout, exit 0); the verdict rules cover only what the
 * hook tests assert. Validator correctness itself is covered by the
 * guardian tests.
 */

'use strict';

const fs = require('node:fs');
const PROTECTED_RE = /\.ssh|\.aws|id_rsa|\.pem$|\.key$/;

function verdictForCommand(segment) {
  const base = segment.trim().split(/\s+/)[0] || '';
  if (base === 'rm' || base === 'mv') {
    return { allowed: false, reason: `'${base}' is a destructive command and is always denied`, trust_level: 'DANGEROUS' };
  }
  if (PROTECTED_RE.test(segment)) {
    return { allowed: false, reason: `${base} of protected path is forbidden`, trust_level: 'SAFE_READONLY' };
  }
  if (base === 'git' && /\bpush\b/.test(segment) && /(\s--force\b|\s-f\b)/.test(segment)) {
    return { allowed: false, reason: 'git force-push is forbidden', trust_level: 'SAFE_READONLY' };
  }
  return { allowed: true, trust_level: 'SAFE_READONLY' };
}

const mode = process.argv[2];
let payload;
try { payload = fs.readFileSync(0, 'utf8'); } catch { payload = ''; }

if (mode === 'command') {
  process.stdout.write(JSON.stringify(verdictForCommand(payload)));
} else if (mode === 'command-batch') {
  let parsed;
  try { parsed = JSON.parse(payload); } catch { parsed = []; }
  const segments = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed && parsed.commands) ? parsed.commands : [];
  process.stdout.write(JSON.stringify(segments.map(verdictForCommand)));
} else if (mode === 'write') {
  if (PROTECTED_RE.test(payload)) {
    process.stdout.write(JSON.stringify({ allowed: false, reason: `Path '${payload}' is protected`, trust_level: 'BLOCKED' }));
  } else {
    process.stdout.write(JSON.stringify({ allowed: true }));
  }
} else if (mode === 'route') {
  if (process.env.FAKE_GUARDIAN_ROUTE === 'empty') {
    process.stdout.write(JSON.stringify({ agents: [], skills: [], provider: 'keyword' }));
  } else {
    process.stdout.write(JSON.stringify({ agents: ['code-reviewer'], skills: ['security-review'], provider: 'keyword' }));
  }
} else if (mode === 'intent') {
  const intent = process.env.FAKE_GUARDIAN_INTENT || 'none';
  process.stdout.write(JSON.stringify({ intent, source: intent === 'none' ? 'none' : 'llm' }));
} else if (mode === 'mine') {
  if (process.env.FAKE_GUARDIAN_MINE === 'skip') {
    process.stdout.write(JSON.stringify({ skip: true, reason: 'no provider key' }));
  } else {
    process.stdout.write(JSON.stringify({
      decisions: [{ what: 'Use fixture-driven tests', why: 'CI has no guardian build' }],
      avoid: [{ what: 'Piping CI watchers to tail', why: 'masks exit codes' }],
      preferences: ['Conventional commits'],
      next: ['Ship the memory miner'],
      provider: 'fixture',
    }));
  }
} else if (mode === 'learn') {
  process.stdout.write(JSON.stringify({ patterns_found: 0, skipped: true, reason: 'fixture' }));
} else {
  process.stdout.write(JSON.stringify({ error: `unknown mode: ${mode}` }));
}
