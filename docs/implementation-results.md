# AWS implementation results

Updated 2026-10-06. The approved 19-task scope is implemented locally on
feature/aws-sdd-implementation. All19 controller task gates are complete. The
whole-branch review identified I1/I2/I3 and M1/M2; their combined fix wave is committed
as `63c1512f75d8cdf687083d71412be522b504efe1` and full final local verification passed.
The ONE scoped independent re-review is complete: all five findings addressed, no new
Critical/Important. N1 (downloaded diagnostic permissions) is a real Minor explicitly deferred;
[final review](implementation-final-review.md) gives its disposition and required local handling.
All52 [controller rulings](implementation-rulings.md) are retained.
This document is local evidence, not production acceptance.
The [historical audit](repository-audit-2026-10-02.md), design and original approval
handoff have not been rewritten. The [resume handoff](superpowers/handoffs/2026-10-03-reminder-server-aws-sdd-resume.md)
now points here instead of directing a future session to restart R02.

2026-10-08追補: F10のログに関する記録は、安全なHTTPエラー、共通logging helper、清掃ログ、Gateway設定の証拠である。
現行APIには、操作の成功・失敗を1呼び出し1件で記録する結果ログがない。
この追加は[独立API結果ログ計画](superpowers/plans/2026-10-08-reminder-server-api-result-logging.md)、正式E2Eは[別の設計・計画](superpowers/specs/2026-10-08-reminder-server-formal-e2e-design.md)として2026-10-08に承認済みで、未実装・未実施である。[実装引き継ぎ](superpowers/handoffs/2026-10-08-reminder-server-formal-e2e-implementation.md)に従い、ログ変更を先に独立実装・検証・レビュー・コミットしてからE2Eを実装する。Gatewayアクセスログの設定保持とFloci HTTP API v2の実配信は区別し、後者は互換性調査へ移した。
以下の過去の成功件数やF10の記録を、新しいAPI結果ログと正式E2Eの検証成功には用いない。

R01–R08 deliver validated contracts/config, authentication and rate/ownership,
item transactions and ETags, image jobs, bounded cleanup and lazy Lambda handlers.
O01–O03 deliver explicit dry-run/import/verify/publish and restored-only verification,
image preservation/owner remap. D01–D08 deliver reproducible standalone ZIP,
immutable S3 registration proof, three Terraform roots, root-specific saved-plan
custody, two-alias proof/status-only smoke, OIDC workflows and these instructions.
Source/types and committed verification/review records are the actual interfaces; plans/audit
capture earlier intent or historical defects.

## Local verification and evidence limits

The final commands/results and measured ZIP are recorded in [acceptance](operations/acceptance.md).
Controller evidence records `verifiedAt=2026-10-05T19:42:04.110074+00:00` for code
`63c1512f75d8cdf687083d71412be522b504efe1`; this raw container timestamp is preserved
separately from this document's October6 update date. All17 verification commands
passed:331/331 Node tests (runtime160 / operations74 / delivery97), Python3/3,
typecheck/lint/build/package/verify and the .devcontainer baseline check.
All three Terraform roots passed; the fix wave's covering evidence records78 mocks
(bootstrap31 / platform17 / application30). Fresh runtime/full audits both report
zero at every severity. Package
checks consume a newly built ZIP, and three Terraform roots run backend-free
schema/validate/mock checks. D07 resolved all six development dependency findings;
current runtime/full audits are reported separately from historical audit16/R08audit7.
Local audit zero is point-in-time evidence, not certification of perpetual safety.

The verified local ZIP digest `e4f5a215942fe8aa4c58f755698564a491cd5a88b13b4810f8c20fdb0d52594c`
is not registered/deployed: no real S3 versionId, Lambda CodeSha256/version/alias,
AWS/GHA execution, Chrome login/extension version, migration, Cognito operation,
PITR, rollback or production smoke was verified. In particular, IAM-only direct-auth
configuration plus classic Hosted UI/code/PKCE requires joint live acceptance.
Private-repository workflow custody depends on restricted repository readers,
configured Environments/OIDC/protection availability and one-day retention.

