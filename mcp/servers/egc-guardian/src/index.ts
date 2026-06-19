#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import path from 'path';
import os from 'os';
import fs from 'fs';
import { execSync } from 'child_process';

function hideEgcRootOnWindows(): void {
  if (process.platform !== 'win32') return;
  const egcRoot = path.join(os.homedir(), '.egc');
  try {
    execSync(`attrib +h "${egcRoot}"`, { stdio: 'ignore' });
  } catch (_) {
    // non-critical: folder works even if attribute fails
  }
}
import { z } from 'zod';
import { validateCommand, validateWrite, isProtectedPath } from './validator.js';
import { detectVolatile } from './cache-aligner.js';
import { detectContentType } from './content-router.js';
import { crushJsonArray } from './smart-crusher.js';

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
    // CacheAligner: detect volatile content (informational only, never mutates)
    const findings = detectVolatile(chunk);
    volatileFindings += findings.length;

    // ContentRouter: classify chunk
    const contentType = detectContentType(chunk);

    let processed = chunk;

    if (contentType === 'json_array') {
      const crushed = crushJsonArray(chunk);
      if (crushed !== null) {
        processed = crushed.crushed;
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

function routeTask(prompt: string, agents: string[], skills: string[]): {
  agents: string[]; skills: string[]; scores: Record<string, number>; rejected: string[]
} {
  return { agents, skills, scores: {}, rejected: [] };
}

class PersistentLogger {
  private logPath: string;
  private maxSizeBytes = 5 * 1024 * 1024; // 5MB

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
      } catch (e) {
        // file might not exist
      }
      await fs.promises.appendFile(this.logPath, payload + '\n', 'utf-8');
    } catch(e) {}
  }
}

const sysLogger = new PersistentLogger('egc-guardian-router');

function auditLog(action: string, status: 'ALLOWED'|'DENIED'|'MUTATED'|'ONLINE'|'SHUTDOWN'|'FATAL', details: Record<string, unknown> = {}) {
  const level = (status === 'FATAL' || status === 'DENIED') ? 'ERROR' : (status === 'ONLINE' || status === 'SHUTDOWN' ? 'INFO' : 'AUDIT');
  sysLogger.log(level, action, status, details);
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
  agents: z.array(z.string()).optional().default([]),
  skills: z.array(z.string()).optional().default([]),
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
        description: "Routes a prompt with optional agent/skill lists and file payloads. Returns routing context and context-reduction metrics. Agent/skill selection is pass-through; provide explicit lists for deterministic routing.",
        inputSchema: {
          type: "object",
          properties: {
             prompt: { type: "string" },
             filepaths: { type: "array", items: { type: "string" } },
             agents: { type: "array", items: { type: "string" } },
             skills: { type: "array", items: { type: "string" } }
          },
          required: ["prompt"]
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    switch (request.params.name) {
      case "validate_command": {
        const { command } = ValidateCommandSchema.parse(request.params.arguments);
        const result = validateCommand(command);
        if (!result.allowed) {
          auditLog('COMMAND_EXECUTION', 'DENIED', { command, reason: result.reason, trust_level: result.trust_level });
          return { content: [{ type: "text", text: `[DENIED] ${result.reason}` }] };
        }
        auditLog('COMMAND_EXECUTION', 'ALLOWED', { command, trust_level: result.trust_level });
        return { content: [{ type: "text", text: "[ALLOWED]" }] };
      }
      
      case "validate_write": {
        const { filepath } = ValidateWriteSchema.parse(request.params.arguments);
        const result = validateWrite(filepath);
        if (!result.allowed) {
          auditLog('FILE_WRITE', 'DENIED', { filepath, reason: result.reason });
          return { content: [{ type: "text", text: `[DENIED] ${result.reason}` }] };
        }
        auditLog('FILE_WRITE', 'ALLOWED', { filepath: path.resolve(filepath) });
        return { content: [{ type: "text", text: "[ALLOWED]" }] };
      }

      case "reduce_context": {
        const { filepaths, mode } = ReduceContextSchema.parse(request.params.arguments);
        const rawPayloads: string[] = [];
        
        let totalBytesLoaded = 0;
        for (const filepath of filepaths) {
           try {
             const resolved = path.resolve(filepath);
             let realResolved: string;
             try {
               realResolved = fs.realpathSync(resolved);
             } catch {
               auditLog('CONTEXT_LOAD', 'DENIED', { filepath, reason: 'path resolution failed' });
               continue;
             }
             if (isProtectedPath(realResolved)) {
               auditLog('CONTEXT_LOAD', 'DENIED', { filepath, reason: 'protected path' });
               continue;
             }
             const content = await fs.promises.readFile(realResolved, 'utf-8');
             // Split context into chunks/paragraphs to allow granular pruning
             const chunks = content.split('\n\n').filter(c => c.trim().length > 0);
             rawPayloads.push(...chunks);
             totalBytesLoaded += Buffer.byteLength(content, 'utf8');
           } catch(e: unknown) {
             const reason = e instanceof Error ? e.message : String(e);
             auditLog('CONTEXT_LOAD', 'DENIED', { filepath, reason });
           }
        }
        
        const pipeline = runCompressionPipeline(rawPayloads);

        auditLog('PAYLOAD_MUTATION', 'MUTATED', {
          mode,
          files_requested: filepaths.length,
          raw_chunks: rawPayloads.length,
          reduced_chunks: pipeline.chunks.length,
          bytes_before: pipeline.bytes_before,
          bytes_after: pipeline.bytes_after,
          savings_pct: pipeline.savings_pct,
          volatile_findings: pipeline.volatile_findings,
          chunks_crushed: pipeline.chunks_crushed,
        });

        const header = [
          `[reduce_context] ${pipeline.savings_pct}% saved`,
          `(${pipeline.bytes_before} -> ${pipeline.bytes_after} bytes,`,
          `${pipeline.chunks_crushed} JSON chunks crushed,`,
          `${pipeline.volatile_findings} volatile tokens detected)`,
        ].join(' ');

        const finalContent = pipeline.chunks.join('\n\n');
        return { content: [{ type: "text", text: `${header}\n\n${finalContent}` }] };
      }

      case "orchestrate_task": {
        const prompt = request.params.arguments?.prompt as string;
        const agents: string[] = (request.params.arguments?.agents ?? []) as string[];
        const skills: string[] = (request.params.arguments?.skills ?? []) as string[];
        const files: string[] = (request.params.arguments?.filepaths ?? []) as string[];

        // Read any provided file payloads
        const rawPayloads: string[] = [];
        for (const filePath of files) {
          try {
            const abs = path.resolve(filePath);
            const realAbs = fs.realpathSync(abs);
            if (!isProtectedPath(realAbs)) rawPayloads.push(fs.readFileSync(realAbs, 'utf8'));
          } catch {}
        }

        const pipeline = runCompressionPipeline(rawPayloads);
        const routing = routeTask(prompt, agents, skills);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              prompt,
              routing,
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

run().catch((err) => {
  auditLog('CRASH', 'FATAL', { error: String(err) });
  process.exit(1);
});
