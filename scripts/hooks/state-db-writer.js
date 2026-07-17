#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getEGCDir } = require(path.join(__dirname, '..', 'lib', 'utils.js'));

function resolveStateDbPath() {
  return path.join(getEGCDir(), 'egc', 'state.db');
}

async function main() {
  let raw;
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) { // NOSONAR
    // Intentional: writer is best-effort; absent stdin (e.g., direct invocation) is a no-op.
    return;
  }

  if (!raw.trim()) return;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_) { // NOSONAR: malformed payload is ignored; writer is fire-and-forget
    return;
  }

  const dbPath = resolveStateDbPath();
  if (!fs.existsSync(dbPath)) return;

  let createStateStore;
  try {
    ({ createStateStore } = require(path.join(__dirname, '..', 'lib', 'state-store', 'index.js')));
  } catch (e) {
    console.error(e);
    return;
  }

  let store;
  try {
    store = await createStateStore({ dbPath });
  } catch (e) {
    console.error(e);
    return;
  }

  const eventType = payload.event_type || payload.type || payload.hook_event_name || 'observe';

  try {
    await store.insertRuntimeEvent({
      id: crypto.randomUUID(),
      sessionId: payload.session_id || process.env.EGC_SESSION_ID || process.env.ECC_SESSION_ID || null,
      eventType,
      payload,
      timestamp: new Date().toISOString(),
    });

    // On session_end events persist token data to the sessions table
    if (eventType === 'session_end' || (payload.event === 'session_end')) {
      const sid = payload.session_id;
      if (sid) {
        const usage = payload.usage || {};
        const inputTokens  = usage.input_tokens;
        const outputTokens = usage.output_tokens;
        const totalTokens  = (Number.isFinite(inputTokens) && Number.isFinite(outputTokens))
          ? inputTokens + outputTokens
          : null;

        store.upsertSession({
          id: sid,
          adapterId: payload.ide || payload.adapter_id || 'unknown',
          harness: payload.harness || 'unknown',
          state: 'ended',
          repoRoot: payload.repo_root || null,
          startedAt: payload.started_at || null,
          endedAt: new Date().toISOString(),
          snapshot: {
            ide: payload.ide,
            model: payload.model || null,
            workers: payload.workers || [],
          },
          inputTokens: Number.isFinite(inputTokens) ? inputTokens : null,
          outputTokens: Number.isFinite(outputTokens) ? outputTokens : null,
          totalTokens,
          tokenCost: null,
        });
      }
    }
  } catch (e) {
    console.error(e);
  } finally {
    try { store.close(); } catch (e) {
      console.error(e);
    }
  }
}

main().catch((e) => { console.error(e); }).finally(() => process.exit(0));
