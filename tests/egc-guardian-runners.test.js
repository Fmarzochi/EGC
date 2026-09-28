'use strict';
/**
 * A command run through a package or environment runner (npx, npm exec,
 * pnpm exec and dlx, yarn exec, dlx and node, bunx, bun x, uv run, uvx,
 * poetry, pipenv, pdm, rye, hatch, conda and pipx run) is judged as the
 * command it is, and code handed to an interpreter the other ways it takes
 * it (PowerShell's -EncodedCommand and abbreviations, php -B/-R/-E, bun -e,
 * deno eval) is inline code.
 *
 * Run with: node tests/egc-guardian-runners.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'validator.js');
if (!fs.existsSync(buildPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}
const { validateCommand, runnerCommandStart } = require(buildPath);
const lib = require('../scripts/lib/wrapper-options');
const { run: hook } = require('../scripts/hooks/pre-bash-guardian-validate');

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

const wipe = ['rm', '-rf', '/'].join(' ');
const hard = command => {
  const v = validateCommand(command);
  return !v.allowed && !v.advisory;
};

console.log('\n=== Runners and the other ways an interpreter takes code ===\n');

run('what a runner runs meets the denial it would meet typed', () => {
  for (const command of [
    `uv run ${wipe}`, `uv --directory x run --with y ${wipe}`, `uv tool run ${wipe}`, `uvx --from x ${wipe}`, `poetry run ${wipe}`,
    `poetry -C dir run ${wipe}`, `pdm run ${wipe}`, `hatch run ${wipe}`, `pipenv run ${wipe}`, `conda run -n base ${wipe}`,
    `mamba run -p /x ${wipe}`, `micromamba run -n x ${wipe}`, `rye run ${wipe}`, `pipx run --spec x ${wipe}`,
    `npm exec -- ${wipe}`, `npm x -- ${wipe}`, `npm --prefix x exec ${wipe}`, `pnpm exec ${wipe}`, `pnpm -C dir exec ${wipe}`,
    `pnpm dlx ${wipe}`, `pnpx ${wipe}`, `yarn exec ${wipe}`, `yarn dlx -p x ${wipe}`, `bun x ${wipe}`, `bunx ${wipe}`,
    `npx ${wipe}`, `npx -y -p x ${wipe}`, `npx.cmd ${wipe}`, `uv run python -c 'x'`, `npx node -e 'x'`, `yarn node -e 'x'`,
    `pnpm exec node --eval 'x'`, `poetry run python3 -c 'x'`,
  ]) {
    assert.ok(hard(command), command);
  }
});

run('a runner that hands its command to a shell as one string is refused', () => {
  for (const command of ["npx -c 'ls'", "npx --call='ls'", "npm exec -c 'ls'", "pnpm exec -c 'ls'", "pnpm dlx --shell-mode 'ls'", "pnpx -c 'ls'"]) {
    const v = validateCommand(command);
    assert.ok(!v.allowed && !v.advisory, command);
    assert.match(v.reason, /runs its value through a shell/, command);
  }
});

run('a runner of something harmless keeps its standing, and one that runs no command stays as it was', () => {
  for (const command of ['npx tsc', 'npx tsc --noEmit', 'npm exec -- tsc', 'npx prettier --check .']) {
    const v = validateCommand(command);
    assert.strictEqual(v.allowed, true, `${command}: ${v.reason}`);
  }
  for (const command of ['pnpm exec tsc', 'uv run pytest', 'poetry run pytest -x', 'npx prettier --check .', 'yarn test', 'pnpm install', 'uv pip install x',
    'npm install', 'conda install x', 'pipx install x', 'yarn add x', 'bun install', 'uv sync']) {
    assert.ok(!hard(command), command);
  }
});

run('PowerShell code given by any spelling of -Command, -EncodedCommand or -CommandWithArgs is inline code', () => {
  for (const command of [
    'pwsh -EncodedCommand ZQA=', 'pwsh -enc ZQA=', 'pwsh -e ZQA=', 'pwsh -ec ZQA=', 'powershell -encodedc ZQA=',
    'pwsh -Command ls', 'pwsh -comm ls', 'pwsh -c ls', 'pwsh --command ls', 'powershell /c ls', 'powershell.exe -Command:ls',
    'pwsh -cwa ls', 'pwsh -CommandWithArgs ls', 'pwsh -NoProfile -NonInteractive -EncodedCommand ZQA=',
  ]) {
    assert.ok(hard(command), command);
  }
  for (const command of ['pwsh -File build.ps1', 'pwsh -ExecutionPolicy Bypass -File x.ps1', 'pwsh -ex Bypass -File x.ps1',
    'pwsh -ConfigurationName x -File y.ps1', 'pwsh -NoProfile -File x.ps1', 'pwsh -Version']) {
    assert.ok(!hard(command), command);
  }
});

run('php, bun and deno code given inline is inline code, and their other options are not', () => {
  for (const command of ["php -B 'x();'", "php -E 'x();'", "php -R 'x();'", "php -r 'x();'", "php -Bx();", "php -nR 'x();'",
    "php --process-begin 'x();'", "php --process-end='x();'", "bun -e 'x'", "bun --eval 'x'", "bun -p 'x'", "deno eval 'x'",
    "deno --quiet eval 'x'", "deno repl --eval 'x'"]) {
    assert.ok(hard(command), command);
  }
  for (const command of ['php -e script.php', 'php -f script.php', 'php -n script.php', 'php -l script.php', 'bun run build',
    'bun test', 'deno run main.ts', 'deno test', 'deno fmt']) {
    assert.ok(!hard(command), command);
  }
});

run('the hooks find a runner\'s command where the validator does, so a script behind one is read', () => {
  for (const line of ['npx -c x', 'npx --call=x', 'pnpm exec -c ls', 'pnpm --shell-mode dlx ls', 'npm exec -- rm', 'uv run --with x rm',
    'uv pip install x', 'yarn node -e x', 'uv tool run ruff', 'npx', 'npm exec', 'conda run -n x -- ls', 'poetry -P p run ls', 'bun x ls', 'npm exec -- -v x']) {
    assert.deepStrictEqual(lib.runnerCommandStart(line.split(' ')), runnerCommandStart(line.split(' ')), line);
  }
  assert.deepStrictEqual(runnerCommandStart('npm exec -- -v x'.split(' ')), { start: 3, shellFlag: null }, 'the command after -- may start with a dash');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-runner-'));
  try {
    fs.writeFileSync(path.join(dir, 'x.sh'), `${wipe}\n`);
    for (const command of ['uv run bash x.sh', 'poetry run sh x.sh', 'npx bash x.sh', 'pnpm exec bash ./x.sh']) {
      assert.strictEqual(hook({ tool_name: 'Bash', tool_input: { command }, cwd: dir }).exitCode, 2, command);
    }
    // A shell, a wrapper or a runner named with its Windows extension or in
    // capitals is the same program, and the script behind it is read.
    for (const command of ['bash.exe x.sh', 'BASH x.sh', 'sh.exe x.sh', 'sudo.exe bash x.sh', 'env.exe bash x.sh', 'nohup.exe bash x.sh',
      "bash.exe -c 'bash x.sh'", 'NPX.CMD bash x.sh', 'Uv run bash x.sh']) {
      assert.strictEqual(hook({ tool_name: 'Bash', tool_input: { command }, cwd: dir }).exitCode, 2, command);
    }
    assert.strictEqual(lib.commandName('/usr/bin/Bash.EXE'), 'bash');
    assert.strictEqual(lib.commandName('C:/Tools/npx.cmd'), 'npx');
    assert.strictEqual(lib.commandName('run.bat'), 'run');
    assert.strictEqual(lib.commandName('tool.exe.bak'), 'tool.exe.bak');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

run('a command is known by its name whatever its case or Windows extension, runners and interpreters included', () => {
  for (const command of [
    wipe.replace('rm', 'rm.exe'), wipe.replace('rm', 'RM.EXE'), wipe.replace('rm', '/usr/bin/rm.exe'), `sudo.exe ${wipe}`, `env.exe ${wipe}`,
    `xargs.exe ${wipe}`, 'git.exe push --force', 'docker.exe system prune -af', `NPX ${wipe}`, `Npx ${wipe}`, `NPM.CMD exec -- ${wipe}`,
    `npx.cmd ${wipe}`, `pnpm.CMD dlx ${wipe}`, `UV run ${wipe}`, "node.exe -e 'x'", "NODE -e 'x'", "python.exe -c 'x'", "bash.exe -c 'x'",
    "pwsh.exe -c 'x'", "deno.exe eval 'x'", "bun.exe -e 'x'", "eval.exe 'x'", 'cat.exe ~/.ssh/id_rsa',
  ]) {
    assert.ok(hard(command), command);
  }
  for (const command of ['npx.cmd tsc --noEmit', 'NPM.CMD exec -- tsc', 'node.exe script.js', 'git.exe status']) {
    assert.ok(!hard(command), command);
  }
  for (const values of [['NPM.CMD', 'exec', '--', 'ls'], ['npx.exe', 'ls'], ['Uvx', 'ls']]) {
    assert.deepStrictEqual(lib.runnerCommandStart(values), runnerCommandStart(values), values.join(' '));
    assert.notStrictEqual(lib.runnerCommandStart(values), null, values.join(' '));
  }
});

run('npm reads -p as --parseable, which takes no value, and npx reads it as --package', () => {
  for (const command of [`npm -p exec -- ${wipe}`, `npm -p x ${wipe}`, `npm exec -p -- ${wipe}`, `npx -p pkg ${wipe}`]) {
    assert.ok(hard(command), command);
  }
  assert.deepStrictEqual(runnerCommandStart(['npm', '-p', 'exec', '--', 'ls']), { start: 4, shellFlag: null });
  assert.deepStrictEqual(runnerCommandStart(['npx', '-p', 'pkg', 'ls']), { start: 3, shellFlag: null });
  assert.ok(!hard('npm -p ls'), 'npm -p ls runs no command');
});

run('deno eval is found past the values of the options before it', () => {
  for (const command of ["deno --config deno.json eval 'x'", "deno -c deno.json eval 'x'", "deno -L debug eval 'x'", "deno --lock l.json --quiet eval 'x'", "deno --cert c.pem eval 'x'"]) {
    assert.ok(hard(command), command);
  }
  for (const command of ['deno --config deno.json run main.ts', 'deno -L debug run eval.ts', 'deno run main.ts eval']) {
    assert.ok(!hard(command), command);
  }
});

run('the runner tables are the same on both sides', () => {
  const validator = require(buildPath);
  const sorted = values => [...(values || [])].sort();
  const table = validator.RUNNER_SPECS;
  assert.deepStrictEqual(Object.keys(lib.RUNNER_SPECS).sort(), Object.keys(table).sort());
  for (const [name, spec] of Object.entries(table)) {
    const mirror = lib.RUNNER_SPECS[name];
    assert.deepStrictEqual(sorted(mirror.valueFlags), sorted(spec.valueFlags), `${name} value options`);
    assert.deepStrictEqual(sorted(mirror.exactLongFlags), sorted(spec.exactLongFlags), `${name} exact names`);
    assert.deepStrictEqual(sorted(mirror.shellFlags), sorted(spec.shellFlags), `${name} shell options`);
    assert.deepStrictEqual(mirror.subcommands, spec.subcommands, `${name} subcommands`);
    assert.deepStrictEqual(mirror.keepsSubcommand, spec.keepsSubcommand, `${name} kept subcommand`);
  }
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
