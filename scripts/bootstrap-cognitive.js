#!/usr/bin/env node
'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const MARKER = '<!-- egc-memory-protocol -->';

// Shared by every harness's protocol text below (BLOCK and the markdown
// fallbacks) so the 9 session bus commands and 5 Guardian commands can't
// drift out of sync across the 9+ copies the way they did before this fix.
const AUTO_INTUITION_MD = `## EGC Auto-Intuition

Act on user intent, not keywords. When what the user says implies an EGC action, call the right tool immediately -- no explicit command needed.

- Session ending (goodbye, break, sleep, done, closing) → call \`update_state\`
- Session starting or resuming → call \`get_state\`
- Context was just compacted/summarized (short recap, missing earlier detail, references to work you don't remember doing) → call \`get_state\` again immediately, do not wait to be asked
- Save/remember this decision → call \`lesson_save\` or \`store_decision\`
- What failed? What did we decide? → call \`search_history\` or \`query_history\`
- Review code or a PR → spawn \`/review-pr\` agents
- Context is heavy or slow → call \`reduce_context\`
- How much did I save? How many tokens did this session save or cost? → run \`egc gain\` (short form: \`egc saved\`)
- What savings am I missing? What is wasting my tokens? → run \`egc discover\`
- Show me the savings history → run \`egc gain --history\`
- I need the full/raw output of that command → rerun it through \`egc run --raw\`
- Did another session/tab leave me anything? What are the others doing? → call \`session_events\` (and \`session_peers\`)
- Tell the other session/tab something, hand work off → call \`session_send\`
- Join session / announce presence → call \`session_announce\`
- Lock / claim a file path to avoid conflicts with other sessions → call \`claim_path\`
- Unlock / release a claimed file path → call \`release_path\`
- Read shared working memory → call \`working_memory_get\`
- Save a key/value to shared working memory → call \`working_memory_set\`
- List shared working memory keys → call \`working_memory_list\`

Judge by the full conversation context, never by literal words. A remark to someone nearby is not a command. When intent is ambiguous, keep working.`;

const GUARDIAN_MD = `## EGC Guardian Protocol

These calls are automatic and non-negotiable. Never wait for the user to ask.

**Start of every non-trivial task:** call \`orchestrate_task({ prompt: "<task>" })\`
**Before every shell/Bash command:** call \`validate_command({ command: "<cmd>" })\`
**Before every new file Write or Edit on a file not yet read:** call \`validate_write({ filepath: "<path>" })\`
**At the end of every significant work block:** call \`auto_learn({ project_path: "<cwd>" })\`

Skipping any of these breaks the EGC contract. There are no exceptions for "simple" tasks.`;

const CRUSHER_MD = `## EGC Token Crusher Protocol

**Route heavy commands through \`egc run\` yourself -- do not wait for a hook to rewrite them.** The Guardian hook attempts an automatic PreToolUse rewrite, but Anthropic confirmed and closed as "not planned" that this rewrite is silently ignored when the assistant itself issues the Bash tool call (not a human typing in a terminal). Relying on the hook alone means noisy output reaches you uncompressed every time.

**Before running any command likely to produce large or noisy output, prefix it yourself:** \`egc run <command>\` instead of \`<command>\` directly. Examples: \`egc run git log --stat -n 50\`, \`egc run git diff\`, \`egc run npm install\`, \`egc run npm test\`, \`egc run find . -name "*.ts"\`.

If you genuinely need the full, uncompressed output, use \`egc run --raw <command>\` -- never skip the wrapper entirely for a command that would otherwise be crushable.`;

const BLOCK = `
<!-- egc-memory-protocol -->
## EGC Session Memory

The \`egc-memory\` MCP server is installed. Use it to maintain cross-session memory:

**Start of every session:** Call \`get_state({})\` to restore project context: decisions made, what failed, what to pick up next.
**End of every session:** Call \`update_state({...})\` to save decisions, preferences, and next steps.

State files live at \`~/.egc/state/<project-slug>.md\`: plain Markdown, one file per project.

${AUTO_INTUITION_MD}

${GUARDIAN_MD}

${CRUSHER_MD}
<!-- /egc-memory-protocol -->
`;

// Standalone Markdown file used by harnesses that read a static instructions
// file instead of a global rules block (OpenCode/CodeBuddy fallback content,
// mirrors the .opencode/.codebuddy source files copied below).
function markdownProtocolBody(title) {
  return `# ${title}\n\nAt the start of every session call \`get_state({})\` via egc-memory to restore context. At the end call \`update_state({...})\` to save decisions.\n\n${AUTO_INTUITION_MD}\n\n${GUARDIAN_MD}\n\n${CRUSHER_MD}\n`;
}

