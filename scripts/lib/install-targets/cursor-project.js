const fs = require('node:fs');
const path = require('node:path');

const { toCursorAgentFileName } = require('../cursor-agent-names');
const {
  createFlatFileOperations,
  createFlatRuleOperations,
  createInstallTargetAdapter,
  createManagedOperation,
  createRemappedOperation,
  isForeignPlatformPath,
} = require('./helpers');
const {
  HOOK_OPERATION_KIND,
  createBashGuardianScriptCopyOperations,
} = require('../claude-settings-hooks');
const {
  BEFORE_SHELL_EXECUTION_EVENT,
  GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
  resolveGuardianAdapterScriptDestination,
  resolveHooksJsonPath,
} = require('../cursor-guardian-hooks');

// EGC-494/EGC-498: every Cursor install registers the Guardian Bash
// validator on beforeShellExecution, even when no content modules are
// selected -- the same "deterministic, unconditional" pattern
// claude-home.js/windsurf-gateguard-operations.js already use for their own
// security hooks, so a minimal install is never silently unprotected.
function createCursorGuardianOperations(adapter, targetRoot, modules, repoRoot) {
  const remap = (moduleId, sourceRelativePath, destinationPath, options) => (
    createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
  );

  // hooks-runtime already scaffolds the whole scripts/hooks and scripts/lib
  // trees (install-modules.json), which includes every file the Guardian
  // copy operations below would otherwise duplicate -- drop the redundant
  // per-file copies when that module is selected, keeping only the merge
  // operation (never redundant: it is the sole writer of hooks.json's
  // Guardian entry).
  const selectedPaths = new Set(modules.flatMap(module => (Array.isArray(module.paths) ? module.paths : [])));
  const alreadyScaffolded = sourceRelativePath => (
    (selectedPaths.has('scripts/hooks') && sourceRelativePath.startsWith('scripts/hooks/'))
    || (selectedPaths.has('scripts/lib') && sourceRelativePath.startsWith('scripts/lib/'))
  );

  const guardianScriptCopyOperations = createBashGuardianScriptCopyOperations(remap, targetRoot)
    .filter(operation => !alreadyScaffolded(operation.sourceRelativePath));
  const adapterModuleId = 'egc-cursor-guardian-hook';
  const adapterScriptDestination = resolveGuardianAdapterScriptDestination(targetRoot);
  const adapterCopyOperation = alreadyScaffolded(GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH)
    ? null
    : createRemappedOperation(
      adapter,
      adapterModuleId,
      GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
      adapterScriptDestination,
      { strategy: 'preserve-relative-path' }
    );
  const seedPath = repoRoot ? path.join(repoRoot, '.cursor', 'hooks.json') : null;
  const mergeOperation = {
    kind: HOOK_OPERATION_KIND,
    moduleId: adapterModuleId,
    sourceRelativePath: GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
    destinationPath: resolveHooksJsonPath(targetRoot),
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: BEFORE_SHELL_EXECUTION_EVENT,
    hookScriptPath: adapterScriptDestination,
    ...(seedPath ? { seedPath } : {}),
  };

  return [
    ...guardianScriptCopyOperations,
    ...(adapterCopyOperation ? [adapterCopyOperation] : []),
    mergeOperation,
  ];
}

function toCursorRuleFileName(fileName, sourceRelativeFile) {
  if (path.basename(sourceRelativeFile).toLowerCase() === 'readme.md') {
    return null;
  }

  return fileName.endsWith('.md')
    ? `${fileName.slice(0, -3)}.mdc`
    : fileName;
}

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

function createJsonMergeOperation({ moduleId, repoRoot, sourceRelativePath, destinationPath }) {
  const sourcePath = path.join(repoRoot, sourceRelativePath);
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    return null;
  }

  return createManagedOperation({
    kind: 'merge-json',
    moduleId,
    sourceRelativePath,
    destinationPath,
    strategy: 'merge-json',
    ownership: 'managed',
    scaffoldOnly: false,
    mergePayload: readJsonObject(sourcePath, sourceRelativePath),
  });
}

