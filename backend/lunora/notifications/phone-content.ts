/**
 * What a phone may show for a push that carried only ids (`push-content-http.ts`): the owner's own notification, and
 * for a chat-linked one, whether the chat may still be named in text right now.
 */
import { v } from "lunorash/server";

import { findPendingRequestOnLatestTurn } from "../chat/lib/tool-approval-claim";
import { ASK_USER_TOOL_NAME } from "../chat/tools/ask-user-constants";
import { REQUEST_SECRET_TOOL_NAME } from "../chat/tools/request-secret-constants";
import type { Id } from "../_generated/dataModel";
import { internalQuery, type QueryCtx } from "../_generated/server";
import { resolveThreadReadAccess } from "../agent/thread-read-access";
import { isThreadLocked } from "../lib/thread-lock";
import { linksToLockedThread, threadIdOfLink } from "./locked-link";
import { pushHeadline } from "./push-text";

/** The teammate an approval push names when its chat has no teammate of its own. */
const DEFAULT_TEAMMATE = "Neore";

/** The tool a push names when the approval's call cannot be read back. */
const DEFAULT_TOOL = "A tool";

/**
 * What a phone shows for a push it got with only the notification id (`push-content-http.ts`): the owner's own
 * notification only, `null` for any other. Text only for a notification that links to a chat, so the chat's lock,
 * delete and share state can be checked when the phone asks; any other stays generic. A notification linking
 * elsewhere can still carry chat content (a task round's answer linked to `/tasks`, the Daily Brief naming chats)
 * with no chat to check, so it never gets text.
 */
export const loadPhonePushContent = internalQuery
    .input({ notificationId: v.id("notifications"), userId: v.string() })
    .output(
        v.union(
            v.null(),
            v.object({ generic: v.literal(true) }),
            // `threadId`: the chat the text is about. Its lock is checked again where the chat lives
            // (`push-content-http.ts`), since a collaborator's chat is on its owner's shard, not here.
            v.object({ body: v.string(), threadId: v.string(), title: v.string() }),
        ),
    )
    .query(async ({ args, ctx }) => {
        // `findFirst`, not `get`: a well-formed string that is no notification id reads as nothing (the same 404 as
        // another user's), never as a lookup error the route would report as an outage.
        const notification = await ctx.db.notifications.findFirst({ where: { _id: args.notificationId } });

        if (notification?.userId !== args.userId) {
            return null;
        }

        const threadId = threadIdOfLink(notification.link);

        if (threadId === undefined || (await linksToLockedThread(ctx.db, notification.link))) {
            return { generic: true as const };
        }

        return { ...pushHeadline(notification), threadId };
    });

/**
 * Whether a phone may show text about a chat right now, read on the shard the chat lives on, for the caller:
 * `open` only when the caller can still read the chat in full (owner, or an unexpired grant: `resolveThreadReadAccess`)
 * and it is neither deleted nor archived; `locked` for a lock or a passcode (both set `lockedAt`); `missing` for
 * anything else (deleted, archived, gone, or no longer the caller's to read). Only `open` lets text through.
 */
export const readThreadLockState = internalQuery
    .input({ threadId: v.string(), userId: v.string() })
    .output(v.union(v.literal("locked"), v.literal("missing"), v.literal("open")))
    .query(async ({ args, ctx }) => {
        const access = await resolveThreadReadAccess(ctx, args.threadId as Id<"threads">, args.userId);

        if (access?.kind === "locked") {
            return "locked" as const;
        }

        if (access?.kind !== "full" || access.thread.deleted === true || access.thread.status === "archived") {
            return "missing" as const;
        }

        return "open" as const;
    });

/**
 * The names a tool approval's push shows on a phone: the tool and the teammate, read where the chat lives. `null` when the
 * approval is no longer pending on its chat (answered, or the conversation moved on), the chat is locked or deleted, or the
 * caller does not own it: no push is sent for any of them.
 */
export const approvalPushNames = async (
    ctx: Pick<QueryCtx, "db">,
    args: { approvalId: string; threadId: string; userId: string },
): Promise<{ teammate: string; tool: string } | null> => {
    const thread = await ctx.db.get("threads", args.threadId as Id<"threads">);

    if (!thread || thread.userId !== args.userId || thread.deleted === true || isThreadLocked(thread) || thread.status === "archived") {
        return null;
    }

    // The request must still be answerable: its approval row belongs to this chat and owner, and is pending. A request that a
    // claim, an abandon or a purge settled can still sit in the message history, and must not reach the phone with its controls.
    const [run] = await ctx.db
        .query("toolApprovalRuns")
        .withIndex("by_approvalId", (q) => q.eq("approvalId", args.approvalId))
        .take(1);

    if (!run || run.threadId !== args.threadId || run.userId !== args.userId || run.status !== "pending") {
        return null;
    }

    const request = await findPendingRequestOnLatestTurn(ctx, thread._id, args.approvalId);

    // A question and a secret request are answered with text or a value, not approved: the in-app card does the same.
    if (!request || request.toolName === ASK_USER_TOOL_NAME || request.toolName === REQUEST_SECRET_TOOL_NAME) {
        return null;
    }

    // The teammate is the thread's bot, when it has one; a plain chat is named for the app.
    const bot = thread.botId ? await ctx.db.get("bots", thread.botId) : null;

    return { teammate: bot?.name ?? DEFAULT_TEAMMATE, tool: request.toolName ?? DEFAULT_TOOL };
};

/**
 * What the phone job reads for a tool approval: its names, `{ locked: true }` for the caller's own locked chat (the job then sends
 * the generic alert, which never names the tool), or `null` when the approval is answered, foreign or gone (no push at all).
 */
export const loadApprovalForPush = internalQuery
    .input({ approvalId: v.string(), threadId: v.string(), userId: v.string() })
    .output(v.union(v.null(), v.object({ locked: v.literal(true) }), v.object({ teammate: v.string(), tool: v.string() })))
    .query(async ({ args, ctx }) => {
        const thread = await ctx.db.get("threads", args.threadId as Id<"threads">);

        if (thread && thread.userId === args.userId && thread.deleted !== true && isThreadLocked(thread)) {
            return { locked: true as const };
        }

        return await approvalPushNames(ctx, args);
    });