The real reminders.json/.env.actions were removed only from the index using
`git rm --cached`, then filesystem existence checks confirmed both remained local.
No contents or hashes were read; byte preservation was tested only using empty
canaries in a temporary Git repository. Past Git history remains unchanged.
AGENTS.md remains the existing symlink to newly created CLAUDE.md. Claude Read
rules use documented glob semantics; supported Claude/Codex PreToolUse scripts
return structured deny JSON/exit0. Script tests do not prove actual harness
activation, trust or comprehensive shell/file-tool coverage. Environment permissions
and instructions remain authoritative. All provider/dependency/generated caches,
private inputs/state/plan/images/backups and artifacts are ignored; public samples
and root lockfiles remain reviewable. The quarantined dependency remnant is
ignored under artifacts; it was not opened, staged or claimed physically removed.

## Audit findings (all F01–F32)

“Local implemented” means code/config plus synthetic evidence in the linked files;
AWS-dependent behavior still requires the acceptance procedure. “Architecture
replaced” means the obsolete long-running Docker/Express/TLS path was removed,
not that a production deployment was performed. Explicit exclusions remain open.

| ID | Result/status | Evidence and remaining boundary |
| --- | --- | --- |
| F01 | Local implemented: validate before item save | [contracts](../tests/runtime/contracts.test.ts), [API](../tests/runtime/api.test.ts); strict DTO/unknown fields |
| F02 | Local implemented: item updates and conditional revision | [writes](../tests/runtime/writes.test.ts); no whole-list replacement |
| F03 | Local implemented: own-property/schema handling | [legacy](../tests/operations/legacy.test.ts), [contracts](../tests/runtime/contracts.test.ts); prototype/special synthetic keys |
| F04 | Local implemented: explicit empty-target migration/publication gate | [migration](../tests/operations/migration.test.ts), [reads/rate](../tests/runtime/reads-rate.test.ts); actual first publication unperformed |
| F05 | Local implemented: Cognito issuer/sub ownership/scopes | [boundaries](../tests/runtime/boundaries.test.ts), [API](../tests/runtime/api.test.ts), platform cognito.tf; joint live auth gap retained |
| F06 | Local implemented: auth/rate/gate before bounded body parsing | [API](../tests/runtime/api.test.ts); no real load measurement |
| F07 | Local implemented: no per-request DNS lookup, literal IP allowlist | [boundaries](../tests/runtime/boundaries.test.ts), [config](../src/config.ts) |
| F08 | Local implemented: explicit Chrome origin/Gateway CORS | application gateway.tf/mock, [API](../tests/runtime/api.test.ts); live extension CORS untested |
| F09 | Local implemented: v2 media/DTO/header contract | [API spec](api-v2.md), [contracts](../tests/runtime/contracts.test.ts), [API](../tests/runtime/api.test.ts) |
| F10 | Local implemented: safe structured errors/logs/request IDs | [boundaries](../tests/runtime/boundaries.test.ts), [API](../tests/runtime/api.test.ts), monitoring.tf; bounded private failure diagnostics; live reader restrictions unverified |
| F11 | Architecture replaced: DynamoDB conditional transactions | [writes](../tests/runtime/writes.test.ts), [images](../tests/runtime/images.test.ts); real failure/load acceptance unperformed |
| F12 | Architecture replaced: partitioned item query, bounded pagination | [reads/rate](../tests/runtime/reads-rate.test.ts); no synchronous whole-user file IO or invented performance measurement |
| F13 | Architecture replaced: AWS managed HTTPS endpoint | application gateway.tf; certificate watcher removed; actual TLS endpoint uncreated |
| F14 | Architecture replaced: AWS TLS termination | application gateway.tf; no Certbot intermediate-chain configuration; actual TLS acceptance pending |
| F15 | Architecture replaced: Lambda ZIP/explicit Terraform inputs | [bundle](../tests/delivery/bundle.test.ts), [ZIP checker](../scripts/build/verify-zip.ts); Compose/Caddy production removed |
| F16 | Architecture replaced: finite invocation budgets/cancellation | [cleanup](../tests/runtime/cleanup.test.ts), [boundaries](../tests/runtime/boundaries.test.ts); no persistent HTTP listener shutdown contract |
| F17 | Local implemented: side-effect-free health and dependency/publication readiness | [API](../tests/runtime/api.test.ts), [release smoke](../tests/delivery/release.test.ts) |
| F18 | Architecture replaced: bounded Lambda memory/time/concurrency, scoped IAM | application lambda.tf and [infra tests](../tests/delivery/infra-check.test.ts); live execution/IAM proof pending |
| F19 | Local lock/npm ci and strict ZIP inventory implemented; .devcontainer portion excluded | package-lock.json, [packaging](../tests/packaging/test_package.py); no .devcontainer edits |
| F20 | Local dependency remediation and audits implemented | D07 dependency fixes, audit scripts/current acceptance; historical findings preserved |
| F21 | Local/prod Node24 path implemented; .devcontainer portion excluded | package engines, ci.yml/deploy.yml, lambda.tf; devcontainer Node configuration untouched |
| F22 | Local implemented: esbuild replaces tsup | [bundle](../scripts/build/bundle.ts), [bundle tests](../tests/delivery/bundle.test.ts), esbuild0.28.2 fixed |
| F23 | Local implemented: static/test/package/infra CI gates | [workflow tests](../tests/delivery/workflows.test.ts), ci.yml; no actual GHA run |
| F24 | Local implemented: least default permission/full SHA/OIDC/Dependabot | [workflow tests](../tests/delivery/workflows.test.ts), deploy.yml/.github/dependabot.yml; external protection/account setup pending |
| F25 | Local implemented: typed lint excludes generated outputs/cache | eslint.config.mjs and fresh npm run lint; ESLint9.39 unsupported/deprecated warning retained |
| F26 | Local implemented: strict boundary validation/noUncheckedIndexedAccess | tsconfig.json, [contracts](../tests/runtime/contracts.test.ts), typed lint |
| F27 | Local credential-free build/ZIP/infra mock path implemented; .devcontainer portion excluded | README verification commands, [packaging](../tests/packaging/test_package.py); no auth bootstrap/container architecture change |
| F28 | Excluded/unresolved: development firewall | .devcontainer unchanged against253e5e2; user-managed network work outside scope |
| F29 | Excluded/unresolved: development third-party proxy default | .devcontainer unchanged; no AI-routing/privacy configuration changes or actual-send claim |
| F30 | Local private-file rules/untrack/contributor guidance implemented; .devcontainer portion excluded | [secret-rule tests](../tests/delivery/secret-rules.test.ts), CLAUDE/settings/hooks/.gitignore; auxiliary scope/trust limits, no content read/history rewrite |
| F31 | Local implemented: executable commands/v2/operations/shared instructions | README/CLAUDE/AGENTS link, operation docs, acceptance/resume update; client product adaptation still separate |
| F32 | Local implemented: lazy handlers, minimal bundle/deps, safe diagnosis | [API](../tests/runtime/api.test.ts), [bundle](../tests/delivery/bundle.test.ts), src/api.ts/src/cleanup.ts; known final-review Minors retained |

