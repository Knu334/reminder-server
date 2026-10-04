#!/usr/bin/env bash
# Auxiliary lexical guard only. Never executes tool_input.command or opens paths.
# jq is required. JSON deny with exit 0 is supported by Claude and Codex PreToolUse.
set -u
deny() {
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Private file or environment dump blocked by repository instructions"}}'
  exit 0
}
command=$(jq -er '.tool_input.command | select(type == "string")') || deny
# Public template filenames and checked-in synthetic fixture paths are readable.
# This is a limited string heuristic, not a shell parser, alias/symlink resolver or sandbox.
if printf '%s' "$command" | jq -Re '
  gsub("[^\\s\\\"\u0027;|]+\\.example(?=[\\s\\\"\u0027;|]|$)"; "PUBLIC_SAMPLE") |
  gsub("tests/fixtures/synthetic/[^\\s\\\"\u0027;|]+"; "SYNTHETIC_FIXTURE") |
  gsub("src/images/[A-Za-z0-9_-]+\\.ts(?=[\\s\\\"\u0027;|]|$)"; "RUNTIME_SOURCE") |
  test("(^|[/\\s\\\"\u0027])\\.env($|[.\\s\\\"\u0027;|])|reminders[^/\\s\\\"\u0027]*\\.json|(^|[/\\s\\\"\u0027])credentials($|[/\\s\\\"\u0027;|])|\\.aws/|\\.terraform/|\\.tfstate|\\.tfplan|\\.tfvars|backend\\.hcl|(^|[/\\s\\\"\u0027])(private|images|backups)/|/proc/[^\\s]*/environ|printenv|(^|[;&|]\\s*)\\s*(env\\s*($|[|;])|set\\s*($|[|;])|export\\s+-p)|process\\.env|os\\.environ"; "i")
' >/dev/null; then deny; fi
exit 0
