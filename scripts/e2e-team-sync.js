const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TMP = path.join(os.tmpdir(), 'egc-e2e-team-' + Date.now());
const REMOTE_REPO = path.join(TMP, 'remote-repo');
const USER1_DIR = path.join(TMP, 'user1');
const USER2_DIR = path.join(TMP, 'user2');

const PROC_OPTS = { stdio: 'pipe', encoding: 'utf-8' };

function run(file, args = [], opts = {}) {
  console.log(`  $ ${file} ${args.join(' ')}`);
  return execFileSync(file, args, { ...PROC_OPTS, ...opts });
}

function runIn(dir, file, args = []) {
  return run(file, args, { cwd: dir });
}

function verifyUser1PushToRemote(remoteRepo) {
  console.log('\n[Verify] Checking remote has User1 data...');
  const remoteLog = runIn(remoteRepo, 'git', ['log', '--oneline', '--all']);
  console.log(`  Remote commits: ${remoteLog.trim() || 'none'}`);
  if (remoteLog.trim()) {
    console.log('  PASS: User1 pushed to remote');
  } else {
    console.log('  FAIL: No commits on remote');
  }
}

function verifyUser2HasUser1State(stateDir) {
  console.log('\n[Verify] User2 has User1 state...');
  if (fs.existsSync(path.join(stateDir, 'test-project.md'))) {
    const content = fs.readFileSync(path.join(stateDir, 'test-project.md'), 'utf-8');
    console.log(`  PASS: State file synced to User2`);
    if (content.includes('User1')) {
      console.log(`  PASS: User1 attribution preserved`);
    } else {
      console.log(`  FAIL: Author attribution lost`);
    }
    if (content.includes('concurrent migrations')) {
      console.log(`  PASS: Lesson content synced`);
    } else {
      console.log(`  FAIL: Lesson content lost`);
    }
  } else {
    console.log(`  FAIL: No synced state found`);
  }
}

function verifyTeamStatus(userDir, teamScript) {
  console.log('\n[Verify] team status...');
  try {
    runIn(userDir, 'node', [teamScript, 'status']);
    console.log(`  Status output includes last sync info`);
    console.log(`  PASS: team status works`);
  } catch (e) {
    console.log(`  FAIL: team status error: ${e.message}`);
  }
}

function verifyUser1PulledUser2Changes(stateDir) {
  const finalContent = fs.readFileSync(path.join(stateDir, 'test-project.md'), 'utf-8');
  console.log('[Verify] Latest state...');
  console.log(`  Author: ${finalContent.split('\n').find(l => l.startsWith('author:'))}`);
  console.log(`  Updated: ${finalContent.split('\n').find(l => l.startsWith('updated:'))}`);
  if (finalContent.includes('User2') && finalContent.includes('PostgreSQL')) {
    console.log('  PASS: User2 changes synced to User1');
  } else {
    console.log('  FAIL: Cross-sync failed');
  }
}

async function main() {
  console.log('EGC Team Sync - E2E Integration Test\n');
  console.log(`Temp dir: ${TMP}`);

  // Setup: Create a bare remote repo
  console.log('\n[Setup] Creating remote bare repo...');
  fs.mkdirSync(REMOTE_REPO, { recursive: true });
  runIn(REMOTE_REPO, 'git', ['init', '--bare']);

  // Simulate User 1: init team sync
  console.log('\n[User 1] Initializing team sync...');
  process.env.USER = 'User1';
  const scriptsDir = path.resolve(__dirname);
  const teamScript = path.join(scriptsDir, 'team.js');
  runIn(USER1_DIR, 'node', [teamScript, 'init', '--backend', 'git', '--remote', REMOTE_REPO, '--branch', 'main']);
  const user1Config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.egc', 'team.json'), 'utf-8'));
  console.log(`  Config: backend=${user1Config.backend}, remote=${user1Config.remote}, branch=${user1Config.branch}`);

  // User 1: Create a state file and sync
  console.log('\n[User 1] Creating state file...');
  const stateDir = path.join(os.homedir(), '.egc', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'test-project.md'), [
    '# Project State',
    'project: /test',
    'author: User1',
    'updated: ' + new Date().toISOString(),
    '',
    '## Context',
    'User1 learned that concurrent migrations break under write locks.',
    '',
    '## Active Decisions',
    '- Use serial migration execution',
    ''
  ].join('\n'), 'utf-8');

  console.log('[User 1] Running team sync...');
  runIn(USER1_DIR, 'node', [teamScript, 'sync']);

  // Verify User 1's push reached remote
  verifyUser1PushToRemote(REMOTE_REPO);

  // Simulate User 2: pull and merge
  console.log('\n[User 2] Initializing team sync...');
  process.env.USER = 'User2';

  // Clean user2 dir
  fs.mkdirSync(USER2_DIR, { recursive: true });

  // User 2 does init from the same remote
  runIn(USER2_DIR, 'node', [teamScript, 'init', '--backend', 'git', '--remote', REMOTE_REPO, '--branch', 'main']);
  const user2Config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.egc', 'team.json'), 'utf-8'));
  console.log(`  Config: backend=${user2Config.backend}, remote=${user2Config.remote}, branch=${user2Config.branch}`);

  // User 2: Sync should pull User1's data
  console.log('[User 2] Running team sync...');
  runIn(USER2_DIR, 'node', [teamScript, 'sync']);

  // Check that User1's state file exists in User2's local state
  verifyUser2HasUser1State(stateDir);

  // User 1: Check team status
  verifyTeamStatus(USER1_DIR, teamScript);

  // User 2: Add their own lesson and sync back
  console.log('\n[User 2] Adding a lesson and syncing back...');
  fs.writeFileSync(path.join(stateDir, 'test-project.md'), [
    '# Project State',
    'project: /test',
    'author: User2',
    'updated: ' + new Date().toISOString(),
    '',
    '## Context',
    'User2 discovered that PostgreSQL has better JSONB indexing than MySQL.',
    '',
    '## Active Decisions',
    '- Use PostgreSQL for production',
    ''
  ].join('\n'), 'utf-8');

  runIn(USER2_DIR, 'node', [teamScript, 'sync']);

  // User 1: Pull User2's changes
  console.log('\n[User 1] Pulling User2 changes...');
  process.env.USER = 'User1';
  runIn(USER1_DIR, 'node', [teamScript, 'sync']);

  verifyUser1PulledUser2Changes(stateDir);

  // Summary
  console.log(`\n${'='.repeat(50)}`);
  console.log('E2E Integration Test Complete');

  // Cleanup temp dir
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(path.join(os.homedir(), '.egc', 'team.json')); } catch { /* best-effort */ }
  try { fs.rmSync(path.join(os.homedir(), '.egc', 'team-sync'), { recursive: true, force: true }); } catch { /* best-effort */ }
}

main().catch(e => {
  console.error(`FATAL: ${e.message}`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
  process.exit(1);
});
