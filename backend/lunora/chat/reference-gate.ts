/**
 * The reference images of a media request (`/chat/media`), checked on the CALLER's shard.
 *
 * The picker lists every image the caller has, locked chats' included, and the request names each one by its URL and its id
 * (`file:<id>` or `doc:<id>`). A reference is refused unless its id is the caller's own row, its URL is that row's URL, and the
 * row's chat is one the caller may read here. The caller's files, documents and passcode rows live on the caller's shard, so
 * only that shard sees a lock of the caller's chat: the check cannot run on the thread's shard alone.
 */
import { REFERENCE_MEDIA_CAPS } from "@neore/ai/models";
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { internalQuery } from "../_generated/server";
import { MAX_LENGTH } from "../lib/validators";
import { threadGateOutcome } from "./lib/thread-gate";

const REFERENCE_ID = /^(file|doc):([\w-]+)$/u;

/** Whether the row's chat may be read by the caller. A row in no chat is the caller's own, so it may. */
const chatRefused = async (
    ctx: Pick<QueryCtx, "db">,
    { chatId, targetThreadId, unlockProof, userId }: { chatId: string | undefined; targetThreadId: string; unlockProof: string | undefined; userId: string },
): Promise<boolean> => {
    if (chatId === undefined) {
        return false;
    }

    // The request's proof opens its own chat only; another locked chat needs its own proof, which the request does not carry.
    const outcome = await threadGateOutcome(ctx, {
        level: "read",
        threadId: chatId as Id<"threads">,
        unlockProof: chatId === targetThreadId ? unlockProof : undefined,
        userId,
    });

    return outcome !== "ok";
};

/** Whether one reference is refused: not the caller's row, not that row's URL, or in a chat the caller may not read here. */
const referenceRefused = async (
    ctx: Pick<QueryCtx, "db">,
    {
        referenceId,
        referenceUrl,
        targetThreadId,
        unlockProof,
        userId,
    }: { referenceId: string; referenceUrl: string; targetThreadId: string; unlockProof: string | undefined; userId: string },
): Promise<boolean> => {
    const match = REFERENCE_ID.exec(referenceId);

    if (!match) {
        return true;
    }

    const [, kind = "", rowId = ""] = match;

    if (kind === "file") {
        const file = await ctx.db.get("files", rowId as Id<"files">);

        if (!file || file.userId !== userId || file.url !== referenceUrl) {
            return true;
        }

        return await chatRefused(ctx, { chatId: file.chatId, targetThreadId, unlockProof, userId });
    }

    const document = await ctx.db.get("documents", rowId as Id<"documents">);

    if (!document || document.userId !== userId || document.content !== referenceUrl) {
        return true;
    }

    return await chatRefused(ctx, { chatId: document.threadId, targetThreadId, unlockProof, userId });
};

/** Whether any of the request's references is refused. Ids and URLs are paired by position; the caller checks the counts. */
export const gateReferencesOnCallerShard = internalQuery
    .input({
        referenceIds: v.array(v.string().max(MAX_LENGTH.id)),
        referenceImages: v.array(v.string()),
        targetThreadId: v.string().max(MAX_LENGTH.id),
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
        userId: v.string(),
    })
    .output(v.object({ refused: v.boolean() }))
    .query(async ({ args, ctx }) => {
        // Refused before any read: the list is caller-controlled and the reads below run once per entry.
        if (args.referenceIds.length > REFERENCE_MEDIA_CAPS.images || args.referenceImages.length > REFERENCE_MEDIA_CAPS.images) {
            return { refused: true };
        }

        for (const [index, referenceId] of args.referenceIds.entries()) {
            const referenceUrl = args.referenceImages[index] ?? "";

            if (
                await referenceRefused(ctx, {
                    referenceId,
                    referenceUrl,
                    targetThreadId: args.targetThreadId,
                    unlockProof: args.unlockProof,
                    userId: args.userId,
                })
            ) {
                return { refused: true };
            }
        }

        return { refused: false };
    });
