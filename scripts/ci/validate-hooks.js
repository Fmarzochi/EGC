#!/usr/bin/env node
/**
 * Validate hooks.json schema and hook entry rules.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Ajv = require('ajv');

const HOOKS_FILE = path.join(__dirname, '../../hooks/hooks.json');
const HOOKS_SCHEMA_PATH = path.join(__dirname, '../../schemas/hooks.schema.json');
const VALID_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'SubagentStart',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'InstructionsLoaded',
  'TeammateIdle',
  'TaskCompleted',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'SessionEnd',
];
const VALID_HOOK_TYPES = ['command', 'http', 'prompt', 'agent'];
const EVENTS_WITHOUT_MATCHER = new Set(['UserPromptSubmit', 'Notification', 'Stop', 'SubagentStop']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(item => isNonEmptyString(item));
}

function validateInlineJs(command, label) {
  const nodeEMatch = command.match(/^node -e "((?:[^"\\]|\\.)*)"(?:\s|$)/s);
  if (!nodeEMatch) return false;

  const unescaped = nodeEMatch[1].replace(/\\(.)/g, (_match, char) => {
    if (char === 'n') return '\n';
    if (char === 't') return '\t';
    if (char === '\\') return '\\';
    if (char === '"') return '"';
    return char;
  });

  try {
    new vm.Script(unescaped);
    return false;
  } catch (syntaxErr) {
    console.error(`ERROR: ${label} has invalid inline JS: ${syntaxErr.message}`);
    return true;
  }
}

function validateCommandHook(hook, label) {
  let hasErrors = false;

  if ('async' in hook && typeof hook.async !== 'boolean') {
    console.error(`ERROR: ${label} 'async' must be a boolean`);
    hasErrors = true;
  }

  if (!isNonEmptyString(hook.command) && !isNonEmptyStringArray(hook.command)) {
    console.error(`ERROR: ${label} missing or invalid 'command' field`);
    hasErrors = true;
  } else if (typeof hook.command === 'string') {
    if (validateInlineJs(hook.command, label)) hasErrors = true;
  }

  return hasErrors;
}

function validateHttpHook(hook, label) {
  let hasErrors = false;

  if (!isNonEmptyString(hook.url)) {
    console.error(`ERROR: ${label} missing or invalid 'url' field`);
    hasErrors = true;
  }

  const invalidHeaders = 'headers' in hook && (
    typeof hook.headers !== 'object' ||
    hook.headers === null ||
    Array.isArray(hook.headers) ||
    !Object.values(hook.headers).every(value => typeof value === 'string')
  );
  if (invalidHeaders) {
    console.error(`ERROR: ${label} 'headers' must be an object with string values`);
    hasErrors = true;
  }

  const invalidAllowedEnvVars = 'allowedEnvVars' in hook && (
    !Array.isArray(hook.allowedEnvVars) ||
    !hook.allowedEnvVars.every(value => isNonEmptyString(value))
  );
  if (invalidAllowedEnvVars) {
    console.error(`ERROR: ${label} 'allowedEnvVars' must be an array of strings`);
    hasErrors = true;
  }

  return hasErrors;
}

function validatePromptOrAgentHook(hook, label) {
  let hasErrors = false;

  if (!isNonEmptyString(hook.prompt)) {
    console.error(`ERROR: ${label} missing or invalid 'prompt' field`);
    hasErrors = true;
  }

  if ('model' in hook && !isNonEmptyString(hook.model)) {
    console.error(`ERROR: ${label} 'model' must be a non-empty string`);
    hasErrors = true;
  }

  return hasErrors;
}

/**
 * Validate a single hook entry has required fields and valid inline JS
 * @param {object} hook - Hook object with type and command fields
 * @param {string} label - Label for error messages (e.g., "PreToolUse[0].hooks[1]")
 * @returns {boolean} true if errors were found
 */
function validateHookEntry(hook, label) {
  let hasErrors = false;

  if (!hook.type || typeof hook.type !== 'string') {
    console.error(`ERROR: ${label} missing or invalid 'type' field`);
    hasErrors = true;
  } else if (!VALID_HOOK_TYPES.includes(hook.type)) {
    console.error(`ERROR: ${label} has unsupported hook type '${hook.type}'`);
    hasErrors = true;
  }

  if ('timeout' in hook && (typeof hook.timeout !== 'number' || hook.timeout < 0)) {
    console.error(`ERROR: ${label} 'timeout' must be a non-negative number`);
    hasErrors = true;
  }

  if (hook.type === 'command') {
    return hasErrors || validateCommandHook(hook, label);
  }

  if ('async' in hook) {
    console.error(`ERROR: ${label} 'async' is only supported for command hooks`);
    hasErrors = true;
  }

  if (hook.type === 'http') {
    return hasErrors || validateHttpHook(hook, label);
  }

  return hasErrors || validatePromptOrAgentHook(hook, label);
}

