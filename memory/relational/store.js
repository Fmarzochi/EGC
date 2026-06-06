const path = require('path');
const Database = require('better-sqlite3');
const IntegrityGuard = require('./IntegrityGuard');

class Store {
  constructor(baseDir) {
    this.dbPath = path.join(baseDir, 'memory', 'relational', 'egc.db');
    this.db = null;
    this.readonly = false;
    this.active = false;
    this.init();
  }

  init() {
    const integrity = IntegrityGuard.check(this.dbPath);
    if (!integrity.safe) {
      console.warn(`[MEMORY_WARN] Database integrity check failed. Entering READONLY/OFFLINE mode. Reason: ${integrity.reason}`);
      this.active = false;
      return;
    }

    try {
      this.db = new Database(this.dbPath, { timeout: 2000 });
      // WAL mode for better concurrency and fewer SQLITE_BUSY errors
      this.db.pragma('journal_mode = WAL');
      this.active = true;
    } catch (err) {
      console.warn(`[MEMORY_WARN] Database failed to boot: ${err.message}. Router will survive in amnesiac mode.`);
      this.active = false;
    }
  }

  executeSafe(operation) {
    if (!this.active || !this.db) return null;
    
    try {
      return operation(this.db);
    } catch (err) {
      if (IntegrityGuard.isLocked(err)) {
        console.warn(`[MEMORY_WARN] Database locked (SQLITE_BUSY). Write ignored to survive.`);
      } else {
        console.warn(`[MEMORY_WARN] Query failed: ${err.message}. Recovering...`);
      }
      return null;
    }
  }

  shutdown() {
    if (this.db && this.active) {
      try {
        this.db.close();
      } catch (err) {
        console.warn(`[MEMORY_WARN] Failed to close database: ${err.message}`);
      }
    }
  }
}

module.exports = Store;
