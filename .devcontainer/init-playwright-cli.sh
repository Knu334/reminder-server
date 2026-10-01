#!/bin/bash
set -u

CLAUDE_SKILLS_DIR="$HOME/.claude/skills/playwright-cli"
AGENTS_SKILLS_DIR="$HOME/.agents/skills/playwright-cli"

if [ -d "$CLAUDE_SKILLS_DIR" ] && [ -d "$AGENTS_SKILLS_DIR" ]; then
  echo "Playwright CLI skills already installed, skipping"
  exit 0
fi

echo "Installing Playwright CLI skills..."
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--dns-result-order=ipv4first"

if (cd "$HOME" && playwright-cli install --skills claude && playwright-cli install --skills agents); then
  exit 0
fi

if [ -d "$CLAUDE_SKILLS_DIR" ] || [ -d "$AGENTS_SKILLS_DIR" ]; then
  echo "Playwright CLI skills installed"
  exit 0
fi

echo "Playwright CLI skills installation failed; continuing devcontainer startup"
exit 0
