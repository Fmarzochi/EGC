'use strict';
// Multi-session coordination E2E: spawns N concurrent egc-memory server
// instances sharing one isolated HOME, driving each over MCP stdio like a
// real harness would. Proves: mutual visibility (session_peers), fail-fast
// path locks with no steal under a concurrent claim (claim_path), stable
// claim/release identity, and concurrent update_state without lost writes.
//
// Requires the built server; CI does not build the MCP servers, so the test
// skips itself when the build output is absent. Run locally with:
//   sh install.sh && node tests/egc-memory-multi-session.e2e.test.js
// EGC_MSTEST_SESSIONS overrides the session count (default 4).

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'mcp', 'servers', 'egc-memory', 'build', 'index.js');
if (!fs.existsSync(SERVER)) {
  console.log('SKIP: egc-memory build output absent (CI does not build MCP servers)');
  process.exit(0);
}

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-mstest-home-'));
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-mstest-proj-'));
const N = Math.max(2, Number.parseInt(process.env.EGC_MSTEST_SESSIONS || '4', 10) || 4);

class Session {
  constructor(name) {
    this.name = name;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
    this.proc = spawn('node', [SERVER], {
      env: { ...process.env, HOME: FAKE_HOME },
      cwd: PROJECT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.on('data', chunk => {
      this.buf += chunk.toString();
      let idx;
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            this.pending.get(msg.id)(msg);
            this.pending.delete(msg.id);
          }
        } catch { /* non-JSON noise on stdout is ignored */ }
      }
    });
  }

  rpc(method, params) {
    const id = this.nextId++;
    const p = new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      setTimeout(() => reject(new Error(`${this.name}: timeout on ${method}`)), 20000);
    });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return p;
  }

  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async init() {
    await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: this.name, version: '1.0.0' },
    });
    this.notify('notifications/initialized', {});
  }

  async tool(name, args) {
    const res = await this.rpc('tools/call', { name, arguments: args });
    const text = res.result?.content?.[0]?.text ?? JSON.stringify(res.result ?? res.error);
    return text;
  }

  kill() { this.proc.kill(); }
}

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  [${detail}]` : ''}`);
}

