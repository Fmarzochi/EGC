#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getEGCDir } = require(path.join(__dirname, '..', 'lib', 'utils.js'));

function resolveStateDbPath() {
  return path.join(getEGCDir(), 'egc', 'state.db');
}

async function main() {
  let raw;
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    // Intentional: writer is best-effort; absent stdin (e.g., direct invocation) is a no-op.
    return;
  }

  if (!raw.trim()) return;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
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

  try {
    await store.insertRuntimeEvent({
      id: crypto.randomUUID(),
      sessionId: payload.session_id || process.env.EGC_SESSION_ID || process.env.ECC_SESSION_ID || null,
      eventType: payload.event_type || payload.type || payload.hook_event_name || 'observe',
      payload,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.error(e);
  } finally {
    try { store.close(); } catch (e) {
      console.error(e);
    }
  }
}

main().catch((e) => { console.error(e); }).finally(() => process.exit(0));
