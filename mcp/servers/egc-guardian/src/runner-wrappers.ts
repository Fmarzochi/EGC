import type { WrapperSpec } from './validator.js';

// Package and environment runners that run the command after their options:
// the Node runners (npx, npm exec, pnpm exec and dlx, yarn exec, dlx and
// node, bunx, bun x) and the Python ones (uv run, uv tool run, uvx, poetry,
// pipenv, pdm, rye, hatch, conda, mamba, micromamba and pipx run). A runner
// with `subcommands` runs a command only after one of them, and reads its
// options again after it; a subcommand in `keepsSubcommand` is the command
// itself (`yarn node -e` runs node). `shellFlags` hand the command to a
// shell as one string, which is judged as such.
export interface RunnerSpec extends WrapperSpec {
  subcommands?: string[][];
  keepsSubcommand?: string[];
  shellFlags?: Set<string>;
}

const set = (values: string[]): Set<string> => new Set(values);

// npx reads -p as --package; npm reads it as --parseable, which takes no value.
const NPM_VALUES = ['--package', '-c', '--call', '-w', '--workspace', '--prefix', '--registry', '--cache', '--userconfig'];
const NPX_VALUES = ['-p', ...NPM_VALUES];
const PNPM_VALUES = ['-C', '--dir', '--filter', '-F', '--workspace-dir', '--package', '--reporter', '--resume-from', '--loglevel'];
const UV_VALUES = [
  '--from', '--with', '--with-editable', '--with-requirements', '-p', '--python', '--directory', '--project', '--package',
  '--extra', '--group', '--only-group', '--no-group', '--env-file', '--index', '--index-url', '--default-index',
  '--extra-index-url', '-f', '--find-links', '--config-file', '--cache-dir', '--python-preference', '--color',
  '--index-strategy', '--keyring-provider', '--resolution', '--prerelease', '--exclude-newer', '--link-mode',
  '-P', '--upgrade-package', '--reinstall-package', '-C', '--config-setting', '--allow-insecure-host', '--no-extra',
  '--python-platform', '--refresh-package', '--no-binary-package', '--only-binary-package', '--no-build-package',
];
const CONDA_VALUES = ['-n', '--name', '-p', '--prefix', '--cwd'];

export const RUNNER_SPECS: Record<string, RunnerSpec> = {
  npx: { valueFlags: set(NPX_VALUES), shellFlags: set(['-c', '--call']) },
  npm: { valueFlags: set(NPM_VALUES), subcommands: [['exec'], ['x']], shellFlags: set(['-c', '--call']) },
  pnpx: { valueFlags: set(PNPM_VALUES), exactLongFlags: set(['--shell-mode']), shellFlags: set(['-c', '--shell-mode']) },
  pnpm: { valueFlags: set(PNPM_VALUES), exactLongFlags: set(['--shell-mode']), subcommands: [['exec'], ['dlx']], shellFlags: set(['-c', '--shell-mode']) },
  yarn: {
    valueFlags: set(['--cwd', '-p', '--package', '--cache-folder', '--modules-folder', '--mutex', '--registry']),
    subcommands: [['exec'], ['dlx'], ['node']],
    keepsSubcommand: ['node'],
  },
  bunx: { valueFlags: set(['-p', '--package']) },
  bun: { valueFlags: set(['--cwd', '-c', '--config', '--env-file', '-p', '--package']), subcommands: [['x']] },
  uvx: { valueFlags: set(UV_VALUES) },
  uv: { valueFlags: set(UV_VALUES), subcommands: [['run'], ['tool', 'run']] },
  poetry: { valueFlags: set(['-C', '--directory', '-P', '--project']), subcommands: [['run']] },
  pipenv: { valueFlags: set(['--python', '--pypi-mirror']), subcommands: [['run']] },
  pdm: { valueFlags: set(['-p', '--project', '-c', '--config', '--venv']), subcommands: [['run']] },
  rye: { valueFlags: set(['--pyproject']), subcommands: [['run']] },
  hatch: { valueFlags: set(['-e', '--env', '-p', '--project', '--data-dir', '--cache-dir', '--config']), subcommands: [['run']] },
  conda: { valueFlags: set(CONDA_VALUES), subcommands: [['run']] },
  mamba: { valueFlags: set(CONDA_VALUES), subcommands: [['run']] },
  micromamba: { valueFlags: set(CONDA_VALUES), subcommands: [['run']] },
  pipx: { valueFlags: set(['--spec', '--python', '--pip-args', '--index-url', '--backend']), subcommands: [['run']] },
};
