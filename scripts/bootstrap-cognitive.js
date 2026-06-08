#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const MARKER = '<!-- egc-memory-protocol -->';

const BLOCK = `
<!-- egc-memory-protocol -->
## EGC Session Memory

The \`egc-memory\` MCP server is installed. Use it to maintain cross-session memory:

**Start of every session:** Call \`get_state({})\` to restore project context — decisions made, what failed, what to pick up next.
**End of every session:** Call \`update_state({...})\` to save decisions, preferences, and next steps.

State files live at \`~/.egc/state/<project-slug>.md\` — plain Markdown, one file per project.
<!-- /egc-memory-protocol -->
`;

const CODEX_PROTOCOL_SUFFIX = ' At the start of every session call get_state({}) via egc-memory to restore context. At the end call update_state({...}) to save decisions.';
const CODEX_PROTOCOL_FULL   = `persistent_instructions = "At the start of every session call get_state({}) via egc-memory to restore context. At the end call update_state({...}) to save decisions. State lives at ~/.egc/state/<slug>.md."\n`;

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
  console.log(`  [cognitive] Claude Code: unexpected error — ${e.message}`);
}

// ── Gemini CLI / AGY ──────────────────────────────────────────────────────────
try {
  if (fs.existsSync(path.join(HOME, '.gemini'))) {
    injectProtocol(path.join(HOME, '.gemini', 'GEMINI.md'), 'Gemini CLI');
  }
} catch (e) {
  console.log(`  [cognitive] Gemini CLI: unexpected error — ${e.message}`);
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
      } catch (_) {
        console.log('  [cognitive] Cursor: settings.json is not valid JSON (JSONC?) — skipping');
        return;
      }
      const existing = obj['cursor.rules'] || '';
      if (existing.includes('[egc-memory-protocol]')) {
        console.log('  [cognitive] Cursor: already configured');
        return;
      }
      const separator = existing.trim() ? '\n\n' : '';
      obj['cursor.rules'] = existing + separator + '[egc-memory-protocol] At the start of every session call get_state({}) via egc-memory to restore project context. At the end call update_state({...}) to save decisions. State lives at ~/.egc/state/<slug>.md.';
      fs.writeFileSync(settingsFile + '.egc.bak', rawContent, 'utf8');
      fs.writeFileSync(settingsFile, JSON.stringify(obj, null, 2) + '\n', 'utf8');
      console.log(`  [cognitive] Cursor: memory protocol installed (${settingsFile.replace(HOME, '~')})`);
    } else {
      injectProtocol(path.join(HOME, '.cursor', 'rules'), 'Cursor');
    }
  } catch (e) {
    console.log(`  [cognitive] Cursor: unexpected error — ${e.message}`);
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
        console.log('  [cognitive] Codex: persistent_instructions multiline — skipping');
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
        console.log('  [cognitive] Codex: persistent_instructions in unrecognized format — skipping');
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
    console.log(`  [cognitive] Codex: unexpected error — ${e.message}`);
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
      fs.writeFileSync(target, '# EGC Session Memory\n\nAt the start of every session call `get_state({})` via egc-memory to restore context. At the end call `update_state({...})` to save decisions.\n');
    }
    console.log(`  [cognitive] OpenCode: memory protocol installed (${target.replace(HOME, '~')})`);
  } catch (e) {
    console.log(`  [cognitive] OpenCode: unexpected error — ${e.message}`);
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
    console.log(`  [cognitive] Trae: unexpected error — ${e.message}`);
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
      fs.writeFileSync(target, '# Session Memory\n\nAt the start of every session call `get_state({})` via egc-memory to restore context. At the end call `update_state({...})` to save decisions.\n');
    }
    console.log('  [cognitive] CodeBuddy: memory protocol installed (~/.codebuddy/MEMORY.md)');
  } catch (e) {
    console.log(`  [cognitive] CodeBuddy: unexpected error — ${e.message}`);
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
    console.log(`  [cognitive] Kiro: unexpected error — ${e.message}`);
  }
})();
