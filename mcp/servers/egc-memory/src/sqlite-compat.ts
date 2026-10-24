// Thin typed door to the shared engine chooser in scripts/lib (native
// sqlite3 first, the portable sql.js engine when it cannot load). The
// package ships scripts/ next to mcp/servers/*/build, so the relative path
// holds in a checkout and in a global npm install alike.
import { createRequire } from 'node:module';
import type { Database } from 'sqlite';

type CompatModule = {
  openCompatDatabase(filename: string, serverName: string): Promise<Database>;
  selectedEngine(): 'native' | 'wasm';
  enableWalBestEffort(db: Database): Promise<void>;
};

const load = createRequire(__filename);
const compat = load('../../../../scripts/lib/state-store/sqlite-compat.js') as CompatModule;

export function openCompatDatabase(filename: string, serverName: string): Promise<Database> {
  return compat.openCompatDatabase(filename, serverName);
}

export function selectedEngine(): 'native' | 'wasm' {
  return compat.selectedEngine();
}

// The switch to WAL retried through SQLITE_BUSY and then left to the next
// opener; the chooser owns the policy so every opener shares it.
export function enableWalBestEffort(db: Database): Promise<void> {
  return compat.enableWalBestEffort(db);
}
