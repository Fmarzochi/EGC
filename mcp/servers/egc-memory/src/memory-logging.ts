import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolveHome } from './home';

export function hideEgcRootOnWindows(): void {
  if (process.platform !== 'win32') return;
  const egcRoot = path.join(resolveHome(), '.egc');
  const attribPath = path.join(process.env.SystemRoot || String.raw`C:\Windows`, 'System32', 'attrib.exe');
  spawnSync(attribPath, ['+h', egcRoot], { stdio: 'ignore', shell: false });
}

export function ensurePrivateDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 }); // NOSONAR jssecurity:S8707
  if (process.platform !== 'win32') {
    try { fs.chmodSync(dirPath, 0o700); } catch { /* best-effort */ } // NOSONAR jssecurity:S8707
  }
}

class PersistentLogger {
  private readonly logPath: string;
  private readonly maxSizeBytes = 5 * 1024 * 1024; // 5MB

  constructor(serviceName: string) {
    const logDir = path.join(resolveHome(), '.egc', 'logs');
    ensurePrivateDir(logDir);
    hideEgcRootOnWindows();
    this.logPath = path.join(logDir, `${serviceName}.log`);
  }

  log(level: 'INFO'|'WARN'|'ERROR'|'AUDIT'|'DEBUG', msg: string, meta: Record<string, unknown> = {}) {
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
      // non-critical: log rotation failure should not crash the server
      console.error('[EGC memory] Log write failed (disk full?):', String(e));
    }
  }
}

const sysLogger = new PersistentLogger('egc-memory-orchestrator');

export function log(level: 'INFO'|'WARN'|'ERROR'|'AUDIT'|'DEBUG', msg: string, meta: Record<string, unknown> = {}) {
  sysLogger.log(level, msg, meta);
}