// Single-line TOML string (matches the pre-existing persistent_instructions
// format): kept flattened rather than switched to a triple-quoted multiline
// TOML string, to avoid restructuring a value format that already installs
// correctly in production rather than risk a new TOML parsing edge case.
const CODEX_PROTOCOL_SUFFIX = ' At the start of every session call get_state({}) via egc-memory to restore context. At the end call update_state({...}) to save decisions. Act on user intent not keywords: session ending->update_state, session start->get_state, save this->lesson_save or store_decision, what failed->search_history, review PR->review-pr agents, context heavy->reduce_context, how much did I save->egc gain, missed savings->egc discover, another session left something->session_events/session_peers, hand off work->session_send, join session->session_announce, lock a path->claim_path, unlock a path->release_path, read shared memory->working_memory_get, save shared memory->working_memory_set, list shared memory->working_memory_list. Judge by full context not literal words. Guardian Protocol (mandatory): before every non-trivial task call orchestrate_task, before every shell command call validate_command, before every new file write/edit call validate_write, after every work block call auto_learn. Token Crusher Protocol (mandatory): the automatic hook rewrite is silently ignored for assistant-issued Bash calls (confirmed Claude Code limitation, not planned to be fixed) -- prefix any command likely to produce large output yourself with egc run <command> instead of running it directly, e.g. egc run git log --stat, egc run npm install, egc run npm test; use egc run --raw <command> only when you genuinely need the uncompressed output.';
const CODEX_PROTOCOL_FULL   = `persistent_instructions = "State lives at ~/.egc/state/<slug>.md.${CODEX_PROTOCOL_SUFFIX}"\n`;

const HOME = os.homedir();

function injectProtocol(filepath, label) {
  const exists = fs.existsSync(filepath);
  if (exists) {
    const raw = fs.readFileSync(filepath, 'utf8');
    if (raw.includes(MARKER)) {
      console.log(`  [cognitive] ${label}: already configured`);
      return;
    }
    fs.writeFileSync(filepath + '.egc.bak', raw, 'utf8');
    fs.writeFileSync(filepath, raw + BLOCK, 'utf8');
  } else {
    const dir = path.dirname(filepath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filepath, BLOCK, 'utf8');
  }
  console.log(`  [cognitive] ${label}: memory protocol installed (${filepath.replace(HOME, '~')})`);
}

// ── Claude Code ───────────────────────────────────────────────────────────────
try {
  if (fs.existsSync(path.join(HOME, '.claude'))) {
    injectProtocol(path.join(HOME, '.claude', 'CLAUDE.md'), 'Claude Code');
  }
} catch (e) {
  console.log(`  [cognitive] Claude Code: unexpected error: ${e.message}`);
}

// ── Gemini CLI / AGY ──────────────────────────────────────────────────────────
try {
  if (fs.existsSync(path.join(HOME, '.gemini'))) {
    injectProtocol(path.join(HOME, '.gemini', 'GEMINI.md'), 'Gemini CLI');
  }
} catch (e) {
  console.log(`  [cognitive] Gemini CLI: unexpected error: ${e.message}`);
}

// ── Cursor (global User Rules via settings.json) ──────────────────────────────
(function bootstrapCursor() {
  try {
    const settingsPaths = [
      path.join(HOME, '.config', 'Cursor', 'User', 'settings.json'),
      path.join(HOME, 'Library', 'Application Support', 'Cursor', 'User', 'settings.json'),
      process.env.APPDATA ? path.join(process.env.APPDATA, 'Cursor', 'User', 'settings.json') : null,
    ].filter(Boolean);

    const settingsFile = settingsPaths.find(p => fs.existsSync(p));
    if (!settingsFile && !fs.existsSync(path.join(HOME, '.cursor'))) return;

    if (settingsFile) {
      const rawContent = fs.readFileSync(settingsFile, 'utf8');
      let obj;
      try {
        obj = JSON.parse(rawContent);
      } catch (_) { // NOSONAR: invalid JSON is reported via the user-facing skip message below
        console.log('  [cognitive] Cursor: settings.json is not valid JSON (JSONC?): skipping');
        return;
      }
      const existing = obj['cursor.rules'] || '';
      if (existing.includes('[egc-memory-protocol]')) {
        console.log('  [cognitive] Cursor: already configured');
        return;
      }
      const separator = existing.trim() ? '\n\n' : '';
      obj['cursor.rules'] = existing + separator + '[egc-memory-protocol] At the start of every session call get_state({}) via egc-memory to restore project context. At the end call update_state({...}) to save decisions. State lives at ~/.egc/state/<slug>.md. [egc-auto-intuition] Act on user intent not keywords: session ending->update_state, session start->get_state, save this->lesson_save or store_decision, what failed->search_history, review PR->review-pr agents, context heavy->reduce_context, how much did I save->egc gain, missed savings->egc discover, another session left something->session_events/session_peers, hand off work->session_send, join session->session_announce, lock a path->claim_path, unlock a path->release_path, read shared memory->working_memory_get, save shared memory->working_memory_set, list shared memory->working_memory_list. Judge by full context not literal words. [egc-guardian] Before every non-trivial task call orchestrate_task. Before every shell command call validate_command. Before every new file write/edit call validate_write. After every work block call auto_learn.';
      fs.writeFileSync(settingsFile + '.egc.bak', rawContent, 'utf8');
      fs.writeFileSync(settingsFile, JSON.stringify(obj, null, 2) + '\n', 'utf8');
      console.log(`  [cognitive] Cursor: memory protocol installed (${settingsFile.replace(HOME, '~')})`);
    } else {
      injectProtocol(path.join(HOME, '.cursor', 'rules'), 'Cursor');
    }
  } catch (e) {
    console.log(`  [cognitive] Cursor: unexpected error: ${e.message}`);
  }
})();

