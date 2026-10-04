# Production image cleanup

These are future operator procedures. Local tests used synthetic transports;
no Scheduler, Lambda invocation, S3 deletion or production data change occurred.
The application root owns the schedule, its scoped invocation policy and alarms.

## Daily schedule and manual execution

Scheduler targets only the cleanup **production alias**, at `cron(0 3 * * ? *)`,
03:00 UTC daily, flexible window OFF. It starts DISABLED. Publish only after
migration verification and then enable through a reviewed application deployment.
A disabled schedule does not cancel accepted events or running invocations.
Before real manual work, confirm the exact account, region, function alias, data
publication gate, approved release versions and operator's invocation permission.
Use short-lived operator credentials in their normal private provider chain;
no secrets, payload, output or environment dump goes to Git/public artifacts.

For an explicitly authorized manual invocation, AWS CLI v2 can use a private
output file and synchronous RequestResponse against the production alias:

```sh
AWS_MAX_ATTEMPTS=1 aws lambda invoke \
  --region <explicit-region> \
  --function-name <cleanup-function-name> --qualifier production \
  --invocation-type RequestResponse --cli-binary-format raw-in-base64-out \
  --cli-read-timeout 700 \
  --payload '{}' /private/cleanup-result.json
```

This example is documentation only and has not been executed. `AWS_MAX_ATTEMPTS=1`
disables automatic CLI transport retries. RequestResponse has no Lambda async
retry behavior. Inspect invocation metadata and FunctionError plus the private
result; HTTP/CLI success alone does not establish completed cleanup. A timeout
or disconnect may have an unknown outcome: inspect safe logs/metrics and durable
job state before an explicit operator retry. Do not repeatedly invoke blindly.
No maintenance workflow or generic management CLI is provided.

[Official Lambda invoke reference](https://docs.aws.amazon.com/cli/latest/reference/lambda/invoke.html)
and [CLI retry configuration](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-retries.html)
were checked through Context7 on 2026-10-05. For production, set client timeout
long enough for the possible 660-second Lambda invocation rather than treating
an early local timeout as definitive server failure.

## Delivery, invocation and processing retries

Scheduler delivery retries **2 times**, maximum event age **3600 seconds**.
The cleanup alias's Lambda asynchronous invocation retries are separately
**2 times**, maximum event age **3600 seconds**. These limits control different
stages, not an exactly-once guarantee; an accepted event can execute more than
once. Manual RequestResponse does not use either async retry queue, and the
example disables transport retries explicitly.

Inside one execution, AWS SDK clients use one transport attempt. The domain
service permits up to three attempts for bounded reads/claim/complete/delete
reconciliation while budget remains. Query evaluation is not retried when its
ScannedCount outcome is unknown. Delivery retry and these processing attempts
must not be conflated in run notes or cost calculations.

## Budget, remaining work and durable state

Cleanup is 512 MiB, timeout 660 seconds, reserved concurrency 1. Processing stops
at 600 seconds or 60 seconds remaining, 10,000 GSI-evaluated records, or 5,000
delete attempts; it waits for in-flight transports and saves the checkpoint.
Up to four candidate workers share these caps. A returned `incomplete:true`
means work remains and is not by itself a transport failure. Failed dependencies,
checkpoint/metric errors fail the invocation. Retry selection follows actual
outcome and persisted state; missing heartbeat needs investigation.

The sparse `cleanup_by_due` GSI includes pending/retired/deleting jobs only, with
four shards each. Pending and retired become eligible after 24 hours; a deleting
lease is 20 minutes. Committed/done remove both index fields. Strong base-item
reads and conditional leases reconcile stale eventual GSI entries. Round-robin
page cursors are durable; they advance only after a complete candidate page.
On resume, abandoned deleting leases become due, completed work is skipped and
an unfinished page is revisited safely. Do not delete a lease/checkpoint to force
progress. Current HEAD/version/checksum mismatch preserves the object and does
not complete it as deleted; investigate the outstanding job privately.

Cleanup creates S3 delete markers on eligible current keys. It does **not** delete
pinned object versions, committed references, or whole tables. The 60-day
noncurrent lifecycle retains versions for the 35-day PITR recovery window.
After PITR, preserve still-referenced versions as new current objects through
[recovery verification](recovery.md) before eventual expiration. Code rollback,
Scheduler disable and API publication changes do not restore/deallocate data.

## Monitoring

Nine CloudWatch alarms are deployed by configuration, with no SNS/DLQ or alarm
notification recipient. Inspect the console/metrics under the operator's account;
no notification delivery has been live-tested.

| Alarm key | Signal |
| --- | --- |
| gateway_5xx | HTTP API 5xx |
| api_errors | API Lambda Errors |
| api_throttles | API Lambda Throttles |
| api_duration | API Lambda p95 Duration > 2000 ms for two periods |
| cleanup_errors | cleanup Lambda Errors |
| cleanup_async_dropped | cleanup AsyncEventsDropped |
| cleanup_incomplete | custom CleanupIncomplete, hourly Maximum >= 1 |
| scheduler_dropped | Scheduler InvocationDroppedCount by schedule group |
| cleanup_heartbeat | custom CleanupHeartbeat, daily Sum < 1 |

The two custom metrics use namespace ReminderServer and Environment=production.
Heartbeat is emitted after a saved checkpoint with no processing failure. Before
publication, Scheduler is disabled, heartbeat actions disabled and missing data
notBreaching. Reviewed scheduler enablement changes heartbeat missing data to
breaching/actions enabled together; other alarm evaluation continues. Unpublished
cleanup skips work rather than implying a successful heartbeat. Logs contain
request/operation/count/status/duration only, no private IDs/titles/images/tokens.
