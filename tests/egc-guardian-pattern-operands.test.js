'use strict';
/**
 * A program, a pattern, a filter or a message a command is handed is text,
 * not a file: sed's script, awk's program, jq's and yq's filter, the pattern
 * of rg, ag and git grep, tr's sets, and the text options of git (a commit
 * message, a log search). A protected name inside one (`.env`,
 * `process.env.X`) is not the file it looks like. The files these commands
 * read stay protected: an operand after the program, a script file (-f), a
 * pathspec, a file jq slurps. An option a command's table does not know
 * leaves every word judged as a path, as before.
 *
 * Run with: node tests/egc-guardian-pattern-operands.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'validator.js');
if (!fs.existsSync(buildPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}
const { validateCommand } = require(buildPath);

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

const hardDenied = v => v.allowed === false && !v.advisory;
const denied = command => run(`${command} is denied`, () => {
  const v = validateCommand(command);
  assert.ok(hardDenied(v), `${command} should be denied, got: ${JSON.stringify(v)}`);
});
const notDenied = command => run(`${command} is not denied`, () => {
  const v = validateCommand(command);
  assert.ok(!hardDenied(v), `${command} should not be denied, got: ${v.reason}`);
});

console.log('\n=== A program, a pattern or a filter is not a file ===\n');
notDenied("sed -i 's/process.env.X/process.env.Y/' file.js");
notDenied('sed -i "s|^const cases = \\[|const cases = process.env.X ? 1 : [|" file.cjs');
notDenied("sed -E 's/process.env.X/y/' f.js");
notDenied("sed -n '/.env/p' notes.txt");
notDenied("sed -i.bak 's/.env/x/' f.js");
notDenied("sed -e 's/a/b/' -e 's/.env/x/' f.js");
notDenied("awk '/.env/' f.txt");
notDenied("gawk '/.env/' f.txt");
notDenied("mawk '/.env/' f.txt");
notDenied("awk -F: '/.env/' f.txt");
notDenied("awk -v x=1 '/.env/' f.txt");
notDenied("awk '{print}' OUT=.env f.txt");
notDenied("jq '.env' config.json");
notDenied('jq .env config.json');
notDenied("jq -r '.env.API_URL' config.json");
notDenied("jq --arg k .env '.[$k]' x.json");
notDenied("jq -n '$ARGS' --args .env");
notDenied("yq '.env' compose.yml");
notDenied("yq e '.env' compose.yml");
notDenied("yq eval '.env' compose.yml");
notDenied("rg '.env' src");
notDenied("rg -n -i '.env' src");
notDenied("rg -e '.env' src");
notDenied("ag '.env' src");
notDenied("tr '.env' 'x'");
notDenied("tr 'x' '.env'");

console.log('\n=== The files these commands read stay protected ===\n');
denied("sed 's/x/y/' .env");
denied("sed -e 's/a/b/' .env");
denied('sed -f .env f.js');
denied('sed --file=.env f.js');
denied('sed -f.env f.js');
denied("jq --arg=k .env '.' x.json");
denied("sed -i 's/a/b/' ~/.ssh/config");
denied("sed --in-place=.bak 's/a/b/' .env");
denied("awk '{print}' .env");
denied('awk -f .env f.txt');
denied("gawk -e '{print}' .env");
denied('jq . .env');
denied('jq -f .env x.json');
denied("jq --slurpfile v .env '.' x.json");
denied("jq --rawfile v ~/.ssh/id_rsa '.' x.json");
denied("yq '.a' .env");
denied('yq --from-file .env x.yml');
denied('rg x .env');
denied('rg -f .env src');
denied('rg -e x ~/.ssh/id_rsa');
denied('ag x .env');
denied("rg --not-a-real-option '.env' src");
denied("rg -Z '.env' src");

console.log('\n=== A git pattern or message is not a file ===\n');
notDenied("git grep '.env'");
notDenied('git grep -n .env -- src');
notDenied('git grep -e .env');
notDenied('git grep -e .env -e x src');
notDenied('git grep -e x -e .env src');
notDenied('git log --grep=.env');
notDenied('git log --grep .env');
notDenied('git log -S .env');
notDenied('git log -S.env');
notDenied("git log -G'.env'");
notDenied('git log --author=.env');
notDenied("git log --format='%s .env'");
notDenied('git commit -m .env');
notDenied("git commit -m 'ignore .env'");
notDenied("git commit --message='docs: .env example'");
notDenied("git tag -a v1 -m '.env'");
notDenied("git merge -m '.env' main");
notDenied("git stash push -m '.env'");
notDenied('git grep -A 3 .env src');
notDenied('git grep --max-count 2 .env src');

console.log('\n=== The files git reads stay protected ===\n');
denied('git grep -f .env');
denied('git grep pattern -- .env');
denied('git grep x .env');
denied('git grep -e x .env');
denied('git show HEAD:.env');
denied('git diff .env');
denied('git commit -F .env');
denied('git log -- .env');
denied('git log -S.env .env');
denied('git log --grep=.env .env');
denied('git commit -Cm .env');
denied('git grep -f pats.txt .env');

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