## Improvements (all B01–B06)

| ID | Result/status | Evidence and remaining boundary |
| --- | --- | --- |
| B01 | Local implemented: authenticated individual update API | [API v2](api-v2.md), runtime API/boundary/write tests; real Chrome/client update and ownership migration pending |
| B02 | Local implemented: revision/opaque ETag/412/428/tombstone contract | [writes](../tests/runtime/writes.test.ts), [API](../tests/runtime/api.test.ts); client conflict UI outside this repository |
| B03 | Local implemented: transaction persistence + explicit importer/recovery | [migration](../tests/operations/migration.test.ts), [recovery](../tests/operations/recovery.test.ts), 3table PITR config; actual data/AWS rehearsal pending |
| B04 | Local implemented: timezone normalization/tombstones and authorized PITR path | [contracts](../tests/runtime/contracts.test.ts), [recovery procedure](operations/recovery.md); no new user-facing undelete endpoint; real PITR unperformed |
| B05 | Architecture replaced: delegate TLS to AWS HTTP API | application gateway.tf and preserved baseline guard; no Caddy/reverse-proxy/real TLS acceptance |
| B06 | Local implemented: maintained explicit esbuild bundle/reproducible ZIP | [bundle](../scripts/build/bundle.ts), [package](../scripts/build/package.py), bundle/Python tests; live artifact registration still pending |

## Completed local review and remaining production acceptance

