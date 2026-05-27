import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { z } from 'zod';

class PersistentLogger {
  private logPath: string;
  private maxSizeBytes = 5 * 1024 * 1024; // 5MB

  constructor(serviceName: string) {
    const logDir = path.join(os.homedir(), '.egc', 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    this.logPath = path.join(logDir, `${serviceName}.log`);
  }

  log(level: 'INFO'|'WARN'|'ERROR'|'AUDIT'|'DEBUG', msg: string, meta: any = {}) {
    const payload = JSON.stringify({ timestamp: new Date().toISOString(), level, msg, ...meta });
    // STDERR used to prevent JSON-RPC corruption on STDOUT
    console.error(payload);
    
    try {
      if (fs.existsSync(this.logPath)) {
        const stats = fs.statSync(this.logPath);
        if (stats.size > this.maxSizeBytes) {
           fs.renameSync(this.logPath, `${this.logPath}.${Date.now()}.bak`);
        }
      }
      fs.appendFileSync(this.logPath, payload + '\n', 'utf-8');
    } catch(e) {
      // Safe fail to avoid runtime crash if disk full
    }
  }
}

const sysLogger = new PersistentLogger('egc-memory-orchestrator');

function log(level: 'INFO'|'WARN'|'ERROR'|'AUDIT'|'DEBUG', msg: string, meta: any = {}) {
  sysLogger.log(level, msg, meta);
}

let dbInstance: Database | null = null;

// ============================================================================
// SQLite Arbitration & Message Queue (Cross-Runtime Synchronization)
// Orchestrates shared memory writes with exponential backoff to prevent IDE crashes
// ============================================================================
interface QueueTask<T> {
  operation: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: any) => void;
  retries: number;
}

class SQLiteArbitrationQueue {
  private queue: QueueTask<any>[] = [];
  private isProcessing = false;
  private readonly MAX_RETRIES = 5;
  private readonly BASE_BACKOFF_MS = 50;
  private readonly MAX_BACKOFF_MS = 5000;

  async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({ operation, resolve, reject, retries: 0 });
      this.processNext();
    });
  }

  private async processNext() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    const task = this.queue.shift();
    if (!task) {
      this.isProcessing = false;
      return;
    }

    try {
      const result = await task.operation();
      task.resolve(result);
    } catch (err: any) {
      if (err.message && (err.message.includes('SQLITE_BUSY') || err.message.includes('database is locked'))) {
        if (task.retries < this.MAX_RETRIES) {
          task.retries++;
          let backoff = Math.pow(2, task.retries) * this.BASE_BACKOFF_MS;
          if (backoff > this.MAX_BACKOFF_MS) backoff = this.MAX_BACKOFF_MS;
          log('WARN', `Write Collision Detected (SQLITE_BUSY). Arbitration retrying...`, { 
            queue_depth: this.queue.length, 
            retry_count: task.retries, 
            backoff_ms: backoff 
          });
          
          setTimeout(() => {
            this.queue.push(task); // Requeue at the end instead of unshift to prevent queue poisoning
            this.processNext();
          }, backoff);
          
          this.isProcessing = false;
          return;
        } else {
          log('ERROR', `Arbitration Failed. Write lock unrecoverable. Dead-lettering task.`, { retries: task.retries });
          task.reject(new Error(`Arbitration Failed after ${this.MAX_RETRIES} retries: ` + err.message));
        }
      } else {
        task.reject(err);
      }
    }

    this.isProcessing = false;
    this.processNext();
  }
}

const writeArbitrator = new SQLiteArbitrationQueue();

