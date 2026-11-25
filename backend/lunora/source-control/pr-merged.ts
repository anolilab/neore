/**
 * What a merged pull request does to the chats linked to it: the merge is recorded on each link, and a chat whose link
 * took the merge now is archived when its owner turned on `autoArchiveMergedChats`. Called from the two places that
 * learn of a merge: the merge action (the person's own merge) and the status read (a merge made elsewhere, seen when the
 * chat's pull request is read). Never throws: the merge has already happened on the host, and a failed record or archive
 * must not fail the caller.
 */
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import type { ActionCtx } from "../_generated/server";
import { internalAction } from "../_generated/server";
import { enqueueJob } from "../lib/job-queue";
import { MAX_LENGTH } from "../lib/validators";
import { requireAddress } from "./pr-threads";

/** An owed link as a page reports it: its chat, and when an attempt last found the chat busy (0 when never). */
interface RecordedLink {
    lastAttemptAt: number;
    linkId: Id<"pullRequestThreads">;
    threadId: Id<"threads">;
}

/** One page of recorded links: the owed ones, and where the next page starts. */
interface RecordedPage {
    continueCursor: string | null;
    isDone: boolean;
    owed: RecordedLink[];
}

export interface MergedPullRequestRef {
    number: number;
    repository: string;
}

/** The merge a recording walks: the pull request, and the host's merge time when the caller has one. */
interface MergeRecording {
    mergedAt?: number;
    mergedBefore?: number;
    mergedBeforeIsHostBound?: boolean;
    number: number;
    /** When the walk first saw the merge. Every page of the walk carries it, so a link stamped on a later page is still bounded by it. */
    recordedAt?: number;
    repository: string;
    userId: string;
}

type RecordCtx = Pick<ActionCtx, "runMutation" | "scheduler">;

/** The recorded walk of one merge: the owed links it saw, and where it stopped when it did not reach the last page. */
interface Walk {
    continueCursor: string | null;
    done: boolean;
    owed: Map<string, RecordedLink>;
}

/**
 * Archive attempts per read. A status read waits for these, so a merge that owes many chats is worked through a bounded
 * batch at a time: what is left stays owed, and the next read takes the next batch.
 */
const MERGED_ARCHIVES_PER_READ = 25;

/**
 * Recording pages one action records. A walk past this continues on the jobs queue from the cursor it stopped at, so no
 * single action records an unbounded number of pages.
 */
const MAX_RECORD_PAGES_PER_ACTION = 10;

/** Walks restarted from the first page per action, when a page's cursor is no longer read. Bounded, so a cursor that keeps failing ends the walk. */
const MAX_CURSOR_RESTARTS = 3;

/** Whether a page call failed because its cursor is no longer read by the server. */
const isInvalidCursor = (error: unknown): boolean => typeof error === "object" && error !== null && "code" in error && error.code === "INVALID_CURSOR";

/** The arguments of one page call for this merge. */
const pageArgsOf = (merge: MergeRecording) => {
    return {
        ...(merge.mergedAt !== undefined && { mergedAt: merge.mergedAt }),
        ...(merge.mergedBefore !== undefined && { mergedBefore: merge.mergedBefore }),
        ...(merge.mergedBeforeIsHostBound !== undefined && { mergedBeforeIsHostBound: merge.mergedBeforeIsHostBound }),
        ...(merge.recordedAt !== undefined && { recordedAt: merge.recordedAt }),
        number: merge.number,
        repository: merge.repository,
        userId: merge.userId,
    };
};

/**
 * Records the links of one merge page by page, from `start`, for at most `maxPages` pages. The owed links are
 * kept once each, even when a restart sees them again. A cursor the server no longer reads (`INVALID_CURSOR`: a write or a deploy
 * between pages) restarts the walk from the first page, as the state sweep does.
 */
const walkPages = async (ctx: Pick<ActionCtx, "runMutation">, merge: MergeRecording, start: string | null, maxPages: number): Promise<Walk> => {
    const owed = new Map<string, RecordedLink>();
    let cursor = start;
    let restarts = 0;
    let pages = 0;

    while (pages < maxPages) {
        let page: RecordedPage;

        try {
            page = await ctx.runMutation(internal.source_control.pr_threads.recordPullRequestMergedPage, { ...pageArgsOf(merge), cursor });
        } catch (error) {
            if (cursor !== null && restarts < MAX_CURSOR_RESTARTS && isInvalidCursor(error)) {
                restarts += 1;
                cursor = null;
                continue;
            }

            throw error;
        }

        pages += 1;

        for (const link of page.owed) {
            owed.set(link.linkId, link);
        }

        if (page.isDone) {
            return { continueCursor: null, done: true, owed };
        }

        cursor = page.continueCursor;
    }

    return { continueCursor: cursor, done: false, owed };
};

/**
 * Records what this action may, schedules the rest of the walk when it did not reach the last page, and archives the chats of the
 * owed batch. Every page is recorded before the attempts, so the attempts go to the owed links least recently attempted: a busy link
 * on an early page cannot take every attempt of the read. What is left stays owed (the next read, the sweep, or the continuation).
 */