All19 task gates completed before the whole-branch review. Its five findings were
corrected in one wave; controller full verification passed on the committed code.
The ONE scoped independent re-review confirmed all five addressed and no new
Critical/Important. All52 rulings were collected before cleaning this execution's
three ignored SDD scratch directories; the worktree, branch and artifacts remain.
[Final review](implementation-final-review.md) preserves the independent verdict,
N1's explicit deferral and diagnostic-download handling limits. The original
runbook's automatic mode-restoration claim needs a follow-up correction.
Current measurements above supersede historical D08 303-test/56-mock/ZIP evidence.
Deferred maintenance remains dense conditions, synthetic test logs, ESLint9.39
maintenance and the expected API-only seed target warning. No live acceptance is
claimed. Follow [acceptance](operations/acceptance.md) for the
separately authorized live steps and record actual results/version IDs without
private data. Cost coefficients remain the existing budget inputs, with no
invented durations, billing or platform measurements.

## 2026-10-08 F10追補: API結果ログのローカル検証

API Lambdaの成功・拒否・503を1呼び出し1件で記録する変更を、製品commit `95dfcdf`（`feat: record safe API invocation outcomes`）に追加した。[独立API結果ログ計画](superpowers/plans/2026-10-08-reminder-server-api-result-logging.md)に沿った先行実装であり、上記の「未実装」はこのcommitより前の記録として残す。独立taskレビューで仕様適合と品質Approvedの判定を得た。作業を止める指摘はなく、既存のESLint警告がMinorとして記録された。

初期化を含む最外側のhandlerに共通wrapperを置き、成功・早期応答・入力拒否・依存先失敗・初期化失敗を記録するようにした。cold/warm invocationでも各1件で、HTTP応答と、delegateが投げた例外の同一性を保つ。記録するJSONは512bytes以内で、requestId/lambdaRequestId/operation/status/code/durationMsに限定する。IDは安全なASCII文字で各128文字以内とし、不正IDを省く。operation/codeは固定許可値を使い、正常時はcodeを省く。本文・画像・owner/item ID・生path/query・token・署名URL・例外message/stackを記録しない。既存のlogging helper/consoleを使い、APIからPutLogEventsを呼ぶ処理、新SDK依存、alarm、metric、subscriptionは追加していない。ログ保持30日は変更していない。

今回の試験はNode24.21.0/npm11.11.1/Python3.13.16で行った。以下は今回実行した試験の結果であり、過去の成功件数を使い回していない。

| 検証 | 今回の結果 |
| --- | --- |
| API結果ログ単独 | 22/22。JSONの項目・512bytes上限・ID上限・秘密canary不在、cold/warmと初期化失敗の一回性、ログ失敗時の応答維持、例外の同一性を確認 |
| Node全suite | 359/359（runtime188 / operations74 / delivery97） |
| Python packaging | 3/3 |
| typecheck / lint | 成功 |
| build / package / verify:zip | 成功。全suiteの前にZIPを再生成・検証 |
| runtime / full audit | 両方0 vulnerabilities。今回の時点での結果 |

製品変更前の試験では、既存の未コミットnull-body修正を保持した作業ツリーで337/337（runtime166 / operations74 / delivery97）を確認した。製品変更後の359件には、既存のnull-body回帰6件と今回追加したログ試験22件が含まれる。null-body修正とその既存試験は `95dfcdf` に含めていない。既存API試験では、結果ログの追加によってstdoutにJSON行が増えるため、子process出力を読む2か所で、最終行のJSONを解析するように直した。これらの2か所は同commitに含め、元の未コミット変更を残した。npm ciのESLint9.39.0非推奨・サポート終了警告は残っており、依存更新は行っていない。

今回のinfra:checkはTerraformが見つからず、initを実行できなかった。3rootの検証成功とは数えず、ツール復旧とinfra確認は正式E2E計画Task3に残す。APIログ変更ではTerraformとAWS設定を変更していない。

今回確認したのは合成fixtureとconsole captureによるローカル動作であり、CloudWatchへの実配信は未検証である。API/清掃Lambdaログの実配信は後続の正式E2Eで確認する。Flociリソース作成、実AWS、GHA、デプロイ、移行、Cognito操作、PITR、push/PR/mergeは行っていない。過去の331件などの結果、承認済み設計、保持方針はこの追補で書き換えていない。
