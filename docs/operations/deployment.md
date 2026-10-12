# Production delivery

These procedures describe future, separately authorized AWS operations. Local
implementation has not run Actions, created resources, registered a real ZIP,
seeded an API, migrated data or deployed. Bootstrap/operator credentials belong
to the operator's private custody, never repository secrets or workflow inputs.
Production is the only permanent environment.

## Before the first dispatch

Delivery supports **private repositories only**. The authorize job refuses a
public repository, non-main dispatch or a commit outside main before any build,
OIDC or private artifact transfer. This restriction does not change repository
visibility and makes no claim about the current repository's visibility.
Private Actions artifacts are accessible to authorized repository readers;
they are not restricted exclusively to environment reviewers. Restrict repository
read/collaborator access accordingly, retain artifacts for one day, and remove
local review downloads after use. Never make the repository public while private
plans or artifacts remain accessible. Expired review artifacts require a new
preview; the workflow cannot apply from an arbitrary local JSON/upload.

Configure the three environments `production-artifact`, `production-plan` and
`production`, each restricted to the main deployment branch. Use required
reviewers/prevent self-review on `production` when the account plan supports
those protections. The exact AWS OIDC subjects must match these environment
names; set bootstrap's explicit `oidc_subjects.artifact`, `.plan`, `.apply` to
exactly `repo:<repository>:environment:production-artifact`, `repo:<repository>:environment:production-plan`, and `repo:<repository>:environment:production`, respectively. Bootstrap rejects branch/tag subjects, extra roles and collapsed environments. Its example placeholders are not deployment
values. GitHub environment/protection availability varies by repository plan;
verify the available controls before enabling delivery. No workflow can
configure or certify those controls for the operator.

Set repository variables `AWS_REGION`, `AWS_ACCOUNT_ID`, `STATE_BUCKET`,
`ARTIFACT_BUCKET`, `ARTIFACT_ROLE_ARN`, `PLAN_ROLE_ARN`, `APPLY_ROLE_ARN` from
reviewed bootstrap outputs. State bucket identity is fixed to
`<name_prefix>-<account_id>-<region>-state`. Backend keys/encryption/native S3
`use_lockfile` are fixed by each root. Each AWS job assumes only its designated
role using OIDC and checks the expected account; there are no long-lived keys.
The workflow never handles bootstrap apply credentials or expands its API grant.

In `production-plan`, configure private secrets containing JSON objects:

- `PLATFORM_INPUTS_JSON`: all required platform variables from
  `infra/platform/production/terraform.tfvars.example`, with actual reviewed
  origin, full callback/logout URLs, region/account/prefix and bootstrap roles.
- `APPLICATION_INPUTS_JSON`: account, region, prefix, exact origin, bootstrap
  `scheduler_role_arn`, and nonnull bootstrap `production_api_id`. Optional
  `allowed_source_ips` and `runtime_limits` may be included. Platform fields
  are read live and allowlisted into a private input file; supplied duplicates
  must agree. Artifact and seed/scheduler flags are fixed by the release driver.
- `PLATFORM_BASELINE_JSON`: literal JSON `null` only for genuinely first
  protected Cognito creation; thereafter the known platform baseline below.
- `APPLICATION_BASELINE_JSON`: known application baseline after API-only seed;
  it must never be null for normal delivery.

Baseline schema is `{root, apiBaseUrl, apiId, cognitoIssuer, cognitoClientId,
cognitoAuthBaseUrl}`. `root` is `platform` or `application`. Platform can have
null API fields; its Cognito identity/domain must be known after creation.
Application requires every identity/URL known and its API ID equal to bootstrap's
handoff and existing application state. Account, region, origin and redirect
values are explicit; no secret or output is inferred from another account.

## Initial sequence

1. The separately authorized operator creates/bootstrap-reviews the bootstrap
   root with `production_api_id=null`. It owns the three distinct encrypted,
   versioned buckets, boundaries, runtime roles and three scoped OIDC roles.
   Null API ID grants GitHub no HTTP API creation/management access. Configure
   the environments and variables above from its private outputs.
2. Preview `target=platform`, `apply=false`, full immutable commit on main,
   and an explicit null platform baseline. This phase does **not** build or
   register a ZIP. Review and apply through the two-run gate below. Null baseline
   is refused for existing pool/client/domain; it is not a reset or adoption
   bypass. After first apply the driver checks actual state resource identities
   against saved region/domain inputs and validates known outputs, writing
   `post-baseline.json`. Install that known platform baseline before later plans.
   Platform provides API/cleanup policies and log groups before any Lambda deploy.
