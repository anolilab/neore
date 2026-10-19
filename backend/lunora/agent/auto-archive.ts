/**
 * Auto-archive: archives threads idle for the user's `autoArchiveAfterDays`.
 * Runs once per housekeeping pass on the user's own shard (`shardSweeps()` in
 * `lib/shard-housekeeping.ts`), not on a cron of its own. The eligibility rules
 * are in `auto-archive-logic.ts`.
 */
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import { internalMutation } from "../_generated/server";
import { currentUserShard } from "../lib/shard-context";
import { type AutoArchiveCandidate, autoArchiveCutoff, isAutoArchiveDays, selectAutoArchiveDue } from "./auto-archive-logic";

/** Threads archived per pass. The rest wait for the next pass, which is idempotent. */
const ARCHIVE_BATCH = 100;
// Scanned newest-idle first (`desc`), so the scan starts at the cutoff, where the threads that just
// went idle are. Archiving bumps `updatedAt`, so archived rows leave the window; pinned, deleted and
// running rows can stay in it, so only more than SCAN_LIMIT of them near the cutoff would hide the rest.
// ponytail: raise SCAN_LIMIT, or add a cursor, if that shows up.
const SCAN_LIMIT = 500;
const STREAM_SCAN_LIMIT = 200;

export const autoArchiveInactiveThreads = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx }) => {
        const userId = currentUserShard();

        if (!userId) {
            return null;
        }

        const settings = await ctx.db
            .query("userSettings")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .unique();
        const days = settings?.autoArchiveAfterDays;

        if (!isAutoArchiveDays(days) || days === 0) {
            return null;
        }

        const cutoff = autoArchiveCutoff(ctx.now, days);
        const candidates = await ctx.db
            .query("threads")
            .withIndex("by_user_and_updatedAt", (q) => q.eq("userId", userId).lt("updatedAt", cutoff))
            .order("desc")
            .take(SCAN_LIMIT);

        const { page: pinnedProjects } = await ctx.db.projects.findMany({
            limit: 200,
            where: { pinnedAt: { gte: 0 }, userId },
        });
        const liveThreadIds = new Set<string>();

        for (const status of ["pending", "streaming"]) {
            const streams = await ctx.db
                .query("persistentStreams")
                .withIndex("by_userId_status", (q) => q.eq("userId", userId).eq("status", status))
                .take(STREAM_SCAN_LIMIT);

            for (const stream of streams) {
                liveThreadIds.add(stream.threadId);
            }
        }

        const due = selectAutoArchiveDue(
            candidates.map((thread): AutoArchiveCandidate => {
                return {
                    _id: thread._id,
                    deleted: thread.deleted,
                    isTemporary: thread.isTemporary,
                    pinnedAt: thread.pinnedAt,
                    projectId: thread.projectId,
                    status: thread.status,
                    updatedAt: thread.updatedAt,
                };
            }),
            cutoff,
            {
                liveThreadIds,
                pinnedProjectIds: new Set(pinnedProjects.map((project) => project._id)),
            },
            ARCHIVE_BATCH,
        );

        // One at a time: each archive writes audited rows, and a batched fan-out nests the audit triggers.
        for (const threadId of due) {
            await ctx.runMutation(internal.agent.threads.archiveThread, { threadId: threadId as Id<"threads"> });
        }

        if (due.length > 0) {
            ctx.log.event("chat.auto_archive", { archived: due.length });
        }

        return null;
    });
