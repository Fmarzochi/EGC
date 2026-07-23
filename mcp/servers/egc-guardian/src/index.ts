#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { llmRoute, keywordRoute } from './llm-router.js';

function hideEgcRootOnWindows(): void {
  if (process.platform !== 'win32') return;
  const egcRoot = path.join(os.homedir(), '.egc');
  const attribPath = path.join(process.env.SystemRoot || String.raw`C:\Windows`, 'System32', 'attrib.exe');
  spawnSync(attribPath, ['+h', egcRoot], { stdio: 'ignore', shell: false });
}
import { z } from 'zod';
import { validateCommand, validateWrite, isProtectedPath } from './validator.js';
import { writeAuditEntry } from './audit-log.js';
import { scanVolatile } from './egc-volatile-scanner.js';
import { classifyChunk } from './egc-chunk-router.js';
import { reduceJsonArray } from './egc-array-crusher.js';
import { autoLearn } from './learn-writer.js';
import { compressViaHeadroom } from './headroom-client.js';

interface PipelineResult {
  chunks: string[];
  bytes_before: number;
  bytes_after: number;
  savings_pct: number;
  volatile_findings: number;
  chunks_crushed: number;
}

function runCompressionPipeline(chunks: string[]): PipelineResult {
  const bytesBefore = chunks.reduce((a, c) => a + Buffer.byteLength(c, 'utf8'), 0);
  let volatileFindings = 0;
  let chunksCrushed = 0;
  const seen = new Set<string>();
  const result: string[] = [];

  for (const chunk of chunks) {
    const findings = scanVolatile(chunk);
    volatileFindings += findings.length;

    const contentType = classifyChunk(chunk);

    let processed = chunk;

    if (contentType === 'json_array') {
      const reduced = reduceJsonArray(chunk);
      if (reduced !== null) {
        processed = reduced.crushed;
        chunksCrushed++;
      }
    }

    // Exact-match dedup as final safety net
    const key = processed.trim();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(processed);
    }
  }

  const bytesAfter = result.reduce((a, c) => a + Buffer.byteLength(c, 'utf8'), 0);
  const savingsPct = bytesBefore === 0 ? 0 : Math.round((1 - bytesAfter / bytesBefore) * 100);

  return { chunks: result, bytes_before: bytesBefore, bytes_after: bytesAfter, savings_pct: savingsPct, volatile_findings: volatileFindings, chunks_crushed: chunksCrushed };
}

async function routeTask(prompt: string): Promise<{
  agents: string[]; skills: string[]; scores: Record<string, number>; rejected: string[]; provider: string;
}> {
  const llm = await llmRoute(prompt);
  if (llm) {
    return { ...llm, scores: {}, rejected: [] };
  }
  return { ...keywordRoute(prompt), provider: 'keyword' };
}

class PersistentLogger {
  private readonly logPath: string;
  private readonly maxSizeBytes = 5 * 1024 * 1024; // 5MB

