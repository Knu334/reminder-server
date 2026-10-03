import type { ActiveReminder, CreateInput } from "../../src/reminders/types";
import type { Budget } from "../../src/shared/ports";

export function validCreate(overrides: Partial<CreateInput> = {}): CreateInput {
  return { id: "reminder-1", url: "https://example.test/reminder", title: "Test reminder", reminderTime: "2026-10-03T00:00:00.000Z", autoOpen: false, webPush: true, hidden: false, thumbnail: null, ...overrides };
}

export function activeReminder(overrides: Partial<ActiveReminder> = {}): ActiveReminder {
  return { ...validCreate(), ownerId: "a".repeat(64), revision: 1, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", thumbnail: null, deleted: false, ...overrides };
}

export function testBudget(): Budget {
  return { signal: new AbortController().signal, remainingMs: () => 10_000 };
}
