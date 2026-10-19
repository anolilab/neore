/**
 * Indexes a locked chat's existing attachments into `chatFileThreads`.
 *
 * The message writers link a file when they write it (`changeMessageFiles`), so a
 * chat that held attachments before the links existed has none. The lock gate
 * reads a chat's links only once its passcode row is stamped (`filesIndexedAt`);
 * until then it scans the messages (`files.ts`). This walks one chat's messages a
 * page at a time, links their files through `linkChatFiles`, and stamps the row
 * when the walk ends. Every later write links its own files, so the stamp holds.
 *
 * Runs on the owner's shard, where the messages and the passcode row live. A
 * stamped row makes a re-run a no-op; a row that is gone ends the walk.
 */
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { patchRow } from "../lib/patch";
import { runAfterOnShard } from "../lib/shard-scheduler";
import { MAX_LENGTH } from "../lib/validators";
import { linkChatFiles } from "./files";
import { readPasscodeRow } from "./thread-passcode";

/** Messages read per walk step. */
export const BACKFILL_PAGE = 100;

/** Queues the walk of one locked chat on its owner's shard. */
export const scheduleFileLinkBackfill = async (ctx: Pick<MutationCtx, "scheduler">, threadId: Id<"threads">, ownerId: string): Promise<void> => {
    await runAfterOnShard(ctx.scheduler, 0, internal.agent.file_link_backfill.backfillChatFileLinks, { threadId }, ownerId);
};

export const backfillChatFileLinks = internalMutation
    .input({
        cursor: v.optional(v.string().max(MAX_LENGTH.cursor)),
        threadId: v.id("threads"),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const row = await readPasscodeRow(ctx.db, args.threadId);

        // Unlocked (the row is gone) or already indexed: nothing to walk.
        if (!row || row.filesIndexedAt !== undefined) {
            return null;
        }

        const page = await ctx.db
            .query("messages")
            .withIndex("by_threadId_order_stepOrder", (q) => q.eq("threadId", args.threadId))
            .paginate({ cursor: args.cursor ?? null, numItems: BACKFILL_PAGE });

        await linkChatFiles(
            ctx,
            args.threadId,
            page.page.flatMap((message) => message.fileIds ?? []),
        );

        if (!page.isDone) {
            await runAfterOnShard(
                ctx.scheduler,
                0,
                internal.agent.file_link_backfill.backfillChatFileLinks,
                { cursor: page.continueCursor, threadId: args.threadId },
                row.userId,
            );

            return null;
        }

        // Stamped even if the thread is gone: the row is removed with it, and the sweep must not re-walk an orphan forever.
        await patchRow(ctx.db, row, { filesIndexedAt: Date.now() });

        return null;
    });

/**
 * The per-shard housekeeping sweep (`lib/shard-housekeeping.ts`): queues the walk
 * of every locked chat on this shard whose links are not indexed yet, so chats
 * locked before the index existed get it. ponytail: a full scan of this shard's
 * passcode rows, which are one owner's locked chats; index `filesIndexedAt` only
 * if a shard ever holds many.
 */
export const backfillUnindexedFileLinks = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx }) => {
        const rows = await ctx.db.query("threadPasscodes").collect();

        for (const row of rows) {
            if (row.filesIndexedAt === undefined) {
                await scheduleFileLinkBackfill(ctx, row.threadId, row.userId);
            }
        }

        return null;
    });
