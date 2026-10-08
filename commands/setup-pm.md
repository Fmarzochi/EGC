---
description: Configure your preferred package manager (npm/pnpm/yarn/bun)
disable-model-invocation: true
---

# Package Manager Setup

Configure your preferred package manager for this project or globally.

## Usage

```bash
# Detect current package manager
node scripts/setup-package-manager.js --detect

# Set global preference
node scripts/setup-package-manager.js --global pnpm

# Set project preference
node scripts/setup-package-manager.js --project bun

# List available package managers
node scripts/setup-package-manager.js --list
```

## Detection Priority

When determining which package manager to use, the following order is checked:

1. **Environment variable**: `EGC_PACKAGE_MANAGER` (the old `GEMINI_PACKAGE_MANAGER` still counts)
2. **Project config**: `.egc/package-manager.json` (an old `.gemini/package-manager.json` is still read)
3. **package.json**: `packageManager` field
4. **Lock file**: Presence of package-lock.json, yarn.lock, pnpm-lock.yaml, or bun.lockb
5. **Global config**: `package-manager.json` in the EGC directory of the active tool (or in the directory `EGC_DIR` names when it is set)
6. **Fallback**: First available package manager (pnpm > bun > yarn > npm)

## Configuration Files

### Global Configuration
```json
// <EGC directory>/package-manager.json
{
  "packageManager": "pnpm"
}
```

### Project Configuration
```json
// .egc/package-manager.json
{
  "packageManager": "bun"
}
```

### package.json
```json
{
  "packageManager": "pnpm@8.6.0"
}
```

## Environment Variable

Set `EGC_PACKAGE_MANAGER` to override all other detection methods (the old `GEMINI_PACKAGE_MANAGER` still works):

```bash
# Windows (PowerShell)
$env:EGC_PACKAGE_MANAGER = "pnpm"

# macOS/Linux
export EGC_PACKAGE_MANAGER=pnpm
```

## Run the Detection

To see current package manager detection results, run:

```bash
node scripts/setup-package-manager.js --detect
```