const recordAndArchive = async (ctx: RecordCtx, merge: MergeRecording, start: string | null): Promise<void> => {
    const address = { number: merge.number, repository: merge.repository };
    const walk = await walkPages(ctx, merge, start, MAX_RECORD_PAGES_PER_ACTION);

    if (!walk.done && walk.continueCursor !== null) {
        await recordRest(ctx, merge, walk.continueCursor, walk.owed);
    }

    const owed = [...walk.owed.values()].toSorted((a, b) => a.lastAttemptAt - b.lastAttemptAt);

    for (const link of owed.slice(0, MERGED_ARCHIVES_PER_READ)) {
        await archiveOwedLink(ctx, link, address);
    }
};

/**
 * Queues the rest of a walk on the jobs queue, on the owner's shard, from the cursor the action stopped at. Long work belongs on the
 * queue, not the scheduler lane. When the queue refuses the send, the rest is recorded in this action instead, so no page is left
 * unrecorded; the cost is this action's time. The owed links it finds join `owed`.
 */
const recordRest = async (ctx: Pick<ActionCtx, "runMutation">, merge: MergeRecording, cursor: string, owed: Map<string, RecordedLink>): Promise<void> => {
    try {
        await enqueueJob(internal.source_control.pr_merged.continueMergedRecordingJob, { ...pageArgsOf(merge), cursor }, { shardKey: merge.userId });

        return;
    } catch (error) {
        console.error("[source-control] could not queue the rest of a merged pull request's recording; recording it in this action", error);
    }

    const rest = await walkPages(ctx, merge, cursor, Infinity);

    for (const [linkId, link] of rest.owed) {
        owed.set(linkId, link);
    }
};

/**
 * Records a merge and archives the chats it owes an archive to. Every caller passes `mergedAt`: the host's merge time, or,
 * when the merge action's follow-up read cannot get it, the time before the merge was requested. `ctx.now` is only the
 * defensive fallback inside the recording. Each chat is attempted on its own: one that fails is logged and left owed, so
 * the next read retries it, and the rest still run.
 */
export const recordMergedPullRequest = async (
    ctx: RecordCtx,
    userId: string,
    ref: MergedPullRequestRef,
    mergedAt?: number,
    mergedBefore?: number,
    mergedBeforeIsHostBound?: boolean,
): Promise<void> => {
    try {
        // Links are stored under the canonical (lowercase) repository, so the lookup must use it too; an invalid address throws here and is logged.
        const address = requireAddress(ref.repository, ref.number);

        await recordAndArchive(
            ctx,
            {
                ...(mergedAt !== undefined && { mergedAt }),
                ...(mergedBefore !== undefined && { mergedBefore }),
                ...(mergedBeforeIsHostBound !== undefined && { mergedBeforeIsHostBound }),
                number: address.number,
                // The walk starts now: the merge was seen no later than this, so it bounds every page of the walk.
                recordedAt: Date.now(),
                repository: address.repository,
                userId,
            },
            null,
        );
    } catch (error) {
        console.error("[source-control] could not record the merged pull request", error);
    }
};

/**
 * The rest of a merge's recording, from the cursor an earlier action stopped at (`recordRest`). Errors propagate: the job that runs it
 * fails, so the queue retries it. Every page is idempotent, so a retry repeats work without changing the result.
 */
export const continueMergedRecording = async (ctx: RecordCtx, args: MergeRecording & { cursor: string }): Promise<void> => {
    const { cursor, ...merge } = args;

    await recordAndArchive(ctx, merge, cursor);
};

/** The job that runs `continueMergedRecording`, on the owner's shard through the jobs queue. */
export const continueMergedRecordingJob = internalAction
    .input({
        cursor: v.string().max(MAX_LENGTH.cursor),
        mergedAt: v.optional(v.number()),
        mergedBefore: v.optional(v.number()),
        mergedBeforeIsHostBound: v.optional(v.boolean()),
        number: v.number(),
        recordedAt: v.optional(v.number()),
        repository: v.string().max(MAX_LENGTH.short),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.null())
    .action(async ({ args, ctx }) => {
        await continueMergedRecording(ctx, args);

        return null;
    });

/** One owed link's archive attempt. A thrown attempt is logged, and its link is noted so the next read moves past it. */
const archiveOwedLink = async (
    ctx: Pick<ActionCtx, "runMutation">,
    link: { linkId: Id<"pullRequestThreads">; threadId: Id<"threads"> },
    address: { number: number; repository: string },
): Promise<void> => {
    try {
        // The attempt settles its link in the same transaction when its answer is final; a busy one stays owed.
        await ctx.runMutation(internal.agent.auto_archive.archiveMergedThread, {
            linkId: link.linkId,
            number: address.number,
            repository: address.repository,
            threadId: link.threadId,
        });
    } catch (error) {
        console.error("[source-control] could not archive a chat for a merged pull request; the next read retries it", error);
        await noteFailedAttempt(ctx, link.linkId);
    }
};

/**
 * Stamps a link whose attempt threw, so the rotation moves past it: a link that keeps failing must not hold the front of
 * the batch and starve the owed chats behind it. Never throws.
 */
const noteFailedAttempt = async (ctx: Pick<ActionCtx, "runMutation">, linkId: Id<"pullRequestThreads">): Promise<void> => {
    try {
        await ctx.runMutation(internal.source_control.pr_threads.noteMergeAttempt, { linkId });
    } catch (error) {
        console.error("[source-control] could not note a failed archive attempt", error);
    }
};
