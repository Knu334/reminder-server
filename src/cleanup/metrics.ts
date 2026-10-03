import { PutMetricDataCommand, type CloudWatchClient, type MetricDatum } from "@aws-sdk/client-cloudwatch";
import type { CleanupResult } from "../images/types";
import { createBudget, requireBudget } from "../shared/budget";
import { ApiError } from "../shared/errors";
import type { Budget } from "../shared/ports";
import { withCleanupDeadline } from "./budget";

export async function emitCleanupMetrics(result: CleanupResult, heartbeat: boolean, client: CloudWatchClient, budget: Budget = createBudget(() => 5_000, 0)): Promise<void> {
  if (result.skippedUnpublished) return;
  const datum = (MetricName: string, Value: number): MetricDatum => ({ MetricName, Value, Unit: "Count", Dimensions: [{ Name: "Environment", Value: "production" }] });
  const MetricData = [datum("CleanupIncomplete", result.incomplete ? 1 : 0)];
  if (heartbeat) MetricData.push(datum("CleanupHeartbeat", 1));
  try {
    await withCleanupDeadline(budget, () => budget.remainingMs(), async active => {
      for (let attempt = 1; ; attempt++) {
        requireBudget(active);
        try { await client.send(new PutMetricDataCommand({ Namespace: "ReminderServer", MetricData }), { abortSignal: active.signal }); return; }
        catch (error) { if (attempt === 3 || active.remainingMs() === 0) throw error; }
      }
    });
  } catch { throw new ApiError(503, "SERVICE_UNAVAILABLE", "Service temporarily unavailable"); }
}
