/**
 * Auto-archive: archives threads idle for the user's `autoArchiveAfterDays`.
 * Runs once per housekeeping pass on the user's own shard (`shardSweeps()` in
 * `lib/shard-housekeeping.ts`), not on a cron of its own. The eligibility rules
 * are in `auto-archive-logic.ts`.
 *
 * A pass reads the idle range newest-first in pages and archives up to
 * ARCHIVE_BATCH threads. Every write goes through `archiveIfStillIdle`, which
 * re-reads the thread in the same mutation and archives it only if it is still
 * due, so a message, a run, or a pin that lands after the scan wins.
 */
import { v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { pendingApprovalCutoff } from "../chat/lib/tool-approval-cleanup";
import { currentUserShard } from "../lib/shard-context";
import type { ScanPage } from "../lib/scan-pages";
import { MAX_LENGTH } from "../lib/validators";
import {
    type AutoArchiveCandidate,
    autoArchiveCutoff,
    isAutoArchiveDays,
    isArchivable,
    isOpenPullRequestForArchive,
    keepsOpenPullRequestChats,
    runArchivePass,
    selectAutoArchiveDue,
} from "./auto-archive-logic";
import { noteMergeAttemptRow, settleMergedLinkRow, settleOwedMergesOf, someLinkOfThread } from "../source-control/pr-thread-links";
import { markThreadArchived } from "./threads";

/** Threads archived per pass. The rest wait for the next pass, which is idempotent. */
const ARCHIVE_BATCH = 100;
/** Pull request links read per thread. A full page keeps the thread: a closed link may hide an open one past it. */
const PULL_REQUEST_LINK_READ = 100;
/** Index rows read per page, and per pass before the pass hands its cursor to a follow-up run. */
const PAGE_SIZE = 200;
const READ_BUDGET = 1000;
/** A follow-up run for a pass that ran out of budget. */
const RESUME_DELAY_MS = 10_000;

const NO_EXCLUSIONS = { liveThreadIds: new Set<string>(), pinnedProjectIds: new Set<string>() };

const candidateOf = (thread: Doc<"threads">): AutoArchiveCandidate => {
    return {
        _id: thread._id,
        deleted: thread.deleted,
        isTemporary: thread.isTemporary,
        pinnedAt: thread.pinnedAt,
        projectId: thread.projectId,
        status: thread.status,
        updatedAt: thread.updatedAt,
    };
};

/**
 * True when the thread has a pending or streaming stream. One indexed `first()`
 * per live status, so the thread's finished streams are never read.
 */
const threadHasLiveStream = async (ctx: MutationCtx, threadId: Id<"threads">): Promise<boolean> => {
    for (const status of ["pending", "streaming"]) {
        const stream = await ctx.db
            .query("persistentStreams")
            .withIndex("by_threadId_status", (q) => q.eq("threadId", threadId).eq("status", status))
            .first();

        if (stream) {
            return true;
        }
    }

    return false;
};

/**
 * True when a tool approval, a question or a secret card (all pending
 * `toolApprovalRuns`) waits on the owner. The run is paused, so it has no live stream.
 * A request older than its answer window is expired (answering it fails closed) and
 * only awaits the purge, so it no longer holds the thread.
 */
const threadWaitsOnPerson = async (ctx: MutationCtx, threadId: Id<"threads">): Promise<boolean> => {
    const live = await ctx.db
        .query("toolApprovalRuns")
        .withIndex("by_threadId_status_createdAt", (q) => q.eq("threadId", threadId).eq("status", "pending").gte("createdAt", pendingApprovalCutoff(ctx.now)))
        .take(1);

    return live.length > 0;
};

/**
 * True when a guest link on the thread is still live. Archiving revokes its links and deletes the notes waiting on them, and
 * a live link is not a sign the owner is idle, so such a thread stays.
 */
const threadHasLiveGuestLink = async (ctx: MutationCtx, threadId: Id<"threads">): Promise<boolean> => {
    const live = await ctx.db
        .query("threadGuestLinks")
        .withIndex("by_thread_expiresAt", (q) => q.eq("threadId", threadId).gt("expiresAt", ctx.now))
        .take(1);

    return live.length > 0;
};

/** The thread's project pin state, read per thread (not from a capped list of pinned projects). */
const pinnedProjectIdsOf = async (ctx: MutationCtx, thread: Doc<"threads">): Promise<Set<string>> => {
    const project = thread.projectId ? await ctx.db.projects.findFirst({ where: { _id: thread.projectId } }) : null;

    return new Set<string>(project && project.pinnedAt !== undefined && thread.projectId ? [thread.projectId] : []);
};

/** True when something keeps the thread from archiving whatever its age: a live stream, a request waiting on the owner, or a live guest link. */
const archiveBlocked = async (ctx: MutationCtx, threadId: Id<"threads">): Promise<boolean> =>
    (await threadHasLiveStream(ctx, threadId)) || (await threadWaitsOnPerson(ctx, threadId)) || (await threadHasLiveGuestLink(ctx, threadId));

/**
 * True when the thread's owner keeps open-pull-request chats (the default) and the thread has a linked pull request that
 * is open, by the stored state. Reads the links only, never the host. A thread with no link returns before the settings read,
 * so a chat without a pull request is decided exactly as before.
 */
const threadKeptForOpenPullRequest = async (ctx: MutationCtx, userId: string | undefined, threadId: Id<"threads">): Promise<boolean> => {
    if (userId === undefined) {
        return false;
    }

    // One link past the bound, so exactly `PULL_REQUEST_LINK_READ` links reads as complete, not truncated.
    const read = await ctx.db
        .query("pullRequestThreads")
        .withIndex("by_user_and_threadId", (q) => q.eq("userId", userId).eq("threadId", threadId))
        .take(PULL_REQUEST_LINK_READ + 1);
    const truncated = read.length > PULL_REQUEST_LINK_READ;
    const links = read.slice(0, PULL_REQUEST_LINK_READ);

    if (!truncated && links.every((link) => !isOpenPullRequestForArchive(link))) {
        return false;
    }

    const settings = await ctx.db
        .query("userSettings")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique();

    return keepsOpenPullRequestChats(settings?.keepOpenPullRequestChats) && (truncated || links.some((link) => isOpenPullRequestForArchive(link)));
};

/**
 * Archives one thread if, as read now, it is still due at `cutoff`. The eligibility check runs
 * on the fresh row, its project's pin state, its live streams and any request waiting on the owner, in the same
 * transaction as the write, so nothing that happened after the scan is overwritten.
 */
const archiveThreadIfDue = async (ctx: MutationCtx, threadId: Id<"threads">, cutoff: number): Promise<boolean> => {
    const thread = await ctx.db.get("threads", threadId);

    if (!thread) {
        return false;
    }

    const pinnedProjectIds = await pinnedProjectIdsOf(ctx, thread);

    // The row checks run first, so a thread that is not due never reads its streams.
    const due = selectAutoArchiveDue([candidateOf(thread)], cutoff, { liveThreadIds: new Set<string>(), pinnedProjectIds }, 1);

    if (due.length === 0 || (await archiveBlocked(ctx, threadId)) || (await threadKeptForOpenPullRequest(ctx, thread.userId, threadId))) {
        return false;
    }

    await markThreadArchived(ctx, threadId);

    return true;
};

export const archiveIfStillIdle = internalMutation
    .input({ cutoff: v.number(), threadId: v.id("threads") })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => await archiveThreadIfDue(ctx, args.threadId, args.cutoff));

