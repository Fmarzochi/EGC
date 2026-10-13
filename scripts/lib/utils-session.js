/**
 * Date/time formatting and session/project naming for EGC hooks and scripts.
 */

const path = require('node:path');
const crypto = require('node:crypto');
const { runCommand } = require('./utils-platform');

const WINDOWS_RESERVED_SESSION_IDS = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
]);

/**
 * Get current date in YYYY-MM-DD format
 */
function getDateString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Get current time in HH:MM format
 */
function getTimeString() {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Get current datetime in YYYY-MM-DD HH:MM:SS format
 */
function getDateTimeString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Get the git repository name
 */
function getGitRepoName() {
  const result = runCommand('git rev-parse --show-toplevel');
  if (!result.success) return null;
  return path.basename(result.output);
}

/**
 * Get project name from git repo or current directory
 */
function getProjectName() {
  const repoName = getGitRepoName();
  if (repoName) return repoName;
  return path.basename(process.cwd()) || null;
}

/**
 * Sanitize a string for use as a session filename segment.
 * Replaces invalid characters with hyphens, collapses runs, strips
 * leading/trailing hyphens, and removes leading dots so hidden-dir names
 * like ".gemini" map cleanly to "egc".
 *
 * Pure non-ASCII inputs get a stable 8-char hash so distinct names do not
 * collapse to the same fallback session id. Mixed-script inputs retain their
 * ASCII part and gain a short hash suffix for disambiguation.
 */
function sanitizeSessionId(raw) {
  if (!raw || typeof raw !== 'string') return null;

  const hasNonAscii = Array.from(raw).some(char => char.codePointAt(0) > 0x7f);
  let normalized = raw.replace(/^\.+/, '');
  if (normalized === 'gemini') normalized = 'egc';

  const sanitized = normalized
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, ''); // NOSONAR: superlinear risk accepted: input is repo-owned or local state content, never network-controlled

  if (sanitized.length > 0) {
    const suffix = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 6);
    if (WINDOWS_RESERVED_SESSION_IDS.has(sanitized.toUpperCase())) {
      return `${sanitized}-${suffix}`;
    }
    if (!hasNonAscii) return sanitized;
    return `${sanitized}-${suffix}`;
  }

  const meaningful = normalized.replace(/[\s\p{P}]/gu, '');
  if (meaningful.length === 0) return null;

  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 8);
}

/**
 * Get short session ID from EGC_SESSION_ID environment variable
 * Returns last 8 characters, falls back to a sanitized project name then 'default'.
 */
function getSessionIdShort(fallback = 'default') {
  const sessionId = process.env.EGC_SESSION_ID || process.env.ECC_SESSION_ID;
  if (sessionId && sessionId.length > 0) {
    const sanitized = sanitizeSessionId(sessionId.slice(-8));
    if (sanitized) return sanitized;
  }
  return sanitizeSessionId(getProjectName()) || sanitizeSessionId(fallback) || 'default';
}

module.exports = {
  getDateString,
  getTimeString,
  getDateTimeString,
  sanitizeSessionId,
  getSessionIdShort,
  getGitRepoName,
  getProjectName,
};
