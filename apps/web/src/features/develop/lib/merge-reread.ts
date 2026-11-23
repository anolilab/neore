/** Re-reads while the host has not worked out a pull request's merge state yet, for a short while: it settles in seconds. */
export const MERGE_UNKNOWN_REREAD_MS = 20_000;
export const MERGE_UNKNOWN_REREAD_FOR_MS = 80_000;

interface StatusRead {
    mergeUnknown?: boolean;
    state?: string;
    status: string;
}

/**
 * When to read a pull request's status again, and since when its merge state has been unknown. `since` is when the
 * current run of "unknown" answers began; any other answer ends the run (`since` back to `undefined`), so a later push
 * that makes it unknown again starts a new window. A read that threw (`failed`) stops it too, though the last answer is
 * still cached: reading again is then the person's retry, and a successful read starts a new window.
 */
export const nextMergeReread = (
    data: StatusRead | undefined,
    since: number | undefined,
    now: number,
    failed = false,
): { delay: number | false; since: number | undefined } => {
    if (failed || data?.status !== "ok" || data.state !== "open" || data.mergeUnknown !== true) {
        return { delay: false, since: undefined };
    }

    const start = since ?? now;

    return { delay: now - start < MERGE_UNKNOWN_REREAD_FOR_MS ? MERGE_UNKNOWN_REREAD_MS : false, since: start };
};
