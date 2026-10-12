'use strict';

// The read-only half of `egc doctor` that looks past the install-state: which
// tools on this machine carry the EGC MCP registration, and whether the
// servers those registrations point at start and answer `tools/list`. Nothing
// here writes a config or registers a server; `egc init` does that.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { buildMcpRegistrationTargets, parseJsonObject } = require('./mcp-register');

let TOML = null;
try {
  TOML = require('@iarna/toml');
} catch {
  TOML = null;
}

const EGC_SERVER_NAMES = ['egc-guardian', 'egc-memory'];
const DEFAULT_PROBE_TIMEOUT_MS = 8000;
const KILL_GRACE_MS = 500;
const STDERR_TAIL_CHARS = 300;
const MCP_PROTOCOL_VERSION = '2024-11-05';

function stringAt(list, index) {
  return Array.isArray(list) && typeof list[index] === 'string' ? list[index] : null;
}

function entryOf(container, name) {
  return container && typeof container === 'object' && !Array.isArray(container) && Object.hasOwn(container, name)
    ? container[name]
    : undefined;
}

// Each reader answers {name: binPath | null} for the EGC servers a parsed
// config names; a server that is named without a path it can be probed at
// keeps null, which the probe reports as a registration without a file.
function serversFromMcpServers(obj) {
  const found = {};
  for (const name of EGC_SERVER_NAMES) {
    const entry = entryOf(obj.mcpServers, name);
    if (entry) found[name] = stringAt(entry.args, 0);
  }
  return found;
}

function serversFromOpenCode(obj) {
  const found = {};
  for (const name of EGC_SERVER_NAMES) {
    const entry = entryOf(obj.mcp, name);
    if (entry) found[name] = stringAt(entry.command, 1);
  }
  return found;
}

function serversFromCrush(obj) {
  const found = {};
  for (const name of EGC_SERVER_NAMES) {
    const entry = entryOf(obj.mcp, name);
    if (entry) found[name] = stringAt(entry.args, 0);
  }
  return found;
}

function serversFromZed(obj) {
  const found = {};
  for (const name of EGC_SERVER_NAMES) {
    const entry = entryOf(obj.context_servers, name);
    if (entry) found[name] = stringAt(entry.command?.args, 0);
  }
  return found;
}

function serversFromTomlText(text) {
  const found = {};
  for (const name of EGC_SERVER_NAMES) {
    if (text.includes(`[mcp_servers.${name}]`) || text.includes(`"${name}"`) || text.includes(`'${name}'`)) {
      found[name] = null;
    }
  }
  return found;
}

function serversFromToml(text) {
  if (!TOML) return serversFromTomlText(text);
  const parsed = TOML.parse(text);
  const servers = parsed.mcp_servers;
  const found = {};
  if (Array.isArray(servers)) {
    for (const server of servers) {
      if (server && EGC_SERVER_NAMES.includes(server.name)) found[server.name] = stringAt(server.args, 0);
    }
    return found;
  }
  for (const name of EGC_SERVER_NAMES) {
    const entry = entryOf(servers, name);
    if (entry) found[name] = stringAt(entry.args, 0);
  }
  return found;
}

function readJsonServers(targetPath, text, pick) {
  return pick(parseJsonObject(targetPath, text, 'MCP config'));
}

const READERS = {
  'json': (targetPath, text) => readJsonServers(targetPath, text, serversFromMcpServers),
  // Claude Code keeps its user-scope servers in ~/.claude.json under
  // mcpServers, the file `claude mcp add -s user` maintains.
  'claude-cli': (targetPath, text) => readJsonServers(targetPath, text, serversFromMcpServers),
  'toml': (_targetPath, text) => serversFromToml(text),
  'zed-context-servers': (targetPath, text) => readJsonServers(targetPath, text, serversFromZed),
  'opencode-mcp': (targetPath, text) => readJsonServers(targetPath, text, serversFromOpenCode),
  'crush-mcp': (targetPath, text) => readJsonServers(targetPath, text, serversFromCrush),
};

