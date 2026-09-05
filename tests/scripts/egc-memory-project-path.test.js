'use strict';
/**
 * project_path is accepted by shape, not by a list of known-bad
 * directories: the home directory itself, any directory under it except the
 * hidden ones directly under home, and any directory outside home that is
 * not a system root. A worktree under a project keeps working even though
 * one of its segments is hidden.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { CLI_TIMEOUT_MS } = require('../fixtures/subprocess-timeouts');

const SERVER = path.join(__dirname, '../../mcp/servers/egc-memory/build/index.js');
if (!fs.existsSync(SERVER)) {
  console.error(`[SKIP] Missing ${SERVER}. Build mcp/servers/egc-memory first.`);
  process.exit(0);
}

class MemoryClient {
  constructor(home, cwd) {
    this.child = spawn(process.execPath, [SERVER], {
      cwd,
      env: { ...process.env, HOME: home, USERPROFILE: home, EGC_PROJECT: cwd },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.waiting = new Map();
    this.nextId = 1;
    this.child.stderr.on('data', () => {});
    readline.createInterface({ input: this.child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const settle = this.waiting.get(message.id);
      if (settle) {
        this.waiting.delete(message.id);
        settle(message);
      }
    });
  }

  call(method, params) {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error(`timeout: ${method}`)); }, CLI_TIMEOUT_MS);
      this.waiting.set(id, message => { clearTimeout(timer); resolve(message); });
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async tool(name, args) {
    return JSON.stringify(await this.call('tools/call', { name, arguments: args }));
  }

  close() {
    return new Promise(resolve => {
      this.child.once('exit', () => resolve());
      this.child.stdin.end();
      this.child.kill();
    });
  }
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-project-path-home-'));
  const project = path.join(home, 'work', 'project');
  const hidden = path.join(home, '.gnupg');
  const toolDir = path.join(home, '.claude', 'worktrees', 'w');
  const worktree = path.join(project, '.claude', 'worktrees', 'feature');
  const doubleDot = path.join(home, '..secrets');
  for (const dir of [project, hidden, toolDir, worktree, doubleDot]) fs.mkdirSync(dir, { recursive: true });
  const filesystemRoot = process.platform === 'win32' ? 'C:\\' : '/';

  const systemRoot = process.platform === 'win32' ? 'C:\\Windows' : '/etc';

  let passed = 0;
  let failed = 0;
  const check = async (name, fn) => {
    try {
      await fn();
      console.log(`  ok ${name}`);
      passed++;
    } catch (error) {
      console.log(`  FAIL ${name}\n    ${error.message}`);
      failed++;
    }
  };

  console.log('\n=== Testing project_path acceptance by shape ===\n');
  const client = new MemoryClient(home, project);
  try {
    const init = await client.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'project-path-test', version: '1.0' } });
    assert.ok(init.result, JSON.stringify(init.error));
    client.notify('notifications/initialized', {});

    await check('a hidden directory directly under home is refused', async () => {
      const reply = await client.tool('update_state', { project_path: hidden, context: 'x' });
      assert.ok(reply.includes('not allowed'), reply.slice(0, 300));
    });
    await check('a directory under a hidden tool directory in home is refused too', async () => {
      const reply = await client.tool('update_state', { project_path: toolDir, context: 'x' });
      assert.ok(reply.includes('not allowed'), reply.slice(0, 300));
    });
    await check('a hidden directory whose name starts with two dots is refused as hidden, not read as a parent', async () => {
      const reply = await client.tool('update_state', { project_path: doubleDot, context: 'x' });
      assert.ok(reply.includes('not allowed'), reply.slice(0, 300));
      assert.ok(reply.includes('hidden directory'), reply.slice(0, 300));
    });
    await check('the filesystem root is refused', async () => {
      const reply = await client.tool('update_state', { project_path: filesystemRoot, context: 'x' });
      assert.ok(reply.includes('not allowed'), reply.slice(0, 300));
    });
    if (process.platform !== 'win32') {
      await check('a missing child of a linked system directory is refused through the link', async () => {
        const link = path.join(home, 'work', 'binlink');
        fs.symlinkSync('/bin', link);
        const reply = await client.tool('update_state', { project_path: path.join(link, 'new-project'), context: 'x' });
        assert.ok(reply.includes('not allowed'), reply.slice(0, 300));
      });
    }
    await check('a system root is refused', async () => {
      const reply = await client.tool('update_state', { project_path: systemRoot, context: 'x' });
      assert.ok(reply.includes('not allowed'), reply.slice(0, 300));
    });
    await check('a worktree under a project is accepted even though its segment is hidden', async () => {
      const reply = await client.tool('update_state', { project_path: worktree, context: 'worktree state' });
      assert.ok(!reply.includes('not allowed'), reply.slice(0, 300));
      assert.ok(reply.includes('updated'), reply.slice(0, 300));
    });
    await check('the project itself is accepted', async () => {
      const reply = await client.tool('update_state', { project_path: project, context: 'project state' });
      assert.ok(reply.includes('updated'), reply.slice(0, 300));
    });
  } finally {
    await client.close();
    fs.rmSync(home, { recursive: true, force: true });
  }



  console.log(`\nPassed: ${passed}\nFailed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
