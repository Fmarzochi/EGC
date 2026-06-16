// mcp/servers/egc-memory/src/compress.ts
// Observation compression logic for issue #142

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ObservationType = "tool_failure" | "tool_success" | "file_edit" | "generic";

export interface RawObservation {
  id?: string;
  tool?: string;
  output?: string;
  content?: string;
  result?: string;
  path?: string;
  timestamp?: string;
}

export interface CompressedObservation {
  type: ObservationType;
  title: string;
  facts: string[];
  importance: number;        // 0.0 → low, 1.0 → critical
  concepts: string[];
  compressed_at: string;
  original_id: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Set-based word list avoids long alternation regex (keeps cognitive complexity low)
const CONCEPT_WORDS = new Set([
  "auth", "jwt", "token", "login", "test", "build", "lint", "type",
  "file", "module", "import", "export", "class", "interface", "async",
  "await", "fetch", "api", "db", "sql", "redis", "cache", "queue",
  "hook", "route", "component", "state", "context", "effect", "ref", "prop",
]);

function extractConcepts(text: string): string[] {
  const words = text.toLowerCase().match(/\b[a-z]+\b/g) ?? [];
  return [...new Set(words.filter((w) => CONCEPT_WORDS.has(w)))];
}

function buildTitle(type: ObservationType, tool: string, content: string): string {
  if (type === "tool_failure") {
    const errorLine = content
      .split("\n")
      .find((l) => /error|failed|exception/i.test(l));
    return errorLine ? errorLine.trim().slice(0, 80) : `${tool} failed`;
  }
  if (type === "tool_success") return `${tool} completed successfully`;
  if (type === "file_edit")    return `File operation via ${tool}`;
  return `${tool} observation`;
}

// ─── Project Hashing & Path Resolution ────────────────────────────────────────

/**
 * Resolves the project root and generates a stable content-addressable ID
 * using direct fs reads instead of child_process spawns (no shell injection risk).
 */
export function getProjectHash(projectPath: string): { projectId: string; projectDir: string } {
  let projectRoot = projectPath;
  let remoteUrl = "";

  // Walk up the directory tree to find the nearest .git directory
  let dir = projectPath;
  while (dir !== path.dirname(dir)) {
    const gitDir = path.join(dir, ".git");
    if (fs.existsSync(gitDir)) {
      projectRoot = dir;
      break;
    }
    dir = path.dirname(dir);
  }

  // Read remote URL from .git/config: no child_process spawn needed
  const gitConfigPath = path.join(projectRoot, ".git", "config");
  if (fs.existsSync(gitConfigPath)) {
    try {
      const configContent = fs.readFileSync(gitConfigPath, "utf8");
      const urlMatch = configContent.match(/url\s*=\s*(.+)/);
      if (urlMatch?.[1]) {
        remoteUrl = urlMatch[1].trim().replace(/:\/\/[^@]+@/, "://");
      }
    } catch (e) {
      // non-critical: remote URL is only used for dedup hashing; falls back to path
      console.error("[EGC compress] Could not read .git/config:", String(e));
    }
  }

  const hashInput = remoteUrl || projectRoot;
  let projectId = "global";
  if (hashInput) {
    // non-security hash: used for dedup/identity only
    projectId = crypto.createHash("sha256").update(hashInput, "utf8").digest("hex").slice(0, 12);
  }

  const homunculusDir = path.join(os.homedir(), ".gemini", "homunculus");
  const projectDir = projectId === "global" ? homunculusDir : path.join(homunculusDir, "projects", projectId);

  return { projectId, projectDir };
}

// ─── Loader & Replacer for observations.jsonl ──────────────────────────────────
function resolveStateStoreDbPath(): string {
  const envOverride = process.env.EGC_STATE_DB;
  if (envOverride) {
    return path.resolve(envOverride);
  }

  const homeDir = process.env.HOME || os.homedir();
  return path.join(homeDir, ".gemini", "egc", "state.db");
}
async function loadRawObservationsFromStateDb(
  limit: number = 50,
  since?: string
): Promise<RawObservation[]> {
  const dbPath = resolveStateStoreDbPath();

  if (!fs.existsSync(dbPath)) {
    return [];
  }

  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database,
  });

  try {
    const query = `
      SELECT id, payload, timestamp
      FROM events
      ORDER BY timestamp DESC
      LIMIT ?
    `;

    const rows = await db.all(query, [limit]);

    return rows.map((row: any) => {
      let payload: any = {};

      try {
        payload = JSON.parse(row.payload);
      } catch {
        payload = {};
      }

      return {
        id: row.id,
        tool: payload.tool,
        output: payload.output ?? payload.result ?? "",
        content:
          payload.input ??
          payload.output ??
          payload.result ??
          "",
        result: payload.result ?? payload.output ?? "",
        path: payload.cwd ?? payload.file ?? "",
        timestamp: row.timestamp,
      };
    });
  } finally {
    await db.close();
  }
}
export async function loadRawObservations(
  projectPath: string,
  limit: number = 50,
  since?: string
): Promise<RawObservation[]> {
  const sqliteObservations = await loadRawObservationsFromStateDb(
  limit,
  since
);

if (sqliteObservations.length > 0) {
  return sqliteObservations;
}

  const { projectDir } = getProjectHash(projectPath);
  const obsPath = path.join(projectDir, "observations.jsonl");

  if (!fs.existsSync(obsPath)) {
    const globalObsPath = path.join(os.homedir(), ".gemini", "homunculus", "observations.jsonl");
    if (!fs.existsSync(globalObsPath)) {
      return [];
    }
    return readObsFile(globalObsPath, limit, since);
  }
  return readObsFile(obsPath, limit, since);
}

