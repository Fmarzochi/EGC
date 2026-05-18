if (require.main === module) {
    console.error('[EGC] scripts/runtime/' + require('path').basename(__filename) + ' is DORMANT. See scripts/runtime/README.md.');
    process.exit(2);
}
/**
 * unmount-all.js
 * Removes all visibility mounts (symlinks/junctions) from .agents/skills/ and .agents/agents/.
 * Restores the environment to its clean, physical state.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const TARGETS = ['.agents/skills', '.agents/agents'];

function unmount() {
  console.log('--- Unmounting Visibility Layers ---');
  
  for (const targetDir of TARGETS) {
    if (!fs.existsSync(targetDir)) continue;
    
    const entries = fs.readdirSync(targetDir);
    for (const entry of entries) {
      const fullPath = path.join(targetDir, entry);
      const stats = fs.lstatSync(fullPath);
      
      if (stats.isSymbolicLink() || (os.platform() === 'win32' && stats.isDirectory())) {
        try {
          fs.unlinkSync(fullPath);
          console.log(`Unmounted: ${fullPath}`);
        } catch (err) {
          console.error(`Failed to unmount ${fullPath}: ${err.message}`);
        }
      }
    }
  }
  console.log('Cleanup complete.');
}

unmount();
