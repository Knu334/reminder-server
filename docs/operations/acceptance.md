# Acceptance record

Updated 2026-10-06. This separates completed local synthetic verification from
future production acceptance. All19 task gates are complete. The whole-branch
review found five issues; the combined fix wave is committed as
`63c1512f75d8cdf687083d71412be522b504efe1`. Controller full final local verification
passed. The ONE scoped independent re-review is complete: all five findings addressed,
no new Critical/Important. One Minor about downloaded diagnostic permissions is explicitly
deferred; see the [final review and controller disposition](../implementation-final-review.md).

The table below records the controller's actual results on that code commit.
Its raw container timestamp is `2026-10-05T19:42:04.110074+00:00`; the document
update date above follows the October6 session date. Historical D08 303-test,
56-mock and ZIP measurements are superseded, not inferred for the changed code.

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
| controller command record | All17 commands exited0 on code `63c1512f75d8cdf687083d71412be522b504efe1` |
| typecheck / lint / build / package / verify:zip | Passed |
| Node tests | 331/331: runtime160 / operations74 / delivery97, zero failures |
| Python packaging | 3/3 passed |
| Terraform roots/mocks | Controller all3 roots/schema/validate/fmt passed; fix-wave covering evidence: bootstrap31 / platform17 / application30 =78 mocks |
| runtime/full dependency audit | Both0 at every severity, including info/low/moderate/high/critical |
| package SHA-256 hex | `e4f5a215942fe8aa4c58f755698564a491cd5a88b13b4810f8c20fdb0d52594c` |
| package SHA-256 Base64 | `5PWiFZQv6KpMWPdVaYVkpJHNWoixO0gQ+MIP2w1SWUw=` |
| compressed / unpacked bytes | 1,387,083 / 8,900,746 |
| S3 key/versionId | Not registered; no actual versionId |
| Lambda CodeSha256 / versions / aliases | Not deployed/live verified |
| .devcontainer baseline253e5e2 | git diff --exit-code passed; unchanged |
| protected-excluded working/staged diff checks | Passed |
| AGENTS link / auxiliary rules | 8/8 focused D08 synthetic tests, AGENTS→CLAUDE resolves |

ZIP contains only dist/*.js, dist/*.js.map and THIRD_PARTY_NOTICES, loads both
handlers on Node24 without repository dependencies, and is not an AWS release
until immutable S3 version/checksum and both Lambda versions/CodeSha are proven.
The same locally measured digest must not be labeled a registered artifact.
Current CycloneDX1.5 SBOM:157 components,209,092 bytes, SHA-256
`c9f10560b1928f6161ec2cd6472060d288be03338d4c9185344b3cd95aa1f5eb`.
Historical D08 npm ci succeeded (157 packages /158 audited), with the existing ESLint9.39
unsupported/deprecated warning. Safe synthetic runtime log noise and the Terraform
target warning remain known; output is not claimed warning-free.
SBOM/audit details and fresh command logs are retained in the ignored delivery
ledger's controller-final-metadata.json, controller-final-verification.json and
controller-final-00.log through controller-final-16.log. The final-fix report holds
the 78-mock covering evidence; earlier D08 reports remain historical.
No private plan/state/content is a public artifact.

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
