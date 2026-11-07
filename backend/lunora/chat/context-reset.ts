/**
 * `/clear`: starts a fresh model context in the same thread. The rows stay in the thread. A context reset row marks
 * where the model's context starts again (`agent/context-reset.ts`), so nothing before it is sent. On a coding agent's
 * thread the agent gets a new session in the same thread instead (`acp/switch.ts#clearHostSession`).
 *
 * The action gates the call and picks the runner; the writes are internal mutations.
 */
import { LunoraError, v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { isHostRunThread } from "../acp/lib/host-thread";
import { CONTEXT_CLEAR_CONFLICT } from "../agent/context-reset-shape";
import { leafRowOf } from "../agent/agent-switch";
import { refreshContextResetPointer } from "../agent/context-reset";
import { getMaxMessage } from "../agent/messages";
import { insertContextResetRow, patchThread } from "../agent/table-writes";
import { requireThreadPermission } from "../agent/thread-read-access";
import { claimOnce } from "../lib/claim-once";
import { authAction, rateLimit } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";
import { assertNotStreaming, assertReplyStarted } from "./agent-switch";
import { throwUnlessGranted } from "./lib/thread-gate";

/** How long a click id stays claimed: a repeat of the same click inside it is refused rather than writing a second reset. */
const CLEAR_CLAIM_TTL_MS = 10 * 60 * 1000;

export const clearContextRowHandler = async (
    ctx: MutationCtx,
    args: { clientId: string; threadId: Id<"threads">; unlockProof?: string; userId: string },
): Promise<{ messageId: string }> => {
    const { thread } = await requireThreadPermission(ctx, args.threadId, args.userId, "write", args.unlockProof);

    // The context is shared by everyone who can write the chat; only the owner resets it, as only the owner compacts it.
    if (thread.userId !== args.userId) {
        throw new LunoraError("FORBIDDEN", "Only the owner of a chat can clear its context");
    }

    if (isHostRunThread(thread)) {
        throw new LunoraError("BAD_REQUEST", "A coding agent's chat clears through its session");
    }

    if (thread.groupChat) {
        throw new LunoraError("BAD_REQUEST", "A group chat has no single context to clear");
    }

    const leaf = await leafRowOf(ctx, thread);

    // A reply running, or a prompt saved whose reply has not started yet (its stream is created by a later mutation): a
    // divider written then would sit under that prompt, and the reply would land beside it, off the path shown.
    try {
        await assertNotStreaming(ctx, thread);

        if (leaf) {
            await assertReplyStarted(ctx, thread, leaf);
        }
    } catch {
        throw new LunoraError("CONFLICT", "Wait for the reply to finish, or stop it, before clearing the context", {
            data: { code: CONTEXT_CLEAR_CONFLICT.replyRunning },
        });
    }

    if (!(await claimOnce(ctx, "context-clear", `${args.userId}:${thread._id}:${args.clientId}`, CLEAR_CLAIM_TTL_MS, args.userId))) {
        throw new LunoraError("CONFLICT", "This clear was already made", { data: { code: CONTEXT_CLEAR_CONFLICT.alreadyMade } });
    }

    // Past every row, so a sibling branch's `order` is never reused; a branched thread also names its parent.
    const last = await getMaxMessage(ctx, thread._id);
    const messageId = await insertContextResetRow(ctx.db, {
        order: (last?.order ?? -1) + 1,
        ...(thread.activeLeafMessageId && leaf && { parentMessageId: leaf._id }),
        threadId: thread._id,
        userId: args.userId,
    });

    await patchThread(ctx.db, thread._id, {
        contextResetMessageId: messageId,
        hasContextReset: true,
        // A branched thread's path ends at the row just written.
        ...(thread.activeLeafMessageId && { activeLeafMessageId: messageId }),
        // A path found too long for summaries is read from the reset now: the next summary job reads it again at once.
        ...(thread.summaryPathTooLongAt !== undefined && { summaryPathTooLongAt: 0 }),
        updatedAt: Date.now(),
    });

    return { messageId };
};

export const clearContextRow = internalMutation
    .input({
        clientId: v.string().max(MAX_LENGTH.id),
        threadId: v.id("threads"),
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.object({ messageId: v.string() }))
    .mutation(async ({ args, ctx }) => await clearContextRowHandler(ctx, args));

/** A fork copied a context reset (`/clear`): the copy is marked too, so its context is cut at the reset as the source's is. */
export const markForkedContextReset = internalMutation
    .input({ threadId: v.id("threads") })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        await patchThread(ctx.db, args.threadId, { hasContextReset: true });

        // The copy's active path ends at its leaf: its pointer is the reset on that path, which the copy carries.
        const thread = await ctx.db.get("threads", args.threadId);
        const leaf = thread ? await leafRowOf(ctx, thread) : null;

        if (leaf) {
            await refreshContextResetPointer(ctx, args.threadId, leaf._id);
        }

        return true;
    });

export const clearContext = authAction
    .use(rateLimit("chat/update"))
    .input({
        /** One id per click: the coding-agent path keys its new session on it, so a repeated delivery makes no second one. */
        clientId: v.string().max(MAX_LENGTH.id),
        threadId: v.id("threads"),
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
    })
    .output(v.object({ hostSession: v.boolean(), messageId: v.string() }))
    .action(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const gate = await ctx.runQuery(internal.chat.functions.gateThreadAction, {
            level: "write",
            threadId: args.threadId,
            unlockProof: args.unlockProof,
            userId,
        });

        throwUnlessGranted(gate.outcome, "Access denied to this thread");

        const hostSession = await ctx.runQuery(internal.acp.switch.isHostSwitchSource, { threadId: args.threadId });
        const result = hostSession
            ? await ctx.runMutation(internal.acp.switch.clearHostSession, {
                  clientId: args.clientId,
                  threadId: args.threadId,
                  unlockProof: args.unlockProof,
                  userId,
              })
            : await ctx.runMutation(internal.chat.context_reset.clearContextRow, {
                  clientId: args.clientId,
                  threadId: args.threadId,
                  unlockProof: args.unlockProof,
                  userId,
              });

        ctx.log.event("chat.clear_context", { hostSession, threadId: args.threadId });

        return { hostSession, messageId: result.messageId };
    });
