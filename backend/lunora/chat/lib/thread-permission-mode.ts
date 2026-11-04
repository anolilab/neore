/**
 * The per-thread permission mode of a cloud thread: how much of the run the owner leaves unasked.
 *
 * - `supervised` — every tool that is not read-only asks.
 * - `auto-edit`  — as supervised, plus whatever is in `BUILTIN_TOOLS_FILE_EDIT` (empty for now).
 * - `auto`       — today's behaviour: each tool keeps its own default. This is also what an absent value means.
 * - `full`       — every tool that would ask runs, except the ones that wait for a person.
 *
 * Pure data; the resolution is in `tool-permissions.ts`.
 */
export type ThreadPermissionMode = "auto" | "auto-edit" | "full" | "supervised";

export const THREAD_PERMISSION_MODES: ReadonlyArray<ThreadPermissionMode> = ["supervised", "auto-edit", "auto", "full"];

/** What an absent value means. */
export const DEFAULT_THREAD_PERMISSION_MODE: ThreadPermissionMode = "auto";

export const isThreadPermissionMode = (value: unknown): value is ThreadPermissionMode =>
    typeof value === "string" && (THREAD_PERMISSION_MODES as ReadonlyArray<string>).includes(value);

/**
 * Built-ins that only look something up and change nothing, spend nothing and start nothing. `supervised` and
 * `auto-edit` leave these at their own mode. An allowlist: a built-in not named here (a new one included) asks.
 */
export const BUILTIN_TOOLS_READ_ONLY: ReadonlySet<string> = new Set([
    "academicSearch",
    "codeSearch",
    "coinData",
    "coinDataByContract",
    "coinOhlc",
    "companySearch",
    "currencyConverter",
    "dateTime",
    "findPlace",
    "flightTracker",
    "githubSearch",
    "imageSearch",
    "listCurrencies",
    "listLanguages",
    "movieTvSearch",
    "nearbyPlacesSearch",
    "peopleSearch",
    "redditSearch",
    "searchMemory",
    "spotifySearch",
    "stockChart",
    "trendingMovies",
    "trendingTv",
    "videoSearch",
    "weather",
    "webSearch",
    "wolframAlpha",
    "xSearch",
    "youtubeSearch",
]);

/**
 * Built-ins that write files or artifacts with no outward reach, which `auto-edit` may let run. Empty for now: the document
 * tools are not here because their HTML can load remote images when the owner views them. Design canvases and slides are not
 * here either: their JSON or HTML can name remote images that load when opened. `fileOperations` is not here: a bot with its own
 * computer shares that filesystem across threads, so its writes ask. `retrieve` is not a lookup: it fetches model-chosen URLs,
 * which can carry thread data and spend quota. Shell, code execution, browser, network, generation and delegation tools keep asking.
 */
export const BUILTIN_TOOLS_FILE_EDIT: ReadonlySet<string> = new Set<string>();
