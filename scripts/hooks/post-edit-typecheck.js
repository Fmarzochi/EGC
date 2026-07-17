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

function runTypeCheck(dir, filePath, resolvedPath) {
  try {
    const npxBin = process.platform === "win32" ? "npx.cmd" : "npx";
    execFileSync(npxBin, ["tsc", "--noEmit", "--pretty", "false"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    });
  } catch (err) {
    const output = (err.stdout || "") + (err.stderr || "");
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
