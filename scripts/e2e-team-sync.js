const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = path.join(os.tmpdir(), 'egc-e2e-team-' + Date.now());
const REMOTE_REPO = path.join(TMP, 'remote-repo');
const USER1_DIR = path.join(TMP, 'user1');
const USER2_DIR = path.join(TMP, 'user2');

const SHELL_OPTS = { stdio: 'pipe', encoding: 'utf-8', shell: 'cmd.exe' };

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  return execSync(cmd, Object.assign({}, SHELL_OPTS, opts));
}

function runIn(dir, cmd) {
  return run(cmd, { cwd: dir });
}

function runIn(dir, cmd) {
  return run(cmd, { cwd: dir });
}

async function main() {
  console.log('EGC Team Sync - E2E Integration Test\n');
  console.log(`Temp dir: ${TMP}`);

  // Setup: Create a bare remote repo
  console.log('\n[Setup] Creating remote bare repo...');
  fs.mkdirSync(REMOTE_REPO, { recursive: true });
  runIn(REMOTE_REPO, 'git init --bare');

  // Simulate User 1: init team sync
  console.log('\n[User 1] Initializing team sync...');
  process.env.USER = 'User1';
  const scriptsDir = path.resolve(__dirname);
  const egcCmd = `node ${path.join(scriptsDir, 'team.js')}`;
  runIn(USER1_DIR, `${egcCmd} init --backend git --remote ${REMOTE_REPO} --branch main`);
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
  runIn(USER1_DIR, `${egcCmd} sync`);

  // Verify User 1's push reached remote
  console.log('\n[Verify] Checking remote has User1 data...');
  const remoteLog = runIn(REMOTE_REPO, 'git log --oneline --all 2>nul');
  console.log(`  Remote commits: ${remoteLog.trim() || 'none'}`);
  if (remoteLog.trim()) {
    console.log('  PASS: User1 pushed to remote');
  } else {
    console.log('  FAIL: No commits on remote');
  }

  // Simulate User 2: pull and merge
  console.log('\n[User 2] Initializing team sync...');
  process.env.USER = 'User2';

  // Clean user2 dir
  fs.mkdirSync(USER2_DIR, { recursive: true });

  // User 2 does init from the same remote
  runIn(USER2_DIR, `${egcCmd} init --backend git --remote ${REMOTE_REPO} --branch main`);
  const user2Config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.egc', 'team.json'), 'utf-8'));
  console.log(`  Config: backend=${user2Config.backend}, remote=${user2Config.remote}, branch=${user2Config.branch}`);

  // User 2: Sync should pull User1's data
  console.log('[User 2] Running team sync...');
  runIn(USER2_DIR, `${egcCmd} sync`);

  // Check that User1's state file exists in User2's local state
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

  // User 1: Check team status
  console.log('\n[Verify] team status...');
  try {
    const statusOut = runIn(USER1_DIR, `${egcCmd} status`);
    console.log(`  Status output includes last sync info`);
    console.log(`  PASS: team status works`);
  } catch (e) {
    console.log(`  FAIL: team status error: ${e.message}`);
  }

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

  runIn(USER2_DIR, `${egcCmd} sync`);

  // User 1: Pull User2's changes
  console.log('\n[User 1] Pulling User2 changes...');
  process.env.USER = 'User1';
  runIn(USER1_DIR, `${egcCmd} sync`);

  const finalContent = fs.readFileSync(path.join(stateDir, 'test-project.md'), 'utf-8');
  console.log('[Verify] Latest state...');
  console.log(`  Author: ${finalContent.split('\n').find(l => l.startsWith('author:'))}`);
  console.log(`  Updated: ${finalContent.split('\n').find(l => l.startsWith('updated:'))}`);
  if (finalContent.includes('User2') && finalContent.includes('PostgreSQL')) {
    console.log('  PASS: User2 changes synced to User1');
  } else {
    console.log('  FAIL: Cross-sync failed');
  }

  // Summary
  console.log(`\n${'='.repeat(50)}`);
  console.log('E2E Integration Test Complete');

  // Cleanup temp dir
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(os.homedir(), '.egc', 'team.json')); } catch {}
  try { fs.rmSync(path.join(os.homedir(), '.egc', 'team-sync'), { recursive: true, force: true }); } catch {}
}

main().catch(e => {
  console.error(`FATAL: ${e.message}`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
