#!/usr/bin/env node
/**
 * Governance Event Capture Hook
 *
 * PreToolUse/PostToolUse hook that detects governance-relevant events
 * and writes them to the governance_events table in the state store.
 *
 * Captured event types:
 *   - secret_detected: Hardcoded secrets in tool input/output
 *   - policy_violation: Actions that violate configured policies
 *   - security_finding: Security-relevant tool invocations
 *   - approval_requested: Operations requiring explicit approval
 *   - hook_input_truncated: Hook input exceeded the safe inspection limit
 *
 * Enable: Set EGC_GOVERNANCE_CAPTURE=1
 * Configure session: Set EGC_SESSION_ID for session correlation
 */

'use strict';

const crypto = require('node:crypto');

const MAX_STDIN = 1024 * 1024;

// Patterns that indicate potential hardcoded secrets
const SECRET_PATTERNS = [
  { name: 'aws_key', pattern: /(?:AKIA|ASIA)[A-Z0-9]{16}/i },
  { name: 'generic_secret', pattern: /(?:secret|password|token|api[_-]?key)\s*[:=]\s*["'][^"']{8,}/i },
  { name: 'private_key', pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/ },
  { name: 'jwt', pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'github_token', pattern: /gh[pousr]_\w{36,}/ },
];

// Tool names that represent security-relevant operations
const SECURITY_RELEVANT_TOOLS = new Set([
  'Bash', // Could execute arbitrary commands
]);

// Commands that require governance approval
const APPROVAL_COMMANDS = [
  /git\s+push\s+.*--force/, // NOSONAR: superlinear risk accepted: input is the local user's own command or CLI output
  /git\s+reset\s+--hard/,
  /rm\s+-rf?\s/,
  /DROP\s+(?:TABLE|DATABASE)/i,
  /DELETE\s+FROM\s+\w+\s*(?:;|$)/i,
];

// File patterns that indicate policy-sensitive paths
const SENSITIVE_PATHS = [
  /\.env(?:\.|$)/,
  /credentials/i,
  /secrets?\./i,
  /\.pem$/,
  /\.key$/,
  /id_rsa/,
];

/**
 * Generate a unique event ID.
 */
function generateEventId() {
  return `gov-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Scan text content for hardcoded secrets.
 * Returns array of { name, match } for each detected secret.
 */
function detectSecrets(text) {
  if (!text || typeof text !== 'string') return [];

  const findings = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      findings.push({ name });
    }
  }
  return findings;
}

/**
 * Check if a command requires governance approval.
 */
function detectApprovalRequired(command) {
  if (!command || typeof command !== 'string') return [];

  const findings = [];
  for (const pattern of APPROVAL_COMMANDS) {
    if (pattern.test(command)) {
      findings.push({ pattern: pattern.source });
    }
  }
  return findings;
}

/**
 * Check if a file path is policy-sensitive.
 */
function detectSensitivePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;

  return SENSITIVE_PATHS.some(pattern => pattern.test(filePath));
}

function fingerprintCommand(command) {
  if (!command || typeof command !== 'string') return null;
  return crypto.createHash('sha256').update(command).digest('hex').slice(0, 12);
}

function summarizeCommand(command) {
  if (!command || typeof command !== 'string') {
    return {
      commandName: null,
      commandFingerprint: null,
    };
  }

  const trimmed = command.trim();
  if (!trimmed) {
    return {
      commandName: null,
      commandFingerprint: null,
    };
  }

  return {
    commandName: trimmed.split(/\s+/)[0] || null,
    commandFingerprint: fingerprintCommand(trimmed),
  };
}

function emitGovernanceEvent(event) {
  process.stderr.write(`[governance] ${JSON.stringify(event)}\n`);
}

/**
 * Detect secrets in tool input/output and return a secret_detected event, or null.
 *
 * @param {string} toolName
 * @param {object|string} toolInput
 * @param {string} toolOutput
 * @param {string|null} sessionId
 * @param {string} hookPhase
 * @returns {object|null}
 */
function detectSecretEvent(toolName, toolInput, toolOutput, sessionId, hookPhase) {
  const inputText = typeof toolInput === 'object'
    ? JSON.stringify(toolInput)
    : String(toolInput);

  const inputSecrets = detectSecrets(inputText);
  const outputSecrets = detectSecrets(toolOutput);
  const allSecrets = [...inputSecrets, ...outputSecrets];

  if (allSecrets.length === 0) return null;

  return {
    id: generateEventId(),
    sessionId,
    eventType: 'secret_detected',
    payload: {
      toolName,
      hookPhase,
      secretTypes: allSecrets.map(s => s.name),
      location: inputSecrets.length > 0 ? 'input' : 'output',
      severity: 'critical',
    },
    resolvedAt: null,
    resolution: null,
  };
}

/**
 * Detect approval-required commands (Bash only) and return an approval_requested event, or null.
 *
 * @param {string} toolName
 * @param {object} toolInput
 * @param {string|null} sessionId
 * @param {string} hookPhase
 * @returns {object|null}
 */
function detectApprovalEvent(toolName, toolInput, sessionId, hookPhase) {
  if (toolName !== 'Bash') return null;

  const command = toolInput.command || '';
  const approvalFindings = detectApprovalRequired(command);
  if (approvalFindings.length === 0) return null;

  const commandSummary = summarizeCommand(command);
  return {
    id: generateEventId(),
    sessionId,
    eventType: 'approval_requested',
    payload: {
      toolName,
      hookPhase,
      ...commandSummary,
      matchedPatterns: approvalFindings.map(f => f.pattern),
      severity: 'high',
    },
    resolvedAt: null,
    resolution: null,
  };
}

/**
 * Detect policy violations from sensitive file paths and return a policy_violation event, or null.
 *
 * @param {string} toolName
 * @param {object} toolInput
 * @param {string|null} sessionId
 * @param {string} hookPhase
 * @returns {object|null}
 */
function detectPolicyViolationEvent(toolName, toolInput, sessionId, hookPhase) {
  const filePath = toolInput.file_path || toolInput.path || '';
  if (!filePath || !detectSensitivePath(filePath)) return null;

  return {
    id: generateEventId(),
    sessionId,
    eventType: 'policy_violation',
    payload: {
      toolName,
      hookPhase,
      filePath: filePath.slice(0, 200),
      reason: 'sensitive_file_access',
      severity: 'warning',
    },
    resolvedAt: null,
    resolution: null,
  };
}

/**
 * Detect elevated privilege commands in security-relevant tools and return a security_finding event, or null.
 *
 * @param {string} toolName
 * @param {object} toolInput
 * @param {string|null} sessionId
 * @param {string} hookPhase
 * @returns {object|null}
 */
function detectElevatedPrivilegeEvent(toolName, toolInput, sessionId, hookPhase) {
  if (!SECURITY_RELEVANT_TOOLS.has(toolName) || hookPhase !== 'post') return null;

  const command = toolInput.command || '';
  const hasElevated = /sudo\s/.test(command) || /chmod\s/.test(command) || /chown\s/.test(command);
  if (!hasElevated) return null;

  const commandSummary = summarizeCommand(command);
  return {
    id: generateEventId(),
    sessionId,
    eventType: 'security_finding',
    payload: {
      toolName,
      hookPhase,
      ...commandSummary,
      reason: 'elevated_privilege_command',
      severity: 'medium',
    },
    resolvedAt: null,
    resolution: null,
  };
}

/**
 * Analyze a hook input payload and return governance events to capture.
 *
 * @param {Object} input - Parsed hook input (tool_name, tool_input, tool_output)
 * @param {Object} [context] - Additional context (sessionId, hookPhase)
 * @returns {Array<Object>} Array of governance event objects
 */
function analyzeForGovernanceEvents(input, context = {}) {
  const events = [];
  const toolName = input.tool_name || '';
  const toolInput = input.tool_input || {};
  const toolOutput = typeof input.tool_output === 'string' ? input.tool_output : '';
  const sessionId = context.sessionId || null;
  const hookPhase = context.hookPhase || 'unknown';

  const secretEvent = detectSecretEvent(toolName, toolInput, toolOutput, sessionId, hookPhase);
  if (secretEvent) events.push(secretEvent);

  const approvalEvent = detectApprovalEvent(toolName, toolInput, sessionId, hookPhase);
  if (approvalEvent) events.push(approvalEvent);

  const policyEvent = detectPolicyViolationEvent(toolName, toolInput, sessionId, hookPhase);
  if (policyEvent) events.push(policyEvent);

  const elevatedEvent = detectElevatedPrivilegeEvent(toolName, toolInput, sessionId, hookPhase);
  if (elevatedEvent) events.push(elevatedEvent);

  return events;
}

/**
 * Core hook logic: exported so run-with-flags.js can call directly.
 *
 * @param {string} rawInput - Raw JSON string from stdin
 * @returns {string} The original input (pass-through)
 */
function run(rawInput, options = {}) {
  // Gate on feature flag
  const enabled = process.env.EGC_GOVERNANCE_CAPTURE || process.env.ECC_GOVERNANCE_CAPTURE;
  if (String(enabled || '').toLowerCase() !== '1') {
    return rawInput;
  }

  const sessionId = process.env.EGC_SESSION_ID || process.env.ECC_SESSION_ID || null;
  const hookPhase = process.env.GEMINI_HOOK_EVENT_NAME || 'unknown';

  if (options.truncated) {
    emitGovernanceEvent({
      id: generateEventId(),
      sessionId,
      eventType: 'hook_input_truncated',
      payload: {
        hookPhase: hookPhase.startsWith('Pre') ? 'pre' : 'post',
        sizeLimitBytes: options.maxStdin || MAX_STDIN,
        severity: 'warning',
      },
      resolvedAt: null,
      resolution: null,
    });
  }

  try {
    const input = JSON.parse(rawInput);

    const events = analyzeForGovernanceEvents(input, {
      sessionId,
      hookPhase: hookPhase.startsWith('Pre') ? 'pre' : 'post',
    });

    if (events.length > 0) {
      for (const event of events) {
        emitGovernanceEvent(event);
      }
    }
  } catch {
    // Silently ignore parse errors: never block the tool pipeline.
  }

  return rawInput;
}

// ── stdin entry point ────────────────────────────────
if (require.main === module) {
  let raw = '';
  let truncated = /^(1|true|yes)$/i.test(String(process.env.EGC_HOOK_INPUT_TRUNCATED || process.env.ECC_HOOK_INPUT_TRUNCATED || ''));
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (raw.length < MAX_STDIN) {
      const remaining = MAX_STDIN - raw.length;
      raw += chunk.substring(0, remaining);
      if (chunk.length > remaining) {
        truncated = true;
      }
    } else {
      truncated = true;
    }
  });

  process.stdin.on('end', () => {
    const result = run(raw, {
      truncated,
      maxStdin: Number(process.env.EGC_HOOK_INPUT_MAX_BYTES || process.env.ECC_HOOK_INPUT_MAX_BYTES) || MAX_STDIN,
    });
    process.stdout.write(result);
  });
}

module.exports = {
  APPROVAL_COMMANDS,
  SECRET_PATTERNS,
  SECURITY_RELEVANT_TOOLS,
  SENSITIVE_PATHS,
  analyzeForGovernanceEvents,
  detectApprovalRequired,
  detectSecrets,
  detectSensitivePath,
  generateEventId,
  run,
};
