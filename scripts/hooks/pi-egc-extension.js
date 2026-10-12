'use strict';

function loadHook(name) {
  try {
    return require(`../scripts/hooks/${name}`);
  } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND') throw error;
    return require(`./${name}`);
  }
}

const { run: runGuardian } = loadHook('pre-bash-guardian-validate');
const { run: runWriteGuardian } = loadHook('pre-write-guardian-validate');
const { run: runCrusherRewrite } = loadHook('pre-bash-crusher-rewrite');

const WRITE_TOOLS = { edit: 'Edit', write: 'Write' };

function guardianDenial(toolName, input, cwd) {
  if (!input || typeof input !== 'object') return null;
  let verdict = null;
  if (toolName === 'bash' && typeof input.command === 'string') {
    verdict = runGuardian({ tool_name: 'Bash', tool_input: { command: input.command }, cwd });
  } else if (WRITE_TOOLS[toolName] && typeof input.path === 'string') {
    verdict = runWriteGuardian({
      tool_name: WRITE_TOOLS[toolName],
      tool_input: { file_path: input.path, path: input.path, content: typeof input.content === 'string' ? input.content : undefined },
      cwd,
    });
  }
  return verdict?.exitCode === 2 ? (verdict.stderr || 'Blocked by the EGC Guardian.') : null;
}

function crushCommand(input) {
  try {
    const rewritten = JSON.parse(runCrusherRewrite({ tool_input: { command: input.command } }));
    if (typeof rewritten?.tool_input?.command === 'string') input.command = rewritten.tool_input.command;
  } catch {
    return;
  }
}

function handleToolCall(event, ctx) {
  const cwd = typeof ctx?.cwd === 'string' ? ctx.cwd : process.cwd();
  const denial = guardianDenial(event?.toolName, event?.input, cwd);
  if (denial) return { block: true, reason: denial };
  if (event?.toolName === 'bash' && typeof event.input?.command === 'string') crushCommand(event.input);
  return undefined;
}

function egcPiExtension(pi) {
  pi.on('tool_call', async (event, ctx) => handleToolCall(event, ctx));
}

module.exports = egcPiExtension;
module.exports.default = egcPiExtension;
module.exports.guardianDenial = guardianDenial;
module.exports.handleToolCall = handleToolCall;
