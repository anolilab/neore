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
import { currentUserShard } from "../lib/shard-context";
import type { ScanPage } from "../lib/scan-pages";
import { type AutoArchiveCandidate, autoArchiveCutoff, isAutoArchiveDays, runArchivePass, selectAutoArchiveDue } from "./auto-archive-logic";
import { markThreadArchived } from "./threads";

/** Threads archived per pass. The rest wait for the next pass, which is idempotent. */
const ARCHIVE_BATCH = 100;
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
 * True when the thread has a pending or streaming stream. Pages the thread's own
 * stream rows until the first live one, so finished streams never hide it.
 */
const threadHasLiveStream = async (ctx: MutationCtx, threadId: Id<"threads">): Promise<boolean> => {
    let cursor: string | null = null;
    let isDone = false;

    while (!isDone) {
        const page = await ctx.db
            .query("persistentStreams")
            .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
            .paginate({ cursor, numItems: 50 });

        if (page.page.some((stream) => stream.status === "pending" || stream.status === "streaming")) {
            return true;
        }

        cursor = page.continueCursor;
        isDone = page.isDone;
    }

    return false;
};

/**
 * Archives one thread if, as read now, it is still due. The eligibility check runs
 * on the fresh row, its project's pin state and its live streams, in the same
 * transaction as the write, so nothing that happened after the scan is overwritten.
 */
export const archiveIfStillIdle = internalMutation
    .input({ cutoff: v.number(), threadId: v.id("threads") })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        const thread = await ctx.db.get(args.threadId);

        if (!thread) {
            return false;
        }

        const hasLiveStream = await threadHasLiveStream(ctx, args.threadId);

        // The project pin is read per thread, not from a capped list of pinned projects.
        const project = thread.projectId ? await ctx.db.projects.findFirst({ where: { _id: thread.projectId } }) : null;
        const pinnedProjectIds = new Set<string>(project && project.pinnedAt !== undefined && thread.projectId ? [thread.projectId] : []);

        const due = selectAutoArchiveDue(
            [candidateOf(thread)],
            args.cutoff,
            {
                liveThreadIds: new Set(hasLiveStream ? [args.threadId] : []),
                pinnedProjectIds,
            },
            1,
        );

        if (due.length === 0) {
            return false;
        }

        await markThreadArchived(ctx, args.threadId);

        return true;
    });

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
    .input({ cursor: v.string() })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await runAutoArchivePass(ctx, args.cursor);

        return null;
    });