async function main() {
  console.log(`HOME isolado: ${FAKE_HOME}`);
  console.log(`Projeto de teste: ${PROJECT}\n`);

  const sessions = [];
  for (let i = 1; i <= N; i++) {
    const s = new Session(`harness-${i}`);
    await s.init();
    sessions.push(s);
  }
  console.log(`${N} servidores egc-memory de pé (1 por sessao, HOME compartilhado)\n`);

  // 1. Announce all sessions concurrently, each with its own territory.
  const announces = await Promise.all(sessions.map((s, i) =>
    s.tool('session_announce', {
      project_path: PROJECT,
      session_name: s.name,
      territory: `area-${i + 1}`,
    })
  ));
  check(`announce concorrente das ${N} sessoes`, announces.every(a => !/error/i.test(a)));

  // 2. Every session must see all four territories on the bus.
  const peersRaw = await Promise.all(sessions.map(s => s.tool('session_peers', { project_path: PROJECT })));
  const everyoneSeesAll = peersRaw.every(p =>
    new RegExp(`Live sessions: ${N}`).test(p) && Array.from({ length: N }, (_, i) => i + 1).every(n => p.includes(`area-${n}`))
  );
  check(`cada sessao ve as ${N} presencas no session_peers`, everyoneSeesAll, everyoneSeesAll ? `${N}x${N} visibilidade` : peersRaw[0].slice(0, 120));

  // 3. Fail-fast lock: sessions 1 and 2 claim the SAME path concurrently.
  const [claimA, claimB] = await Promise.all([
    sessions[0].tool('claim_path', { project_path: PROJECT, path: 'src/shared.js' }),
    sessions[1].tool('claim_path', { project_path: PROJECT, path: 'src/shared.js' }),
  ]);
  const granted = [claimA, claimB].filter(c => !/refused|held|denied|conflict/i.test(c)).length;
  check('claim simultaneo do mesmo path: exatamente 1 vence', granted === 1, `granted=${granted}`);
  const refusal = [claimA, claimB].find(c => /refused|held|denied|conflict/i.test(c)) || '';
  check('recusa identifica quem segura o lock', /locked by live session \S+ \(territory: area-[12]\)/.test(refusal), refusal.slice(0, 100));

  // 4. Disjoint claims all succeed.
  const disjoint = await Promise.all(sessions.map((s, i) =>
    s.tool('claim_path', { project_path: PROJECT, path: `src/only-${i}.js` })
  ));
  check('claims de paths disjuntos: todos passam', disjoint.every(c => !/refused|held|denied|conflict/i.test(c)));

  // 5a. Control case: sequential update_state from all four sessions.
  for (const [i, s] of sessions.entries()) {
    await s.tool('update_state', {
      project_path: PROJECT,
      decisions: [{ what: `seq da ${s.name}`, why: `escrita sequencial ${i}` }],
    });
  }
  const seqState = await sessions[sessions.length - 1].tool('get_state', { project_path: PROJECT });
  const seqAll = sessions.every(s => seqState.includes(`seq da ${s.name}`));
  check(`${N} update_state SEQUENCIAIS, zero perda`, seqAll, seqAll ? `${N}/${N}` : seqState.slice(0, 200));

  // 5b. Stress case: concurrent update_state from all four sessions.
  await Promise.all(sessions.map((s, i) =>
    s.tool('update_state', {
      project_path: PROJECT,
      decisions: [{ what: `conc da ${s.name}`, why: `escrita concorrente ${i}` }],
    })
  ));
  const state = await sessions[sessions.length - 1].tool('get_state', { project_path: PROJECT });
  const present = sessions.filter(s => state.includes(`conc da ${s.name}`)).length;
  check(`${N} update_state CONCORRENTES, zero perda no get_state`, present === N, `${present}/${N} decisoes presentes`);

  // 6. Release and confirm the freed path can be claimed by someone else.
  const holderIdx = /area-1\)/.test(refusal) ? 0 : 1;
  const released = await sessions[holderIdx].tool('release_path', { project_path: PROJECT, path: 'src/shared.js' });
  const reclaim = await sessions[2].tool('claim_path', { project_path: PROJECT, path: 'src/shared.js' });
  check('apos release, outra sessao consegue o lock', !/refused|held|denied|conflict/i.test(reclaim), `release: ${released.slice(0, 80)} | reclaim: ${reclaim.slice(0, 80)}`);

  // 7. Event queue: direct send, broadcast, exactly-once consumption, peek.
  // Direct targeting needs the receiver's real bus id: grab it from peers.
  const peersForIds = await sessions[0].tool('session_peers', { project_path: PROJECT });
  const ids = [...peersForIds.matchAll(/- (bus-\d+)/g)].map(m => m[1]);
  check('ids de sessao visiveis para enderecamento', ids.length >= N - 1, `${ids.length} ids`);

  const directTarget = ids[0];
  const direct = await sessions[0].tool('session_send', {
    project_path: PROJECT, to_session: directTarget, kind: 'handoff', payload: 'auth notes in state',
  });
  check('send direto aceito', /Event #\d+ sent/.test(direct), direct.slice(0, 80));

  const broadcast = await sessions[0].tool('session_send', {
    project_path: PROJECT, kind: 'heads-up', payload: 'refactor em curso',
  });
  check('broadcast aceito', /broadcast/.test(broadcast), broadcast.slice(0, 80));

  const senderRead = await sessions[0].tool('session_events', { project_path: PROJECT });
  check('remetente nao recebe o proprio broadcast', /No new events/.test(senderRead), senderRead.slice(0, 60));

  const lastReader = sessions[sessions.length - 1];
  const firstRead = await lastReader.tool('session_events', { project_path: PROJECT });
  check('receptor ve o broadcast', /heads-up/.test(firstRead), firstRead.slice(0, 100));
  const secondRead = await lastReader.tool('session_events', { project_path: PROJECT });
  check('consumo exactly-once: segunda leitura vazia', /No new events/.test(secondRead));

  const peekTarget = sessions[sessions.length - 2];
  const peeked = await peekTarget.tool('session_events', { project_path: PROJECT, peek: true });
  const afterPeek = await peekTarget.tool('session_events', { project_path: PROJECT });
  check('peek nao consome', /heads-up/.test(peeked) && /heads-up/.test(afterPeek));

  // 8. Implicit presence: a brand-new session that only calls get_state
  // becomes visible on the bus without any session_announce.
  const ghost = new Session('ghost');
  await ghost.init();
  await ghost.tool('get_state', { project_path: PROJECT });
  const peersAfterGhost = await sessions[0].tool('session_peers', { project_path: PROJECT });
  const ghostVisible = new RegExp(`Live sessions: ${N + 1}`).test(peersAfterGhost);
  check('presenca implicita: get_state registra a sessao no bus', ghostVisible, peersAfterGhost.split('\n')[0]);
  ghost.kill();

  sessions.forEach(s => s.kill());
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err.message); process.exit(1); });