3. The separately authorized operator seeds **only** the application-owned
   `aws_apigatewayv2_api.production` using the exact
   [API-only seed procedure](../../infra/application/production/README.md).
   All root variables remain required. Before a real ZIP exists, its explicitly
   UNUSED seed-only descriptor has the known bootstrap artifact bucket, a
   64-zero hex release key, `operator-api-seed-unused` version and zero32 Base64.
   It is not a RegisteredArtifact or verified ZIP. Review the targeted saved
   plan: only API creation, no stage/Lambda/S3 artifact operations. Full-root
   seed is rejected, scheduler is disabled, and no GHA seed path exists.
4. Capture the real API ID/URL privately, return the known ID to bootstrap via
   the separately reviewed operator change, and configure the known application
   baseline with platform Cognito identity/domain. Preserve the API in its
   original application state/address. Discard the seed flag/dummy descriptor;
   normal delivery requires `operator_api_seed=false` and an actual immutable ZIP.
5. Preview `target=application`, `apply=false`, `reviewed_run` empty, and
   `scheduler_enabled=false`. This builds/packages once, verifies the generated
   ZIP, runs local tests/static Terraform checks, audits and produces a CycloneDX
   SBOM. Only after validation does the registration role register the ZIP and
   persist its complete manifest/evidence hashes. Planning uses that selected
   S3 key/version/checksum, requires the already-seeded API and can create the
   first `$default` stage. No normal plan can create/replace/delete the API.
6. Review and apply as below. Default `published=false` expects `/readyz=503`;
   the workflow changes no publication data. Migration/publication and Cognito
   console user operations follow their separately approved operator procedures.
   Classic Hosted UI with admin-only IAM-gated password auth still needs real
   AWS login/PKCE/direct-public-auth rejection acceptance; mock checks do not
   establish live compatibility.

## Review and apply

Use GitHub's manual Run workflow UI on `main`, supply a full 40-hex immutable
commit reachable from main, and keep `apply=false` for preview. Checkout uses
that exact commit. There is no PR OIDC, `pull_request_target`, automatic push
deployment, maintenance workflow or user administration workflow.

Review the successful preview's **private** `release-review` artifact before
expiry. Inspect its saved binary via the matching Terraform version and the
`plan.json` derived from that binary, exact `inputs.json`, baseline, root,
registered artifact/evidence (application only), and `request.json` including
scheduler/publication expectations. The public summary exposes only root,
commit, action counts and `review_sha256`, not raw plan/state/input contents.

Every apply uses a second dispatch, even when environment reviewers are
available. Set the same target/commit/inputs and flags, `apply=true`,
`reviewed_run=<successful original preview run ID>`, and
`expected_review_sha256=<reviewed digest>`. The source must be this private
repository's completed successful main manual deployment workflow and must be
marked a preview, not an apply run. Application apply skips build/registration
and reuses the original RegisteredArtifact plus hash-checked audit/SBOM/test
files; HEAD rechecks its pinned S3 version/size/checksum.

That run creates and guards one new saved plan using exactly the reviewed input
bytes and baseline. Only Terraform's root timestamp is excluded from the review
digest. Drift or any other review difference stops delivery, including initial
creation. Unknown IDs can differ between real first-create previews; if the
review digest changes, review a new preview instead of weakening the comparison.
Approve the `production` environment only after reviewing the **current run's**
plan. If required-reviewer controls are unavailable, the mandatory digest plus
successful original preview remains the operator's manual gate; restrict
workflow dispatch and repository/environment configuration rights accordingly.

The apply job consumes **this run's** saved binary with its `needs` dependency.
It restores artifact download permissions to private directory 0700/files 0600,
checks the plan-job custody SHA plus exact private file hashes, current checkout,
root, input bytes, baseline and artifact. It regenerates JSON from the very same
binary for D06 `verifySavedPlan`, then applies that binary with a native state
lock/5-minute lock timeout. It never replans, rebuilds or registers. Private
backend data is derived from bound account/region/prefix, and both roots' fixed
keys are distinct. Production concurrency has `cancel-in-progress=false` across
roots and jobs: a new run cannot cancel an active or awaiting-approval apply.
Pending runs may be superseded by GitHub's concurrency queue; inspect run status
and dispatch a fresh review when necessary. Do not manually cancel an apply.