function readObsFile(filePath: string, limit: number, since?: string): RawObservation[] {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n").filter(Boolean);
  const observations: RawObservation[] = [];
  const sinceTime = since ? new Date(since).getTime() : 0;

  for (let i = 0; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i]);
      // Only load raw, uncompressed observations
      if (parsed.event && parsed.tool && !parsed.compressed_at) {
        const timestamp = parsed.timestamp;
        if (sinceTime && timestamp) {
          const time = new Date(timestamp).getTime();
          if (time < sinceTime) continue;
        }

        // non-security hash: used for dedup/identity only
        const id = parsed.id || `obs-${i}-${crypto.createHash("sha256").update(lines[i]).digest("hex").slice(0, 8)}`;
        observations.push({
          id,
          tool: parsed.tool,
          output: parsed.output || "",
          content: parsed.input || parsed.output || "",
          result: parsed.output || "",
          path: parsed.cwd || "",
          timestamp: parsed.timestamp,
        });
      }
    } catch (e) {
      // non-critical: skip malformed JSONL lines during read
      console.error(`[EGC compress] Skipping malformed observation line ${i}:`, String(e));
    }
  }

  return observations.slice(-limit);
}

export async function replaceObservation(projectPath: string, id: string, compressed: CompressedObservation): Promise<void> {
  const { projectDir } = getProjectHash(projectPath);
  let obsPath = path.join(projectDir, "observations.jsonl");
  if (!fs.existsSync(obsPath)) {
    const globalObsPath = path.join(os.homedir(), ".gemini", "homunculus", "observations.jsonl");
    if (fs.existsSync(globalObsPath)) {
      obsPath = globalObsPath;
    } else {
      return;
    }
  }

  const content = fs.readFileSync(obsPath, "utf8");
  const lines = content.split("\n");
  let replaced = false;

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    try {
      const parsed = JSON.parse(lines[i]);
      // non-security hash: used for dedup/identity only
      const lineId = parsed.id || `obs-${i}-${crypto.createHash("sha256").update(lines[i]).digest("hex").slice(0, 8)}`;
      if (lineId === id) {
        lines[i] = JSON.stringify({
          ...compressed,
          id,
        });
        replaced = true;
        break;
      }
    } catch (e) {
      // non-critical: skip malformed lines during replacement scan
      console.error(`[EGC compress] Skipping malformed line ${i} during replacement:`, String(e));
    }
  }

  if (replaced) {
    const tempPath = `${obsPath}.tmp`;
    fs.writeFileSync(tempPath, lines.join("\n"), "utf8");
    fs.renameSync(tempPath, obsPath);
  }
}