// The doctor judges presence by files, never by PATH: a tool is on this
// machine when its config, or the directory that config lives in, exists.
// Claude Code keeps the config at the home root, so its directory stands in.
function toolDirectory(target) {
  if (target.format === 'claude-cli') return path.join(path.dirname(target.path), '.claude');
  return path.dirname(target.path);
}

function inspectRegistration(target) {
  const base = { name: target.name, path: target.path, format: target.format, servers: {}, missing: [...EGC_SERVER_NAMES] };
  if (!fs.existsSync(target.path)) return { ...base, status: 'absent' };
  const reader = READERS[target.format];
  if (!reader) return { ...base, status: 'unreadable', reason: `no reader for the ${target.format} format` };
  let servers;
  try {
    servers = reader(target.path, fs.readFileSync(target.path, 'utf8'));
  } catch (error) {
    return { ...base, status: 'unreadable', reason: error.message };
  }
  const missing = EGC_SERVER_NAMES.filter(name => !Object.hasOwn(servers, name));
  return { ...base, servers, missing, status: missing.length === 0 ? 'registered' : 'missing' };
}

/**
 * Every tool present in homeDir with the state of its EGC MCP registration:
 * `registered` (both servers named), `missing` (one or both absent, listed in
 * `missing`), `absent` (the tool is there, its config is not) or `unreadable`
 * (the config does not parse). Tools whose directory does not exist are not
 * listed at all. A tool without the servers is a warning, not an error: the
 * doctor cannot tell a tool that was never registered (`egc init` not run
 * for it) from one that rewrote its config, and only the second is a loss.
 * A config that does not parse is an error either way.
 */
function inspectMcpRegistrations(homeDir) {
  return buildMcpRegistrationTargets(homeDir)
    .filter(target => fs.existsSync(target.path) || fs.existsSync(toolDirectory(target)))
    .map(inspectRegistration);
}

function tailOf(text) {
  return text.length > STDERR_TAIL_CHARS ? text.slice(-STDERR_TAIL_CHARS) : text;
}

/**
 * Starts one server binary with Node, runs the MCP handshake and asks for
 * `tools/list`. Resolves to `{ status: 'ok', tools }` or to one of
 * `missing-file`, `exited` (with `code` and the stderr tail), `no-answer`
 * (nothing within `timeoutMs`) and `bad-answer` (an error reply). The child
 * never outlives the probe.
 */
function probeMcpServer(binPath, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  if (typeof binPath !== 'string' || binPath.length === 0 || !fs.existsSync(binPath)) {
    return Promise.resolve({ status: 'missing-file' });
  }
  return new Promise(resolve => {
    const child = spawn(process.execPath, [binPath], {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    let stderr = '';
    let settled = false;
    let exited = false;
    let timer = null;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!exited) {
        child.kill();
        setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, KILL_GRACE_MS).unref();
      }
      resolve(result);
    };
    timer = setTimeout(() => finish({ status: 'no-answer', timeoutMs, stderr: tailOf(stderr) }), timeoutMs);
    const send = message => {
      try {
        child.stdin.write(JSON.stringify(message) + '\n');
      } catch (error) {
        finish({ status: 'exited', code: null, stderr: tailOf(stderr || error.message) });
      }
    };
    const onMessage = message => {
      if (message.id === 1) {
        if (message.error) {
          finish({ status: 'bad-answer', detail: `initialize: ${JSON.stringify(message.error)}` });
          return;
        }
        send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        return;
      }
      if (message.id === 2) {
        if (message.error || !Array.isArray(message.result?.tools)) {
          finish({ status: 'bad-answer', detail: `tools/list: ${JSON.stringify(message.error || message.result)}` });
          return;
        }
        finish({ status: 'ok', tools: message.result.tools.length });
      }
    };
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        onMessage(message);
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => finish({ status: 'exited', code: null, stderr: tailOf(error.message) }));
    child.on('exit', code => {
      exited = true;
      finish({ status: 'exited', code, stderr: tailOf(stderr) });
    });
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'egc-doctor', version: '1' } },
    });
  });
}

