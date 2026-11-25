/**
 * What a merged pull request does to the chats linked to it: the merge is recorded on each link, and a chat whose link
 * took the merge now is archived when its owner turned on `autoArchiveMergedChats`. Called from the two places that
 * learn of a merge: the merge action (the person's own merge) and the status read (a merge made elsewhere, seen when the
 * chat's pull request is read). Never throws: the merge has already happened on the host, and a failed record or archive
 * must not fail the caller.
 */
import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { requireAddress } from "./pr-threads";

/** One page of recorded links: the owed ones, and where the next page starts. */
interface RecordedPage {
    continueCursor: string | null;
    isDone: boolean;
    owed: { linkId: Id<"pullRequestThreads">; threadId: Id<"threads"> }[];
}

export interface MergedPullRequestRef {
    number: number;
    repository: string;
}

/**
 * Archive attempts per read. A status read waits for these, so a merge that owes many chats is worked through a bounded
 * batch at a time: what is left stays owed, and the next read takes the next batch.
 */
const MERGED_ARCHIVES_PER_READ = 25;

/**
 * Records a merge and archives the chats it owes an archive to. Every caller passes `mergedAt`: the host's merge time, or,
 * when the merge action's follow-up read cannot get it, the time before the merge was requested. `ctx.now` is only the
 * defensive fallback inside the recording. Each chat is attempted on its own: one that fails is logged and left owed, so
 * the next read retries it, and the rest still run.
 */
export const recordMergedPullRequest = async (
    ctx: Pick<ActionCtx, "runMutation">,
    userId: string,
    ref: MergedPullRequestRef,
    mergedAt?: number,
    mergedBefore?: number,
    mergedBeforeIsHostBound?: boolean,
): Promise<void> => {
    try {
        // Links are stored under the canonical (lowercase) repository, so the lookup must use it too; an invalid address throws here and is logged.
        const address = requireAddress(ref.repository, ref.number);
        // The links are recorded one bounded page per call; the archive attempts are capped for the whole read, and what is left stays
        // owed (the next read or sweep takes it).
        let cursor: string | null = null;
        let attempts = 0;

        for (;;) {
            const page: RecordedPage = await ctx.runMutation(internal.source_control.pr_threads.recordPullRequestMergedPage, {
                ...(mergedAt !== undefined && { mergedAt }),
                ...(mergedBefore !== undefined && { mergedBefore }),
                ...(mergedBeforeIsHostBound !== undefined && { mergedBeforeIsHostBound }),
                cursor,
                number: address.number,
                repository: address.repository,
                userId,
            });

            for (const link of page.owed) {
                if (attempts >= MERGED_ARCHIVES_PER_READ) {
                    break;
                }

                attempts += 1;
                await archiveOwedLink(ctx, link, address);
            }

            if (page.isDone) {
                break;
            }

            cursor = page.continueCursor;
        }
    } catch (error) {
        console.error("[source-control] could not record the merged pull request", error);
    }
};

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
