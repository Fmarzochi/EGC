#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { createStateStore } = require('../lib/state-store');
const { getEGCDir } = require('../lib/utils');

const ROOT = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
    const opts = {
        logPath: null,
        dbPath: null,
        recent: 50,
        eventsOnly: false,
        pretty: false
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--log') {
            opts.logPath = argv[i + 1];
            i += 1;
        } else if (arg === '--db') {
            opts.dbPath = argv[i + 1];
            i += 1;
        } else if (arg === '--recent') {
            const n = Number.parseInt(argv[i + 1], 10);
            if (Number.isFinite(n) && n >= 0) {
                opts.recent = n;
            }
            i += 1;
        } else if (arg === '--events-only') {
            opts.eventsOnly = true;
        } else if (arg === '--pretty') {
            opts.pretty = true;
        }
    }
    return opts;
}

function readJsonlEvents(logPath) {
    const result = {
        logPath,
        logExists: false,
        events: []
    };
    if (!fs.existsSync(logPath)) {
        return result;
    }
    result.logExists = true;
    const raw = fs.readFileSync(logPath, 'utf8');
    const lines = raw.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            result.events.push(JSON.parse(trimmed));
        } catch (_err) {
            continue;
        }
    }
    return result;
}

function buildEventTypeCounts(events) {
    const counts = {};
    for (const ev of events) {
        const t = ev && ev.type ? String(ev.type) : 'unknown';
        counts[t] = (counts[t] || 0) + 1;
    }
    return counts;
}

function buildSessionCounts(events) {
    const counts = {};
    for (const ev of events) {
        const id = ev && ev.execution_id ? String(ev.execution_id) : 'unknown';
        counts[id] = (counts[id] || 0) + 1;
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const out = {};
    for (const [id, count] of sorted) {
        out[id] = count;
    }
    return out;
}

function buildTracerBlock(opts) {
    const logPath = opts.logPath
        ? path.resolve(opts.logPath)
        : path.join(ROOT, '.sessions', 'execution_log.jsonl');
    const { logExists, events } = readJsonlEvents(logPath);
    const recent = events.slice(-opts.recent);
    return {
        logPath,
        logExists,
        totalEvents: events.length,
        recentEvents: recent,
        eventTypeCounts: buildEventTypeCounts(events),
        sessionCounts: buildSessionCounts(events)
    };
}

async function buildStateStoreBlock(opts) {
    const dbPath = opts.dbPath
        ? path.resolve(opts.dbPath)
        : path.join(getEGCDir(), 'egc', 'state.db');
    const block = {
        dbPath,
        dbExists: fs.existsSync(dbPath)
    };
    if (!block.dbExists) {
        return block;
    }
    let store = null;
    try {
        store = await createStateStore({ dbPath });
        const db = store._database;
        const tableRows = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .all();
        const tables = [];
        for (const row of tableRows) {
            const name = row && row.name ? String(row.name) : null;
            if (!name) continue;
            let rowCount = null;
            try {
                const countRow = db.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get();
                rowCount = countRow && typeof countRow.c === 'number' ? countRow.c : Number(countRow ? countRow.c : 0);
            } catch (_err) {
                rowCount = null;
            }
            tables.push({ name, rowCount });
        }
        block.tables = tables;
    } catch (err) {
        block.error = err && err.message ? String(err.message) : String(err);
    } finally {
        if (store) {
            try {
                store.close();
            } catch (_closeErr) {
                // ignore
            }
        }
    }
    return block;
}

async function buildSnapshot(opts) {
    const snapshot = {
        generatedAt: new Date().toISOString(),
        repoRoot: ROOT,
        tracer: buildTracerBlock(opts)
    };
    if (!opts.eventsOnly) {
        snapshot.stateStore = await buildStateStoreBlock(opts);
    }
    return snapshot;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const snapshot = await buildSnapshot(opts);
    const payload = opts.pretty
        ? JSON.stringify(snapshot, null, 2)
        : JSON.stringify(snapshot);
    process.stdout.write(payload + '\n');
}

main().catch((err) => {
    process.stderr.write(`[runtime-snapshot] FAILED: ${err && err.message ? err.message : err}\n`);
    process.exit(1);
});
