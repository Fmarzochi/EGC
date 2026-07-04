/**
 * Anonymous opt-in telemetry for the EGC CLI.
 *
 * Only sends: EGC version + OS platform. No project data, no state files,
 * no identifiers. Disabled by default -- user must explicitly opt in.
 *
 * Consent is stored in ~/.egc/telemetry.json.
 * Users can disable at any time with `egc telemetry off` or by deleting
 * the file.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { ensurePrivateDir } = require('./utils');

const TELEMETRY_FILE = path.join(
  process.env.HOME || process.env.USERPROFILE || os.homedir(),
  '.egc',
  'telemetry.json'
);

const GOATCOUNTER_URL = 'https://egc.goatcounter.com/count';
const SCHEMA_VERSION = 1;

/**
 * Read the telemetry consent file.
 * Returns null if the file does not exist yet.
 */
function readConsent() {
  try {
    const raw = fs.readFileSync(TELEMETRY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.enabled === 'boolean') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Persist telemetry consent.
 */
function writeConsent(enabled) {
  const dir = path.dirname(TELEMETRY_FILE);
  ensurePrivateDir(dir);
  fs.writeFileSync(
    TELEMETRY_FILE,
    JSON.stringify({ enabled, version: SCHEMA_VERSION }, null, 2) + '\n',
    'utf8'
  );
}

/**
 * Prompt the user for telemetry consent via stdin.
 * Resolves to true (opted in) or false (opted out).
 */
function promptConsent() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(
      '\nEGC can send anonymous usage data (version + OS only, no project data).\n' +
      'This helps us understand how EGC is being used. Allow? [y/N]: ',
      (answer) => {
        rl.close();
        const trimmed = answer.trim().toLowerCase();
        resolve(trimmed === 'y' || trimmed === 'yes');
      }
    );
  });
}

/**
 * Ensure consent has been recorded. If not, prompt the user.
 * Call this at the start of primary commands.
 *
 * Returns true if telemetry is enabled after this call.
 */
async function ensureConsent() {
  const consent = readConsent();
  if (consent !== null) {
    return consent.enabled;
  }

  if (!process.stdin.isTTY) {
    writeConsent(false);
    return false;
  }

  const enabled = await promptConsent();
  writeConsent(enabled);
  return enabled;
}

/**
 * Send a single fire-and-forget hit to GoatCounter.
 * Never throws -- telemetry must never break the CLI.
 */
function ping(pagePath, title) {
  const consent = readConsent();
  if (!consent || !consent.enabled) return;

  const { version } = require('../../package.json');
  const userAgent = `EGC-CLI/${version} (${process.platform}; Node/${process.versions.node})`;

  const params = new URLSearchParams({
    p: pagePath,
    t: title,
  });

  const url = `${GOATCOUNTER_URL}?${params.toString()}`;

  try {
    fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': userAgent },
    }).catch(() => {});
  } catch (_) {
    // Telemetry must never break the CLI — swallow all errors silently
  }
}

module.exports = {
  readConsent,
  writeConsent,
  ensureConsent,
  ping,
};
