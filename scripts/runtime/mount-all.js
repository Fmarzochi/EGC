if (require.main === module) {
    console.error('[EGC] scripts/runtime/' + require('path').basename(__filename) + ' is DORMANT. See scripts/runtime/README.md.');
    process.exit(2);
}
/**
 * mount-all.js
 * Registry-driven orchestrator for visibility mounts.
 * Maps agents and skills into HOT runtime paths.
 */

const fs = require('fs');
const path = require('path');
const { activate } = require('./activator');

const REGISTRY_FILE = path.resolve('registry/runtime-map.json');
const AGENTS_SRC = path.resolve('agents');
const AGENTS_DEST = path.resolve('.agents/agents');

function mount() {
  console.log('--- Mounting Hybrid Visibility Layer ---');

  // 1. Mount Skills from Registry
  if (!fs.existsSync(REGISTRY_FILE)) {
    console.error('ERROR: Registry not found. Run discovery.js first.');
    return;
  }
  const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
  
  let skillCount = 0;
  for (const skill of registry.skills) {
    if (skill.status === 'cold') {
      try {
        activate(path.resolve(skill.physicalPath), path.resolve(skill.targetLink));
        skillCount++;
      } catch (err) {
        console.warn(`[SKIP] Skill ${skill.id}: ${err.message}`);
      }
    } else {
      console.log(`[AUTH] Authoritative version exists for: ${skill.name}`);
    }
  }

  // 2. Mount Agents
  if (!fs.existsSync(AGENTS_DEST)) fs.mkdirSync(AGENTS_DEST, { recursive: true });
  const agents = fs.readdirSync(AGENTS_SRC).filter(f => f.endsWith('.md'));
  
  let agentCount = 0;
  for (const agentFile of agents) {
    const src = path.join(AGENTS_SRC, agentFile);
    const dest = path.join(AGENTS_DEST, agentFile);
    
    if (fs.existsSync(dest)) {
      const stats = fs.lstatSync(dest);
      if (stats.isSymbolicLink()) continue; // Already linked
      console.log(`[AUTH] Authoritative agent exists: ${agentFile}`);
      continue;
    }

    try {
      // Agents are files, but we link them individually
      const type = process.platform === 'win32' ? 'file' : 'file';
      fs.symlinkSync(src, dest, type);
      agentCount++;
    } catch (err) {
      console.warn(`[ERR] Agent ${agentFile}: ${err.message}`);
    }
  }

  console.log(`\nMounting Summary:`);
  console.log(`- Skills Mounted: ${skillCount}`);
  console.log(`- Agents Mounted: ${agentCount}`);
}

mount();
