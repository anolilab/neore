/**
 * Non-table exports from the original `sandbox/schema.ts`.
 *
 * The table definitions moved to the generated top-level `lunora/schema.ts`;
 * these types and validators are still referenced by handlers, so they stay here.
 */
export type SandboxSessionStatus = "starting" | "active" | "completed" | "failed" | "terminated" | "warm";

export type SandboxActionType = "shell" | "runCode" | "writeFile" | "readFile" | "deleteFile" | "listDir" | "pty";
