const fs = require('node:fs');
const path = require('node:path');

const BUILD_DIR = path.join(__dirname, '..', 'mcp', 'servers', 'egc-memory', 'build');

async function main() {
  let passed = 0;
  let failed = 0;

  function assert(condition, msg) {
    if (condition) {
      console.log(`  PASS: ${msg}`);
      passed++;
    } else {
      console.log(`  FAIL: ${msg}`);
      failed++;
    }
  }

  // Test 1: Build output exists
  console.log('\n=== Test 1: Build output exists ===');
  assert(fs.existsSync(path.join(BUILD_DIR, 'index.js')), 'build/index.js exists');
  assert(fs.existsSync(path.join(BUILD_DIR, 'sync', 'SyncBackend.js')), 'build/sync/SyncBackend.js exists');
  assert(fs.existsSync(path.join(BUILD_DIR, 'sync', 'GitBackend.js')), 'build/sync/GitBackend.js exists');
  assert(fs.existsSync(path.join(BUILD_DIR, 'sync', 'TeamSync.js')), 'build/sync/TeamSync.js exists');

  // Test 2: Module loading
  console.log('\n=== Test 2: Module loading ===');
  try {
    const { SyncBackend } = require(path.join(BUILD_DIR, 'sync', 'SyncBackend.js'));
    assert(typeof SyncBackend === 'function', 'SyncBackend class loads');
  } catch (e) {
    assert(false, `SyncBackend loads: ${e.message}`);
  }

  try {
    const { GitBackend } = require(path.join(BUILD_DIR, 'sync', 'GitBackend.js'));
    assert(typeof GitBackend === 'function', 'GitBackend class loads');
  } catch (e) {
    assert(false, `GitBackend loads: ${e.message}`);
  }

  try {
    const sync = require(path.join(BUILD_DIR, 'sync', 'TeamSync.js'));
    assert(typeof sync.teamInit === 'function', 'teamInit is function');
    assert(typeof sync.teamSync === 'function', 'teamSync is function');
    assert(typeof sync.teamStatus === 'function', 'teamStatus is function');
    assert(typeof sync.getTeamConfig === 'function', 'getTeamConfig is function');
    assert(typeof sync.writeTeamConfig === 'function', 'writeTeamConfig is function');
  } catch (e) {
    assert(false, `TeamSync exports: ${e.message}`);
  }

  // Test 3: MCP tool definitions in compiled output
  console.log('\n=== Test 3: MCP tool definitions ===');
  const buildIndex = fs.readFileSync(path.join(BUILD_DIR, 'index.js'), 'utf-8');
  assert(buildIndex.includes('team_init'), 'team_init tool definition exists');
  assert(buildIndex.includes('team_sync'), 'team_sync tool definition exists');
  assert(buildIndex.includes('team_status'), 'team_status tool definition exists');
  assert(buildIndex.includes('TeamSync_js_1.teamInit'), 'teamInit() called in switch handler');
  assert(buildIndex.includes('TeamSync_js_1.teamSync'), 'teamSync() called in switch handler');
  assert(buildIndex.includes('TeamSync_js_1.teamStatus'), 'teamStatus() called in switch handler');
  assert(buildIndex.includes('case "team_init"'), 'case team_init in switch');
  assert(buildIndex.includes('case "team_sync"'), 'case team_sync in switch');
  assert(buildIndex.includes('case "team_status"'), 'case team_status in switch');

  // Test 4: Author metadata in state files
  console.log('\n=== Test 4: Author metadata ===');
  assert(buildIndex.includes('author:'), 'author: field in writeStateDoc');
  assert(buildIndex.includes('process.env.USERNAME'), 'USERNAME env var in writeStateDoc');
  assert(buildIndex.includes('process.env.USER'), 'USER env var in writeStateDoc');
  assert(buildIndex.includes('authorName'), 'authorName variable in lesson_save');
  assert(buildIndex.includes(`author`), 'author column in INSERT');

  // Test 5: Migration 9 for author column
  console.log('\n=== Test 5: Database migration ===');
  assert(buildIndex.includes('version = 9'), 'Migration 9 exists');
  assert(buildIndex.includes('ALTER TABLE lessons ADD COLUMN author'), 'ALTER TABLE for author column');

  // Test 6: CLI wiring
  console.log('\n=== Test 6: CLI wiring ===');
  const egcJs = fs.readFileSync(path.join(__dirname, 'egc.js'), 'utf-8');
  assert(egcJs.includes("team:"), 'team entry in COMMANDS object');
  assert(egcJs.includes("'team.js'"), 'team.js script reference');
  assert(egcJs.includes("'team'"), 'team in PRIMARY_COMMANDS');
  assert(egcJs.includes('Team memory sync'), 'team description text');

  // Test 7: team.js CLI script
  console.log('\n=== Test 7: team.js CLI script ===');
  const teamJs = fs.readFileSync(path.join(__dirname, 'team.js'), 'utf-8');
  assert(teamJs.includes('egc team init'), 'init subcommand help text');
  assert(teamJs.includes('egc team sync'), 'sync subcommand help text');
  assert(teamJs.includes('egc team status'), 'status subcommand help text');
  assert(teamJs.includes('directSync'), 'directSync fallback function');
  assert(teamJs.includes('--backend'), '--backend option');
  assert(teamJs.includes('--remote'), '--remote option');
  assert(teamJs.includes('--branch'), '--branch option');
  assert(teamJs.includes('TEAM_CONFIG_PATH'), 'team config path constant');

  // Test 8: Package.json dependency
  console.log('\n=== Test 8: Dependencies ===');
  const pkgJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mcp', 'servers', 'egc-memory', 'package.json'), 'utf-8'));
  assert(pkgJson.dependencies['simple-git'] !== undefined, 'simple-git in dependencies');

  // Summary
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(50)}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(`FATAL: ${e.message}`);
  process.exit(1);
});
