#!/usr/bin/env bash
# Usage: ./scripts/release.sh <version>
# Examples: ./scripts/release.sh 1.0.6
#           ./scripts/release.sh 2.0.0-rc.1
set -euo pipefail

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "Usage: ./scripts/release.sh <version>"
  echo "Examples:"
  echo "  ./scripts/release.sh 1.0.6"
  echo "  ./scripts/release.sh 2.0.0-rc.1"
  exit 1
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "Invalid version: $VERSION"
  echo "Expected X.Y.Z or X.Y.Z-prerelease (e.g. 2.0.0-rc.1)"
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ROOT_PACKAGE_JSON="package.json"
ROOT_ZH_CN_README_FILE="README.zh-CN.md"

CURRENT=$(node -p "require('./${ROOT_PACKAGE_JSON}').version")

echo "Bumping $CURRENT -> $VERSION"

dirty=$(git status --porcelain --untracked-files=all 2>/dev/null | grep -v '^??' || true)
if [[ -n "$dirty" ]]; then
  echo "Working tree has uncommitted changes. Commit or stash them first."
  git status --short
  exit 1
fi

update_version() {
  local file="$1"
  if [[ -f "$file" ]]; then
    sed -i "s/\"version\": \"${CURRENT}\"/\"version\": \"${VERSION}\"/g" "$file"
  fi
}

update_latest_release_heading() {
  local file="$1"
  if [[ -f "$file" ]]; then
    sed -i "s/## v${CURRENT}/## v${VERSION}/g" "$file"
    sed -i "s/version ${CURRENT}/version ${VERSION}/g" "$file"
  fi
}

update_version "$ROOT_PACKAGE_JSON"
update_version ".opencode/package.json"
update_version ".gemini-plugin/plugin.json"
update_version ".gemini-plugin/marketplace.json"
update_version ".codex-plugin/plugin.json"
update_version ".agents/plugins/marketplace.json"

sed -i "s/${CURRENT}/${VERSION}/g" VERSION agent.yaml
sed -i "s/EGC_VERSION: \"${CURRENT}\"/EGC_VERSION: \"${VERSION}\"/g" .opencode/plugins/egc-hooks.ts
sed -i "s/Extended Global Context v${CURRENT}/Extended Global Context v${VERSION}/g" .opencode/plugins/egc-hooks.ts

update_latest_release_heading "$ROOT_ZH_CN_README_FILE"

VERSION="${VERSION}" node -e "
const fs = require('fs');
const v = process.env.VERSION;
for (const f of ['package-lock.json', '.opencode/package-lock.json']) {
  if (!fs.existsSync(f)) continue;
  const pkg = JSON.parse(fs.readFileSync(f, 'utf8'));
  pkg.version = v;
  if (pkg.packages && pkg.packages['']) pkg.packages[''].version = v;
  fs.writeFileSync(f, JSON.stringify(pkg, null, 2) + '\n');
}
"

echo "Verifying npm pack payload..."
node tests/scripts/build-opencode.test.js

echo "Running version sync tests..."
node tests/plugin-manifest.test.js

git add \
  "$ROOT_PACKAGE_JSON" package-lock.json VERSION agent.yaml \
  .gemini-plugin/plugin.json .gemini-plugin/marketplace.json \
  .codex-plugin/plugin.json \
  .agents/plugins/marketplace.json \
  .opencode/package.json .opencode/package-lock.json \
  .opencode/plugins/egc-hooks.ts

git commit -m "chore: bump plugin version to $VERSION" --signoff

echo ""
echo "Version bumped to $VERSION and committed."
echo ""
echo "Next steps:"
echo "  1. git push origin HEAD"
echo "  2. Create a PR and wait for CI to pass"
echo "  3. After merge: git checkout main && git pull"
echo "  4. git tag v${VERSION} && git push origin v${VERSION}"
echo "  5. The release.yml CI publishes to npm automatically"
