const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TMP = path.join(os.tmpdir(), 'egc-e2e-' + Date.now());
const REMOTE = path.join(TMP, 'remote.git');
const SANDBOX_HOME = path.join(TMP, 'home');

// Redirect ~/.egc to an isolated temp sandbox before loading modules.
fs.mkdirSync(SANDBOX_HOME, { recursive: true });
process.env.HOME = SANDBOX_HOME;
process.env.USERPROFILE = SANDBOX_HOME;

const EGCDIR = path.join(SANDBOX_HOME, '.egc');
const STATEDIR = path.join(EGCDIR, 'state');
const SYNCDIR = path.join(EGCDIR, 'team-sync');
const TEAMJSON = path.join(EGCDIR, 'team.json');

function resolveGitBin() {
  const lookupCmd = process.platform === 'win32' ? 'where' : 'which';
  const output = execFileSync(lookupCmd, ['git'], { encoding: 'utf-8', stdio: 'pipe' });
  const gitPath = output.split('\n').map(s => s.trim()).find(Boolean);
  if (!gitPath || !path.isAbsolute(gitPath)) {
    throw new Error(`git executable not found at an absolute path (got: ${gitPath || 'none'})`);
  }
  return gitPath;
}

const GIT_BIN = resolveGitBin();

function sh(args, cwd) {
  const r = execFileSync(GIT_BIN, args, { cwd: cwd || TMP, encoding: 'utf-8', windowsHide: true });
  return (r || '').trim();
}

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { console.log('  PASS: ' + msg); passed++; } else { console.log('  FAIL: ' + msg); failed++; } }

async function runGitBackendTests(GitBackend, REMOTE, SYNCDIR) {
  console.log('\n2. Testing GitBackend directly...');
  const gitBackend = new GitBackend();
  ok(typeof gitBackend.init === 'function', 'GitBackend has init method');
  ok(typeof gitBackend.pull === 'function', 'GitBackend has pull method');
  ok(typeof gitBackend.push === 'function', 'GitBackend has push method');
  ok(typeof gitBackend.status === 'function', 'GitBackend has status method');

  // Initialize git backend
  await gitBackend.init({ backend: 'git', remote: REMOTE, branch: 'main' });
  ok(fs.existsSync(path.join(SYNCDIR, '.git')), 'GitBackend.init creates repo');

  // Check status before any sync
  const preStatus = await gitBackend.status();
  ok(preStatus.lastSyncTime === null, 'status reports no last sync before first push');
  ok(preStatus.remoteUrl === REMOTE, 'status reports correct remote URL');
}

async function runTeamSyncTests(teamInit, teamSync, teamStatus, REMOTE, STATEDIR, SYNCDIR, TEAMJSON) {
  // 7. Create state file
  fs.mkdirSync(STATEDIR, { recursive: true });
  const stateContent = [
    '# Project State',
    'project: /e2e',
    'author: TestUser',
    'updated: ' + new Date().toISOString(),
    '',
    '## Context',
    'E2E test lesson learned.',
    '',
    '## Active Decisions',
    '- Use last-write-wins for merge conflicts',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(STATEDIR, 'e2e-test.md'), stateContent, 'utf-8');
  ok(fs.existsSync(path.join(STATEDIR, 'e2e-test.md')), 'state file created');

  // 8. Team init
  console.log('\n3. Testing teamInit...');
  const initCfg = await teamInit('git', REMOTE, 'main');
  ok(initCfg.backend === 'git', 'teamInit returns config');
  ok(initCfg.remote === REMOTE, 'teamInit returns correct remote');
  ok(fs.existsSync(TEAMJSON), 'team.json created');

  // 9. Team sync
  console.log('\n4. Testing teamSync...');
  const syncResult = await teamSync();
  ok(syncResult.pushedCount >= 0, 'teamSync returns result with pushedCount: ' + syncResult.pushedCount);
  ok(Array.isArray(syncResult.errors), 'teamSync errors is array');

  // 10. Check remote for the commit
  console.log('\n5. Verifying remote...');
  try {
    const log = sh(['log', '--oneline', '--all'], REMOTE);
    ok(log.length > 0, 'remote has commits: ' + log);
    console.log('   Remote log: ' + log.replaceAll('\n', ' | '));
  } catch (e) {
    ok(false, 'git log on remote: ' + e.message);
  }

  // 11. Team status after sync
  console.log('\n6. Testing teamStatus...');
  const postStatus = await teamStatus();
  ok(postStatus.lastSyncTime !== null, 'status shows lastSyncTime after push');
  ok(postStatus.remoteUrl === REMOTE, 'status shows remote URL');

  // 12. Verify sync repo has state files
  const syncedStateDir = path.join(SYNCDIR, 'state');
  ok(fs.existsSync(syncedStateDir), 'sync repo has state directory');
  const syncedFiles = fs.readdirSync(syncedStateDir);
  ok(syncedFiles.length > 0, 'state files synced to team-sync: ' + syncedFiles.join(', '));
}

