import { requireBudget } from "../shared/budget";
import type { Budget } from "../shared/ports";

/** Await transport settlement; cancellation never races an operation into the background. */
export async function withCleanupDeadline<T>(outer: Budget, availableMs: () => number, operation: (budget: Budget) => Promise<T>): Promise<T> {
  requireBudget(outer);
  const controller = new AbortController();
  const initial = Math.max(0, Math.min(5_000, availableMs(), outer.remainingMs()));
  const deadline = Date.now() + initial;
  const abort = (): void => { controller.abort(); };
  outer.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, initial); timer.unref();
  const budget: Budget = { signal: controller.signal, remainingMs() {
    const remaining = Math.max(0, Math.min(deadline - Date.now(), availableMs(), outer.remainingMs()));
    if (remaining === 0 || outer.signal.aborted) abort();
    return controller.signal.aborted ? 0 : remaining;
  } };
  try { requireBudget(budget); return await operation(budget); }
  finally { clearTimeout(timer); outer.signal.removeEventListener("abort", abort); }
}
