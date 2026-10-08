---
description: Configure package manager preference
agent: egc:build
---

# Setup Package Manager Command

Configure your preferred package manager: $ARGUMENTS

## Your Task

Set up package manager preference for the project or globally.

## Detection Order

1. **Environment variable**: `EGC_PACKAGE_MANAGER` (the old `GEMINI_PACKAGE_MANAGER` still counts)
2. **Project config**: `.egc/package-manager.json` (an old `.gemini/package-manager.json` is still read)
3. **package.json**: `packageManager` field
4. **Lock file**: Auto-detect from lock files
5. **Global config**: `package-manager.json` in the EGC directory of the active tool (or in the directory `EGC_DIR` names when it is set)
6. **Fallback**: First available

## Configuration Options

### Option 1: Environment Variable
```bash
export EGC_PACKAGE_MANAGER=pnpm
```

### Option 2: Project Config
```bash
# Create .egc/package-manager.json
echo '{"packageManager": "pnpm"}' > .egc/package-manager.json
```

### Option 3: package.json
```json
{
  "packageManager": "pnpm@8.0.0"
}
```

### Option 4: Global Config
Create `package-manager.json` in the EGC directory of the active tool (the directory `EGC_DIR` names when it is set; otherwise the one EGC uses for the tool in session, where its sessions and learned skills live):
```json
{
  "packageManager": "yarn"
}
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
