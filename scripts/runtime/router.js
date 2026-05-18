if (require.main === module) {
    console.error('[EGC] scripts/runtime/' + require('path').basename(__filename) + ' is DORMANT. See scripts/runtime/README.md.');
    process.exit(2);
}
/**
 * router.js
 * CLI interface for EGC Skill & Agent Router.
 * Bridges COLD library with HOT runtime dynamically.
 */

const fs = require('fs');
const path = require('path');
const { activate, deactivate } = require('./activator');

const PROJECT_ROOT = path.resolve('.');
const REGISTRY_FILE = path.join(PROJECT_ROOT, 'registry/runtime-map.json');

function loadRegistry() {
  if (!fs.existsSync(REGISTRY_FILE)) {
    throw new Error('Registry not found. Run discovery.js first.');
  }
  return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
}

const commands = {
  /**
   * List all components in the registry.
   */
  list: (type = 'skills') => {
    const registry = loadRegistry();
    const items = registry[type] || [];
    console.log(`--- EGC ${type.toUpperCase()} Inventory ---`);
    items.forEach(item => {
      const id = item.id || item.name;
      console.log(`[${item.status.toUpperCase()}] ${id}`);
    });
  },

  /**
   * Search for components by keyword.
   */
  search: (query) => {
    const registry = loadRegistry();
    console.log(`--- Search Results for "${query}" ---`);
    
    const skillMatches = registry.skills.filter(s => 
      s.id.toLowerCase().includes(query.toLowerCase()) || 
      s.name.toLowerCase().includes(query.toLowerCase())
    );
    
    const agentMatches = registry.agents.filter(a => 
      a.name.toLowerCase().includes(query.toLowerCase())
    );

    if (skillMatches.length > 0) {
      console.log('\nSkills:');
      skillMatches.forEach(s => console.log(`  - ${s.id} [${s.status}]`));
    }

    if (agentMatches.length > 0) {
      console.log('\nAgents:');
      agentMatches.forEach(a => console.log(`  - ${a.name} [${a.status}]`));
    }
  },

  /**
   * Activate a component (Skill or Agent).
   */
  activate: (id) => {
    const registry = loadRegistry();
    let item = registry.skills.find(s => s.id === id);
    if (!item) item = registry.agents.find(a => a.name === id);
    
    if (!item) throw new Error(`Component not found: ${id}`);
    
    activate(path.resolve(item.physicalPath), path.resolve(item.targetLink));
  },

  /**
   * Deactivate a component.
   */
  deactivate: (id) => {
    const registry = loadRegistry();
    let item = registry.skills.find(s => s.id === id);
    if (!item) item = registry.agents.find(a => a.name === id);
    
    if (!item) throw new Error(`Component not found: ${id}`);
    
    deactivate(path.resolve(item.targetLink));
  },

  /**
   * Sync the runtime with the registry (discovery).
   */
  sync: () => {
    const { spawnSync } = require('child_process');
    console.log('Running discovery...');
    const result = spawnSync('node', [path.join(PROJECT_ROOT, 'scripts/runtime/discovery.js')], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error('Discovery failed.');
  }
};

const [,, cmd, ...args] = process.argv;

if (!commands[cmd]) {
  console.log('Usage: node router.js <list|search|activate|deactivate|sync> [args]');
  process.exit(1);
}

try {
  commands[cmd](...args);
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
}
