#!/usr/bin/env node
/**
 * Antigravity hooks adapter for the session-mesh wake signal.
 *
 * Antigravity has no UserPromptSubmit hook. Its PreInvocation hook runs
 * before each model call with {conversationId, workspacePaths,
 * invocationNum, ...} on stdin and may answer {injectSteps: [...]} on
 * stdout, each step a tool call, a user message or an ephemeral message
 * handed to the model (antigravity.google/docs/hooks, read 2026-10-10).
 * This adapter calls mesh-events-inject.js's run() with Antigravity's
 * conversationId as the session key and answers one ephemeral message when
 * the bus store moved since this conversation's last look, an empty object
 * otherwise. It always prints a JSON object and always exits 0: a wake
 * signal must never break the turn.
 */

'use strict';

const fs = require('node:fs');
const { run } = require('./mesh-events-inject');
const { readAdapterStdinJson } = require('../lib/adapter-stdin-json');

function conversationIdOf(event) {
  return event && typeof event === 'object' && typeof event.conversationId === 'string' ? event.conversationId : '';
}

function buildInjection(event) {
  const notice = run({ session_id: conversationIdOf(event) });
  return notice ? { injectSteps: [{ ephemeralMessage: notice }] } : {};
}

function injectionFor(ok, value) {
  try {
    return buildInjection(ok ? value : null);
  } catch (_) { // NOSONAR: a wake signal must never break the harness turn
    return {};
  }
}

function main() {
  readAdapterStdinJson(({ ok, value }) => {
    // Synchronous write to fd 1, as mesh-events-inject.js does: a forced
    // exit right after an asynchronous stdout write can truncate the payload.
    fs.writeSync(1, JSON.stringify(injectionFor(ok, value)));
    process.exitCode = 0;
  });
}

if (require.main === module) {
  main();
}

module.exports = { buildInjection };