After apply, verify root-owned identity outputs, including first platform
creation's now-known baseline. Application additionally verifies both production
aliases resolve to the selected published versions and AWS CodeSha256 equals the
registered ZIP digest, then checks status-only GETs: `/healthz=200`, `/readyz=200`
when published or 503 otherwise, and unauthenticated `/v2/reminders=401/403`.
No smoke writes or token/body logging occurs. A success ledger is written only
after all checks and contains commit/root/review/artifact digest, two versions,
API URL and result; no user data. `release-result` stays private for one day.
Partial apply or proof/smoke failure is not success; inspect private outputs/state
under an operator's approved recovery procedure before another release.

## Schedule changes and rollback

To enable cleanup after publication, preview application with the existing
RegisteredArtifact's original preview run selected via `reviewed_run`,
`scheduler_enabled=true` and the correct `published` expectation. An existing
artifact preview skips build/registration but produces a newly reviewed plan for
changed settings. Apply that new preview using its exact digest/flags. The cron
is 03:00 UTC daily with window OFF; enabling it also enables missing-heartbeat
alarm actions. No maintenance workflow toggles publication or edits user data.

Before rolling back code, first preview/review/apply `scheduler_enabled=false`
using the current verified artifact. Wait for in-flight cleanup/invocations to
settle according to the operator recovery procedure. Select the older immutable
ZIP and its original validation evidence/commit (which must remain reachable on
main) from a nonexpired original preview; if custody expired, prepare a fresh
preview rather than uploading an arbitrary manifest. Keep API/Cognito identities,
origin/config and unpublished/published expectation stable, and review the plan.
Apply the reviewed selected version and verify both aliases, hashes and smoke.
Terraform updates API and cleanup production aliases **nonatomically**; a failure
can leave mixed versions. Do not announce rollback complete until both alias
proofs and smoke pass. Disabling Scheduler does not cancel existing invocations.
Code rollback does not restore tables, images or publication state; data/PITR
recovery is a separate authorized operation and never a delivery workflow.

## Dependency evidence

CI uses Node 24.21.0/npm 11.11.1, Python 3.13.16, Terraform 1.16.5 and checked-in
provider 6.67.0 locks. Runtime and complete-development audits report every
severity and fail on unresolved High/Critical; no `continue-on-error` masks them.
The current D07 audit fixed six development transitive dependency findings; the
verified local runtime and all-dependency reports contain zero vulnerabilities.
Dependabot checks npm, Actions and the three Terraform roots weekly; it excludes
Docker and `.devcontainer`. SHA updates require official release/tag provenance
review. Audit results are point-in-time evidence, not a permanent guarantee.

Current docs used for implementation: [GitHub deployment controls](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments),
[artifact access/download](https://docs.github.com/en/actions/how-tos/monitor-workflows/download-workflow-artifacts),
[download action](https://github.com/actions/download-artifact),
[saved Terraform plans](https://developer.hashicorp.com/terraform/tutorials/cli/plan),
[npm audit](https://docs.npmjs.com/cli/v11/commands/npm-audit) and
[npm SBOM](https://docs.npmjs.com/cli/v11/commands/npm-sbom).

## Restored selection and private failure diagnostics

`restored_tables` defaults to `{}` in all roots. Exceptional same-account/region recovery uses one complete reviewed three-name map and the original image bucket, following [recovery cutover](recovery.md). Bootstrap alone changes runtime ceilings; platform verifies read-only restored identities/protections and retains original tables. Application handoff, saved plan, both Lambda environments and post-apply verification bind the selected set. Existing API/Cognito baseline and exact ZIP custody remain required.

On command failure, ordinary logs contain only the phase, exit status and private diagnostic directory. Download the failed private run's `failure-diagnostics-<job>-<run_id>` artifact from its Actions artifacts panel within one day. CI private-repository infrastructure failures use `failure-diagnostics-infra-<run_id>`. Access is limited by private repository read permissions; it is not exclusive to environment reviewers. Keep those readers restricted. Files are restored/created with0700 directory and0600 file permissions locally; remove review downloads after use. No artifact is uploaded for public repositories.

Local `infra:check` failures use `<RUNNER_TEMP or OS temp>/infra-diagnostics`; release commands use `release-diagnostics`. JSON files record phase, exitStatus, signal/errorCode and bounded diagnostics. Each stream retains at most128KiB, at most8 failure files survive, and files older than one day are pruned on subsequent failure. Remove local diagnostics within one day even if no further command runs. Successful output, command arguments and environment are never persisted; plan/show/output stdout is omitted. Common credential assignments are redacted, but diagnostics remain private and must not be pasted into ordinary logs. Failed workflow runs cannot pass the successful-preview provenance check, and diagnostics use a separate path/name from release custody.