  constructor(serviceName: string) {
    const logDir = path.join(os.homedir(), '.egc', 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    hideEgcRootOnWindows();
    this.logPath = path.join(logDir, `${serviceName}.log`);
  }

  async log(level: 'INFO'|'WARN'|'ERROR'|'AUDIT'|'DEBUG', action: string, status?: string, meta: Record<string, unknown> = {}) {
    const payload = JSON.stringify({ timestamp: new Date().toISOString(), level, type: 'AUDIT', action, status, ...meta });
    console.error(payload); // MCP strict requirement
    try {
      try {
        const stats = await fs.promises.stat(this.logPath);
        if (stats.size > this.maxSizeBytes) {
           await fs.promises.rename(this.logPath, `${this.logPath}.${Date.now()}.bak`);
        }
      } catch (_e) { // NOSONAR: rotating a missing log file is a no-op
        // file might not exist
      }
      await fs.promises.appendFile(this.logPath, payload + '\n', 'utf-8');
    } catch(err) {
      console.error('[EGC Guardian] PersistentLogger failed to write:', err);
    }
  }
}

const sysLogger = new PersistentLogger('egc-guardian-router');

// Security audit log writes are handled by audit-log.ts (writeAuditEntry).

function auditLog(action: string, status: 'ALLOWED'|'DENIED'|'MUTATED'|'ONLINE'|'SHUTDOWN'|'FATAL', details: Record<string, unknown> = {}) {
  let level: 'ERROR' | 'INFO' | 'AUDIT';
  if (status === 'FATAL' || status === 'DENIED') level = 'ERROR';
  else if (status === 'ONLINE' || status === 'SHUTDOWN') level = 'INFO';
  else level = 'AUDIT';
  sysLogger.log(level, action, status, details);
  if (status === 'DENIED') writeAuditEntry(action, status, details);
}

const server = new Server({ name: "egc-guardian-router", version: "3.0.0" }, { capabilities: { tools: {} } });

// Validation logic lives in validator.ts: imported above

const ValidateCommandSchema = z.object({
  command: z.string().min(1)
});

const ValidateWriteSchema = z.object({
  filepath: z.string().min(1)
});

const ReduceContextSchema = z.object({
  filepaths: z.array(z.string()),
  mode: z.enum(['FAST_RESPONSE', 'DEEP_COGNITION']).optional().default('DEEP_COGNITION')
});

const OrchestrateTaskSchema = z.object({
  prompt: z.string(),
  filepaths: z.array(z.string()).optional().default([]),
  heuristic_sandbox_id: z.string().optional()
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      { name: "validate_command", description: "Validate command execution safety.", inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
      { name: "validate_write", description: "Validate write path safety.", inputSchema: { type: "object", properties: { filepath: { type: "string" } }, required: ["filepath"] } },
      { 
        name: "reduce_context", 
        description: "Adaptive Context Routing: Loads files and mutates payloads to save IDE token budget.", 
        inputSchema: { 
          type: "object", 
          properties: { 
            filepaths: { type: "array", items: { type: "string" } },
            mode: { type: "string", enum: ['FAST_RESPONSE', 'DEEP_COGNITION'] }
          }, 
          required: ["filepaths"] 
        } 
      },
      {
        name: "orchestrate_task",
        description: "Routes a prompt against the EGC catalog of skills, agents, and rules. Uses semantic LLM routing when a provider API key is available (ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY) and falls back to local keyword scoring otherwise. Also returns context-reduction metrics for any file payloads.",
        inputSchema: {
          type: "object",
          properties: {
             prompt: { type: "string" },
             filepaths: { type: "array", items: { type: "string" } }
          },
          required: ["prompt"]
        }
      },
      {
        name: "auto_learn",
        description: "Mines recent tool failures from session history and writes actionable recommendations to all AI tool config files found in the project (CLAUDE.md, GEMINI.md, AGENTS.md, Cursor, Copilot, Windsurf, and others). Safe to call at any time; skips gracefully if no failures are found.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string", description: "Absolute path to the project root." },
            target_file: { type: "string", description: "Primary file to write recommendations to. Defaults to CLAUDE.md in the project root. Lessons are also propagated to all other AI tool config files found in the project." },
            limit: { type: "number", description: "Max number of failure patterns to surface (default 10)." }
          },
          required: ["project_path"]
        }
      }
    ]
  };
});

const RATE_WINDOW_MS = 60_000;
const RATE_MAX_CALLS = 60;
const rateLimitMap = new Map<string, number[]>();

function checkRateLimit(tool: string, projectPath?: string | null): boolean {
  const now = Date.now();
  
  // Create a composite storage key if projectPath is available, otherwise fall back to global tool name
  const trimmed = projectPath ? projectPath.trim() : "";
  const storageKey = trimmed !== "" 
    ? `${trimmed}::${tool}` 
    : tool;

  const timestamps = (rateLimitMap.get(storageKey) ?? []).filter(t => now - t < RATE_WINDOW_MS);
  timestamps.push(now);
  rateLimitMap.set(storageKey, timestamps);
  return timestamps.length <= RATE_MAX_CALLS;
}

function handleValidateCommand(toolArgs: unknown) {
  const { command } = ValidateCommandSchema.parse(toolArgs);
  const result = validateCommand(command);
  if (!result.allowed) {
    auditLog('COMMAND_EXECUTION', 'DENIED', { command, reason: result.reason, trust_level: result.trust_level });
    return { content: [{ type: "text", text: `[DENIED] ${result.reason}` }] };
  }
  auditLog('COMMAND_EXECUTION', 'ALLOWED', { command, trust_level: result.trust_level });
  return { content: [{ type: "text", text: "[ALLOWED]" }] };
}

function handleValidateWrite(toolArgs: unknown) {
  const { filepath } = ValidateWriteSchema.parse(toolArgs);
  const result = validateWrite(filepath);
  if (!result.allowed) {
    auditLog('FILE_WRITE', 'DENIED', { filepath, reason: result.reason });
    return { content: [{ type: "text", text: `[DENIED] ${result.reason}` }] };
  }
  auditLog('FILE_WRITE', 'ALLOWED', { filepath: path.resolve(filepath) });
  return { content: [{ type: "text", text: "[ALLOWED]" }] };
}

