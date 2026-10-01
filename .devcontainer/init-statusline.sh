#!/bin/bash
set -e

SCRIPT_SRC="/usr/local/lib/claude-statusline.sh"
SCRIPT_DST="$HOME/.claude/statusline.sh"
SETTINGS="$HOME/.claude/settings.json"

cp "$SCRIPT_SRC" "$SCRIPT_DST"

[ -f "$SETTINGS" ] || echo '{}' >"$SETTINGS"

tmp=$(jq '. + {"statusLine": {"type": "command", "command": "cat | bash ~/.claude/statusline.sh"}}' "$SETTINGS")
echo "$tmp" >"$SETTINGS"
