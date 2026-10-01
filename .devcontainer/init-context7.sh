#!/bin/zsh
set -e

if [ -z "$CONTEXT7_API_KEY" ]; then
  echo "CONTEXT7_API_KEY not set, skipping context7 setup"
  exit 0
fi
if [ -d "$HOME/.claude/skills/find-docs" ] && [ -d "$HOME/.agents/skills/find-docs" ]; then
  echo "context7 already installed, skipping"
  exit 0
fi

echo "Installing context7 CLI + Skills..."
ctx7 setup --claude --cli --api-key "$CONTEXT7_API_KEY" --yes
ctx7 setup --codex --cli --api-key "$CONTEXT7_API_KEY" --yes