/**
 * Archives a chat that a closed pull request made due (`source-control/pr-state.ts`). The owner's settings are read here, in the
 * same transaction as the decision, so a setting changed after the job was scheduled decides it. The idle archive runs only
 * with auto-archive on, and a raised threshold keeps the chat. Then an owed merge of the chat archives it, with merged-chat
 * archiving on, whatever the idle setting. An archive settles the chat's owed merges with it.
 */
export const archiveClosedLinkChat = internalMutation
    .input({ threadId: v.id("threads") })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        const thread = await ctx.db.get("threads", args.threadId);

        if (!thread) {
            return false;
        }

        const settings = await ctx.db
            .query("userSettings")
            .withIndex("by_userId", (q) => q.eq("userId", thread.userId))
            .unique();
        const days = settings?.autoArchiveAfterDays;

        if (isAutoArchiveDays(days) && days !== 0) {
            const archived = await archiveThreadIfDue(ctx, args.threadId, autoArchiveCutoff(ctx.now, days));

            if (archived) {
                ctx.log.event("chat.auto_archive", { archived: 1, reason: "pull_request_closed" });

                return true;
            }
        }

        // A request that kept the chat open may just have closed: a merge the chat still owes may now archive it.
        if (thread.userId === undefined) {
            return false;
        }

        const archivedForMerge = await archiveOwedMergesOf(ctx, thread.userId, args.threadId);

        if (archivedForMerge) {
            ctx.log.event("chat.auto_archive", { archived: 1, reason: "pull_request_closed" });
        }

        return archivedForMerge;
    });

