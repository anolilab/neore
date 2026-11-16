/** A read that answered, now or before a refetch that failed: data it kept is still an answer. */
const answered = (read: { data?: unknown; isSuccess: boolean }): boolean => read.isSuccess || read.data !== undefined;

/** The thread has answered that it is not a worker's: a read still out is not an answer. */
export const isKnownNotWorker = (
    relationship: { data?: { branchType?: string } | null; isSuccess: boolean },
    worker: { data?: unknown; isSuccess: boolean },
): boolean => answered(relationship) && (relationship.data?.branchType !== "subagent" || (answered(worker) && !worker.data));