async function loadContextFileChunks(filepath: string, totalBytesLoaded: number): Promise<{ chunks: string[]; bytes: number } | null> {
  try {
    const resolved = path.resolve(filepath);
    let realResolved: string;
    try {
      realResolved = fs.realpathSync(resolved);
    } catch {
      auditLog('CONTEXT_LOAD', 'DENIED', { filepath, reason: 'path resolution failed' });
      return null;
    }
    if (isProtectedPath(realResolved)) {
      auditLog('CONTEXT_LOAD', 'DENIED', { filepath, reason: 'protected path' });
      return null;
    }

    // SEC-05/SEC-06: enforce byte-load limits against the same file handle
    // used to read (stat-then-read on a path is a TOCTOU race if the file
    // is swapped between the two calls).
    const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
    const MAX_TOTAL_SIZE = 50 * 1024 * 1024; // 50MB

    const fileHandle = await fs.promises.open(realResolved, 'r');
    try {
      const stats = await fileHandle.stat();
      if (!stats.isFile()) {
        auditLog('CONTEXT_LOAD', 'DENIED', { filepath, reason: 'not a regular file' });
        return null;
      }
      if (stats.size > MAX_FILE_SIZE) {
        auditLog('CONTEXT_LOAD', 'DENIED', { filepath, reason: `file exceeds 10MB limit (${stats.size} bytes)` });
        return null;
      }
      if (totalBytesLoaded + stats.size > MAX_TOTAL_SIZE) {
        auditLog('CONTEXT_LOAD', 'DENIED', { filepath, reason: `aggregate size exceeds 50MB limit` });
        return null;
      }

      const content = await fileHandle.readFile('utf-8');
      // Split context into chunks/paragraphs to allow granular pruning
      const chunks = content.split('\n\n').filter(c => c.trim().length > 0);
      return { chunks, bytes: Buffer.byteLength(content, 'utf8') };
    } finally {
      await fileHandle.close();
    }
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : JSON.stringify(e);
    auditLog('CONTEXT_LOAD', 'DENIED', { filepath, reason });
    return null;
  }
}

async function handleReduceContext(toolArgs: unknown) {
  const { filepaths, mode } = ReduceContextSchema.parse(toolArgs);
  const rawPayloads: string[] = [];

  let totalBytesLoaded = 0;
  for (const filepath of filepaths) {
    const loaded = await loadContextFileChunks(filepath, totalBytesLoaded);
    if (!loaded) continue;
    rawPayloads.push(...loaded.chunks);
    totalBytesLoaded += loaded.bytes;
  }


  const pipeline = runCompressionPipeline(rawPayloads);

  // Phase 2: optional Headroom deep compression (falls back silently if proxy not running)
  let finalContent = pipeline.chunks.join('\n\n');
  let headroomSavingsPct = 0;
  let headroomTransforms: string[] = [];
  if (pipeline.chunks.length > 0) {
    const hr = await compressViaHeadroom(pipeline.chunks);
    if (hr !== null) {
      finalContent = hr.text;
      headroomSavingsPct = Math.round((1 - hr.bytes_after / hr.bytes_before) * 100);
      headroomTransforms = hr.transforms_applied;
    }
  }

  const finalBytes = Buffer.byteLength(finalContent, 'utf8');
  const totalSavingsPct = pipeline.bytes_before === 0
    ? 0
    : Math.round((1 - finalBytes / pipeline.bytes_before) * 100);

  auditLog('PAYLOAD_MUTATION', 'MUTATED', {
    mode,
    files_requested: filepaths.length,
    raw_chunks: rawPayloads.length,
    reduced_chunks: pipeline.chunks.length,
    bytes_before: pipeline.bytes_before,
    bytes_after: finalBytes,
    savings_pct: totalSavingsPct,
    volatile_findings: pipeline.volatile_findings,
    chunks_crushed: pipeline.chunks_crushed,
    headroom_savings_pct: headroomSavingsPct,
    headroom_transforms: headroomTransforms.length,
  });

  const headerParts = [
    `[reduce_context] ${totalSavingsPct}% saved`,
    `(${pipeline.bytes_before} -> ${finalBytes} bytes,`,
    `${pipeline.chunks_crushed} JSON chunks crushed,`,
    `${pipeline.volatile_findings} volatile tokens detected`,
  ];
  if (headroomSavingsPct > 0) {
    headerParts.push(`, headroom: ${headroomSavingsPct}% extra via ${headroomTransforms.length} transforms`);
  }
  const header = headerParts.join(' ') + ')';

  return { content: [{ type: "text", text: `${header}\n\n${finalContent}` }] };
}

