/**
 * What a phone may show for a push that carried only ids (`push-content-http.ts`): the owner's own notification, and
 * for a chat-linked one, whether the chat may still be named in text right now.
 */
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internalQuery } from "../_generated/server";
import { resolveThreadReadAccess } from "../agent/thread-read-access";
import { linksToLockedThread, threadIdOfLink } from "./locked-link";
import { pushHeadline } from "./push-text";

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
