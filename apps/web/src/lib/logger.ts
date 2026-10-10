/**
 * Client-side logger.
 *
 * This used to be `@visulima/pail`. Both its default AND its `/browser` build
 * call `createRequire`, which Vite externalises in the browser — and this module
 * is imported by client components (`chat-context.tsx`,
 * `use-thread-manager.ts`), so `/chat` rendered
 * "Something went wrong! (0, …createRequire) is not a function" instead of the
 * chat UI.
 *
 * The surface actually used here is small — a handful of named levels, `scope`
 * and `disable` — so it is a console shim rather than a dependency. Server-side
 * logging is unaffected; that lives in the backend.
 */
type Level = "abort" | "connection" | "error" | "message" | "network" | "performance" | "stream" | "thread" | "update" | "user";

const BADGES: Record<Level, string> = {
    abort: "⏹️",
    connection: "🔄",
    error: "❌",
    message: "💬",
    network: "🌐",
    performance: "⏱️",
    stream: "🌊",
    thread: "🧵",
    update: "🔄",
    user: "👤",
};

export interface Logger extends Record<Level, (...args: unknown[]) => void> {
    disable: () => void;
    enable: () => void;
    scope: (name: string) => Logger;
}

const createLogger = (scope: string, enabled = true): Logger => {
    let isEnabled = enabled;

    const emit =
        (level: Level) =>
        (...args: unknown[]) => {
            if (!isEnabled) {
                return;
            }

            const write = level === "error" ? console.error : console.debug;

            write(`${BADGES[level]} [${scope}]`, ...args);
        };

    return {
        ...(Object.fromEntries(Object.keys(BADGES).map((l) => [l, emit(l as Level)])) as Record<Level, (...args: unknown[]) => void>),
        disable: () => {
            isEnabled = false;
        },
        enable: () => {
            isEnabled = true;
        },
        scope: (name: string) => createLogger(`${scope}:${name}`, isEnabled),
    };
};

const isDevelopment = import.meta.env?.DEV || process.env.NODE_ENV === "development";

export const logger = createLogger("ai-chat");

// Create scoped loggers for different modules
export const providerLogger = logger.scope("provider");
export const handlerLogger = logger.scope("handlers");
export const threadLogger = logger.scope("threads");

// Debug-level loggers are noise in production, so they are born disabled there.
// Info/warning/error loggers stay enabled for production monitoring.
export const streamLogger = createLogger("ai-chat:streaming", isDevelopment);
export const performanceLogger = createLogger("ai-chat:performance", isDevelopment);

// Helper functions for common logging patterns
export const logStreamStart = (threadId: string) => {
    streamLogger.stream("Starting ultra-optimized stream for thread: %s", threadId);
};

export const logStreamComplete = (
    threadId: string,
    stats: {
        avgUpdateInterval: number;
        charsPerSecond: number;
        duration: number;
        finalTextLength: number;
        updates: number;
    },
) => {
    streamLogger.performance(`Ultra-fast stream completed: ${threadId}
        📊 Duration: ${stats.duration.toFixed(1)}ms
        🔄 Updates: ${stats.updates}
        ⚡ Avg update interval: ${stats.avgUpdateInterval.toFixed(1)}ms
        🚀 Chars/second: ${stats.charsPerSecond.toFixed(0)}
        📝 Final text length: ${stats.finalTextLength} chars`);
};

export const logStreamUpdate = (length: number) => {
    streamLogger.update("Streaming update: %d chars", length);
};

export const logMessageUpdate = (messageId: string, length: number) => {
    handlerLogger.update("Updating message %s with %d chars", messageId, length);
};

export const logThreadLoad = (threadId: string, count: number) => {
    threadLogger.thread("Loading %d messages for thread: %s", count, threadId);
};

export const logThreadUpdate = (threadId: string, count: number) => {
    threadLogger.thread("Updated %d messages for thread: %s", count, threadId);
};

export const logConnectionRetry = (attempt: number, maxRetries: number, operationId: string, error: string) => {
    logger.connection("Retry attempt %d/%d for %s: %s", attempt, maxRetries, operationId, error);
};

export const logUserAction = (action: string, threadId: string) => {
    logger.user("%s called with currentThreadId: %s", action, threadId);
};

export const logNetworkError = (error: string) => {
    logger.network("Stream error: %s", error);
};

export const logStreamAbort = () => {
    logger.abort("Stream aborted by user");
};

export const logStreamCancel = () => {
    logger.abort("Stream cancelled by user");
};