module.exports = createInstallTargetAdapter({
  id: 'cursor-project',
  target: 'cursor',
  kind: 'project',
  rootSegments: ['.cursor'],
  installStatePathSegments: ['egc-install-state.json'],
  nativeRootRelativePath: '.cursor',
  planOperations(input, adapter) {
    let modules;
    if (Array.isArray(input.modules)) {
      modules = input.modules;
    } else if (input.module) {
      modules = [input.module];
    } else {
      modules = [];
    }
    const seenDestinationPaths = new Set();
    const {
      repoRoot,
      projectRoot,
      homeDir,
    } = input;
    const planningInput = {
      repoRoot,
      projectRoot,
      homeDir,
    };
    const targetRoot = adapter.resolveRoot(planningInput);
    const entries = modules.flatMap((module, moduleIndex) => {
      const paths = Array.isArray(module.paths) ? module.paths : [];
      return paths
        .filter(p => !isForeignPlatformPath(p, adapter.target))
        .map((sourceRelativePath, pathIndex) => ({
          module,
          sourceRelativePath,
          moduleIndex,
          pathIndex,
        }));
    }).sort((left, right) => {
      const getPriority = value => {
        if (value === '.cursor') {
          return 0;
        }

        if (value === 'rules') {
          return 1;
        }

        return 2;
      };

      const leftPriority = getPriority(left.sourceRelativePath);
      const rightPriority = getPriority(right.sourceRelativePath);
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }

      if (left.moduleIndex !== right.moduleIndex) {
        return left.moduleIndex - right.moduleIndex;
      }

      return left.pathIndex - right.pathIndex;
    });

    function takeUniqueOperations(operations) {
      return operations.filter(operation => {
        if (!operation?.destinationPath) {
          return false;
        }

        if (seenDestinationPaths.has(operation.destinationPath)) {
          return false;
        }

        seenDestinationPaths.add(operation.destinationPath);
        return true;
      });
    }

    return [...entries.flatMap(({ module, sourceRelativePath }) => {
      const cursorMcpOperation = createJsonMergeOperation({
        moduleId: module.id,
        repoRoot,
        sourceRelativePath: '.mcp.json',
        destinationPath: path.join(targetRoot, 'mcp.json'),
      });

      if (sourceRelativePath === 'AGENTS.md') {
        // Cursor treats nested AGENTS.md files as directory context; do not
        // install EGC's root project identity into a host project's .cursor/.
        return [];
      }

      if (sourceRelativePath === 'rules') {
        return takeUniqueOperations(createFlatRuleOperations({
          moduleId: module.id,
          repoRoot,
          sourceRelativePath,
          destinationDir: path.join(targetRoot, 'rules'),
          destinationNameTransform: toCursorRuleFileName,
        }));
      }

      if (sourceRelativePath === 'agents') {
        return takeUniqueOperations(createFlatFileOperations({
          moduleId: module.id,
          repoRoot,
          sourceRelativePath,
          destinationDir: path.join(targetRoot, 'agents'),
          destinationNameTransform: toCursorAgentFileName,
        }));
      }

      if (sourceRelativePath === '.cursor') {
        const cursorRoot = path.join(repoRoot, '.cursor');
        if (!fs.existsSync(cursorRoot) || !fs.statSync(cursorRoot).isDirectory()) {
          return [];
        }

        const childOperations = fs.readdirSync(cursorRoot, { withFileTypes: true })
          .sort((left, right) => left.name.localeCompare(right.name))
          .filter(entry => entry.name !== 'rules' && entry.name !== 'hooks.json')
          .map(entry => createManagedOperation({
            moduleId: module.id,
            sourceRelativePath: path.join('.cursor', entry.name),
            destinationPath: path.join(targetRoot, entry.name),
            strategy: 'preserve-relative-path',
          }));

        const ruleOperations = createFlatRuleOperations({
          moduleId: module.id,
          repoRoot,
          sourceRelativePath: '.cursor/rules',
          destinationDir: path.join(targetRoot, 'rules'),
          destinationNameTransform: toCursorRuleFileName,
        });

        return takeUniqueOperations([
          ...childOperations,
          ...(cursorMcpOperation ? [cursorMcpOperation] : []),
          ...ruleOperations,
        ]);
      }

      if (sourceRelativePath === 'mcp-configs') {
        const operations = [
          adapter.createScaffoldOperation(module.id, sourceRelativePath, planningInput),
        ];
        if (cursorMcpOperation) {
          operations.push(cursorMcpOperation);
        }
        return takeUniqueOperations(operations);
      }

      return takeUniqueOperations([
        adapter.createScaffoldOperation(module.id, sourceRelativePath, planningInput),
      ]);
    }), ...createCursorGuardianOperations(adapter, targetRoot, modules, repoRoot)];
  },
});
