/**
 * Live progress of a long MCP tool call (`notifications/progress`).
 *
 * The server's numbers reach the chat as a `toolProgress` field on a
 * `persistentChunks` row, the same stream the reply's text travels on. Nothing
 * writes a row per notification: {@link createLatestThrottle} lets one update
 * through at once, keeps only the newest of the rest, and sends it when the
 * interval is over. {@link createToolProgressWriter} adds the per-call
 * lifecycle: a call that never reported progress writes nothing, and one that
 * did ends with a single `ended` marker so the row stops showing it.
 *
 * Progress is best effort. A refused write (a stop, a lost stream) is swallowed:
 * it must never fail the tool.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** At most one update per call and this many ms. */
export const PROGRESS_INTERVAL_MS = 500;

/** The interval once a call has run {@link PROGRESS_SLOW_AFTER_MS}: a long call's bar moves slowly anyway. */
export const PROGRESS_SLOW_INTERVAL_MS = 2000;

/** How long a call runs before its reports back off to {@link PROGRESS_SLOW_INTERVAL_MS}. */
export const PROGRESS_SLOW_AFTER_MS = 60_000;

/** Reports one call writes at the normal pace; past this it slows to {@link PROGRESS_CAPPED_INTERVAL_MS}, so a chatty server cannot grow the stream fast. */
export const MAX_PROGRESS_REPORTS = 300;

/** The interval once a call has written {@link MAX_PROGRESS_REPORTS}: the bar still moves, a row every half minute. */
export const PROGRESS_CAPPED_INTERVAL_MS = 30_000;

/** The longest status message that is relayed; the server's text is untrusted. */
export const MAX_PROGRESS_MESSAGE_LENGTH = 200;

/** The most of a server or tool name a progress chunk keeps (the column's cap). */
const MAX_TOOL_LABEL_LENGTH = 500;

/** One progress report, as the chat shows it. `total` is absent for an indeterminate task. */
export interface McpProgress {
    message?: string;
    progress: number;
    total?: number;
}

/** What a `persistentChunks` row carries: a report, or the end of the call's reports. */
export interface ToolProgressChunk {
    /** Set on the last write of a call: the row stops showing progress. */
    ended?: boolean;
    message?: string;
    progress?: number;
    serverName: string;
    toolCallId: string;
    toolName: string;
    total?: number;
}

/**
 * An untrusted status message made safe to show: line breaks and tabs become a space, other control
 * characters and the bidi overrides and isolates (which can reorder the text around them) are removed,
 * and it is cut to {@link MAX_PROGRESS_MESSAGE_LENGTH} code points, so a surrogate pair is never split.
 */
export const sanitizeProgressMessage = (message: string, maxLength = MAX_PROGRESS_MESSAGE_LENGTH): string =>
    [
        // Cut first, so a huge message from the server costs no more than a short one: what survives the
        // cleaning is at most `maxLength` code points of at most two units, plus what the cleaning removes.
        ...message
            .slice(0, maxLength * 8)
            .replaceAll(/[\t\n\r]+/gu, " ")
            .replaceAll(/[\p{Cc}\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu, "")
            .trim(),
    ]
        .slice(0, maxLength)
        .join("");

/**
 * The numbers of a `notifications/progress` params object, or `undefined` when
 * there is nothing usable. The server is untrusted: a non-finite or negative
 * `progress` is dropped, a `total` that is not a positive finite number reads
 * as "unknown" (indeterminate), and the message is sanitised ({@link sanitizeProgressMessage}).
 */
export const readProgressParams = (params: unknown): McpProgress | undefined => {
    if (typeof params !== "object" || params === null) {
        return undefined;
    }

    const { message, progress, total } = params as { message?: unknown; progress?: unknown; total?: unknown };

    if (typeof progress !== "number" || !Number.isFinite(progress) || progress < 0) {
        return undefined;
    }

    const text = typeof message === "string" ? sanitizeProgressMessage(message) : "";

    return {
        ...(text && { message: text }),
        progress,
        ...(typeof total === "number" && Number.isFinite(total) && total > 0 && { total }),
    };
};

/** A call's latest report, as the persisted body hands it to a viewer that lost the live stream. */
export type OpenToolProgress = Omit<ToolProgressChunk, "ended" | "progress"> & { progress: number };

/**
 * The latest report of every call that has not ended, in the order the calls first reported: all a viewer
 * needs to show what is running, however many reports were written. A chunk that is not progress is skipped.
 */
export const openToolProgress = (chunks: Iterable<{ toolProgress?: ToolProgressChunk | null }>): OpenToolProgress[] => {
    const open = new Map<string, OpenToolProgress>();

    for (const { toolProgress } of chunks) {
        if (!toolProgress) {
            continue;
        }

        const { ended, progress, ...report } = toolProgress;

        if (ended) {
            open.delete(report.toolCallId);
        } else if (progress !== undefined) {
            open.set(report.toolCallId, { ...report, progress });
        }
    }

    return [...open.values()];
};

export interface ThrottleClock {
    clearTimer?: (timer: unknown) => void;
    now?: () => number;
    setTimer?: (callback: () => void, ms: number) => unknown;
}

export interface LatestThrottle<T> {
    /** Stops sending, drops what is waiting, and resolves once a write already in flight has settled. */
    close: () => Promise<void>;
    /** Offers a value: sent at once when the interval allows, otherwise it replaces the one waiting. */
    push: (value: T) => void;
}

/**
 * Lets at most one value through per interval (a number, or a function read on every push so it can back off), newest wins: the first goes
 * out at once, the rest collapse into the latest and leave when the interval is
 * over. A new value never starts while an earlier `emit` is still running, so
 * writes cannot overlap or land out of order. Time is injected for the tests.
 */
export const createLatestThrottle = <T>(
    emit: (value: T) => Promise<void> | void,
    { clearTimer = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>), now = Date.now, setTimer = setTimeout }: ThrottleClock = {},
    interval: number | (() => number) = PROGRESS_INTERVAL_MS,
): LatestThrottle<T> => {
    const intervalMs = typeof interval === "function" ? interval : () => interval;
    let waiting: { value: T } | undefined;
    let lastSentAt: number | undefined;
    let timer: unknown;
    let timerSet = false;
    let writing: Promise<void> | undefined;
    let closed = false;

    const schedule = (): void => {
        if (closed || timerSet || writing || !waiting) {
            return;
        }

        const wait = lastSentAt === undefined ? 0 : Math.max(0, lastSentAt + intervalMs() - now());

        if (wait === 0) {
            send();

            return;
        }

        timerSet = true;
        timer = setTimer(() => {
            timerSet = false;
            send();
        }, wait);
    };

    const send = (): void => {
        if (closed || writing || !waiting) {
            return;
        }

        const { value } = waiting;

        waiting = undefined;
        lastSentAt = now();

        let result: Promise<void> | void;

        try {
            result = emit(value);
        } catch {
            result = undefined;
        }

        writing = Promise.resolve(result)
            .catch(() => undefined)
            .then(() => {
                writing = undefined;
                schedule();

                return undefined;
            });
    };

    return {
        close: async () => {
            closed = true;
            waiting = undefined;

            if (timerSet) {
                clearTimer(timer);
                timerSet = false;
            }

            await writing;
        },
        push: (value) => {
            if (closed) {
                return;
            }

            waiting = { value };
            schedule();
        },
    };
};