// ─── Rule-based compressor (no LLM required) ──────────────────────────────────

export function ruleBasedCompress(raw: RawObservation): CompressedObservation {
  const content = raw.output ?? raw.content ?? raw.result ?? "";
  const tool    = raw.tool ?? "unknown";
  const lines   = content.split("\n").filter(Boolean);

  let type:       ObservationType = "generic";
  let importance: number          = 0.3;
  const facts:    string[]        = [];
  const concepts: string[]        = [];

  if (/error|failed|exception|cannot|unexpected/i.test(content)) {
    // ── Failure ──────────────────────────────────────────────────────────────
    type       = "tool_failure";
    importance = 0.8;
    lines.slice(0, 6).forEach((l) => facts.push(l.trim()));
    concepts.push(...extractConcepts(content));

  } else if (/success|passed|done|✓|completed/i.test(content)) {
    // ── Success ───────────────────────────────────────────────────────────────
    type       = "tool_success";
    importance = 0.4;
    lines.slice(0, 3).forEach((l) => facts.push(l.trim()));

  } else if (["write_file", "read_file", "str_replace", "create_file"].includes(tool)) {
    // ── File edit ─────────────────────────────────────────────────────────────
    type       = "file_edit";
    importance = 0.5;
    facts.push(`Tool: ${tool}`);
    if (raw.path) facts.push(`File: ${raw.path}`);
    lines.slice(0, 2).forEach((l) => facts.push(l.trim()));

  } else if (lines[0]) {
    // ── Generic ───────────────────────────────────────────────────────────────
    facts.push(lines[0]);
  }

  return {
    type,
    title:         buildTitle(type, tool, content),
    facts:         facts.slice(0, 6),
    importance,
    concepts,
    compressed_at: new Date().toISOString(),
    original_id:   raw.id ?? null,
  };
}

// ─── Zod schema for LLM response validation ───────────────────────────────────

const LlmCompressedSchema = z.object({
  type:       z.enum(["tool_failure", "tool_success", "file_edit", "generic"]),
  title:      z.string().max(80),
  facts:      z.array(z.string()).min(1).max(6),
  importance: z.number().min(0).max(1),
  concepts:   z.array(z.string()),
});

// ─── LLM-based compressor (uses EGC's configured LLM provider) ───────────────

export async function llmCompress(
  raw: RawObservation,
  llmCall: (prompt: string) => Promise<string>
): Promise<CompressedObservation> {
  const content = raw.output ?? raw.content ?? raw.result ?? "";
  const tool    = raw.tool ?? "unknown";

  const prompt = `You are a context compression engine for an AI coding assistant's memory system.
Given this raw tool observation, produce a JSON object with EXACTLY these fields:
- "type": one of "tool_failure" | "tool_success" | "file_edit" | "generic"
- "title": string, max 80 chars, human-readable summary
- "facts": string[], 3 to 6 key facts extracted from the output
- "importance": float 0.0–1.0 (failures ≥ 0.7, successes ~0.4, generic ~0.3)
- "concepts": string[], relevant keyword tags (e.g. ["auth", "jwt", "testing"])

Tool that ran: ${tool}
Raw output (truncated to 2000 chars):
${content.slice(0, 2000)}

Respond with ONLY valid JSON. No markdown, no explanation, no backticks.`;

  try {
    const response = await llmCall(prompt);
    // Validate the LLM response shape before spreading to prevent injection of unexpected fields
    const parsed = LlmCompressedSchema.parse(JSON.parse(response));

    return {
      ...parsed,
      compressed_at: new Date().toISOString(),
      original_id:   raw.id ?? null,
    };
  } catch {
    // LLM unavailable, returned bad JSON, or failed Zod validation → safe fallback
    console.error("[EGC compress] LLM compression failed: using rule-based fallback");
    return ruleBasedCompress(raw);
  }
}
