/**
 * The per-thread permission mode of a cloud thread: how much of the run the owner leaves unasked.
 *
 * - `supervised` — every tool that is not read-only asks.
 * - `auto`       — today's behaviour: each tool keeps its own default. This is also what an absent value means.
 * - `full`       — every tool that would ask runs, except the ones that wait for a person.
 *
 * Pure data; the resolution is in `tool-permissions.ts`.
 */
export type ThreadPermissionMode = "auto" | "full" | "supervised";

export const THREAD_PERMISSION_MODES: ReadonlyArray<ThreadPermissionMode> = ["supervised", "auto", "full"];

/**
 * The error code of a refused mode save on a comparison column (`setThreadPermissionMode`). The column's mode is the comparison's, so the
 * save changed nothing: the client tells it apart from a save that failed by this code, not by its message.
 */
export const COMPARISON_COLUMN_MODE_CODE = "COMPARISON_COLUMN_MODE";

/** What an absent value means. */
export const DEFAULT_THREAD_PERMISSION_MODE: ThreadPermissionMode = "auto";

export const isThreadPermissionMode = (value: unknown): value is ThreadPermissionMode =>
    typeof value === "string" && (THREAD_PERMISSION_MODES as ReadonlyArray<string>).includes(value);

/**
 * Built-ins that answer from data the app already holds, with no outbound call: they spend nothing, start nothing and send nothing
 * the model chose to a third party. `supervised` leaves these at their own mode. An allowlist: a built-in not named
 * here asks. A search, a lookup, or a memory query that reaches a provider (even one of the app's own, billed per request) asks.
 */
export const BUILTIN_TOOLS_READ_ONLY: ReadonlySet<string> = new Set(["dateTime", "listLanguages"]);
