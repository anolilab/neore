/**
 * The rows of a message the user sent into a running reply ("steering",
 * `chat/steering.ts`). Plain writes over `ctx.db`, in the caller's transaction:
 * which text, for which run and when is the caller's business.
 *
 * Where the rows go, by the parent rule of `branch-tree.ts`:
 *
 * - The steer row takes a FRESH `order` past every row of the thread (`max + 1`,
 *   `stepOrder` 0), the same place a tool-approval continuation takes
 *   (`continuationOrder`). It is inserted by `addMessagesHandler` with no prompt
 *   and no override order, so `resolveBranchParent` returns the explicit parent
 *   it is given, `pinFollowingRowParent` finds nothing after it, and the active
 *   leaf advances by the usual rule.
 * - Its explicit parent is the reply's last saved row: the tree parent of the
 *   run's pending row, which is the placeholder the previous step saved for the
 *   next one.
 * - That pending row moves to `(steer order, 1)`, just after the steer row in
 *   creation time too, and loses any explicit parent, so it follows the steer
 *   row implicitly. The run saves its later steps with
 *   the steer row as their prompt, after it (`agent/client/start.ts`).
 * - The reply's rows before the steer keep their place. No other row changes
 *   parent: a row after the pending row in storage order was pinned when the
 *   pending row went in. A row that is the pending row's child, by following it
 *   implicitly or by naming it as its parent, would be re-parented by the move
 *   (its reference would point forward), so the steer is refused instead.
 *
 * So a steered reply reads prompt → reply (its order) → steer → reply (the
 * steer's order). That is two ordinary turns in storage, and regenerate, edit
 * and fork work on either half as they would on any turn.
 */
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { patchRow } from "../lib/patch";
import { childrenOf, getThreadRow, parentOf } from "./branch-rows";
import { addMessagesHandler } from "./messages";

export interface SteerRowArgs {
    /** The run's pending row: where its next step will be saved. */
    pendingMessageId: string;
    text: string;
    threadId: Id<"threads">;
    /** The run's user, who sent the message. */
    userId: string;
}

/**
 * Inserts the steer row and moves the pending row under it. `null`, writing
 * nothing, when the run has no next step to steer (its pending row is gone or
 * settled) or when the move would re-parent another row.
 */
export const insertSteerRow = async (ctx: MutationCtx, args: SteerRowArgs): Promise<{ messageId: string } | null> => {
    const { threadId } = args;
    const pending = await getThreadRow(ctx, threadId, args.pendingMessageId);

    if (pending?.status !== "pending") {
        return null;
    }

    // Any row that is the pending row's child now (it names it as its parent, or
    // follows it implicitly) would change parent once the pending row moves away.
    const children = await childrenOf(ctx, threadId, pending);

    if (children.length > 0) {
        return null;
    }

    const parent = await parentOf(ctx, threadId, pending);

    if (!parent) {
        return null;
    }

    const { messages } = await addMessagesHandler(ctx, {
        messages: [{ message: { content: args.text, role: "user" } }],
        parentMessageId: parent._id,
        threadId,
        userId: args.userId,
    });

    const [steerRow] = messages;

    if (!steerRow) {
        return null;
    }

    await patchRow(ctx.db, pending, {
        // Readers that order by creation time (the extension) must see the continuation after the steer, as storage does.
        createdAt: (steerRow.createdAt ?? steerRow._creationTime) + 1,
        order: steerRow.order,
        stepOrder: steerRow.stepOrder + 1,
        ...(pending.parentMessageId !== undefined && { parentMessageId: undefined }),
    });

    return { messageId: steerRow._id };
};
