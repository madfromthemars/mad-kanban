#!/usr/bin/env bash
# Publish a new plugin version to the team server. Every connected Obsidian
# picks it up within a few hours (or on restart / "Check for plugin updates").
#
#   scripts/release-plugin.sh 2.1.1
set -euo pipefail

VERSION="${1:?usage: scripts/release-plugin.sh <version, e.g. 2.1.1>}"
HOST="${KANBAN_HOST:-abdulaziz_pensiya@170.168.60.196}"
REMOTE_DIR="${KANBAN_REMOTE_DIR:-kanban-server}"
VAULT_PLUGIN="${KANBAN_VAULT_PLUGIN:-$HOME/Documents/MADHause/.obsidian/plugins/kanban-custom}"

cd "$(dirname "$0")/.."

node -e '
const fs = require("fs");
const v = process.argv[1];
for (const f of ["manifest.json", "package.json"]) {
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  j.version = v;
  fs.writeFileSync(f, JSON.stringify(j, null, f === "manifest.json" ? "\t" : 2) + "\n");
}' "$VERSION"

npm run build >/dev/null

OUT=server/public
mkdir -p "$OUT/plugin"
cp manifest.json main.js styles.css "$OUT/plugin/"
TMP=$(mktemp -d)
mkdir "$TMP/kanban-custom"
cp manifest.json main.js styles.css "$TMP/kanban-custom/"
rm -f "$OUT/kanban-custom.zip"
(cd "$TMP" && COPYFILE_DISABLE=1 zip -qr -X "$OLDPWD/$OUT/kanban-custom.zip" kanban-custom)
rm -rf "$TMP"

ssh "$HOST" "mkdir -p ~/$REMOTE_DIR/public/plugin"
scp -q "$OUT/kanban-custom.zip" "$HOST:$REMOTE_DIR/public/"
scp -q "$OUT/plugin/manifest.json" "$OUT/plugin/main.js" "$OUT/plugin/styles.css" "$HOST:$REMOTE_DIR/public/plugin/"

if [ -d "$VAULT_PLUGIN" ]; then
  cp manifest.json main.js styles.css "$VAULT_PLUGIN/"
fi

echo "published $VERSION"
