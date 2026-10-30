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
 * The numbers of a `notifications/progress` params object, or `undefined` when
 * there is nothing usable. The server is untrusted: a non-finite or negative
 * `progress` is dropped, a `total` that is not a positive finite number reads
 * as "unknown" (indeterminate), and the message is cut short.
 */
export const readProgressParams = (params: unknown): McpProgress | undefined => {
    if (typeof params !== "object" || params === null) {
        return undefined;
    }

    const { message, progress, total } = params as { message?: unknown; progress?: unknown; total?: unknown };

    if (typeof progress !== "number" || !Number.isFinite(progress) || progress < 0) {
        return undefined;
    }

    const text = typeof message === "string" ? message.trim().slice(0, MAX_PROGRESS_MESSAGE_LENGTH) : "";

    return {
        ...(text && { message: text }),
        progress,
        ...(typeof total === "number" && Number.isFinite(total) && total > 0 && { total }),
    };
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
 * Lets at most one value through per `intervalMs`, newest wins: the first goes
 * out at once, the rest collapse into the latest and leave when the interval is
 * over. A new value never starts while an earlier `emit` is still running, so
 * writes cannot overlap or land out of order. Time is injected for the tests.
 */
export const createLatestThrottle = <T>(
    emit: (value: T) => Promise<void> | void,
    { clearTimer = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>), now = Date.now, setTimer = setTimeout }: ThrottleClock = {},
    intervalMs = PROGRESS_INTERVAL_MS,
): LatestThrottle<T> => {
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

        const wait = lastSentAt === undefined ? 0 : Math.max(0, lastSentAt + intervalMs - now());

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

/**
 * The sink for one run: `write` puts a chunk on the stream. Each call gets its own
 * throttle, so two tools running side by side each report at their own pace.
 */
export const createToolProgressWriter = (write: (chunk: ToolProgressChunk) => Promise<void>, clock?: ThrottleClock): ToolProgressSink => {
    return (called) => {
        // The column caps names; a longer one would be refused on every write.
        const tool = { ...called, serverName: called.serverName.slice(0, MAX_TOOL_LABEL_LENGTH), toolName: called.toolName.slice(0, MAX_TOOL_LABEL_LENGTH) };
        let reported = false;
        const throttle = createLatestThrottle(async (progress: McpProgress) => {
            reported = true;

            try {
                await write({ ...tool, ...progress });
            } catch {
                // Best effort: a stopped stream refuses the write, and the tool carries on.
            }
        }, clock);

        return {
            finish: async () => {
                await throttle.close();

                if (!reported) {
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
    token: string;
}

const progressCalls = new AsyncLocalStorage<ProgressCall>();

/** Runs `callback` as the tool call `call`: the MCP request it makes carries `call.token` as its `progressToken`. */
export const runWithProgressCall = <T>(call: ProgressCall, callback: () => T): T => progressCalls.run(call, callback);

/** The tool call the running code serves, if any. */
export const currentProgressCall = (): ProgressCall | undefined => progressCalls.getStore();
