import { ApiError } from "./errors";
import type { Budget } from "./ports";

function deadlineError(): ApiError { return new ApiError(503, "DEADLINE_EXCEEDED", "Service temporarily unavailable"); }

/** The reserve is excluded from usable time. Consumers must await SDK abort settlement. */
export function createBudget(remainingMs: () => number, reserveMs: number): Budget {
  if (!Number.isFinite(reserveMs) || reserveMs < 0) throw new Error("Invalid deadline reserve");
  const controller = new AbortController();
  const initial = remainingMs() - reserveMs;
  const deadline = Date.now() + Math.max(0, Number.isFinite(initial) ? initial : 0);
  const usableMs = (): number => {
    if (controller.signal.aborted) return 0;
    const current = remainingMs() - reserveMs;
    const value = Math.max(0, Math.min(Number.isFinite(current) ? current : 0, deadline - Date.now()));
    if (value === 0) controller.abort(deadlineError());
    return value;
  };
  const available = usableMs();
  if (available > 0) {
    const timer = setTimeout(() => controller.abort(deadlineError()), Math.min(available, 2_147_483_647));
    timer.unref();
    controller.signal.addEventListener("abort", () => { clearTimeout(timer); }, { once: true });
  }
  return { signal: controller.signal, remainingMs: usableMs };
}

/** Call before every operation/retry, and pass budget.signal to the SDK operation. */
export function requireBudget(budget: Budget): void {
  if (budget.remainingMs() <= 0) throw deadlineError();
  budget.signal.throwIfAborted();
}
