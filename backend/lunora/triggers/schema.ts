/**
 * Non-table exports from the original `triggers/schema.ts`.
 *
 * The table definitions moved to the generated top-level `lunora/schema.ts`;
 * these types and validators are still referenced by handlers, so they stay here.
 */
export type TriggerType = "schedule" | "webhook" | "event";

export type TriggerExecutionStatus = "running" | "completed" | "failed";
