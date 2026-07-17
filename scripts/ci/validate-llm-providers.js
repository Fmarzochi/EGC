#!/usr/bin/env node
/**
 * Validate that every LLM provider named in README.md's "Works natively
 * with..." sentence has a real, corresponding file under src/llm/providers/.
 *
 * README.md and src/llm/providers/ are both hand-edited and had zero
 * automated check tying them together (audit EGC-128, medium finding):
 * agents/skills/commands counts are all guarded by scripts/ci/catalog.js,
 * but the native-provider list — the area with the most recent churn (two
 * new native providers landed within days of each other) — had none.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const README_PATH = path.join(REPO_ROOT, 'README.md');
const PROVIDERS_DIR = path.join(REPO_ROOT, 'src', 'llm', 'providers');

// Display name (as it appears in the README sentence) -> the .py file that
// must exist under src/llm/providers/. Necessarily hand-maintained (display
// names like "GPT-4o" and "Vertex AI" don't derive mechanically from
// filenames like openai.py/vertex_ai.py) — the value this script adds is
// the check itself, not eliminating the mapping.
const NATIVE_PROVIDER_FILES = {
  Claude: 'claude.py',
  'GPT-4o': 'openai.py',
  Gemini: 'gemini.py',
  DeepSeek: 'deepseek.py',
  Mistral: 'mistral.py',
  Groq: 'groq.py',
  Cohere: 'cohere.py',
  'Vertex AI': 'vertex_ai.py',
};

function extractNativeProviderSentence(readmeContent) {
  const match = readmeContent.match(/Works natively with ([^.]+)\./);
  if (!match) {
    throw new Error('README.md is missing the "Works natively with ..." sentence this validator checks');
  }
  return match[1];
}

function validate() {
  const readmeContent = fs.readFileSync(README_PATH, 'utf8');
  const sentence = extractNativeProviderSentence(readmeContent);

  let hasErrors = false;

  for (const [displayName, fileName] of Object.entries(NATIVE_PROVIDER_FILES)) {
    const mentioned = sentence.includes(displayName);
    const filePath = path.join(PROVIDERS_DIR, fileName);
    const fileExists = fs.existsSync(filePath);

    if (mentioned && !fileExists) {
      console.error(`ERROR: README.md claims native support for "${displayName}" but ${fileName} does not exist under src/llm/providers/`);
      hasErrors = true;
    }
    if (!mentioned && fileExists) {
      console.error(`ERROR: src/llm/providers/${fileName} exists but "${displayName}" is not mentioned in README.md's native-provider sentence — either advertise it or explain why not`);
      hasErrors = true;
    }
  }

  // Providers this repo ships that are deliberately NOT part of the
  // "Works natively" claim (Ollama is local-only, OpenRouter is announced
  // separately as the fallback aggregator) are not checked here — only
  // the providers this script explicitly maps are in scope.

  if (hasErrors) {
    process.exit(1);
  }

  console.log(`Validated ${Object.keys(NATIVE_PROVIDER_FILES).length} native LLM providers named in README.md against src/llm/providers/`);
}

validate();