async function handleOrchestrateTask(toolArgs: unknown) {
  const parsed = OrchestrateTaskSchema.parse(toolArgs);
  const prompt = parsed.prompt;
  const files: string[] = parsed.filepaths ?? [];

  // Read any provided file payloads using the same hardened loader as
  // reduce_context (TOCTOU-safe file-handle reads, per-file 10MB and
  // aggregate 50MB size limits, isFile() check). See SEC-05/SEC-06.
  const rawPayloads: string[] = [];
  let totalBytesLoaded = 0;
  for (const filePath of files) {
    const loaded = await loadContextFileChunks(filePath, totalBytesLoaded);
    if (!loaded) continue;
    rawPayloads.push(...loaded.chunks);
    totalBytesLoaded += loaded.bytes;
  }

  const pipeline = runCompressionPipeline(rawPayloads);
  const routing = await routeTask(prompt);

  const hint = routing.provider === 'keyword'
    ? 'Semantic routing unavailable: set ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY to enable LLM-based routing.'
    : undefined;

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        prompt,
        routing,
        ...(hint ? { routing_hint: hint } : {}),
        context_reduction: {
    bytes_before: pipeline.bytes_before,
    bytes_after: pipeline.bytes_after,
    savings_pct: pipeline.savings_pct,
        },
        files_loaded: rawPayloads.length,
      }, null, 2),
    }],
  };
}

async function handleAutoLearn(toolArgs: Record<string, unknown> | undefined) {
  const projectPath = toolArgs?.project_path as string;
  const targetFile  = toolArgs?.target_file as string | undefined;
  const limit       = toolArgs?.limit as number | undefined;

  if (!projectPath) {
    throw new McpError(ErrorCode.InvalidParams, 'project_path is required');
  }

  let realProjectPath: string;
  try {
    realProjectPath = fs.realpathSync(path.resolve(projectPath));
  } catch {
    throw new McpError(ErrorCode.InvalidParams, 'project_path resolution failed');
  }
  if (isProtectedPath(realProjectPath)) {
    throw new McpError(ErrorCode.InvalidParams, 'project_path must not be a protected path');
  }

  const result = await autoLearn({ project_path: projectPath, target_file: targetFile, limit });

  auditLog('AUTO_LEARN', 'MUTATED', {
    project_path: projectPath,
    patterns_found: result.patterns_found,
    recommendations_written: result.recommendations_written,
    skipped: result.skipped,
  });

  const extraFiles = result.propagated_to?.length ?? 0;
  const extraSuffix = extraFiles > 0 ? ` and ${extraFiles} other AI tool config file(s)` : '';
  const summary = result.skipped
    ? `[auto_learn] skipped: ${result.reason}`
    : `[auto_learn] wrote ${result.recommendations_written} recommendations to ${result.target_file}${extraSuffix} (${result.patterns_found} failure patterns found)`;

  return { content: [{ type: 'text', text: summary }] };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const tool = request.params.name;
    
    // Safely extract project_path from arguments if provided by the client
    const args = request.params.arguments as Record<string, unknown> | undefined;
    const projectPath = typeof args?.project_path === 'string' ? args.project_path : undefined;

    if (!checkRateLimit(tool, projectPath)) {
      auditLog('RATE_LIMIT_EXCEEDED', 'DENIED', { tool, project_path: projectPath, limit: RATE_MAX_CALLS, window_ms: RATE_WINDOW_MS });
      return { content: [{ type: "text", text: `[DENIED] Rate limit exceeded for tool '${tool}': max ${RATE_MAX_CALLS} calls per ${RATE_WINDOW_MS / 1000}s` }] };
    }
    
    switch (request.params.name) {
      case "validate_command": return handleValidateCommand(request.params.arguments);
      case "validate_write": return handleValidateWrite(request.params.arguments);
      case "reduce_context": return await handleReduceContext(request.params.arguments);
      case "orchestrate_task": return await handleOrchestrateTask(request.params.arguments);
      case "auto_learn": return await handleAutoLearn(request.params.arguments);

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${request.params.name}`);
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid arguments: ${error.message}`);
    }
    throw error;
  }
});

let transport: StdioServerTransport | null = null;

async function run() {
  transport = new StdioServerTransport();
  await server.connect(transport);
  auditLog('SYSTEM_BOOT', 'ONLINE', { service: 'egc-guardian-router', mode: 'COGNITIVE_INJECTION' });
}

async function shutdown() {
  auditLog('SYSTEM_HALT', 'SHUTDOWN', { service: 'egc-guardian-router' });
  if (transport) {
     await server.close();
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  await run();
} catch (err) {
  auditLog('CRASH', 'FATAL', { error: String(err) });
  process.exit(1);
}