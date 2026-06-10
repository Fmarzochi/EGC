#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "Usage: ./scripts/release.sh <version>"
  echo "Example: ./scripts/release.sh 1.0.6"
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CURRENT=$(node -p "require('./package.json').version")
echo "Bumping $CURRENT -> $VERSION"

FILES_JSON=(
  package.json
  .opencode/package.json
  .gemini-plugin/plugin.json
  .gemini-plugin/marketplace.json
  .codex-plugin/plugin.json
  .agents/plugins/marketplace.json
)

for f in "${FILES_JSON[@]}"; do
  if [[ -f "$f" ]]; then
    sed -i "s/\"version\": \"${CURRENT}\"/\"version\": \"${VERSION}\"/g" "$f"
  fi
done

sed -i "s/${CURRENT}/${VERSION}/g" VERSION agent.yaml

sed -i "s/EGC_VERSION: \"${CURRENT}\"/EGC_VERSION: \"${VERSION}\"/g" .opencode/plugins/egc-hooks.ts
sed -i "s/Extended Global Context v${CURRENT}/Extended Global Context v${VERSION}/g" .opencode/plugins/egc-hooks.ts

npm install --package-lock-only --silent
sed -i "s/\"version\": \"${CURRENT}\"/\"version\": \"${VERSION}\"/g" .opencode/package-lock.json

echo "Running version sync tests..."
node tests/plugin-manifest.test.js 2>&1 | tail -3

git add \
  package.json package-lock.json VERSION agent.yaml \
  .gemini-plugin/plugin.json .gemini-plugin/marketplace.json \
  .codex-plugin/plugin.json \
  .agents/plugins/marketplace.json \
  .opencode/package.json .opencode/package-lock.json \
  .opencode/plugins/egc-hooks.ts

git commit -m "chore: bump version to ${VERSION}
Signed-off-by: Felipe Marzochi <fmarzochi@gmail.com>"

echo ""
echo "Done. Next steps:"
echo "  1. Create a PR, wait for CI to pass, then merge"
echo "  2. After merge: git checkout main && git pull && git tag v${VERSION} && git push origin v${VERSION}"
echo "  3. The release.yml CI will publish to npm automatically"
