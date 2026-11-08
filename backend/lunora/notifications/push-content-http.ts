/**
 * `POST /notifications/push-content` — the text of one notification, for the phone
 * that got a push carrying only its id (`phone-delivery.ts`), before it shows the
 * alert. It signs in with the session's short-lived JWT as a bearer.
 *
 * Owner-only: the text comes back only when the notification's owner is the
 * signed-in session's user. Another user's notification and a missing one answer
 * the same 404, so the route cannot be used to probe for ids. Text only for a
 * notification that links to a chat (`phone-content.ts`): the chat is read when the
 * request comes in, on the shard it lives on (a collaborator's chat is on its
 * owner's shard), since a lock, a delete or a revoked grant can arrive after the
 * push went out, and text comes back only while the caller can still read the chat
 * and it is not locked, passcode-protected, deleted or archived. Anything else (any
 * other link, or a check that fails) answers `{ generic: true }`.
 * A failure on our side is logged and answers 503, kept apart from "not found";
 * the phone shows its placeholder for anything but a 200 with text.
 */
import type { HttpActionCtx } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import { callOnShard } from "../lib/cross-shard";
import { checkRateLimit } from "../lib/rate-limiter";
import { threadShardFor } from "../lib/thread-shard";

const NO_STORE = { "cache-control": "no-store" };

/** Lunora ids are short and plain (`[\w-]`); anything else is not one, and is refused (400) before a read. */
const NOTIFICATION_ID = /^[\w-]{1,64}$/u;

/** The body is one id in JSON; anything longer is refused while it is read, before it is buffered. */
export const PUSH_CONTENT_MAX_BODY_BYTES = 1024;

/** The body's text, or `undefined` once it passes {@link PUSH_CONTENT_MAX_BODY_BYTES}: read in chunks, never buffered whole. */
const readCappedBody = async (request: Request): Promise<string | undefined> => {
    if (Number(request.headers.get("Content-Length") ?? "0") > PUSH_CONTENT_MAX_BODY_BYTES) {
        return undefined;
    }

    const reader = request.body?.getReader();

    if (!reader) {
        return "";
    }

    const chunks: Uint8Array[] = [];
    let size = 0;

    for (;;) {
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        size += value.byteLength;

        if (size > PUSH_CONTENT_MAX_BODY_BYTES) {
            await reader.cancel();

            return undefined;
        }

        chunks.push(value);
    }

    const body = new Uint8Array(size);
    let offset = 0;

    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }

    return new TextDecoder().decode(body);
};

export const pushContentHttpAction = async (context: HttpActionCtx, request: Request): Promise<Response> => {
    const userId = context.auth.userId as null | string | undefined;

    if (!userId) {
        return Response.json({ error: "UNAUTHORIZED" }, { headers: NO_STORE, status: 401 });
    }

    // Per caller, before any read: each request costs a notification read and possibly a cross-shard chat check.
    // Fail open: the limiter only bounds read cost, so an outage of its store must not refuse every phone (the reads
    // are still owner-only and capped).
    const limited = await checkRateLimit(context, "notifications/pushContent", { failMode: "open", key: userId, throws: false });

    if (!limited.ok) {
        // `retryAfter` is in milliseconds; the header is in whole seconds, at least one.
        const retryAfter = String(Math.max(1, Math.ceil((limited.retryAfter ?? 0) / 1000)));

        return Response.json({ error: "RATE_LIMITED" }, { headers: { ...NO_STORE, "Retry-After": retryAfter }, status: 429 });
    }

    let raw: string | undefined;

    try {
        raw = await readCappedBody(request);
    } catch (error) {
        // The phone dropped the connection mid-body, most likely: logged, and answered as a bad request.
        console.warn("[notifications] push-content body could not be read:", error);

        return Response.json({ error: "BAD_REQUEST" }, { headers: NO_STORE, status: 400 });
    }

    if (raw === undefined) {
        return Response.json({ error: "PAYLOAD_TOO_LARGE" }, { headers: NO_STORE, status: 413 });
    }

    let notificationId: unknown;

    try {
        ({ notificationId } = JSON.parse(raw) as { notificationId?: unknown });
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

    return Response.json({ body, title }, { headers: NO_STORE });
};

const GENERIC = { generic: true };

/** The chat's lock state on the shard it lives on: the caller's own, or its owner's for a chat shared with the caller. */
const threadLockState = async (context: HttpActionCtx, userId: string, threadId: string): Promise<"locked" | "missing" | "open"> => {
    const shardKey = await threadShardFor(context, userId, threadId);

    if (shardKey === userId) {
        return await context.runQuery(internal.notifications.phone_content.readThreadLockState, { threadId, userId });
    }

    return await callOnShard(internal.notifications.phone_content.readThreadLockState, { threadId, userId }, { shardKey });
};

const readContent = async (context: HttpActionCtx, notificationId: Id<"notifications">, userId: string) =>
    await context.runQuery(internal.notifications.phone_content.loadPhonePushContent, { notificationId, userId });