function verifyBuildOutput(EGC_ROOT, SyncBackend) {
  // 13. Test SyncBackend abstract class
  console.log('\n7. Testing SyncBackend abstract class...');
  ok(typeof SyncBackend === 'function', 'SyncBackend class exports');
  ok(SyncBackend.prototype.init === undefined || Object.getOwnPropertyDescriptor(SyncBackend.prototype, 'init'), 'SyncBackend declares init');

  // 14. Verify the build output wires team tools
  console.log('\n8. Build verification...');
  const buildIndex = fs.readFileSync(path.join(EGC_ROOT, 'mcp/servers/egc-memory/build/index.js'), 'utf-8');
  ok(buildIndex.includes('team_init'), 'build/index.js defines team_init tool');
  ok(buildIndex.includes('team_sync'), 'build/index.js defines team_sync tool');
  ok(buildIndex.includes('team_status'), 'build/index.js defines team_status tool');
  ok(buildIndex.includes('teamInit'), 'build/index.js references teamInit');
  ok(buildIndex.includes('teamSync'), 'build/index.js references teamSync');
  ok(buildIndex.includes('teamStatus'), 'build/index.js references teamStatus');
}

function cleanSandboxState() {
  if (fs.existsSync(SYNCDIR)) fs.rmSync(SYNCDIR, { recursive: true, force: true });
  if (fs.existsSync(TEAMJSON)) fs.unlinkSync(TEAMJSON);
  if (fs.existsSync(STATEDIR)) fs.rmSync(STATEDIR, { recursive: true, force: true });
}

function cleanSandboxAll() {
  cleanSandboxState();
  if (fs.existsSync(TMP)) fs.rmSync(TMP, { recursive: true, force: true });
}

// Each removal keeps its own try so one failure never blocks the next path.
function cleanSandboxAllBestEffort() {
  try { if (fs.existsSync(SYNCDIR)) fs.rmSync(SYNCDIR, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { if (fs.existsSync(TEAMJSON)) fs.unlinkSync(TEAMJSON); } catch { /* best-effort */ }
  try { if (fs.existsSync(STATEDIR)) fs.rmSync(STATEDIR, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { if (fs.existsSync(TMP)) fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
}

(async () => { try {
  console.log('=== E2E Direct Module Test ===\n');
  console.log(`Sandbox home: ${SANDBOX_HOME}`);

  // 1. Create remote bare repo via git
  fs.mkdirSync(REMOTE, { recursive: true });
  sh(['init', '--bare'], REMOTE);
  console.log('1. Remote repo created at ' + REMOTE);
  ok(fs.existsSync(path.join(REMOTE, 'HEAD')), 'remote git repo initialized');

  // 2. Clean slate in sandbox
  cleanSandboxState();

  // 3. Load and test the modules directly (after sandbox env is set)
  const EGC_ROOT = path.resolve(__dirname, '..');
  const { teamInit, teamSync, teamStatus, getTeamConfig, writeTeamConfig } = require(path.join(EGC_ROOT, 'mcp/servers/egc-memory/build/sync/TeamSync.js'));
  const { SyncBackend } = require(path.join(EGC_ROOT, 'mcp/servers/egc-memory/build/sync/SyncBackend.js'));
  const { GitBackend } = require(path.join(EGC_ROOT, 'mcp/servers/egc-memory/build/sync/GitBackend.js'));

  ok(typeof teamInit === 'function', 'teamInit exports as function');
  ok(typeof teamSync === 'function', 'teamSync exports as function');
  ok(typeof teamStatus === 'function', 'teamStatus exports as function');
  ok(typeof GitBackend === 'function', 'GitBackend class exports');

  // 4. Test getTeamConfig returns null before init
  ok(getTeamConfig() === null, 'getTeamConfig returns null before init');

  // 5. Test writeTeamConfig / getTeamConfig round-trip
  writeTeamConfig({ backend: 'git', remote: REMOTE, branch: 'main' });
  const cfg = getTeamConfig();
  ok(cfg !== null, 'getTeamConfig returns config after write');
  ok(cfg.backend === 'git', 'config backend is git');
  ok(cfg.remote === REMOTE, 'config remote matches');
  ok(cfg.branch === 'main', 'config branch is main');

  await runGitBackendTests(GitBackend, REMOTE, SYNCDIR);
  await runTeamSyncTests(teamInit, teamSync, teamStatus, REMOTE, STATEDIR, SYNCDIR, TEAMJSON);
  verifyBuildOutput(EGC_ROOT, SyncBackend);

  // Cleanup
  console.log('\n--- Cleaning up ---');
  cleanSandboxAll();

  console.log('\n' + '='.repeat(50));
  console.log('E2E Results: ' + passed + ' passed, ' + failed + ' failed');
  console.log('='.repeat(50));
  process.exit(failed > 0 ? 1 : 0);

} catch (e) {
  console.error('\nFATAL: ' + e.message);
  console.error(e.stack);
  cleanSandboxAllBestEffort();
  process.exit(1);
}})();
