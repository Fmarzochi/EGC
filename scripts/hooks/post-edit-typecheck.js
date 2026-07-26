#!/usr/bin/env node
/**
 * PostToolUse Hook: TypeScript check after editing .ts/.tsx files
 *
 * Cross-platform (Windows, macOS, Linux)
 *
 * Runs after Edit tool use on TypeScript files. Walks up from the file's
 * directory to find the nearest tsconfig.json, then runs tsc --noEmit
 * and reports only errors related to the edited file.
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const MAX_STDIN = 1024 * 1024; // 1MB limit
let data = "";
process.stdin.setEncoding("utf8");

process.stdin.on("data", (chunk) => {
  if (data.length < MAX_STDIN) {
    const remaining = MAX_STDIN - data.length;
    data += chunk.substring(0, remaining);
  }
});

function findTsConfig(startDir) {
  let dir = startDir;
  const root = path.parse(dir).root;
  let depth = 0;

  while (dir !== root && depth < 20) {
    if (fs.existsSync(path.join(dir, "tsconfig.json"))) {
      return dir;
    }
    dir = path.dirname(dir);
    depth++;
  }
  
  if (fs.existsSync(path.join(dir, "tsconfig.json"))) {
    return dir;
  }
  return null;
}

function reportTscErrors(output, dir, filePath, resolvedPath) {
  const relPath = path.relative(dir, resolvedPath);
  const candidates = new Set([filePath, resolvedPath, relPath]);
  const relevantLines = output
    .split("\n")
    .filter((line) => {
      for (const candidate of candidates) {
        if (line.includes(candidate)) return true;
      }
      return false;
    })
    .slice(0, 10);

  if (relevantLines.length > 0) {
    console.error(
      "[Hook] TypeScript errors in " + path.basename(filePath) + ":",
    );
    relevantLines.forEach((line) => console.error(line));
  }
}

// Resolve the project's own tsc compiler by walking up from startDir for
// node_modules/typescript/bin/tsc, a plain Node script we run through
// process.execPath. This deliberately avoids npx: since Node 20.12 (the
// CVE-2024-27980 mitigation) spawning the npx.cmd shim without a shell throws
// EINVAL, so the previous execFileSync of npx silently never ran the check on
// Windows, and adding shell:true would reopen a command-injection surface.
function resolveTscBin(startDir) {
  let dir = startDir;
  const root = path.parse(dir).root;
  let depth = 0;

  while (depth < 20) {
    const candidate = path.join(dir, "node_modules", "typescript", "bin", "tsc");
    if (fs.existsSync(candidate)) return candidate;
    if (dir === root) break;
    dir = path.dirname(dir);
    depth++;
  }
  return null;
}

function runTypeCheck(dir, filePath, resolvedPath) {
  const tscBin = resolveTscBin(dir);
  if (!tscBin) return;

  try {
    execFileSync(process.execPath, [tscBin, "--noEmit", "--pretty", "false"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    });
  } catch (err) {
    reportTscErrors((err.stdout || "") + (err.stderr || ""), dir, filePath, resolvedPath);
  }
}

process.stdin.on("end", () => {
  try {
    const input = JSON.parse(data);
    const filePath = input.tool_input?.file_path;

    if (filePath && /\.(ts|tsx)$/.test(filePath)) {
      const resolvedPath = path.resolve(filePath);
      if (!fs.existsSync(resolvedPath)) {
        process.stdout.write(data);
        process.exit(0);
      }
      
      const tsConfigDir = findTsConfig(path.dirname(resolvedPath));
      if (tsConfigDir) {
        runTypeCheck(tsConfigDir, filePath, resolvedPath);
      }
    }
  } catch {
    // Invalid input: pass through
  }

  process.stdout.write(data);
  process.exit(0);
});
