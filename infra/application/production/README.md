# Production application handoff

This root owns the HTTP API and default stage, two ZIP Lambda functions and
production aliases, the dedicated cleanup schedule/group, the Scheduler inline
Invoke grant and nine alarms. Bootstrap owns all three runtime roles, trust and
permissions ceilings. Platform owns tables/images/log groups and API/cleanup
inline policies. Do not import roles, attach managed policies or read other root
states. Pass only allowlisted outputs in a private input file.

Normal releases require `operator_api_seed=false`, a nonnull bootstrap
`production_api_id` matching this root's existing API, and the registered
immutable `artifact` object. Map D02 `versionId` to `artifact.version_id` and
`sha256Base64` to `artifact.sha256_base64`; preserve `bucket` and `key` exactly.
D02 registration validates the key/hash encodings; both functions check AWS
`code_sha256` against that digest. Lambda manages reserved `AWS_REGION` itself.
The eight public outputs are `api_base_url`, `api_id`, `api_alias_arn`,
`cleanup_alias_arn`, `api_version`, `cleanup_version`, `release_sha256_base64`
and `scheduler_enabled`.

`scheduler_enabled` defaults to false. Set true only at publication: it enables
both Scheduler and heartbeat missing-data/actions in the same plan. Before
publication the heartbeat uses `notBreaching` and disabled actions; metric
thresholds still exist, so this does not suspend CloudWatch's entire evaluation
engine. No SNS/DLQ or Function URL is created. Runtime source IPs are an optional
list of literal IPv4/IPv6 addresses. `runtime_limits` accepts only the five
loadConfig environment keys and positive safe integer values, at higher or lower
values than the runtime defaults; Terraform converts each to a decimal string.

## Exceptional operator preparation (not performed by local delivery)

The first API must be created from this application's same resource address,
`aws_apigatewayv2_api.production`. This is a separately authorized operator
operation, using operator credentials and the application's own configured S3
backend/state. GHA has no `/apis` root-collection creation grant and cannot seed.

1. Supply **all** required variables from `variables.tf`, even for the target
   operation; targeting does not remove the root's required input contract.
   Use allowlisted platform/bootstrap values. Before the first registered ZIP,
   supply the explicitly **UNUSED seed-only** artifact descriptor below solely
   to satisfy Terraform's required variable validation. Set its bucket to the
   known bootstrap artifact bucket; it identifies no verified/uploaded object:

   ```hcl
   artifact = {
     bucket        = "<BOOTSTRAP_ARTIFACT_BUCKET>"
     key           = "releases/0000000000000000000000000000000000000000000000000000000000000000/reminder-server.zip"
     version_id    = "operator-api-seed-unused"
     sha256_base64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
   }
   ```

   This is neither a RegisteredArtifact nor evidence of a ZIP. The targeted
   API has no Lambda/S3 artifact dependency. Never register, verify, upload,
   HEAD or reuse this descriptor as a normal release artifact.
   Configure the application state key/backend with `backend.hcl.example`.
   Verify the application state has no API and bootstrap's API ID is null. If
   an API already exists, stop and reconcile ownership/state; never seed again,
   replace it, change name/ID, create a second root, or delete state to bypass
   the handoff. Set `operator_api_seed=true`, `production_api_id=null`, and
   `scheduler_enabled=false` in a private operator input file.
2. From the repository root, prepare a private saved plan:

   ```sh
   terraform -chdir=infra/application/production init -backend-config=/private/application-backend.hcl
   terraform -chdir=infra/application/production plan -var-file=/private/operator-inputs.tfvars.json -target=aws_apigatewayv2_api.production -out=/private/operator-api-seed.tfplan
   ```

   Review it privately. Its resource changes must be **only** a create of
   `aws_apigatewayv2_api.production` (no stage, function, role, policy, schedule
   or alarm), with no Lambda or S3 artifact operation. This resource depends only
   on explicit inputs/provider config;
   Lambda's API-ID environment reference points in the opposite direction.
   Targeting is exceptional and must never be used in the normal release path.
3. Only after the separate operator authorization, apply that exact saved plan
   and capture the output privately:

   ```sh
   terraform -chdir=infra/application/production apply /private/operator-api-seed.tfplan
   terraform -chdir=infra/application/production output -raw api_id
   ```

   Pass this ID to bootstrap's explicit `production_api_id` input. Bootstrap's
   operator change grants GHA management only of that API and child ARNs. Keep
   this application's API in its original state/address; do not import or move
   it to bootstrap. Destroy/replacement is protected by `prevent_destroy` on
   both API and default stage.
4. Remove the private seed flag/plan. The normal release inputs must explicitly
   set `operator_api_seed=false` and use bootstrap's now-nonnull matching ID.
   Discard the UNUSED seed-only descriptor. Application preview now builds and
   registers the actual ZIP; normal plans require its verified RegisteredArtifact.
   Lambda preconditions reject a full-root seed. API postconditions reject a
   normal mismatch; variable validation rejects absent/malformed IDs. D06/D07
   must also check a known existing API baseline before planning/applying:
   deny normal API create/delete/replacement and unknown ID outputs, and check
   planned/final IDs against bootstrap. A computed ID postcondition alone can
   be deferred until after creation and is not a replacement for that guard.
   Never silently enable the seed flag or add GHA root-collection permissions.

All commands above are documentation for the separately authorized real
operator operation. Local implementation runs only backend-free init, validate
and mock Terraform tests. Do not execute seed/apply/AWS from the local task.
Keep backend/input/state/plan/artifact manifests and credentials private and out
of Git/logs/public artifacts; D08 supplies the repository ignore/guard contract.
