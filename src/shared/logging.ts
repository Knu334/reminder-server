export interface SafeLogEvent {
  requestId?: string;
  lambdaRequestId?: string;
  operation?: string;
  status?: number;
  code?: string;
  durationMs?: number;
  evaluated?: number;
  deletes?: number;
  incomplete?: boolean;
}

/** Rebuild the event so accidental bodies, bearer tokens, URLs or AWS errors cannot be logged. */
export function logEvent(event: SafeLogEvent): void {
  const safe: SafeLogEvent = {};
  for (const name of ["requestId", "lambdaRequestId", "operation", "code"] as const) {
    const value = event[name];
    if (typeof value === "string") safe[name] = value;
  }
  for (const name of ["status", "durationMs", "evaluated", "deletes"] as const) {
    const value = event[name];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) safe[name] = value;
  }
  if (typeof event.incomplete === "boolean") safe.incomplete = event.incomplete;
  console.log(JSON.stringify(safe));
}
