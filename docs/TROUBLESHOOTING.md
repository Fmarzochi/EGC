# Troubleshooting

## `EACCES: permission denied` on macOS

**Symptom:** `npm install -g @egchq/egc` fails with:

```
npm error code EACCES
npm error syscall mkdir
npm error path /usr/local/lib/node_modules/@egchq
npm error errno -13
```

**Cause:** Node.js was installed system-wide (via the official installer or Homebrew) and npm cannot write to `/usr/local/lib/node_modules` without root access.

**Fix:** Use a Node version manager so Node lives under your home directory and global installs work without `sudo`.

With [nvm](https://github.com/nvm-sh/nvm):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
# restart your terminal, then:
nvm install --lts
nvm use --lts
npm install -g @egchq/egc
```

With [fnm](https://github.com/Schniz/fnm) (faster):

```bash
brew install fnm
# Add to ~/.zshrc or ~/.bash_profile, then restart your terminal:
eval "$(fnm env --use-on-cd)"
fnm install --lts
fnm use lts-latest
npm install -g @egchq/egc
```

If you prefer not to change your Node installation, the alternative is to [configure a custom npm global prefix](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally) under your home directory.

---

## Node.js version conflict with mise / asdf (multiple Node installations)

**Symptom:** `egc auto-update` fails with a confusing git error, or `egc` reports version issues even though it is already up to date. Common when using [mise](https://mise.jdx.dev) or [asdf](https://asdf-vm.com) with multiple Node versions.

**Cause:** EGC was installed globally under one Node version (e.g. 24), but a project's `.tool-versions` activates a different version (e.g. 20). The two global installs each have their own copy of EGC, and they can disagree about where EGC's files came from.

**Fix:** Keep EGC in a single Node version -- the one that is active outside of any project directory.

```bash
# 1. Check which Node version is your system default
node --version        # outside any project dir

# 2. Remove EGC from the other Node version (replace 20.x.x with the version to clean)
/path/to/mise/installs/node/20.x.x/bin/npm uninstall -g @egchq/egc

# 3. Reinstall from the correct version
npm install -g @egchq/egc@latest
```

With mise, you can also align the project's `.tool-versions` with your global Node to avoid the split:

```bash
# In the project directory, update .tool-versions to match your global Node
echo "nodejs $(node --version | tr -d v)" > .tool-versions
```

**Verification:** After fixing, run `egc doctor` -- it should report no errors.

---

## `EGC requires Node.js 20 or later`

**Symptom:** Running `egc` prints:

```
EGC requires Node.js 20 or later (found: v18.x.x).
Update with:  mise install node@lts  OR  nvm install --lts  OR  https://nodejs.org
```

**Cause:** The active Node.js version is below the minimum required by EGC.

**Fix:** Install or activate Node.js 20 or later:

```bash
# With mise
mise install node@lts
mise use -g node@lts

# With nvm
nvm install --lts
nvm use --lts

# With fnm
fnm install --lts
fnm use lts-latest
```

Then re-run `egc`.
