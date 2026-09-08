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

## `EBUSY: resource busy or locked` during `npm install -g` on Windows

**Symptom:** `npm install -g @egchq/egc@latest` fails while EGC is already installed:

```
npm error code EBUSY
npm error syscall rename
npm error path C:\Users\<you>\AppData\Roaming\npm\node_modules\@egchq\egc\dashboard
npm error errno -4082
npm error EBUSY: resource busy or locked, rename '...\@egchq\egc\dashboard' -> '...\@egchq\.egc-XXXXXXXX\dashboard'
```

**Cause:** npm upgrades a global package by renaming the old package folder aside before unpacking the new one. Windows refuses to rename a folder while any process holds a file inside it. The usual holders are an AI tool that is running the EGC MCP servers (`egc-memory` and `egc-guardian` live inside that package) and a terminal where an EGC hook is running.

**Fix:** close the AI tools and terminals that run EGC, then run the install again:

```powershell
npm install -g @egchq/egc@latest
egc auto-update
egc doctor
```

If the lock does not clear, a reboot releases it. Nothing needs to be uninstalled first: `egc auto-update` reinstalls the new version into every managed target and `egc doctor` confirms the result.

---

## `egc doctor` says some state files are plain text

**Symptom:** the doctor report ends with a `State files` section:

```
State files:
  WARNING: 3 of 41 state files under /home/<you>/.egc/state are plain text:
    /home/<you>/.egc/state/Projetos--demo.md (last write 2026-06-10T05:32:05.652Z)
    ...
```

**Cause:** EGC has encrypted state at rest since 1.1.6, but three kinds of file were left in plain text: files written before that release, files the EGC hooks saved before 1.1.18 (the compaction snapshot and the mined memory were written without encrypting), and files an AI tool wrote straight to disk because it had no `egc-memory` server registered and followed the old protocol text to the path. The memory server reads all of them and encrypts a file the next time it saves it, but a file for a project or branch that is never opened again stays plain, readable by anything running on the machine.

**Fix:** encrypt them in place with the maintenance script. The doctor prints the exact command, with the absolute path of the script inside the installed package, right under the list; on Linux it looks like this:

```bash
node '/usr/lib/node_modules/@egchq/egc/scripts/maintenance/encrypt-plaintext-state.js'
```

Run it as printed: without `--apply` it is a dry run that lists what it would encrypt and writes nothing. Review the list, then run the same command with `--apply` at the end. Each file is encrypted with the same key the server uses, proven to decrypt back in memory before anything is written, rewritten atomically with its integrity sidecar, and read back from disk before it counts; if that read-back or the sidecar fails, the plain content is put back and the file is reported as failed. A file that stopped being a plain regular file in between (already encrypted by the server, replaced by something else) is skipped and reported. Run `egc doctor` again: the section is gone. If a tool wrote one of those files by hand, also run `egc init` in that project so the tool gets the memory server instead of the filesystem.

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
