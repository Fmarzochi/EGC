# Preflight: the lint findings your branch adds

`npm run preflight` runs, before you push, the static checks the pull request pipeline applies to the files your branch changes, and reports only the findings the branch adds. `npm run lint` lints the whole tree, so it cannot tell a finding you introduced from one that was already there.

## When to run it

Run it after your last edit and before `git push`, together with the test suite:

```bash
git fetch origin
npm run preflight
```

It compares against the merge base with `origin/main`, so fetch first. To compare against another ref, pass it after `--`:

```bash
npm run preflight -- --base origin/release
```

## What it does

1. It lists the files changed against the merge base: added, copied, modified and renamed `.js`, `.cjs`, `.mjs` and `.ts` files, including files not tracked yet. Anything under a `build/` or `dist/` directory is skipped.
2. It lints each file as it is in your working tree, and the version at the merge base under the same path, so the same configuration applies to both. A file the branch adds has no base version, so all its findings count as new.
3. It compares the two by rule and message counts, never by line. A rule such as cognitive complexity is reported on the function declaration when its body grows, so line numbers move without the finding being new. When a rule fires more often than at the base, the extra occurrences (the last ones in the file) are reported as added.
4. It prints one line per finding, `file:line rule message`: first the findings the branch adds, then the ones already present at the base, as information.
5. It exits with `1` when the branch adds a finding, `0` when it adds none, and `2` when it cannot run (no ESLint, no merge base).

## Which rules run

The script loads the repository's `eslint.config.js` through ESLint's Node API, so the rules live in one place. The first line of the output names the mode that ran:

- `eslint.config.js only`: the rules in the repository configuration.
- `eslint.config.js + eslint-plugin-sonarjs recommended`: the same, plus the recommended rules of `eslint-plugin-sonarjs`, which is close to what the SonarCloud analysis applies. This mode turns on only when the plugin can be resolved, for example after `npm install --no-save eslint-plugin-sonarjs`. The plugin is not a dependency of the repository, so the lighter mode is the default: read the mode line before you trust a clean result.

Type-aware linting is not turned on. If your own configuration enables it with `projectService`, a file the branch adds that no `tsconfig.json` includes is linted through the TypeScript default project instead of failing with a "not found by the project service" parsing error.

## Worktrees

A git worktree needs no `node_modules` of its own. When the worktree has none, the script uses ESLint and the configuration's plugins from the main checkout's `node_modules`, so one `npm ci` in the main checkout serves every worktree.

## What it does not replace

- The test suite: run `node tests/run-all.js` as before.
- The CI lint job and the SonarCloud analysis on the pull request: they still decide. Preflight runs a subset of the SonarCloud rules at best, and only on the files you changed.
- `npm run lint:md` for Markdown and the structure validators under `scripts/ci/`.
- Review: a clean preflight means no new lint findings, not that the change is right.
