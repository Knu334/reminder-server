# Legacy JSON migration

Migration is an explicit operator action against an isolated, unpublished AWS environment. Ordinary server startup never reads or converts JSON. Run these commands only after separately authorizing the account operation; the implementation and tests use synthetic SDK transports and perform no AWS calls.

1. In the Cognito console, create or inspect each intended user. Record the configured issuer and the user's actual `sub`, including non-UUID subjects. A deleted and recreated username has a different subject: do not reuse the old mapping automatically. The scripts do not create or disable users.
2. Make private copies of the source JSON and original owner mapping. Preserve the originals unchanged. Keep copies, mapping, and target configuration outside source control and public artifacts. Mapping is an array of `{ legacyKey, issuer, sub, ownerId? }`. Every source own-property key must match exactly; special keys and empty owners are supported. Multiple legacy keys may map to one owner only when combined IDs and quotas are valid.
3. Prepare a private target JSON with explicit `accountId`, `region`, `remindersTable`, `ownerStateTable`, `imageJobsTable`, `imagesBucket`, `issuer`, `clientId`, `expectedApiId`, and `expectedStage`. Optional `sourceIps` and `limits` use the runtime configuration names. Limits default to 2 MiB per original item JSON (including `createdAt`), 1 MiB per original image, 1000 items per owner, and 128 MiB owner image bytes. Larger original images require explicitly configured limits; migration never transforms or drops images. The first target must be empty across all three tables, apart from an optional exact unpublished PUBLICATION row. Disable API write traffic and the cleanup schedule through import and verification. Use short-lived AWS credentials in the normal SDK credential provider; never commit credentials.
4. Run a dry-run on the copies. This mode loads no AWS clients and makes no AWS calls:

   ```sh
   npm run migrate:json -- --mode dry-run --source /private/source-copy.json --mapping /private/owner-map.json --config /private/target.json
   ```

5. Select a lowercase UUID once and retain it in the private run notes. Import the validated copies into the unpublished target:

   ```sh
   npm run migrate:json -- --mode import --run-id <uuid> --source /private/source-copy.json --mapping /private/owner-map.json --config /private/target.json
   ```

   Explicit import, verify, and publish modes first compare STS GetCallerIdentity's account with the target account. They do not discover resources by name. Source and mapping hashes are SHA-256 of exact file bytes. The contract hash covers the canonical full effective target configuration, admission settings, normalized date and original-image conventions, and migration image ID/upload/publication/checkpoint algorithm. Changing whitespace in either input, mapping, target resources, account, issuer, limits, or contract means the old run cannot resume. Restore the exact original run inputs, or prepare a separate new empty environment; never mix changed data into an existing run.

6. If the process fails, keep the target unpublished and rerun the identical import command with the same UUID and copies. Checkpoints are stored at `GLOBAL/MIGRATION#<uuid>`. Each item has its own transaction; a checkpoint is saved after each complete item and owner. The run root stores a fixed-size `chunks-v1` progress manifest (`sha256`, `ownerCount`, `itemCount`), with immutable completed-owner/item chunks of at most 64 entries. Failed verification mismatch arrays are chunked the same way, while identity and exactMatch remain on the root. Keys are `GLOBAL/MIGRATION#<uuid>#CHUNK#<kind>#<snapshotSha256>#<index16>`, and each chunk includes its own checksum and run tag. All chunks are strongly read back before the conditional root pointer advances; partial chunks cannot advance a checkpoint. `loadRun` reconstructs and hashes the exact logical arrays, rejecting missing, wrong-run or corrupt chunks. There is no aggregate source item cap or truncation. Old unreferenced same-run chunks may remain after a retry; keep them private with the migration environment. Owner `STORAGE` rows contain exact `itemCount` and `imageBytes`, including zero rows for empty owners. Imported reminders preserve the original ID and normalized `createdAt`, set `updatedAt = createdAt`, `revision = 1`, and persist `migrationRunId` with a pinned image reference.

   Image IDs derive from SHA-256 of the JSON tuple `["reminder-migration-image-v1", runId, ownerPosition, itemPosition]`: the first 128 bits receive UUID v5 and variant bits. Thus every retry uses the same UUID and `images/<ownerId>/<imageId>` key. A run-tagged pending job is saved before upload. HEAD/GET of the existing version and exact original-byte/checksum comparison resolve uncertain uploads. `IfNoneMatch: "*"` protects writes against an extra version; mismatching existing objects abort. No blind rewrite is performed. Reminder, committed job, and owner totals are atomic, so a post-commit timeout is reconciled through strong read-back without double counting.
7. Verify all data:

   ```sh
   npm run migrate:json -- --mode verify --run-id <uuid> --source /private/source-copy.json --mapping /private/owner-map.json --config /private/target.json
   ```

   Verification uses full table pagination with strong reads, validates runtime record shapes, checks every owner/item field and totals, and reads each pinned original image. Missing/extra data, another run, bad jobs, different image metadata/bytes/checksums, or unreadable pages cannot pass. Starting import or verification invalidates previous verification success. Diagnostics contain numeric positions, field names, and fixed reasons, never source keys, titles, URLs, image bytes, or credentials. A mismatch or infrastructure failure exits nonzero and keeps publication false.
8. Publish only after confirming the intended target and verification result:

   ```sh
   npm run migrate:json -- --mode publish --run-id <uuid> --source /private/source-copy.json --mapping /private/owner-map.json --config /private/target.json
   ```

   Publish repeats full verification using the same inputs and records its result before a conditional transaction changes the single `GLOBAL/PUBLICATION` row to true and marks the run published. The transaction requires the same run identity and exact persisted successful verification. It does not enable schedules or deploy anything. If the publication response is uncertain, inspect the exact gate/run state; a confirmed published run rejects import/verify reruns. Do not reset its gate and reimport.
9. Before enabling the cleanup schedule or API write traffic, confirm publication is true for the expected run, empty-owner and nonempty-owner quotas match, image versions are readable, and the target is the intended environment. Confirm PITR retention is 35 days and noncurrent image versions are retained for 60 days using the separately managed infrastructure. Enable the schedule only through a separately approved deployment operation.

Switching back to the old JSON service is possible only before writes begin in the new service. Once new writes start, the old JSON is stale; returning to it requires a separately planned reconciliation/recovery operation. Keep the original source and mapping private for recovery. Administrative writes outside the migration adapter must remain disabled while verifying: strong table scans are paginated reads, not a multi-table snapshot.
