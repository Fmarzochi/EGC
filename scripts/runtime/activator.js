if (require.main === module) {
    console.error('[EGC] scripts/runtime/' + require('path').basename(__filename) + ' is DORMANT. See scripts/runtime/README.md.');
    process.exit(2);
}
/**
 * activator.js
 * Cross-platform skill activator (Symlink/Junction).
 * Maps COLD skills into HOT runtime explicitly.
 */

const fs = require('fs');
const os = require('os');

/**
 * Activates a skill by creating a symlink in .agents/skills/
 * @param {string} physicalPath - Absolute path to the skill directory
 * @param {string} targetLink - Absolute path where the symlink should be created
 */
function activate(physicalPath, targetLink) {
  if (!fs.existsSync(physicalPath)) {
    throw new Error(`Physical path does not exist: ${physicalPath}`);
  }

  if (fs.existsSync(targetLink)) {
    const stats = fs.lstatSync(targetLink);
    if (stats.isSymbolicLink() || (os.platform() === 'win32' && stats.isDirectory())) {
      console.log(`Already active: ${targetLink}`);
      return;
    }
    throw new Error(`Collision detected: ${targetLink} exists and is NOT a link/junction.`);
  }

  const type = os.platform() === 'win32' ? 'junction' : 'dir';
  
  try {
    fs.symlinkSync(physicalPath, targetLink, type);
    console.log(`Activated: ${targetLink} -> ${physicalPath}`);
  } catch (err) {
    if (os.platform() === 'win32' && err.code === 'EPERM') {
      console.error('ERROR: Windows Symlink/Junction requires elevated privileges or Developer Mode.');
    }
    throw err;
  }
}

/**
 * Deactivates a skill by removing the symlink.
 * @param {string} targetLink - Path to the symlink
 */
function deactivate(targetLink) {
  if (fs.existsSync(targetLink)) {
    const stats = fs.lstatSync(targetLink);
    if (stats.isSymbolicLink() || (os.platform() === 'win32' && stats.isDirectory())) {
      fs.unlinkSync(targetLink);
      console.log(`Deactivated: ${targetLink}`);
    } else {
      throw new Error(`Cannot deactivate: ${targetLink} is not a symlink/junction.`);
    }
  }
}

module.exports = { activate, deactivate };
