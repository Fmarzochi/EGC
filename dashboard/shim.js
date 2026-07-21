#!/usr/bin/env node
'use strict';

const http = require('http');
const { PORT } = require('./port');

const IDE = process.env.EGC_IDE || process.argv[2] || 'claude';

function post(ev) {
  const body = JSON.stringify(ev);
  const req = http.request(
    { hostname: '127.0.0.1', port: PORT, path: '/event', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 300 },
    () => {}
  );
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.end(body);
}

function fileFrom(input) {
  if (!input) return '';
  return input.file_path || input.path || input.command || input.url ||
         input.skill || input.subagent_type || '';
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => raw += d);
process.stdin.on('end', () => {
  try {
    const hook = JSON.parse(raw);
    const name = hook.hook_event_name;

    if (name === 'Stop') {
      post({
        ide:        IDE,
        event:      'session_end',
        agent:      'main',
        session_id: hook.session_id,
        stop_reason: hook.stop_reason || null,
        usage:      hook.usage || null,
      });
      process.exit(0);
    }

    const isPre  = name === 'PreToolUse';
    const isPost = name === 'PostToolUse';
    if (!isPre && !isPost) process.exit(0);

    post({
      ide:        IDE,
      event:      isPre ? 'pre_tool' : 'post_tool',
      tool:       hook.tool_name || '',
      agent:      'main',
      detail:     fileFrom(hook.tool_input),
      status:     isPre ? 'running' : (hook.tool_response?.is_error ? 'error' : 'success'),
      session_id: hook.session_id,
      duration_ms: hook.tool_response?.duration_ms || undefined,
    });
  } catch (_) {}
  process.exit(0);
});
