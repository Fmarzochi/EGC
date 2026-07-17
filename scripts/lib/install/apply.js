'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { writeInstallState } = require('../install-state');
const { syncInstallStateToStore } = require('../install-state-store-sync');
const { filterMcpConfig, parseDisabledMcpServers } = require('../mcp-config');
const {
  HOOK_OPERATION_KIND,
  PRE_TOOL_USE_EVENT,
  STOP_EVENT,
  USER_PROMPT_SUBMIT_EVENT,
  applyHookEntryToFile,
  applyIntuitionHookToFile,
  applySessionStartHookToFile,
  applyStopHookToFile,
} = require('../claude-settings-hooks');
const {
  PRE_RUN_COMMAND_EVENT,
  PRE_WRITE_CODE_EVENT,
  applyWindsurfGateGuardHookToFile,
} = require('../windsurf-gateguard-hooks');
const {
  MERGE_YAML_READ_LIST_KIND,
  mergeAiderConfigReadList,
} = require('../aider-config-merge');
const {
  MERGE_MARKDOWN_INDEX_KIND,
  mergeSkillIndexEntry,
} = require('../warp-agents-merge');

const WINDSURF_HOOK_EVENTS = new Set([PRE_WRITE_CODE_EVENT, PRE_RUN_COMMAND_EVENT]);

function readJsonObject(filePath, label) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to parse ${label} at ${filePath}: ${error.message}`, { cause: error });
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid ${label} at ${filePath}: expected a JSON object`);
  }

  return parsed;
}

function cloneJsonValue(value) {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepMergeJson(baseValue, patchValue) {
  if (!isPlainObject(baseValue) || !isPlainObject(patchValue)) {
    return cloneJsonValue(patchValue);
  }

  const merged = { ...baseValue };
  for (const [key, value] of Object.entries(patchValue)) {
    if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = deepMergeJson(merged[key], value);
    } else {
      merged[key] = cloneJsonValue(value);
    }
  }
  return merged;
}

function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function replacePluginRootPlaceholders(value, pluginRoot) {
  if (!pluginRoot) {
    return value;
  }

  if (typeof value === 'string') {
    return value.split('${GEMINI_PLUGIN_ROOT}').join(pluginRoot);
  }

  if (Array.isArray(value)) {
    return value.map(item => replacePluginRootPlaceholders(item, pluginRoot));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        replacePluginRootPlaceholders(nestedValue, pluginRoot),
      ])
    );
  }

  return value;
}

function findHooksSourcePath(plan, hooksDestinationPath) {
  const operation = plan.operations.find(item => item.destinationPath === hooksDestinationPath);
  return operation ? operation.sourcePath : null;
}

function isMcpConfigPath(filePath) {
  const basename = path.basename(String(filePath || ''));
  return basename === '.mcp.json' || basename === 'mcp.json';
}

function buildResolvedClaudeHooks(plan) {
  if (plan.adapter?.target !== 'egc') {
    return null;
  }

  const pluginRoot = plan.targetRoot;
  const hooksDestinationPath = path.join(plan.targetRoot, 'hooks', 'hooks.json');
  const hooksSourcePath = findHooksSourcePath(plan, hooksDestinationPath) || hooksDestinationPath;
  if (!fs.existsSync(hooksSourcePath)) {
    return null;
  }

  const hooksConfig = readJsonObject(hooksSourcePath, 'hooks config');
  const resolvedHooks = replacePluginRootPlaceholders(hooksConfig.hooks, pluginRoot);
  if (!resolvedHooks || typeof resolvedHooks !== 'object' || Array.isArray(resolvedHooks)) {
    throw new Error(`Invalid hooks config at ${hooksSourcePath}: expected "hooks" to be a JSON object`);
  }

  return {
    hooksDestinationPath,
    resolvedHooksConfig: {
      ...hooksConfig,
      hooks: resolvedHooks,
    },
  };
}