// ============================================================================
// Boot & Migrations
// ============================================================================
async function runMigrations(db: Database, dbDir: string) {
  const lockFile = path.join(dbDir, 'migration.lock');

  // Remove stale lock from a previous crashed process
  if (fs.existsSync(lockFile)) {
    try {
      const storedPid = parseInt(fs.readFileSync(lockFile, 'utf-8').trim(), 10);
      if (!isNaN(storedPid) && storedPid !== process.pid) {
        // Check if the PID is still alive (POSIX: signal 0 = probe only)
        let alive = false;
        try { process.kill(storedPid, 0); alive = true; } catch (_) {}
        if (!alive) fs.unlinkSync(lockFile);
      }
    } catch (_) {}
  }

  let locked = false;
  let retries = 50;
  while (!locked && retries > 0) {
    try {
      fs.writeFileSync(lockFile, process.pid.toString(), { flag: 'wx' });
      locked = true;
    } catch (e) {
      retries--;
      await new Promise(r => setTimeout(r, 100));
    }
  }

  if (!locked) throw new Error('Timeout acquiring migration lock');

  try {
    log('INFO', 'Running SQLite migrations');
    await db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO schema_migrations (version) VALUES (1);
      CREATE TABLE IF NOT EXISTS operational_state (id TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, context TEXT, decision TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP);
    `);
  } finally {
    try { fs.unlinkSync(lockFile); } catch(e) {}
  }
}

async function getDb(): Promise<Database> {
  if (dbInstance) return dbInstance;
  const dbDir = path.join(os.homedir(), '.egc', 'memory');
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  
  const dbPath = path.join(dbDir, 'state.db');
  dbInstance = await open({ filename: dbPath, driver: sqlite3.Database });
  
  await dbInstance.exec('PRAGMA journal_mode = WAL;');
  await dbInstance.exec('PRAGMA synchronous = NORMAL;');
  await dbInstance.exec('PRAGMA foreign_keys = ON;');
  await dbInstance.exec('PRAGMA busy_timeout = 5000;'); // Native fallback
  
  await runMigrations(dbInstance, dbDir);
  return dbInstance;
}

const server = new Server({ name: "egc-memory-orchestrator", version: "3.0.0" }, { capabilities: { tools: {} } });

function getStateDir(): string {
  const dir = path.join(os.homedir(), '.egc', 'state');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function projectSlug(projectPath: string): string {
  const parts = projectPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-2).join('--').replace(/[^a-zA-Z0-9-_]/g, '_') || 'default';
}

function stateFilePath(projectPath: string): string {
  return path.join(getStateDir(), `${projectSlug(projectPath)}.md`);
}

function resolveProjectPath(provided?: string): string {
  return provided || process.env.EGC_PROJECT || process.env.PWD || os.homedir();
}

function readStateDoc(filePath: string): Record<string, string[]|string> {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, 'utf-8');
  const result: Record<string, string[]|string> = {};
  let currentSection = '';
  for (const line of content.split('\n')) {
    const h2 = line.match(/^## (.+)/);
    if (h2) { currentSection = h2[1].trim(); result[currentSection] = result[currentSection] || []; continue; }
    if (currentSection && line.trim() && !line.startsWith('#')) {
      const arr = result[currentSection];
      if (Array.isArray(arr)) arr.push(line.replace(/^- /, '').trim());
      else result[currentSection] = line.trim();
    }
  }
  return result;
}

function writeStateDoc(filePath: string, projectPath: string, data: {
  context?: string;
  decisions?: {what: string; why?: string}[];
  avoid?: {what: string; why?: string}[];
  preferences?: string[];
  next?: string[];
}, existing: Record<string, string[]|string>) {
  const mergedDecisions = [
    ...(data.decisions || []).map(d => `- ${d.what}${d.why ? ': ' + d.why : ''}`),
    ...((existing['Active Decisions'] as string[]) || []).map(l => `- ${l}`)
  ].slice(0, 15);

  const mergedAvoid = [
    ...(data.avoid || []).map(d => `- ${d.what}${d.why ? ': ' + d.why : ''}`),
    ...((existing['Do Not Repeat'] as string[]) || []).map(l => `- ${l}`)
  ].slice(0, 10);

  const mergedPrefs = [
    ...(data.preferences || []).map(p => `- ${p}`),
    ...((existing['Preferences'] as string[]) || []).map(l => `- ${l}`)
  ].slice(0, 15);

  const nextItems = (data.next || []).map(n => `- ${n}`);

  const context = data.context || (existing['Context'] as string) || '';

  const lines = [
    `# Project State`,
    `project: ${projectPath}`,
    `updated: ${new Date().toISOString()}`,
    ``,
    `## Context`,
    context,
    ``,
    `## Active Decisions`,
    ...mergedDecisions,
    ``,
    `## Do Not Repeat`,
    ...mergedAvoid,
    ``,
    `## Preferences`,
    ...mergedPrefs,
    ``,
    `## Next Session`,
    ...nextItems,
    ``
  ];

  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
}

const StoreDecisionSchema = z.object({
  context: z.string().min(1).max(5000),
  decision: z.string().min(1).max(10000)
});

const QueryHistorySchema = z.object({
  limit: z.number().min(1).max(100).optional().default(10),
  offset: z.number().min(0).optional().default(0)
});

const GetStateSchema = z.object({
  project_path: z.string().optional()
});

