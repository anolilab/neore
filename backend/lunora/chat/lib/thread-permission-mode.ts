/**
 * The per-thread permission mode of a cloud thread: how much of the run the owner leaves unasked.
 *
 * - `supervised` — every tool that is not read-only asks.
 * - `auto-edit`  — as supervised, but the file-edit tools run.
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
    "knowledgeSearch",
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
 * Built-ins that write files or artifacts inside the thread's own sandbox or document space, with no outward
 * reach: the document and design tools. `fileOperations` is not here: a bot with its own computer shares that filesystem across
 * threads, so its writes ask. Slides are not here either: their HTML can load remote images when viewed, so creating or editing one
 * asks. `retrieve` is not a lookup: it fetches model-chosen URLs, which can carry thread data and spend quota. `auto-edit` lets the listed tools run; shell, code execution, browser, network,
 * generation and delegation tools keep asking.
 */
export const BUILTIN_TOOLS_FILE_EDIT: ReadonlySet<string> = new Set([
    "createDesign",
    "createDocument",
    "updateDesign",
    "updateDocument",
]);
