#!/usr/bin/env bash
# Same auxiliary lexical check and supported PreToolUse response as Claude.
# Resolve relative to this checked-in script; never inspect credentials or user config.
set -u
script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd) || exit 1
exec bash "$script_directory/../../.claude/hooks/check-bash-command.sh"