const UpdateStateSchema = z.object({
  project_path: z.string().optional(),
  context: z.string().max(2000).optional(),
  decisions: z.array(z.object({
    what: z.string().max(500),
    why: z.string().max(500).optional()
  })).max(20).optional(),
  avoid: z.array(z.object({
    what: z.string().max(500),
    why: z.string().max(500).optional()
  })).max(20).optional(),
  preferences: z.array(z.string().max(300)).max(20).optional(),
  next: z.array(z.string().max(500)).max(10).optional()
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      { name: "get_project_state", description: "Get current state.", inputSchema: { type: "object", properties: {} } },
      { name: "store_decision", description: "Store a decision with lock arbitration.", inputSchema: { type: "object", properties: { context: { type: "string" }, decision: { type: "string" } }, required: ["context", "decision"] } },
      { name: "query_history", description: "Query past decisions.", inputSchema: { type: "object", properties: { limit: { type: "number" }, offset: { type: "number" } } } },
      {
        name: "get_state",
        description: "Returns the current project memory: decisions made, preferences established, things to avoid, and what to pick up next. Call this at the START of every session to restore context.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string", description: "Absolute path to the project root. Defaults to current working directory." }
          }
        }
      },
      {
        name: "update_state",
        description: "Updates the project memory with decisions made this session. Call this at the END of every session. Merges with existing state — does not erase previous memory.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string" },
            context: { type: "string", description: "What this project is and its current phase." },
            decisions: { type: "array", items: { type: "object", properties: { what: { type: "string" }, why: { type: "string" } }, required: ["what"] }, description: "Decisions made this session." },
            avoid: { type: "array", items: { type: "object", properties: { what: { type: "string" }, why: { type: "string" } }, required: ["what"] }, description: "What failed and should not be repeated." },
            preferences: { type: "array", items: { type: "string" }, description: "Coding style, workflow, or communication preferences discovered." },
            next: { type: "array", items: { type: "string" }, description: "What to pick up in the next session." }
          }
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const db = await getDb();
  try {
    switch (request.params.name) {
      case "store_decision": {
        const { context, decision } = StoreDecisionSchema.parse(request.params.arguments);
        
        // Execute write through the Queue Arbitrator to prevent IDE crash on SQLITE_BUSY
        await writeArbitrator.enqueue(async () => {
          await db.run('INSERT INTO decisions (context, decision) VALUES (?, ?)', [context, decision]);
        });
        
        log('INFO', 'Decision stored securely via Queue Arbitration');
        return { content: [{ type: "text", text: "Decision stored securely." }] };
      }
      case "query_history": {
        const { limit, offset } = QueryHistorySchema.parse(request.params.arguments || {});
        const rows = await db.all('SELECT * FROM decisions ORDER BY timestamp DESC LIMIT ? OFFSET ?', [limit, offset]);
        return { content: [{ type: "text", text: JSON.stringify({ data: rows, meta: { limit, offset } }, null, 2) }] };
      }
      case "get_project_state": {
        return { content: [{ type: "text", text: JSON.stringify({ status: "active", engine: "sqlite-wal", arbitration: "MessageQueue" }) }] };
      }
      case "get_state": {
        const { project_path } = GetStateSchema.parse(request.params.arguments || {});
        const projPath = resolveProjectPath(project_path);
        const filePath = stateFilePath(projPath);

        if (!fs.existsSync(filePath)) {
          return { content: [{ type: "text", text: `No state found for this project yet.\nPath: ${filePath}\n\nCall update_state at the end of this session to start building project memory.` }] };
        }

        const content = fs.readFileSync(filePath, 'utf-8');
        log('INFO', 'Project state retrieved', { project: projPath });
        return { content: [{ type: "text", text: content }] };
      }

      case "update_state": {
        const args = UpdateStateSchema.parse(request.params.arguments || {});
        const projPath = resolveProjectPath(args.project_path);
        const filePath = stateFilePath(projPath);
        const existing = readStateDoc(filePath);

        writeStateDoc(filePath, projPath, args, existing);

        log('INFO', 'Project state updated', { project: projPath, decisions: args.decisions?.length || 0 });
        return { content: [{ type: "text", text: `Project memory updated.\nFile: ${filePath}\nDecisions saved: ${args.decisions?.length || 0}\nNext session items: ${args.next?.length || 0}` }] };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${request.params.name}`);
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid arguments: ${error.message}`);
    }
    log('ERROR', 'Tool execution failed', { tool: request.params.name, error: String(error) });
    throw error;
  }
});

let transport: StdioServerTransport | null = null;

async function run() {
  // Pre-warm: open DB and run migrations before accepting MCP requests.
  // Eliminates first-call latency that caused first-run failures in AGY.
  await getDb();
  transport = new StdioServerTransport();
  await server.connect(transport);
  log('INFO', 'egc-memory-orchestrator initialized with Write Arbitration');
}

async function shutdown() {
  log('INFO', 'Shutting down gracefully');
  if (dbInstance) {
    await dbInstance.close();
    log('INFO', 'SQLite handle closed');
  }
  if (transport) {
    await server.close();
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

run().catch((e) => {
  log('ERROR', 'Fatal startup error', { error: String(e) });
  process.exit(1);
});