/**
 * The distinct (server, binary) pairs the registrations point at, each with
 * the tools that registered it. A registration that names a server without a
 * binary path (a TOML read without the parser, a hand-edited entry) is a pair
 * with `bin: null`, so the report still shows where the server is expected.
 */
function registeredServers(registrations) {
  const pairs = new Map();
  for (const registration of registrations) {
    for (const [name, bin] of Object.entries(registration.servers || {})) {
      const key = `${name}\u0000${bin ?? ''}`;
      const pair = pairs.get(key) || { name, bin, registeredIn: [] };
      pair.registeredIn.push(registration.name);
      pairs.set(key, pair);
    }
  }
  return [...pairs.values()];
}

/**
 * Probes every server the registrations point at, one at a time (two Node
 * processes side by side on a small machine are enough), as one promise chain.
 */
function probeRegisteredServers(registrations, options = {}) {
  return registeredServers(registrations).reduce(
    (chain, pair) => chain.then(async results => {
      const probe = pair.bin === null
        ? { status: 'missing-file' }
        : await probeMcpServer(pair.bin, options);
      return [...results, { ...pair, ...probe }];
    }),
    Promise.resolve([])
  );
}

const REGISTRATION_SEVERITY = { registered: 'ok', missing: 'warning', absent: 'warning', unreadable: 'error' };

function registrationSeverity(registration) {
  return REGISTRATION_SEVERITY[registration.status] || 'error';
}

function describeRegistration(registration) {
  switch (registration.status) {
    case 'registered': return 'registered';
    case 'missing': return `${registration.missing.join(' and ')} not registered here (egc init registers them; if they were, the tool rewrote its config)`;
    case 'absent': return 'no config with the EGC servers yet (run egc init)';
    default: return `config not readable: ${registration.reason}`;
  }
}

function describeServer(server) {
  switch (server.status) {
    case 'ok': return `answers tools/list (${server.tools} tool${server.tools === 1 ? '' : 's'})`;
    case 'missing-file': return server.bin ? 'registered path does not exist (run egc init after an update)' : 'registered without a path to a binary';
    case 'exited': {
      const code = server.code === null ? 'none' : String(server.code);
      const tail = server.stderr ? server.stderr.trim() : '';
      return tail.length > 0 ? `exited with code ${code} before answering: ${tail}` : `exited with code ${code} before answering`;
    }
    case 'no-answer': return `no answer within ${server.timeoutMs} ms`;
    default: return `answered with an error: ${server.detail}`;
  }
}

function mcpCounts(report) {
  const errorCount = report.registrations.filter(r => registrationSeverity(r) === 'error').length
    + report.servers.filter(s => s.status !== 'ok').length;
  const warningCount = report.registrations.filter(r => registrationSeverity(r) === 'warning').length;
  return { errorCount, warningCount };
}

/**
 * The whole MCP section of a doctor run: the registrations found in homeDir
 * and the probe of every server they name. `errorCount` is what the doctor
 * adds to its failures; `warningCount` the tools still to register.
 */
async function buildMcpReport(homeDir, options = {}) {
  const registrations = inspectMcpRegistrations(homeDir);
  const servers = await probeRegisteredServers(registrations, options);
  const report = { registrations, servers };
  return { ...report, ...mcpCounts(report) };
}

module.exports = {
  DEFAULT_PROBE_TIMEOUT_MS,
  EGC_SERVER_NAMES,
  buildMcpReport,
  describeRegistration,
  describeServer,
  inspectMcpRegistrations,
  probeMcpServer,
  probeRegisteredServers,
  registrationSeverity,
};
