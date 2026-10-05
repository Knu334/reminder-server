# Acceptance record

Updated 2026-10-06. This separates completed local synthetic verification from
future production acceptance. All19 task gates are complete. The whole-branch
review found five issues; the combined fix wave is underway. Full final local
verification and one scoped independent re-review remain pending.

The table below is **historical pre-fix D08 evidence**. The changed runtime has
not yet received the controller's final build/test/audit pass, so neither the303
count nor the old ZIP digest is current evidence. No inferred315 count is used.

## Local reproducible commands and artifact

Use Node24.21.0/npm11.11.1/Python3.13.16/Terraform1.16.5/AWS provider6.67.0.
Run the exact [README verification block](../../README.md), with build/package
before npm test. `infra:check` performs backend-free validation/schema checks,
mocked Terraform runs across bootstrap/platform/application, and fmt.
It makes no AWS account call. Synthetic tests cover authentication/ownership,
ETag conflict, storage/uncertain writes, cleanup/checkpoints, migration/recovery,
immutable artifact registration, saved plan custody, aliases and workflow gates.
Secret-rule tests use command strings and an isolated Git repository with empty
canaries; only temporary bytes are read in the untracking-preservation test.
No real private data, credential or environment dump was inspected.

| Evidence | Local result |
| --- | --- |
| typecheck / lint | Passed, including repeat after source-read guard correction |
| Node tests | 303/303: runtime157 / operations72 / delivery74 (including8 secret-rule cases), zero failures |
| Python packaging | 3/3 passed |
| Terraform roots/mocks | All3 passed: bootstrap21 / platform10 / application25 =56 mocks, schema/validate/fmt passed |
| runtime/full dependency audit | Fresh D08 both0 at every severity |
| package SHA-256 hex | `b50f7fed609c49b4bcefc86cf6379478dbcd798ddede7c80713c1d533c1ae15a` (fresh D08 local recheck) |
| package SHA-256 Base64 | `tQ9/7WCcSbS878hs9jeUeNvNeY3e3nyAcTwdUzwa4Vo=` |
| compressed / unpacked bytes | 1,386,996 / 8,900,297 (fresh D08 local recheck) |
| S3 key/versionId | Not registered; no actual versionId |
| Lambda CodeSha256 / versions / aliases | Not deployed/live verified |
| .devcontainer baseline253e5e2 | git diff --exit-code passed; unchanged |
| AGENTS link / auxiliary rules | 8/8 focused D08 synthetic tests, AGENTS→CLAUDE resolves |

ZIP contains only dist/*.js, dist/*.js.map and THIRD_PARTY_NOTICES, loads both
handlers on Node24 without repository dependencies, and is not an AWS release
until immutable S3 version/checksum and both Lambda versions/CodeSha are proven.
The same locally measured digest must not be labeled a registered artifact.
Historical D08 CycloneDX1.5 SBOM:157 components,209,092 bytes, SHA-256
`cab45f38cba89ced69c2aee6296cce3ab2d209fde91de509b8f19f9827a0e065`.
Historical D08 npm ci succeeded (157 packages /158 audited), with the existing ESLint9.39
unsupported/deprecated warning. Safe synthetic runtime log noise and the Terraform
target warning remain known; output is not claimed warning-free.
SBOM/audit details and fresh command logs are retained in ignored D08 task report;
no private plan/state/content is a public artifact.

## Production record to complete only after separate authorization

| Field | Current value / required future evidence |
| --- | --- |
| Server immutable commit | Record selected full40 commit and matching main checkout |
| ZIP digest and registration | Record verified SHA/size, S3 bucket/key/versionId, evidence IDs |
| API/cleanup versions | Record both production aliases, published version numbers and actual CodeSha256 |
| Gateway/auth identity | Record reviewed region/API ID/URL, Cognito issuer/client/domain baseline |
| Extension version and ID | Not provided; record installed release/version, exact extension ID and callback/logout URLs |
| Synthetic test IDs | Reserve `acceptance-d08-001` (CRUD/no image), `acceptance-d08-image-001` (original bytes), `acceptance-d08-conflict-001` (ETag). None created live |
| Date / operator / result | UTC time, authorized operator and actual observed result; no passwords/tokens/user content |

A future operator first confirms private-repository access, main/environment/OIDC
subjects and reviewer protection availability as described in [deployment](deployment.md).
Verify bootstrap/platform/operator API-only seed/known ID handoff and application
preview→reviewed digest→apply, saved-binary provenance/custody and both aliases.
No AWS provisioning, real registration, GHA run, seed/apply or status-only live
smoke has been performed in this implementation.

Then the owner performs the [Chrome authentication checks](../chrome-extension-cognito-auth.md)
with the exact extension version: initial console-created user's temporary
password change, code/PKCE/state, classic Hosted UI, OAuth scope, public direct
SRP/password/user/custom auth rejection, 5-minute expiry and single-flight refresh,
30-day refresh lifetime/10-second rotation grace, restart/offline/logout and
invalid callback. **Admin-only IAM-gated flow plus classic Hosted UI compatibility
and direct-public-auth closure need joint live acceptance**; Terraform mocks are
not proof of Cognito behavior. No client repository/product change or real Chrome
login was made here.

Using only authorized synthetic IDs, verify full v2 CRUD and conflict responses,
no cross-owner access, original image checksum/MIME, independent 15-minute signed
URL and no token/URL/body logging. Remove only those test items with latest ETags.
User disable/logout may leave API access for about5minutes and a newly issued
image URL for a further15minutes (maximum about20minutes); cached offline bytes
are separate. Never disable the owner or delete live items in automated smoke.

Finally separately approve migration/publication, daily cleanup/manual sync alias,
alarms, two-alias rollback and a real PITR rehearsal to new tables. Verify all
three tables/counters/jobs/images, preserved current copies before60-day source
version expiration, known console identities/explicit remap, unpublished gate,
controlled table-reference switch and cleanup of temporary resources afterward.
PITR does not restore Cognito credentials; code rollback does not restore data.
No actual migration, publication, image deletion, Cognito operation, PITR or
rollback has been executed. Fees remain budget inputs with no measured bill or
latency. Historical audit/approval material remains historical.