// ── Codex CLI (persistent_instructions in ~/.codex/config.toml) ───────────────
(function bootstrapCodex() {
  try {
    const codexDir = path.join(HOME, '.codex');
    if (!fs.existsSync(codexDir)) return;
    const tomlPath = path.join(codexDir, 'config.toml');

    if (fs.existsSync(tomlPath)) {
      const originalContent = fs.readFileSync(tomlPath, 'utf8');
      if (originalContent.includes('egc-memory-protocol') || originalContent.includes('get_state')) {
        console.log('  [cognitive] Codex: already configured');
        return;
      }

      const RE_TRIPLE_D = /^persistent_instructions\s*=\s*"""/m;
      const RE_TRIPLE_S = /^persistent_instructions\s*=\s*'''/m;
      const RE_DOUBLE   = /^(persistent_instructions\s*=\s*")(.*?)(")\s*$/m;
      const RE_SINGLE   = /^(persistent_instructions\s*=\s*')(.*?)(')\s*$/m;
      const hasKey      = /^persistent_instructions\s*=/m.test(originalContent);

      if (RE_TRIPLE_D.test(originalContent) || RE_TRIPLE_S.test(originalContent)) {
        console.log('  [cognitive] Codex: persistent_instructions multiline: skipping');
        return;
      }

      let newContent;
      if (RE_DOUBLE.test(originalContent)) {
        newContent = originalContent.replace(
          RE_DOUBLE,
          (_, pre, val, post) => `${pre}${val}${CODEX_PROTOCOL_SUFFIX}${post}`
        );
      } else if (RE_SINGLE.test(originalContent)) {
        newContent = originalContent.replace(
          RE_SINGLE,
          (_, _pre, val, _post) => `persistent_instructions = "${val}${CODEX_PROTOCOL_SUFFIX}"`
        );
      } else if (hasKey) {
        console.log('  [cognitive] Codex: persistent_instructions in unrecognized format: skipping');
        return;
      } else {
        newContent = originalContent + '\n' + CODEX_PROTOCOL_FULL;
      }

      fs.writeFileSync(tomlPath + '.egc.bak', originalContent, 'utf8');
      fs.writeFileSync(tomlPath, newContent, 'utf8');
    } else {
      const dir = path.dirname(tomlPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tomlPath, CODEX_PROTOCOL_FULL);
    }
    console.log(`  [cognitive] Codex: memory protocol installed (${tomlPath.replace(HOME, '~')})`);
  } catch (e) {
    console.log(`  [cognitive] Codex: unexpected error: ${e.message}`);
  }
})();

// ── OpenCode (~/.opencode/instructions/EGC_MEMORY.md) ────────────────────────
(function bootstrapOpenCode() {
  try {
    const opencodeDir = path.join(HOME, '.opencode');
    if (!fs.existsSync(opencodeDir)) return;
    const instructionsDir = path.join(opencodeDir, 'instructions');
    const target = path.join(instructionsDir, 'EGC_MEMORY.md');
    if (fs.existsSync(target)) {
      console.log('  [cognitive] OpenCode: already configured');
      return;
    }
    if (!fs.existsSync(instructionsDir)) fs.mkdirSync(instructionsDir, { recursive: true });
    const src = path.join(__dirname, '..', '.opencode', 'instructions', 'EGC_MEMORY.md');
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, target);
    } else {
      fs.writeFileSync(target, markdownProtocolBody('EGC Session Memory'));
    }
    console.log(`  [cognitive] OpenCode: memory protocol installed (${target.replace(HOME, '~')})`);
  } catch (e) {
    console.log(`  [cognitive] OpenCode: unexpected error: ${e.message}`);
  }
})();

// ── Trae (~/.trae/MEMORY.md and ~/.trae-cn/MEMORY.md) ────────────────────────
(function bootstrapTrae() {
  try {
    const src = path.join(__dirname, '..', '.trae', 'MEMORY.md');
    if (!fs.existsSync(src)) return;
    for (const dir of ['.trae', '.trae-cn']) {
      const traeDir = path.join(HOME, dir);
      if (!fs.existsSync(traeDir)) continue;
      const target = path.join(traeDir, 'MEMORY.md');
      if (fs.existsSync(target)) {
        console.log(`  [cognitive] Trae (${dir}): already configured`);
        continue;
      }
      fs.copyFileSync(src, target);
      console.log(`  [cognitive] Trae (${dir}): memory protocol installed (~/${dir}/MEMORY.md)`);
    }
  } catch (e) {
    console.log(`  [cognitive] Trae: unexpected error: ${e.message}`);
  }
})();

// ── CodeBuddy (~/.codebuddy/MEMORY.md) ───────────────────────────────────────
(function bootstrapCodeBuddy() {
  try {
    const codebuddyDir = path.join(HOME, '.codebuddy');
    if (!fs.existsSync(codebuddyDir)) return;
    const target = path.join(codebuddyDir, 'MEMORY.md');
    if (fs.existsSync(target)) {
      console.log('  [cognitive] CodeBuddy: already configured');
      return;
    }
    const src = path.join(__dirname, '..', '.codebuddy', 'MEMORY.md');
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, target);
    } else {
      fs.writeFileSync(target, markdownProtocolBody('Session Memory'));
    }
    console.log('  [cognitive] CodeBuddy: memory protocol installed (~/.codebuddy/MEMORY.md)');
  } catch (e) {
    console.log(`  [cognitive] CodeBuddy: unexpected error: ${e.message}`);
  }
})();

// ── Continue.dev (~/.continue/prompts/egc-memory.prompt) ─────────────────────
(function bootstrapContinue() {
  try {
    const continueDir = path.join(HOME, '.continue');
    if (!fs.existsSync(continueDir)) return;
    const promptsDir = path.join(continueDir, 'prompts');
    const target = path.join(promptsDir, 'egc-memory.prompt');
    if (fs.existsSync(target)) {
      console.log('  [cognitive] Continue.dev: already configured');
      return;
    }
    if (!fs.existsSync(promptsDir)) fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(target, `name: EGC Session Memory\ndescription: Restore and persist EGC cross-session memory\n---\nAt the start of every session call \`get_state({})\` via egc-memory to restore context. At the end call \`update_state({...})\` to save decisions.\n\n${AUTO_INTUITION_MD}\n\n${GUARDIAN_MD}\n\n${CRUSHER_MD}\n`);
    console.log('  [cognitive] Continue.dev: memory protocol installed (~/.continue/prompts/egc-memory.prompt)');
  } catch (e) {
    console.log(`  [cognitive] Continue.dev: unexpected error: ${e.message}`);
  }
})();

// ── Kiro (~/.kiro/hooks/) ─────────────────────────────────────────────────────
(function bootstrapKiro() {
  try {
    const kiroDir = path.join(HOME, '.kiro');
    if (!fs.existsSync(kiroDir)) return;
    const hooksDir = path.join(kiroDir, 'hooks');
    if (!fs.existsSync(hooksDir)) fs.mkdirSync(hooksDir, { recursive: true });
    const srcDir = path.join(__dirname, '..', '.kiro', 'hooks');
    let installed = false;
    for (const hook of ['session-restore.kiro.hook', 'session-save.kiro.hook']) {
      const dest = path.join(hooksDir, hook);
      if (fs.existsSync(dest)) continue;
      const src = path.join(srcDir, hook);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
        installed = true;
      }
    }
    if (installed) {
      console.log('  [cognitive] Kiro: session hooks installed (~/.kiro/hooks/)');
    } else {
      console.log('  [cognitive] Kiro: already configured');
    }
  } catch (e) {
    console.log(`  [cognitive] Kiro: unexpected error: ${e.message}`);
  }
})();

// ── Windsurf (~/.codeium/windsurf/memories/global_rules.md) ──────────────────
(function bootstrapWindsurf() {
  try {
    const codeiumDir = path.join(HOME, '.codeium');
    if (!fs.existsSync(codeiumDir)) return;
    const target = path.join(codeiumDir, 'windsurf', 'memories', 'global_rules.md');
    injectProtocol(target, 'Windsurf');
  } catch (e) {
    console.log(`  [cognitive] Windsurf: unexpected error: ${e.message}`);
  }
})();

// ── Zed (~/.config/zed/AGENTS.md) ─────────────────────────────────────────────
(function bootstrapZed() {
  try {
    const zedDir = path.join(HOME, '.config', 'zed');
    if (!fs.existsSync(zedDir)) return;
    injectProtocol(path.join(zedDir, 'AGENTS.md'), 'Zed');
  } catch (e) {
    console.log(`  [cognitive] Zed: unexpected error: ${e.message}`);
  }
})();