function validateMatcher(matcher, eventType, i, hasErrors) {
  let errors = hasErrors;

  if (!('matcher' in matcher) && !EVENTS_WITHOUT_MATCHER.has(eventType)) {
    console.error(`ERROR: ${eventType}[${i}] missing 'matcher' field`);
    errors = true;
  } else if ('matcher' in matcher && typeof matcher.matcher !== 'string' && (typeof matcher.matcher !== 'object' || matcher.matcher === null)) {
    console.error(`ERROR: ${eventType}[${i}] has invalid 'matcher' field`);
    errors = true;
  }

  if (!matcher.hooks || !Array.isArray(matcher.hooks)) {
    console.error(`ERROR: ${eventType}[${i}] missing 'hooks' array`);
    errors = true;
  } else {
    for (let j = 0; j < matcher.hooks.length; j++) {
      if (validateHookEntry(matcher.hooks[j], `${eventType}[${i}].hooks[${j}]`)) {
        errors = true;
      }
    }
  }

  return errors;
}

function validateObjectFormat(hooks) {
  let hasErrors = false;
  let totalMatchers = 0;

  for (const [eventType, matchers] of Object.entries(hooks)) {
    if (!VALID_EVENTS.includes(eventType)) {
      console.error(`ERROR: Invalid event type: ${eventType}`);
      hasErrors = true;
      continue;
    }

    if (!Array.isArray(matchers)) {
      console.error(`ERROR: ${eventType} must be an array`);
      hasErrors = true;
      continue;
    }

    for (let i = 0; i < matchers.length; i++) {
      const matcher = matchers[i];
      if (typeof matcher !== 'object' || matcher === null) {
        console.error(`ERROR: ${eventType}[${i}] is not an object`);
        hasErrors = true;
        continue;
      }
      hasErrors = validateMatcher(matcher, eventType, i, hasErrors);
      totalMatchers++;
    }
  }

  return { hasErrors, totalMatchers };
}

function validateArrayFormat(hooks) {
  let hasErrors = false;
  let totalMatchers = 0;

  for (let i = 0; i < hooks.length; i++) {
    const hook = hooks[i];

    if (!('matcher' in hook)) {
      console.error(`ERROR: Hook ${i} missing 'matcher' field`);
      hasErrors = true;
    } else if (typeof hook.matcher !== 'string' && (typeof hook.matcher !== 'object' || hook.matcher === null)) {
      console.error(`ERROR: Hook ${i} has invalid 'matcher' field`);
      hasErrors = true;
    }

    if (!hook.hooks || !Array.isArray(hook.hooks)) {
      console.error(`ERROR: Hook ${i} missing 'hooks' array`);
      hasErrors = true;
    } else {
      for (let j = 0; j < hook.hooks.length; j++) {
        if (validateHookEntry(hook.hooks[j], `Hook ${i}.hooks[${j}]`)) {
          hasErrors = true;
        }
      }
    }
    totalMatchers++;
  }

  return { hasErrors, totalMatchers };
}

function validateHooks() {
  if (!fs.existsSync(HOOKS_FILE)) {
    console.log('No hooks.json found, skipping validation');
    process.exit(0);
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(HOOKS_FILE, 'utf-8'));
  } catch (e) {
    console.error(`ERROR: Invalid JSON in hooks.json: ${e.message}`);
    process.exit(1);
  }

  if (fs.existsSync(HOOKS_SCHEMA_PATH)) {
    const schema = JSON.parse(fs.readFileSync(HOOKS_SCHEMA_PATH, 'utf-8'));
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(schema);
    const valid = validate(data);
    if (!valid) {
      for (const err of validate.errors) {
        console.error(`ERROR: hooks.json schema: ${err.instancePath || '/'} ${err.message}`);
      }
      process.exit(1);
    }
  }

  const hooks = data.hooks || data;
  let result;

  if (typeof hooks === 'object' && !Array.isArray(hooks)) {
    result = validateObjectFormat(hooks);
  } else if (Array.isArray(hooks)) {
    result = validateArrayFormat(hooks);
  } else {
    console.error('ERROR: hooks.json must be an object or array');
    process.exit(1);
  }

  if (result.hasErrors) {
    process.exit(1);
  }

  console.log(`Validated ${result.totalMatchers} hook matchers`);
}

validateHooks();
