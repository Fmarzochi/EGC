#!/usr/bin/env node
// The egc-memory MCP server: this file wires the transport, the tool list
// and the dispatch table; each family of tools lives in its own module.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { Database } from 'sqlite';
import { z } from 'zod';
import { log } from './memory-logging';
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

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const db = await getDb();
  const name = request.params.name;
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
  closeMeshTransport();
  await closeDb();
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
