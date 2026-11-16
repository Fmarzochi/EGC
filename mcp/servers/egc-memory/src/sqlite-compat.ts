// Thin typed door to the shared engine chooser in scripts/lib (native
// sqlite3 first, the portable sql.js engine when it cannot load). The
// package ships scripts/ next to mcp/servers/*/build, so the relative path
// holds in a checkout and in a global npm install alike.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { Database } from 'sqlite';

type CompatModule = {
  openCompatDatabase(filename: string, serverName: string, options?: { nativeResolvePaths?: string[] }): Promise<Database>;
  selectedEngine(): 'native' | 'wasm';
  enableWalBestEffort(db: Database): Promise<void>;
};

const load = createRequire(__filename);
const compat = load('../../../../scripts/lib/state-store/sqlite-compat.js') as CompatModule;

// The package root of this build. Naming it lets the chooser prefer a native
// driver that actually loads: under the repository's yarn install the root
// sqlite3 resolves without a native build, while the copy the server's own
// install left in its node_modules has one. From a directory with no
// node_modules of its own, resolution walks up to the package root, so this
// changes nothing for a global npm install.
const serverRoot = resolve(__dirname, '..');

export function openCompatDatabase(filename: string, serverName: string): Promise<Database> {
  return compat.openCompatDatabase(filename, serverName, { nativeResolvePaths: [serverRoot] });
}

export function selectedEngine(): 'native' | 'wasm' {
  return compat.selectedEngine();
}

// The switch to WAL retried through SQLITE_BUSY and then left to the next
// opener; the chooser owns the policy so every opener shares it.
export function enableWalBestEffort(db: Database): Promise<void> {
  return compat.enableWalBestEffort(db);
}
