#!/usr/bin/env bash
# Publish the current build as a GitHub release, so phones can install and update the
# plugin with BRAT (madfromthemars/mad-kanban). Run after scripts/release-plugin.sh and
# after the version bump is committed and pushed:
#
#   scripts/github-release.sh            # version from manifest.json
#
# Uses the same main.js/styles.css that release-plugin.sh put on the team server, so BRAT
# and the plugin's own updater always install the same build.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p 'require("./manifest.json").version')
REPO="${GITHUB_REPO:-madfromthemars/mad-kanban}"
OUT=server/public/plugin

command -v gh >/dev/null || { echo "gh (GitHub CLI) is not installed" >&2; exit 1; }
for f in manifest.json main.js styles.css; do
  [ -f "$OUT/$f" ] || { echo "missing $OUT/$f: run scripts/release-plugin.sh $VERSION first" >&2; exit 1; }
done
[ "$(node -p "require('./$OUT/manifest.json').version")" = "$VERSION" ] ||
  { echo "$OUT/manifest.json is not $VERSION: run scripts/release-plugin.sh $VERSION first" >&2; exit 1; }

# BRAT reads manifest.json from the default branch, so the bump must be pushed.
git fetch -q origin
if ! git diff --quiet origin/HEAD -- manifest.json; then
  echo "manifest.json $VERSION is not pushed to GitHub yet. Commit and push, then run this again." >&2
  exit 1
fi

NOTES=$(git log -1 --format=%s)
if gh release view "$VERSION" --repo "$REPO" >/dev/null 2>&1; then
  gh release upload "$VERSION" "$OUT/manifest.json" "$OUT/main.js" "$OUT/styles.css" --repo "$REPO" --clobber
  echo "updated GitHub release $VERSION"
else
  gh release create "$VERSION" "$OUT/manifest.json" "$OUT/main.js" "$OUT/styles.css" \
    --repo "$REPO" --title "$VERSION" --notes "$NOTES" --target "$(git rev-parse HEAD)"
  echo "created GitHub release $VERSION"
fi
