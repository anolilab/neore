/**
 * `POST /notifications/push-content` — the text of one notification, for the phone
 * that got a push carrying only its id (`native-push.ts`). The iOS Notification
 * Service Extension calls it before the alert shows; the Android app before it
 * builds the notification. Both send the session's short-lived JWT as a bearer.
 *
 * Owner-only: the text comes back only when the notification's owner is the
 * signed-in session's user. Another user's notification and a missing one answer
 * the same 404, so the route cannot be used to probe for ids. For a chat-linked
 * notification the chat is read when the request comes in, on the shard it lives
 * on (a collaborator's chat is on its owner's shard), since a lock, a delete or a
 * revoked grant can arrive after the push went out: text comes back only while the
 * caller can still read the chat and it is not locked, passcode-protected, deleted
 * or archived. Anything else, or a check that fails, answers `{ generic: true }`. A failure on our side is
 * logged and answers 503,
 * kept apart from "not found"; the phone shows its placeholder for anything but
 * a 200 with text.
 */
import type { HttpActionCtx } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import { callOnShard } from "../lib/cross-shard";
import { threadShardFor } from "../lib/thread-shard";

const NO_STORE = { "cache-control": "no-store" };

/** Lunora ids are short and plain (`[\w-]`); anything else is not one, and is refused before a read. */
const NOTIFICATION_ID = /^[\w-]{1,64}$/u;

export const pushContentHttpAction = async (context: HttpActionCtx, request: Request): Promise<Response> => {
    const userId = context.auth.userId as null | string | undefined;

    if (!userId) {
        return Response.json({ error: "UNAUTHORIZED" }, { headers: NO_STORE, status: 401 });
    }

    let notificationId: unknown;

    try {
        ({ notificationId } = (await request.json()) as { notificationId?: unknown });
    } catch {
        return Response.json({ error: "BAD_REQUEST" }, { headers: NO_STORE, status: 400 });
    }

    if (typeof notificationId !== "string" || !NOTIFICATION_ID.test(notificationId)) {
        return Response.json({ error: "BAD_REQUEST" }, { headers: NO_STORE, status: 400 });
    }

    let content: Awaited<ReturnType<typeof readContent>>;

    try {
        content = await readContent(context, notificationId as Id<"notifications">, userId);
    } catch (error) {
        // An unknown id reads as `null` above; reaching here is a failure on our side, not a missing notification.
        console.error("[notifications] push-content lookup failed:", error);

        return Response.json({ error: "UNAVAILABLE" }, { headers: NO_STORE, status: 503 });
    }

    if (!content) {
        return Response.json({ error: "NOT_FOUND" }, { headers: NO_STORE, status: 404 });
    }

    if ("generic" in content) {
        return Response.json(GENERIC, { headers: NO_STORE });
    }

    const { body, threadId, title } = content;

    if (threadId !== undefined) {
        let state: "locked" | "missing" | "open" | "unknown";

        try {
            state = await threadLockState(context, userId, threadId);
        } catch (error) {
            console.error("[notifications] push-content lock check failed:", error);
            state = "unknown";
        }

        // Text only for a chat we can see, right now, to be open.
        if (state !== "open") {
            return Response.json(GENERIC, { headers: NO_STORE });
        }
    }

    return Response.json({ body, title }, { headers: NO_STORE });
};

const GENERIC = { generic: true };

/** The chat's lock state on the shard it lives on: the caller's own, or its owner's for a chat shared with the caller. */
const threadLockState = async (context: HttpActionCtx, userId: string, threadId: string): Promise<"locked" | "missing" | "open"> => {
    const shardKey = await threadShardFor(context, userId, threadId);

    if (shardKey === userId) {
        return await context.runQuery(internal.notifications.push.readThreadLockState, { threadId, userId });
    }

    return await callOnShard(internal.notifications.push.readThreadLockState, { threadId, userId }, { shardKey });
};

const readContent = async (context: HttpActionCtx, notificationId: Id<"notifications">, userId: string) =>
    await context.runQuery(internal.notifications.push.loadPhonePushContent, { notificationId, userId });