function applyInstallPlan(plan) {
  const resolvedClaudeHooksPlan = buildResolvedClaudeHooks(plan);
  const disabledServers = parseDisabledMcpServers(process.env.EGC_DISABLED_MCPS || process.env.ECC_DISABLED_MCPS);

  for (const operation of plan.operations) {
    fs.mkdirSync(path.dirname(operation.destinationPath), { recursive: true });

    if (operation.kind === HOOK_OPERATION_KIND) {
      if (operation.hookEvent === STOP_EVENT) {
        applyStopHookToFile(operation.destinationPath, operation.hookScriptPath);
      } else if (operation.hookEvent === USER_PROMPT_SUBMIT_EVENT) {
        applyIntuitionHookToFile(operation.destinationPath, operation.hookScriptPath);
      } else if (operation.hookEvent === PRE_TOOL_USE_EVENT) {
        applyHookEntryToFile(operation.destinationPath, PRE_TOOL_USE_EVENT, operation.hookScriptPath, { matcher: operation.hookMatcher });
      } else if (WINDSURF_HOOK_EVENTS.has(operation.hookEvent)) {
        applyWindsurfGateGuardHookToFile(operation.destinationPath, operation.hookEvent, operation.hookScriptPath);
      } else {
        applySessionStartHookToFile(operation.destinationPath, operation.hookScriptPath);
      }
      continue;
    }

    if (operation.kind === 'merge-json') {
      const payload = cloneJsonValue(operation.mergePayload);
      if (payload === undefined) {
        throw new Error(`Missing merge payload for ${operation.destinationPath}`);
      }

      const filteredPayload = (
        isMcpConfigPath(operation.destinationPath) && disabledServers.length > 0
      )
        ? filterMcpConfig(payload, disabledServers).config
        : payload;

      const currentValue = fs.existsSync(operation.destinationPath)
        ? readJsonObject(operation.destinationPath, 'existing JSON config')
        : {};
      const mergedValue = deepMergeJson(currentValue, filteredPayload);
      fs.writeFileSync(operation.destinationPath, formatJson(mergedValue), 'utf8');
      continue;
    }

    if (operation.kind === MERGE_YAML_READ_LIST_KIND) {
      if (!operation.readEntry) {
        throw new Error(`Missing readEntry for ${operation.destinationPath}`);
      }

      const existingContent = fs.existsSync(operation.destinationPath)
        ? fs.readFileSync(operation.destinationPath, 'utf8')
        : null;
      let nextContent;
      try {
        nextContent = mergeAiderConfigReadList(existingContent, operation.readEntry);
      } catch (error) {
        // js-yaml's raw SyntaxError gives no indication of which file or
        // that it's a YAML problem at all — matches readJsonObject's
        // actionable-error convention above instead of a bare crash.
        throw new Error(
          `Failed to parse Aider config at ${operation.destinationPath}: ${error.message}`,
          { cause: error },
        );
      }
      fs.writeFileSync(operation.destinationPath, nextContent, 'utf8');
      continue;
    }

    if (operation.kind === MERGE_MARKDOWN_INDEX_KIND) {
      const existingContent = fs.existsSync(operation.destinationPath)
        ? fs.readFileSync(operation.destinationPath, 'utf8')
        : null;
      const nextContent = mergeSkillIndexEntry(existingContent, {
        name: operation.skillName,
        description: operation.skillDescription,
        relativePath: operation.relativePath,
      });
      fs.writeFileSync(operation.destinationPath, nextContent, 'utf8');
      continue;
    }

    if (operation.kind === 'copy-file' && isMcpConfigPath(operation.destinationPath) && disabledServers.length > 0) {
      const sourceConfig = readJsonObject(operation.sourcePath, 'MCP config');
      const filteredConfig = filterMcpConfig(sourceConfig, disabledServers).config;
      fs.writeFileSync(operation.destinationPath, formatJson(filteredConfig), 'utf8');
      continue;
    }

    fs.copyFileSync(operation.sourcePath, operation.destinationPath);
  }

  if (resolvedClaudeHooksPlan) {
    fs.mkdirSync(path.dirname(resolvedClaudeHooksPlan.hooksDestinationPath), { recursive: true });
    fs.writeFileSync(
      resolvedClaudeHooksPlan.hooksDestinationPath,
      JSON.stringify(resolvedClaudeHooksPlan.resolvedHooksConfig, null, 2) + '\n',
      'utf8'
    );
  }

  writeInstallState(plan.installStatePath, plan.statePreview);

  syncInstallStateToStore(plan.statePreview, {
    onError: error => console.error(`Warning: Failed to sync install state to status store: ${error.message}`),
  });

  return {
    ...plan,
    applied: true,
  };
}

module.exports = {
  applyInstallPlan,
};
