/**
 * Non-table exports from the original `browser/schema.ts`.
 *
 * The table definitions moved to the generated top-level `lunora/schema.ts`;
 * these types and validators are still referenced by handlers, so they stay here.
 */
export type BrowserSessionStatus = "starting" | "active" | "completed" | "failed" | "terminated";

export type BrowserSessionSource = "browserbase" | "extension";
