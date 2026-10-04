# Contributor instructions

AGENTS.md is a symlink to this file; preserve the link and edit this shared source.
Read README.md and the relevant operation document before changing the runtime or
release tooling. Production is AWS HTTP API + Node 24 Lambda ZIP + DynamoDB/S3.

## Authorized work and private files

Use synthetic fixtures only. Never open, hash, print or copy real reminders.json,
.env, .env.actions, other private .env files, AWS credentials, private mappings,
Terraform state/plan/private inputs, image backups, or whole environment dumps.
Public .env.example and checked-in *.example files are placeholders, not secrets.
Inspect individually named nonsecret settings only. Do not change .devcontainer.
Do not run AWS operations, real ZIP registration, GHA, seed, deploy, migration,
Cognito user operations, PITR, push/PR/merge without explicit authorization.
Local implementation, documentation, tests and feature commits already approved
for the AWS SDD work do not need renewed approval.

When untracking private files use only `git rm --cached -- .env.actions reminders.json`;
preserve local files and verify filesystem existence only. Byte-preservation
checks belong solely to empty canaries in a temporary Git repository. Review
nonprivate differences with exclusions **before generation**:

```sh
git diff -- . ':!reminders.json' ':!.env.actions'
git diff --cached --check -- . ':!reminders.json' ':!.env.actions'
git diff --cached --stat -- . ':!reminders.json' ':!.env.actions'
git diff --cached --name-status --no-renames -- .env.actions reminders.json
```

Never generate a full diff/stat/show and then filter private paths. Do not rewrite
history or claim untracking removes historical exposure. Stage explicit paths;
never stage generated caches, artifacts or private files. Retain the three ignored
.superpowers SDD ledgers until controller review and Rulings collection finish.

## Verification

Use Node 24.21.0/npm 11.11.1, Python 3.13.16 (uv can install it), Terraform 1.16.5
and pinned AWS provider 6.67.0. In the approved implementation workspace, prefix
**all** npm/npx/Python/preparation commands with
`PATH=/tmp/aws-sdd-tools/node_modules/.bin:/tmp/aws-sdd-tools/bin:$PATH`.
Read tests, write a meaningful failing synthetic case, implement minimally and
verify GREEN. Build and package before the full npm test command because ZIP
checks consume the artifact. Run README's final command list, report exact
counts and warnings, distinguish mock/local evidence from live acceptance.

## Auxiliary command guards

.claude/settings.json includes supported Read denies and a Bash PreToolUse hook;
its public .env.example carve-out uses current gitignore negation semantics.
Codex 0.160.0 and current official docs support the inline hooks table and Bash
matcher, using hookSpecificOutput.permissionDecision=deny with exit 0. The hooks
feature must be enabled and the user must trust non-managed hook definitions.
No trust/config mutation or bypass flag is part of this repository setup.
These scripts inspect command strings only, never execute the input. They reject
obvious private paths/environment dumps but do not parse every shell expression,
resolve aliases/symlinks, cover all tools, or establish an access-control boundary.
Project hook loading varies by harness; synthetic script tests do not prove active
integration in Claude, ChatGPT Work or Codex. Actual environment permissions,
sandbox and session instructions remain authoritative. Hooks require Bash and jq.
Sources checked 2026-10-05: [Claude permissions](https://code.claude.com/docs/en/permissions),
[Claude hooks](https://code.claude.com/docs/en/hooks),
[OpenAI Hooks](https://learn.chatgpt.com/docs/hooks).

<!-- context7 -->
## Current library documentation

Use the `ctx7` CLI to fetch current documentation whenever the user asks about a
library, framework, SDK, API, CLI tool, or cloud service, including API syntax,
configuration, migration, library-specific debugging, setup and CLI usage.
Do not use for refactoring, scripts from scratch, business logic debugging,
code review or general programming concepts. Prefer Context7 over web search.

1. Resolve with `npx ctx7@latest library <name> "<specific single-concept query>"`.
   Use official punctuation (Next.js, Customer.io, Three.js). Select `/org/project`
   by exact match, relevance, snippet count, High/Medium reputation and score.
   Try alternate names/queries if results are unsuitable.
2. Fetch `npx ctx7@latest docs <libraryId> "<specific concept>"`; separate concepts
   unless the question concerns their interaction. Use returned version-specific
   `/org/project/version` for a requested version.
3. Answer from fetched docs. Call library first unless the user supplied a valid
   `/org/project` ID. Run no more than three commands per question.

Run Context7 outside the default sandbox. On DNS/network/fetch failure rerun
outside it instead of retrying inside. Never include keys, credentials, personal
or private data in queries. On quota errors disclose the failure and suggest
`npx ctx7@latest login` or `CONTEXT7_API_KEY` for higher limits; do not silently
fall back to training data. For OpenAI/Codex configuration consult safe installed
code/help/schema first and official OpenAI documentation as fallback.
<!-- context7 -->
