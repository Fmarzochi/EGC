// Thin typed door to the shared engine chooser in scripts/lib (native
// sqlite3 first, the portable sql.js engine when it cannot load). This
// package is ESM, so the CommonJS module is reached through createRequire;
// scripts/ ships next to mcp/servers/*/build in every layout.
import { createRequire } from 'node:module';
import type { Database } from 'sqlite';

interface CompatModule {
  openCompatDatabase(filename: string, serverName: string): Promise<Database>;
}

const load = createRequire(import.meta.url);
const compat = load('../../../../scripts/lib/state-store/sqlite-compat.js') as CompatModule;

export const openCompatDatabase = (filename: string, serverName: string): Promise<Database> =>
  compat.openCompatDatabase(filename, serverName);