export interface ToolProgressTool {
    serverName: string;
    toolCallId: string;
    toolName: string;
}

export interface ToolCallProgress {
    /** Ends the call's reports: nothing more is sent, and a `ended` marker follows if any report was. */
    finish: () => Promise<void>;
    push: (progress: McpProgress) => void;
}

export type ToolProgressSink = (tool: ToolProgressTool) => ToolCallProgress;

/** What a write throws when the stream is over (the reply was stopped or ended): every later write would be refused too. */
export class ProgressStreamClosedError extends Error {
    public constructor() {
        super("The stream no longer takes progress");
        this.name = "ProgressStreamClosedError";
    }
}

/**
 * The sink for one run: `write` puts a chunk on the stream. Each call gets its own
 * throttle, so two tools running side by side each report at their own pace.
 */
export const createToolProgressWriter = (write: (chunk: ToolProgressChunk) => Promise<void>, clock?: ThrottleClock): ToolProgressSink => {
    const now = clock?.now ?? Date.now;

    return (called) => {
        // The names come from the MCP server too: cleaned like the message, and capped as the column is.
        const tool = {
            ...called,
            serverName: sanitizeProgressMessage(called.serverName, MAX_TOOL_LABEL_LENGTH),
            toolName: sanitizeProgressMessage(called.toolName, MAX_TOOL_LABEL_LENGTH),
        };
        const startedAt = now();
        let reported = false;
        let written = 0;
        // Once the stream is over (the reply was stopped), it refuses every later write: stop trying. Any other
        // failure is one write lost; the next report may still land.
        let refused = false;
        let last: McpProgress | undefined;
        const throttle = createLatestThrottle(
            async (progress: McpProgress) => {
                // A repeat tells the viewer nothing.
                if (refused || (last && last.progress === progress.progress && last.total === progress.total && last.message === progress.message)) {
                    return;
                }

                last = progress;
                written += 1;
                reported = true;

                try {
                    await write({ ...tool, ...progress });
                } catch (error) {
                    // Best effort: the tool carries on whatever happens to its progress.
                    refused = error instanceof ProgressStreamClosedError;
                }
            },
            clock,
            () => {
                if (written >= MAX_PROGRESS_REPORTS) {
                    return PROGRESS_CAPPED_INTERVAL_MS;
                }

                return now() - startedAt >= PROGRESS_SLOW_AFTER_MS ? PROGRESS_SLOW_INTERVAL_MS : PROGRESS_INTERVAL_MS;
            },
        );

        return {
            finish: async () => {
                await throttle.close();

                if (!reported || refused) {
                    return;
                }

                try {
                    await write({ ...tool, ended: true });
                } catch {
                    // See above.
                }
            },
            push: throttle.push,
        };
    };
};

/** The call a progress notification belongs to: its token on the wire, and who to tell. */
export interface ProgressCall {
    onProgress: (progress: McpProgress) => void;
    /** Registers what to forget when the call is released (the transport's bookkeeping for its request). */
    onRelease?: (cleanup: () => void) => void;
    token: string;
}

/** A {@link ProgressCall} that runs the cleanups registered with it when `release` is called, once. */
export const createProgressCall = ({ onProgress, token }: Pick<ProgressCall, "onProgress" | "token">): ProgressCall & { release: () => void } => {
    const cleanups = new Set<() => void>();

    return {
        onProgress,
        onRelease: (cleanup) => {
            cleanups.add(cleanup);
        },
        release: () => {
            for (const cleanup of cleanups) {
                cleanup();
            }

            cleanups.clear();
        },
        token,
    };
};

const progressCalls = new AsyncLocalStorage<ProgressCall>();

/** Runs `callback` as the tool call `call`: the MCP request it makes carries `call.token` as its `progressToken`. */
export const runWithProgressCall = <T>(call: ProgressCall, callback: () => T): T => progressCalls.run(call, callback);

/** The tool call the running code serves, if any. */
export const currentProgressCall = (): ProgressCall | undefined => progressCalls.getStore();
