#!/usr/bin/env node
// The egc-memory MCP server: this file wires the transport, the tool list
// and the dispatch table; each family of tools lives in its own module.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { Database } from 'sqlite';
import { z } from 'zod';
import { log } from './memory-logging';
import { createRateLimiter, rateLimitSettings } from './rate-limit';
import { closeDb, getDb } from './memory-db';
import { TOOL_DEFINITIONS } from './memory-tool-definitions';
import { handleGetState, handleUpdateState } from './memory-state-tools';
import { handleLessonRecall, handleLessonReinforce, handleLessonSave } from './memory-lessons';
import {
  closeMeshTransport,
  handleClaimPath,
  handleReleasePath,
  handleSessionAnnounce,
  handleSessionEvents,
  handleSessionPeers,
  handleSessionSend,
  handleSessionWait,
} from './memory-session-bus';
import {
  handleCompressObservations,
  handleDetectPatterns,
  handleGetProjectState,
  handleQueryHistory,
  handleSearchHistoryTool,
  handleStoreDecision,
  handleTeamInit,
  handleTeamStatus,
  handleTeamSync,
  handleWorkingMemoryGet,
  handleWorkingMemoryList,
  handleWorkingMemorySet,
} from './memory-misc-tools';

const server = new Server({ name: "egc-memory-orchestrator", version: "3.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOL_DEFINITIONS }));

// Each tool this server answers, by name.
const TOOL_HANDLERS = {
  store_decision: handleStoreDecision,
  query_history: handleQueryHistory,
  search_history: handleSearchHistoryTool,
  get_project_state: handleGetProjectState,
  get_state: handleGetState,
  update_state: handleUpdateState,
  session_announce: handleSessionAnnounce,
  claim_path: handleClaimPath,
  release_path: handleReleasePath,
  session_peers: handleSessionPeers,
  session_send: handleSessionSend,
  session_events: handleSessionEvents,
  session_wait: handleSessionWait,
  working_memory_set: handleWorkingMemorySet,
  working_memory_get: handleWorkingMemoryGet,
  working_memory_list: handleWorkingMemoryList,
  lesson_save: handleLessonSave,
  lesson_recall: handleLessonRecall,
  lesson_reinforce: handleLessonReinforce,
  detect_patterns: handleDetectPatterns,
  compress_observations: handleCompressObservations,
  team_init: handleTeamInit,
  team_sync: handleTeamSync,
  team_status: handleTeamStatus,
} satisfies Record<string, (db: Database, toolArgs: unknown) => Promise<unknown>>;

// Calls still running when the client closes stdin must finish before the
// database closes. A client that writes its last call and then closes the pipe
// reads the response from a server that is still working, not from one that has
// already shut down.
// Per tool and project (#2142): an honest session never reaches the default,
// a looping caller gets a clear refusal, and the refusal goes to the audit log.
// session_wait is one call however long it parks, so it counts as one.
const RATE_LIMIT = rateLimitSettings(process.env, { windowMs: 60_000, maxCalls: 120 });
const rateLimiter = createRateLimiter(RATE_LIMIT);

function refuseOverRateLimit(tool: string, args: unknown): void {
  const record = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const projectPath = typeof record.project_path === 'string' ? record.project_path : undefined;
  if (rateLimiter.check(tool, projectPath)) return;
  log('AUDIT', 'RATE_LIMIT_EXCEEDED', { tool, project_path: projectPath, limit: RATE_LIMIT.maxCalls, window_ms: RATE_LIMIT.windowMs });
  throw new McpError(
    ErrorCode.InvalidRequest,
    `Rate limit exceeded for tool '${tool}': at most ${RATE_LIMIT.maxCalls} calls per ${RATE_LIMIT.windowMs} ms for one tool and project. Wait a moment; EGC_MCP_RATE_MAX_CALLS raises the limit.`
  );
}

let inFlightRequests = 0;
const idleWaiters: Array<() => void> = [];

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  inFlightRequests++;
  try {
    const name = request.params.name;
    refuseOverRateLimit(name, request.params.arguments);
    const db = await getDb();
    try {
      if (!Object.hasOwn(TOOL_HANDLERS, name)) {
        throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`);
      }
      return await TOOL_HANDLERS[name as keyof typeof TOOL_HANDLERS](db, request.params.arguments);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new McpError(ErrorCode.InvalidParams, `Invalid arguments: ${error.message}`);
      }
      log('ERROR', 'Tool execution failed', { tool: name, error: String(error) });
      if (error instanceof Error && error.message.includes('SQLITE_FULL')) {
        throw new McpError(ErrorCode.InternalError, `Database disk image is full: ${error.message}`);
      }
      throw error;
    }
  } finally {
    inFlightRequests--;
    if (inFlightRequests === 0) idleWaiters.splice(0).forEach(resolve => resolve());
  }
});

let transport: StdioServerTransport | null = null;

async function run() {
  // Pre-warm: open DB and run migrations before accepting MCP requests.
  // Eliminates first-call latency that caused first-run failures in AGY.
  const db = await getDb();
  transport = new StdioServerTransport();
  await server.connect(transport);
  log('INFO', 'egc-memory-orchestrator initialized with Write Arbitration');
  // The bridge to the mesh central, when this machine has one configured
  // and this process won the election among the machine's servers; a bridge
  // that cannot start is a log line, never a server that does not answer.
  try {
    const { startBridgeIfElected } = await import('./relay/bridge.js');
    bridgeHandle = startBridgeIfElected({ db, log: line => log('INFO', line) });
  } catch (error) {
    log('WARN', 'The mesh bridge did not start', { error: String(error) });
  }
}

// The bridge to the mesh, stopped before the database closes under it.
let bridgeHandle: { stop(): Promise<void> } | null = null;
let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) { process.exit(1); }
  shuttingDown = true;
  log('INFO', 'Shutting down gracefully');
  // The dispatch chain starts a handler in a microtask, so let that run before
  // the count is read, then wait for every call already accepted.
  await new Promise(resolve => setImmediate(resolve));
  closeMeshTransport();
  while (inFlightRequests > 0) {
    await new Promise<void>(resolve => idleWaiters.push(resolve));
  }
  closeMeshTransport();
  if (bridgeHandle) {
    await bridgeHandle.stop().catch(() => undefined);
    bridgeHandle = null;
  }
  await closeDb();
  if (transport) {
    await server.close();
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Windows does not deliver SIGTERM to a child stopped with kill(), so a stdio
// client there asks the server to stop by closing its stdin. Shut down on that
// path too, or the database is never closed and its write-ahead log survives.
process.stdin.on('end', shutdown);

run().catch((e) => {
  log('ERROR', 'Fatal startup error', { error: String(e) });
  process.exit(1);
});
