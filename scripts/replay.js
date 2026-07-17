#!/usr/bin/env node
'use strict';

const http = require('node:http');
const { execSync } = require('node:child_process');

const DASHBOARD_URL = 'http://localhost:7890';

function showHelp() {
  console.log(`
Usage: egc replay [<session-id>] [--json]

List recorded sessions or open a session in the replay UI.

  egc replay              List available sessions
  egc replay <id>         Open session <id> in the browser replay UI
  egc replay --json       List sessions as JSON
`);
  process.exit(0);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = { sessionId: null, json: false, help: false };
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg.startsWith('--') || arg.startsWith('-')) {
      console.error(`Error: Unrecognized option '${arg}'`);
      showHelp();
    } else {
      parsed.sessionId = arg;
    }
  }
  return parsed;
}

function fetchJSON(path) {
  return new Promise((resolve, reject) => {
    http.get(DASHBOARD_URL + path, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (_e) { /* ignore: original parse error is replaced by a clearer Invalid JSON response error */ reject(new Error('Invalid JSON response')); }
      });
    }).on('error', () => {
      reject(new Error(
        'Cannot reach EGC Dashboard at ' + DASHBOARD_URL + '\n' +
        'Start it first with: egc dashboard'
      ));
    });
  });
}

function openBrowser(url) {
  const platform = process.platform;
  try {
    if (platform === 'darwin') execSync(`open "${url}"`);
    else if (platform === 'win32') execSync(`start "" "${url}"`);
    else execSync(`xdg-open "${url}"`);
  } catch (_) {
    // ignore: fallback to manual URL output if OS-specific open command fails
    console.log('Open this URL in your browser: ' + url);
  }
}

function formatDur(ms) {
  if (!ms) return '';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  return Math.floor(ms / 60000) + 'm ' + Math.floor((ms % 60000) / 1000) + 's';
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) showHelp();

  // Open specific session in browser
  if (opts.sessionId) {
    const url = `${DASHBOARD_URL}/replay.html?session=${encodeURIComponent(opts.sessionId)}`;
    console.log(`Opening replay for session: ${opts.sessionId}`);
    openBrowser(url);
    return;
  }

  // List sessions
  const sessions = await fetchJSON('/replay/sessions');

  if (opts.json) {
    process.stdout.write(JSON.stringify(JSON.parse(JSON.stringify(sessions)), null, 2) + '\n');
    return;
  }

  if (!sessions.length) {
    console.log('No sessions recorded yet. Start egc dashboard and run some AI sessions.');
    return;
  }

  console.log('\nRecorded sessions:\n');
  for (const s of sessions) {
    const ts = new Date(s.timestamp).toLocaleString();
    const dur = s.duration ? ` [${formatDur(s.duration)}]` : '';
    const evts = s.eventCount ? ` ${s.eventCount} events` : '';
    console.log(`  ${s.id}`);
    console.log(`    IDE: ${s.ide || 'unknown'}  |  ${ts}${dur}${evts}`);
    if (s.model) console.log(`    Model: ${s.model}`);
    console.log();
  }

  console.log(`Open a session with: egc replay <session-id>`);
  console.log(`Or view all in browser: ${DASHBOARD_URL}/replay.html`);
}

main().catch(err => {
  console.error('Error: ' + err.message);
  process.exit(1);
});

module.exports = { main, parseArgs };