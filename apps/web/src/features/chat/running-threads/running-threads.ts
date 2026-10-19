/** The fields of a thread-list row the rail reads. Same rows as the sidebar's `getThreadListData`. */
export interface RunnableThread {
    _id: string;
    status?: string;
    title?: string;
    updatedAt?: number;
}

/**
 * Threads whose run is in flight, most recently started first. The backend
 * sets `status: "running"` when a stream starts and `updatedAt` at the same
 * write, so `updatedAt` stands in for the start time.
 */
export const runningThreads = <T extends RunnableThread>(threads: ReadonlyArray<T>): T[] =>
    threads.filter((thread) => thread.status === "running").toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
