#!/bin/bash
input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // ""')

if echo "$command" | grep -qiE '(printenv|^\s*env\s*($|\|)|GH_TOKEN|\.devcontainer/\.env|devcontainer[/\\]\.env)'; then
  printf '{"permissionDecision":"deny","permissionDecisionReason":"機密ファイルへのアクセスは制限されています"}'
  exit 2
fi