type MergedArchiveArgs = {
    linkId: Id<"pullRequestThreads">;
    number: number;
    repository: string;
    threadId: Id<"threads">;
};

/** One archive attempt for an owed merge. The caller settles the link when the answer is final. */
const attemptMergedArchive = async (ctx: MutationCtx, args: MergedArchiveArgs): Promise<"archived" | "busy" | "declined" | "link-declined"> => {
    const thread = await ctx.db.get("threads", args.threadId);

    // A thread with no owner holds no links, so there is nothing to merge into.
    if (!thread || thread.userId === undefined) {
        return "declined";
    }

    const settings = await ctx.db
        .query("userSettings")
        .withIndex("by_userId", (q) => q.eq("userId", thread.userId))
        .unique();

    if (settings?.autoArchiveMergedChats !== true) {
        return "declined";
    }

    // Set by the settings write when the owner turned the setting on; a merge before it owes nothing.
    const since = settings.autoArchiveMergedChatsSince;

    // The one link the merge owed this chat, read by id: the cost does not grow with the links of the pull request.
    const link = await ctx.db.get("pullRequestThreads", args.linkId);

    if (
        !link ||
        link.userId !== thread.userId ||
        link.threadId !== args.threadId ||
        link.repository !== args.repository ||
        link.number !== args.number ||
        link.mergedAt === undefined ||
        link.mergeSettledAt !== undefined ||
        since === undefined ||
        link.mergedAt < since
    ) {
        // About this link alone (its merge predates the opt-in, say): the chat's other merges are not decided by it.
        return "link-declined";
    }

    // A merge that predates the chat's last archive was covered by that archive: a reopened chat is not archived again for it.
    if (thread.archivedAt !== undefined && link.mergedAt <= thread.archivedAt) {
        return "link-declined";
    }

    const pinnedProjectIds = await pinnedProjectIdsOf(ctx, thread);

    // Judged as if the run were over: a pin or any other permanent reason declines this merge for good, even while a run is
    // going, so unpinning the chat later cannot archive it for a merge that came while it was pinned. A run only defers.
    const candidate = candidateOf(thread);
    const judged = thread.status === "running" ? { ...candidate, status: "active" } : candidate;

    if (!isArchivable(judged, { liveThreadIds: new Set<string>(), pinnedProjectIds })) {
        return "declined";
    }

    // The same open-pull-request rule as the idle archive: a chat with another open link stays. The merge stays owed (busy):
    // when that link closes, the close handler tries again (`archiveClosedLinkChat`).
    if (keepsOpenPullRequestChats(settings?.keepOpenPullRequestChats) && (await threadHasOpenLink(ctx, thread.userId, args.threadId))) {
        return "busy";
    }

    if (thread.status === "running") {
        return "busy";
    }

    if (await archiveBlocked(ctx, args.threadId)) {
        return "busy";
    }

    await markThreadArchived(ctx, args.threadId);

    return "archived";
};

/**
 * One owed merge's archive and its settlement: the attempt, the link's settle, and (for a thread-wide answer) the chat's other
 * owed merges. Shared by the mutation and the close handler, so both settle the same way.
 */
const runMergedArchive = async (ctx: MutationCtx, args: MergedArchiveArgs): Promise<"archived" | "busy" | "declined"> => {
    // An attempt for a link already settled is stale (an earlier answer decided it): it must not settle the chat's other links,
    // which may belong to a merge recorded since and still owed an attempt of its own.
    const current = await ctx.db.get("pullRequestThreads", args.linkId);

    if (current?.mergeSettledAt !== undefined) {
        return "declined";
    }

    const outcome = await attemptMergedArchive(ctx, args);

    if (outcome === "busy") {
        await noteMergeAttemptRow(ctx, args.linkId, ctx.now);
    } else {
        await settleMergedLinkRow(ctx, args.linkId, ctx.now);
    }

    // A thread-wide final answer (archived, or a pin or other permanent reason) holds for the whole chat, so every other owed
    // link of the chat settles with it. A link-only decline settles just this link: another merge may still be eligible.
    if (outcome === "archived" || outcome === "declined") {
        await settleOwedSiblingRows(ctx, args.linkId, args.threadId, ctx.now);
    }

    return outcome === "link-declined" ? "declined" : outcome;
};

/**
 * Archives the chat for the first of its owed merges that is now eligible. A busy answer is thread-wide (a run, a request waiting on
 * the owner, an open request), so it holds for the other owed merges too: the walk stops there and leaves them owed. A decline about
 * one link keeps the walk going.
 */
