---
description: Configure package manager preference
agent: egc:build
---

# Setup Package Manager Command

Configure your preferred package manager: $ARGUMENTS

## Your Task

Set up package manager preference for the project or globally.

## Detection Order

1. **Environment variable**: `GEMINI_PACKAGE_MANAGER`
2. **Project config**: `.gemini/package-manager.json`
3. **package.json**: `packageManager` field
4. **Lock file**: Auto-detect from lock files
5. **Global config**: `~/.gemini/package-manager.json`
6. **Fallback**: First available

## Configuration Options

### Option 1: Environment Variable
```bash
export GEMINI_PACKAGE_MANAGER=pnpm
```

### Option 2: Project Config
```bash
# Create .gemini/package-manager.json
echo '{"packageManager": "pnpm"}' > .gemini/package-manager.json
```

### Option 3: package.json
```json
{
  "packageManager": "pnpm@8.0.0"
}
```

### Option 4: Global Config
```bash
# Create ~/.gemini/package-manager.json
echo '{"packageManager": "yarn"}' > ~/.gemini/package-manager.json
```

## Supported Package Managers

| Manager | Lock File | Commands |
|---------|-----------|----------|
| npm | package-lock.json | `npm install`, `npm run` |
| pnpm | pnpm-lock.yaml | `pnpm install`, `pnpm run` |
| yarn | yarn.lock | `yarn install`, `yarn run` |
| bun | bun.lockb | `bun install`, `bun run` |

## Verification

Check current setting:
```bash
node scripts/setup-package-manager.js --detect
```

---

**TIP**: For consistency across team, add `packageManager` field to package.json.
