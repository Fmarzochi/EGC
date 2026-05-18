if (require.main === module) {
    console.error('[EGC] scripts/runtime/' + require('path').basename(__filename) + ' is DORMANT. See scripts/runtime/README.md.');
    process.exit(2);
}
/**
 * discovery.js
 * Version 3.0: Hybrid Discovery for Skills & Agents
 * Recursively maps COLD library and HOT runtime for full visibility.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECT_ROOT = path.resolve('.');
const SKILLS_ROOT = path.join(PROJECT_ROOT, 'skills');
const AGENTS_ROOT = path.join(PROJECT_ROOT, 'agents');
const HOT_SKILLS_ROOT = path.join(PROJECT_ROOT, '.agents/skills');
const HOT_AGENTS_ROOT = path.join(PROJECT_ROOT, '.agents/agents');
const REGISTRY_FILE = path.join(PROJECT_ROOT, 'registry/runtime-map.json');

function normalizePortablePath(p) {
  return path.relative(PROJECT_ROOT, p).split(path.sep).join('/');
}

function getDirectories(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory() || dirent.isSymbolicLink())
    .map(dirent => dirent.name);
}

function discover() {
  console.log('--- EGC Hybrid Discovery Engine v3.0 ---');
  
  const namespaces = getDirectories(SKILLS_ROOT);
  const hotSkills = new Set(getDirectories(HOT_SKILLS_ROOT));
  const hotAgents = new Set(fs.existsSync(HOT_AGENTS_ROOT) ? fs.readdirSync(HOT_AGENTS_ROOT) : []);
  
  const registry = {
    generatedAt: new Date().toISOString(),
    os: os.platform(),
    projectRoot: PROJECT_ROOT.split(path.sep).join('/'),
    stats: {
      hotSkills: hotSkills.size,
      coldSkills: 0,
      hotAgents: hotAgents.size,
      coldAgents: 0
    },
    skills: [],
    agents: []
  };

  // 1. Map Skills
  for (const ns of namespaces) {
    const nsPath = path.join(SKILLS_ROOT, ns);
    const skillDirs = fs.readdirSync(nsPath, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory());

    for (const dirent of skillDirs) {
      const skillName = dirent.name;
      const skillPath = path.join(nsPath, skillName);
      const skillMd = path.join(skillPath, 'SKILL.md');

      if (fs.existsSync(skillMd)) {
        const id = `${ns}-${skillName}`;
        const isShadowed = hotSkills.has(id) || hotSkills.has(skillName);
        
        registry.skills.push({
          id,
          name: skillName,
          namespace: ns,
          physicalPath: normalizePortablePath(skillPath),
          targetLink: normalizePortablePath(path.join(HOT_SKILLS_ROOT, id)),
          status: isShadowed ? 'shadowed' : 'cold',
          runtime: detectRuntime(skillPath)
        });
        registry.stats.coldSkills++;
      }
    }
  }

  // 2. Map Agents
  if (fs.existsSync(AGENTS_ROOT)) {
    const agentFiles = fs.readdirSync(AGENTS_ROOT).filter(f => f.endsWith('.md'));
    for (const file of agentFiles) {
      const isShadowed = hotAgents.has(file);
      registry.agents.push({
        name: file,
        physicalPath: normalizePortablePath(path.join(AGENTS_ROOT, file)),
        targetLink: normalizePortablePath(path.join(HOT_AGENTS_ROOT, file)),
        status: isShadowed ? 'shadowed' : 'cold'
      });
      registry.stats.coldAgents++;
    }
  }

  if (!fs.existsSync(path.dirname(REGISTRY_FILE))) {
    fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });
  }

  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
  console.log(`Successfully indexed ${registry.stats.coldSkills} skills and ${registry.stats.coldAgents} agents.`);
  console.log(`Registry saved to: ${REGISTRY_FILE}`);
}

function detectRuntime(dir) {
  const runtime = [];
  const files = fs.readdirSync(dir, { recursive: true });
  if (files.some(f => f.endsWith('.py'))) runtime.push('python');
  if (files.some(f => f.endsWith('.sh'))) runtime.push('shell');
  if (files.some(f => f.endsWith('.js') || f.endsWith('.ts'))) runtime.push('node');
  return runtime;
}

discover();
