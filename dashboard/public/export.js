/**
 * Utility functions for exporting session history data.
 * This file is loaded in the browser and also imported in tests via Node.js module.exports.
 */

/**
 * Escapes a cell value for CSV serialization according to RFC 4180.
 * Double quotes are doubled, and values containing quotes, commas, or newlines are wrapped in double quotes.
 * 
 * @param {any} val - The raw cell value
 * @returns {string} The CSV escaped string
 */
function escapeCSVCell(val) {
  if (val === null || val === undefined) {
    return '';
  }
  const str = String(val);
  const needsQuotes = str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r');
  if (needsQuotes) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Converts a list of session objects into a CSV string.
 * Supports timestamp, timestamp_iso, ide, model, input_tokens, output_tokens, total_tokens, cost, and duration_s.
 * 
 * @param {Array<Object>} sessions - List of sessions to export
 * @returns {string} The generated CSV string
 */
function sessionsToCSV(sessions) {
  const keys = ['timestamp', 'timestamp_iso', 'ide', 'model', 'input_tokens', 'output_tokens', 'total_tokens', 'cost', 'duration_s'];
  const header = keys.join(',');

  const rows = sessions.map(session => {
    return keys.map(key => {
      let val = session[key];
      if (key === 'timestamp_iso') {
        const ts = session.timestamp;
        val = ts ? new Date(ts).toISOString() : '';
      } else if (key === 'duration_s') {
        val = session.duration_s !== undefined ? session.duration_s : '';
      }
      return escapeCSVCell(val);
    }).join(',');
  });

  return [header, ...rows].join('\r\n');
}

/**
 * Formats a list of session objects as a pretty JSON string.
 * 
 * @param {Array<Object>} sessions - List of sessions to export
 * @returns {string} Pretty JSON string
 */
function sessionsToJSON(sessions) {
  return JSON.stringify(sessions, null, 2);
}

/**
 * Generates the filename based on format and date.
 * 
 * @param {string} format - Either 'csv' or 'json'
 * @param {Date} [date] - Optional date object, defaults to current time
 * @returns {string} The filename
 */
function exportFilename(format, date = new Date()) {
  const yyyymmdd = date.toISOString().split('T')[0];
  return `egc-sessions-${yyyymmdd}.${format}`;
}

// Support Node.js test environment imports
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    escapeCSVCell,
    sessionsToCSV,
    sessionsToJSON,
    exportFilename
  };
}