const archiveOwedMergesOf = async (ctx: MutationCtx, userId: string, threadId: Id<"threads">): Promise<boolean> => {
    let archived = false;

    await someLinkOfThread(ctx, userId, threadId, async (row) => {
        if (row.mergedAt === undefined || row.mergeSettledAt !== undefined) {
            return false;
        }

        const outcome = await runMergedArchive(ctx, { linkId: row._id, number: row.number, repository: row.repository, threadId });

        if (outcome === "archived") {
            archived = true;
        }

        return outcome === "archived" || outcome === "busy";
    });

    return archived;
};

/**
 * Archives a chat linked to a pull request that has just merged, when the owner turned on `autoArchiveMergedChats`.
 * Called by `source-control` for each link the merge owes (`recordPullRequestMerged`), so a chat the person reopens later
 * is not archived again. The same guards as the idle archive keep the thread, re-read here. The answer says what to do
 * with the owed link: `archived` and `declined` are final, and settle the link in this transaction; `busy` (a run, a
 * request waiting on the owner, or a live guest link) is not, so the next read tries again.
 */
export const archiveMergedThread = internalMutation
    .input({ linkId: v.id("pullRequestThreads"), number: v.number(), repository: v.string().max(MAX_LENGTH.short), threadId: v.id("threads") })
    .output(v.union(v.literal("archived"), v.literal("busy"), v.literal("declined")))
    .mutation(async ({ args, ctx }) => await runMergedArchive(ctx, args));

const settleOwedSiblingRows = async (ctx: MutationCtx, linkId: Id<"pullRequestThreads">, threadId: Id<"threads">, at: number): Promise<void> => {
    const link = await ctx.db.get("pullRequestThreads", linkId);

    if (!link) {
        return;
    }

    await settleOwedMergesOf(ctx, link.userId, threadId, at);
};

/**
 * Whether the chat has any open linked request, read over every one of its links and stopping at the first open one. A merge
 * is not declined by a read cut short (the idle rule's bounded read keeps the chat instead).
 */
const threadHasOpenLink = async (ctx: MutationCtx, userId: string, threadId: Id<"threads">): Promise<boolean> =>
    await someLinkOfThread(ctx, userId, threadId, (row) => isOpenPullRequestForArchive(row));

const runAutoArchivePass = async (ctx: MutationCtx, cursor: string | null): Promise<void> => {
    const userId = currentUserShard();

    if (!userId) {
        return;
    }

    const settings = await ctx.db
        .query("userSettings")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique();
    const days = settings?.autoArchiveAfterDays;

    if (!isAutoArchiveDays(days) || days === 0) {
        return;
    }

    const cutoff = autoArchiveCutoff(ctx.now, days);
    const result = await runArchivePass({
        archiveBatch: ARCHIVE_BATCH,
        archiveIfStillDue: async (threadId) =>
            await ctx.runMutation(internal.agent.auto_archive.archiveIfStillIdle, { cutoff, threadId: threadId as Id<"threads"> }),
        cursor,
        fetchPage: async (pageCursor): Promise<ScanPage<AutoArchiveCandidate>> => {
            const page = await ctx.db
                .query("threads")
                .withIndex("by_user_and_updatedAt", (q) => q.eq("userId", userId).lt("updatedAt", cutoff))
                .order("desc")
                .paginate({ cursor: pageCursor, numItems: PAGE_SIZE });

            return {
                continueCursor: page.continueCursor,
                isDone: page.isDone,
                page: (page.page as unknown as Doc<"threads">[]).map((thread) => candidateOf(thread)),
            };
        },
        isDue: (candidate) => selectAutoArchiveDue([candidate], cutoff, NO_EXCLUSIONS, 1).length === 1,
        readBudget: READ_BUDGET,
    });

    if (result.continueCursor) {
        await ctx.scheduler.runAfter(RESUME_DELAY_MS, internal.agent.auto_archive.autoArchiveContinue, { cursor: result.continueCursor });
    }

    if (result.archived > 0) {
        ctx.log.event("chat.auto_archive", { archived: result.archived });
    }
};

/** The housekeeping sweep entry: a fresh pass from the newest idle thread. */
export const autoArchiveInactiveThreads = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx }) => {
        await runAutoArchivePass(ctx, null);

        return null;
    });

/** Resumes a pass that ran out of read budget, from the cursor it stopped at. */
export const autoArchiveContinue = internalMutation
    .input({ cursor: v.string().max(MAX_LENGTH.cursor) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await runAutoArchivePass(ctx, args.cursor);

        return null;
    });
