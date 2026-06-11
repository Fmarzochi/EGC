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
fnm install --lts
fnm use lts-latest
npm install -g @egchq/egc
```

If you prefer not to change your Node installation, the alternative is to [configure a custom npm global prefix](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally) under your home directory.
