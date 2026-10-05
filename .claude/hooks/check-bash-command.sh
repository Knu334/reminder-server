#!/usr/bin/env bash
# Auxiliary lexical guard only. Never executes tool_input.command or opens paths.
# jq is required. JSON deny with exit 0 is supported by Claude and Codex PreToolUse.
set -u
deny() {
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Private file or environment dump blocked by repository instructions"}}'
  exit 0
}
command=$(jq -er '.tool_input.command | select(type == "string")') || deny
# Slurp the complete command: a later harmless line cannot cancel an earlier match.
# Recognize plain/quoted words and ordinary shell separators, but do not evaluate
# substitutions, resolve aliases/symlinks or claim to implement a shell parser.
if printf '%s' "$command" | jq -Rse '
  def words:
    [scan("(?:[^\\s\\\"\u0027;&|<>()]+|\\\"[^\\\"]*\\\"|\u0027[^\u0027]*\u0027)+") |
      gsub("[\\\"\u0027]"; "")];
  def path_words:
    # Also inspect literal path words inside quoted child-command strings.
    words[] | splits("[\\s\u0060{}]+") | select(length > 0);
  def public_path:
    sub("^\\./"; "") as $path |
    ($path | test("^[A-Za-z0-9_./-]+$")) and
    ($path | test("(^|/)\\.\\.?(/|$)") | not) and
    ($path | test("^(?:\\.env\\.example|infra/(?:bootstrap|platform/production|application/production)/(?:backend\\.hcl|terraform\\.tfvars)\\.example|tests/fixtures/synthetic/[A-Za-z0-9_./-]+|src/images/[A-Za-z0-9_-]+\\.ts)$"));
  def assignments_removed:
    if length > 0 and (.[0] | test("^[A-Za-z_][A-Za-z0-9_]*="))
    then .[1:] | assignments_removed else . end;
  def env_words:
    # Preserve quotes while identifying actual redirection operators. Literal
    # angle brackets inside quoted assignments belong to the assignment word.
    [scan("[0-9]*[<>]+|(?:[^\\s\\\"\u0027;&|<>()]+|\\\"[^\\\"]*\\\"|\u0027[^\u0027]*\u0027)+")];
  def redirections_removed:
    if length == 0 then []
    elif (.[0] | test("^[0-9]*[<>]+$")) then .[2:] | redirections_removed
    else [.[0]] + (.[1:] | redirections_removed) end;
  def environment_display:
    # Redirection destinations are not child executables. Only remove quotes
    # after discarding operator/target pairs, then distinguish assignments/child.
    # Unsupported env options stay rejected instead of guessing their syntax.
    env_words | redirections_removed | map(gsub("[\\\"\u0027]"; "")) | assignments_removed |
    if .[0] == "env" then
      .[1:] | assignments_removed | length == 0 or (.[0] | startswith("-"))
    else . == ["set"] or (.[0] == "export" and .[1] == "-p") end;
  . as $command |
  any(path_words;
    (public_path | not) and
    test("(^|/)\\.env($|\\.)|reminders[^/]*\\.json|(^|/)credentials($|/)|\\.aws/|\\.terraform/|\\.tfstate|\\.tfplan|\\.tfvars|backend\\.hcl|(^|/)(private|images|backups)/"; "i")) or
  ($command | test("/proc/[^\\s]*/environ|printenv|process\\.env|os\\.environ"; "i")) or
  any($command | splits("[;&|\\n]"); environment_display)
' >/dev/null; then deny; fi
exit 0
