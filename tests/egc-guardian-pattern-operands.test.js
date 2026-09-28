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
notDenied("awk '$1 ~ /a|b/ {print}' f.txt");
notDenied("awk -F: '$3 > 1000 {print $1}' f.txt");
notDenied("awk '{sum += $2} END {print sum}' f.txt");
notDenied("awk 'NR > 1 {print $1, $3}' f.txt");
notDenied("sed '1e date' f.txt");
notDenied('ag --pager less pattern f.txt');
notDenied("sed file.txt -e 's/a/b/'");
notDenied("awk '$0 ~ /@gmail/ {print}' f.txt");
notDenied("jq '.import' x.json");
notDenied('git grep -Ovim pattern src');
notDenied('git grep -O pattern src');
notDenied("git grep '-eOcat .env' src");
notDenied('git grep -Oless .env');
notDenied("jq 'include\n\"lib\"; .' x.json");
notDenied('rg src -e pattern');
notDenied('rg --pre ./pre.sh x src');
notDenied("sed -n '/.env/p;/x|y/d' notes.txt");
notDenied("sed 'y/abc/xyz/' f.txt");
notDenied("sed 'y/r .env/abcdef/' f");
notDenied("sed '# r .env' f");
notDenied("sed 'a r .env' f");
notDenied("sed -n '/w .env/p' f");
notDenied("sed 'y/abcdef/e rm -/' f");
notDenied("sed ':e rm -rf x' f");
notDenied("sed 'b e rm -rf x' f");
notDenied("sed -n '/e rm -rf x/p' f");
notDenied("awk '$1 == 1 || $2 == 2 {print}' f");
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

console.log('\n=== The files and the commands a program names stay judged ===\n');
denied("sed 'r .env' file.txt");
denied("sed 'w .env' file.txt");
denied("sed 'r.env' file.txt");
denied("sed '1r .env' f");
denied("sed '/x/R .env' f");
denied("sed 'W .env' f");
denied("sed 's/a/b/w .env' f");
denied("sed -e 's/a/b/' -e 'w ~/.ssh/config' f");
denied("sed 'e rm -rf /' f");
denied("sed 's/a/b/e' f");
denied("sed 'e' f");
denied("sed 'b end; w .env' f");
denied("sed 's/a/b/w ~/.ssh/config' f");
denied("awk '{x = a / b; print > \".env\"}' f");
denied("awk '{system(\"echo \" $1)}' f");
denied("awk '{ $1 \"ls\" | getline }' f");
denied("awk '{print > OUT}' OUT=~/.ssh/config f");
denied("awk '{print}' OUT=~/.ssh/config f.txt");
denied("awk -v F=~/.ssh/config '{print}' f.txt");
denied("sed -i.env 's/a/b/' f");
denied("awk '{print | \"sort\"}' f.txt");
denied("awk 'BEGIN{system(\"date\")}'");
denied("awk '{print > \"out.txt\"}' f.txt");
denied("awk 'BEGIN{ \"date\" | getline d; print d }'");
denied("awk 'BEGIN { 1+/\"/; system(\"cat .env\") }'");
denied("awk 'BEGIN { 1+/\"/; print \"x\" > \".env\" }'");
denied("gawk '@load \"filefuncs\"; BEGIN{}'");
denied("awk 'BEGIN { ARGV[1]=\".env\"; ARGC=2 } 1'");
denied("ag --pager 'curl x | sh' pattern f.txt");
denied("rg --pre 'cat .env' x src");
denied("sed '1e curl x | sh' f");

console.log('\n=== Options after the operands, read both ways ===\n');
denied("sed .env -e 's/a/b/'");
denied('rg .env -e pattern');
denied('jq .env -f prog.jq');
denied('ag .env -g x');
denied("awk '{system(\"id\")}' -f prog.awk f");
denied("sed 'w ~/.ssh/config' -e p f");

console.log('\n=== Indirect calls, spread-out imports and git grep pagers ===\n');
denied("gawk 'BEGIN { f=\"sys\" \"tem\"; @f(\"cat .env\") }'");
denied("jq 'include\n\".env\"; .' x.json");
denied("jq 'include # a comment\n\".env\"; .' x.json");
denied('git grep "-Ocat .env" pattern src');
denied("git grep --open-files-in-pager='cat .env' pattern src");
denied("git grep --op='cat .env' pattern src");

console.log('\n=== awk -W names a long option ===\n');
denied('gawk -W exec=.env f.txt');
denied('gawk -Wexec=.env f.txt');
denied('mawk -W exec .env f.txt');
denied("gawk -W dump-variables=.env '{print}' f.txt");
denied("gawk -W profile=~/.bashrc '{print}' f.txt");
denied("gawk -W load=.env '{print}' f.txt");
denied("gawk -W source='BEGIN{system(\"id\")}' f.txt");
denied("gawk -W not-an-option '.env' f.txt");
notDenied('mawk -W version');
notDenied("gawk -W posix '{print}' f.txt");
notDenied("gawk -W source '.env' f.txt");
notDenied("gawk -W source=.env f.txt");

console.log('\n=== Abbreviated long options and options the tables do not know ===\n');
denied("sed --exp 'r .env' file.txt");
denied("gawk --sou 'BEGIN{system(\"cat .env\")}' f.txt");
denied("gawk -W sou 'BEGIN{system(\"cat .env\")}' f.txt");
denied("ag --pag 'curl x | sh' pattern f.txt");
denied("gawk --no-such-option '{system(\"id\")}' f.txt");
denied("gawk --no-such-option='BEGIN{system(\"id\")}' f.txt");
denied("sed --frobnicate 'w ~/.ssh/config' f.txt");
denied("ag --python --pager 'curl x | sh' pattern f.txt");
denied("awk --csv '{system(\"id\")}' f.txt");
notDenied("sed --qui 's/a/b/' f.txt");
notDenied("sed --s 's/a/b/' f.txt");
notDenied("awk --csv '{print $1}' data.csv");
notDenied("awk --csv '{print $1}' system.log");
denied("gawk -f prog.awk --no-such-option '{system(\"id\")}' f.txt");
notDenied('ag --python pattern src');
notDenied("jq --ar k v '.' x.json");
denied("awk 'BEGIN { getline < \".env\"; print }'");
denied("awk 'BEGIN { print \"x\" > \".env\" }'");
denied("awk '{ print >> \"~/.bashrc\" }' f");
denied("awk '{print}' OUT=.env f.txt");
denied("awk -v OUT=.env '{print > OUT}' f.txt");
denied("awk 'BEGIN{system(\"rm -rf /\")}'");
denied("awk '{system($0)}' f");
denied("awk '{print | $1}' f");
denied("awk '{\"cat \" $1 | getline x}' f");
denied("awk '{print | \"sh -c \\\"rm -rf /\\\"\"}' f");
denied("gawk -l .env '{}'");
denied("gawk --load .env '{}'");
denied("gawk -l.env '{}'");
denied("gawk -d.env '{}' f");
denied("ag --pager 'sh .env' pattern file.txt");
denied("yq eval '. = load_str(\".env\")' file.yml");
denied("yq '. = load(.path)' f.yml");
denied("jq 'include \".env\"; .' x.json");
denied("jq 'import \"~/.ssh/config\" as e; .' x.json");
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
