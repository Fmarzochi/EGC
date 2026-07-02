'use strict';

function escapeCSVCell(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  const needsQuotes = str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r');
  return needsQuotes ? `"${str.replace(/"/g, '""')}"` : str;
}

function sessionsToCSV(sessions) {
  const keys = ['timestamp', 'timestamp_iso', 'ide', 'model', 'input_tokens', 'output_tokens', 'total_tokens', 'cost', 'duration_s'];
  const header = keys.join(',');
  const rows = sessions.map(s =>
    keys.map(k => {
      if (k === 'timestamp_iso') return escapeCSVCell(s.timestamp ? new Date(s.timestamp).toISOString() : '');
      if (k === 'duration_s') return escapeCSVCell(s.duration_s !== undefined ? s.duration_s : '');
      return escapeCSVCell(s[k]);
    }).join(',')
  );
  return [header, ...rows].join('\r\n');
}

function sessionsToJSON(sessions) {
  return JSON.stringify(sessions, null, 2);
}

function exportFilename(format, date = new Date()) {
  return `egc-sessions-${date.toISOString().split('T')[0]}.${format}`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { escapeCSVCell, sessionsToCSV, sessionsToJSON, exportFilename };
}
