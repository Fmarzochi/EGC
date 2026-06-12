#!/usr/bin/env node
if (require.main === module) {
    console.error('[EGC] scripts/generate-plugin-manifest.js is DORMANT. See docs/governance/SUBSYSTEM-MAP.md.');
    process.exit(2);
}
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const SKILLS_REGISTRY_PATH = path.join(PROJECT_ROOT, 'registry/skills-registry.json');
const AGENTS_REGISTRY_PATH = path.join(PROJECT_ROOT, 'registry/agents-registry.json');
const PLUGIN_JSON_PATH = path.join(PROJECT_ROOT, '.gemini-plugin/plugin.json');

const MAX_SKILLS_PER_NAMESPACE = 30;

function generateManifest() {
  console.log('--- EGC Manifest Generator ---');

  if (!fs.existsSync(SKILLS_REGISTRY_PATH) || !fs.existsSync(AGENTS_REGISTRY_PATH)) {
    console.error('ERROR: Registries not found. Run Phase 5A first.');
    process.exit(1);
  }

  const skillsRegistry = JSON.parse(fs.readFileSync(SKILLS_REGISTRY_PATH, 'utf-8'));
  const agentsRegistry = JSON.parse(fs.readFileSync(AGENTS_REGISTRY_PATH, 'utf-8'));

  // 1. Group Skills by Namespace
  const namespaces = {};
  skillsRegistry.forEach(s => {
    if (!namespaces[s.namespace]) namespaces[s.namespace] = [];
    namespaces[s.namespace].push(s.name);
  });

  // 2. Validate Overflow and Paths
  const skillSources = [];
  const sortedNamespaces = Object.keys(namespaces).sort((a, b) => a.localeCompare(b));
  
  sortedNamespaces.forEach(ns => {
    const count = namespaces[ns].length;
    if (count > MAX_SKILLS_PER_NAMESPACE) {
      console.warn(`WARNING: Namespace '${ns}' has ${count} skills, exceeding limit of ${MAX_SKILLS_PER_NAMESPACE}. Discovery may be truncated.`);
    }
    
    const nsPath = `./skills/${ns}/`;
    if (fs.existsSync(path.join(PROJECT_ROOT, 'skills', ns))) {
      skillSources.push(nsPath);
    } else {
      console.error(`ERROR: Path for namespace '${ns}' does not exist: ${nsPath}`);
    }
  });

  // 3. Prepare Base Plugin Data (Preserving existing metadata)
  let existingData = {};
  if (fs.existsSync(PLUGIN_JSON_PATH)) {
    existingData = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf-8'));
  }

  const manifest = {
    name: existingData.name || "everything-gemini",
    version: existingData.version || "1.0.0",
    description: existingData.description || "",
    author: existingData.author || {},
    homepage: existingData.homepage || "",
    repository: existingData.repository || "",
    license: existingData.license || "MIT",
    keywords: existingData.keywords || [],
    mcpServers: existingData.mcpServers || {},
    agents: {
      test: {
        description: "Test subagent",
        instructions: "agents/test.md"
      }
    },
    skills: skillSources,
    commands: ["./commands/"]
  };

  // 4. Write Manifest
  fs.writeFileSync(PLUGIN_JSON_PATH, JSON.stringify(manifest, null, 2));
  console.log(`SUCCESS: Generated manifest with ${skillSources.length} skill sources and ${agentsRegistry.length} agents.`);
}

generateManifest();
