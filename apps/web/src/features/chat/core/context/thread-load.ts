/**
 * Where the thread's own read stands: "loading" until it first answers, "failed" when it failed with no thread to show, and
 * "ready" otherwise (a thread, none to read, or an answer that there is none).
 */
export type ThreadLoad = "failed" | "loading" | "ready";

export const threadLoadOf = (threadId: string | undefined, hasThread: boolean, read: { isError: boolean; isPending: boolean }): ThreadLoad => {
    if (!threadId || hasThread) {
        return "ready";
    }

    if (read.isError) {
        return "failed";
    }

    return read.isPending ? "loading" : "ready";
};
