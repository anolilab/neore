/**
 * Messenger connection CRUD functions.
 *
 * Exposed via cRPC for the frontend settings page. Handles creating,
 * listing, updating, and deleting messenger platform connections.
 */
import { LunoraError } from "lunorash/server";
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { changeRefcount } from "../agent/files";
import { insertMessageRow, insertThread, patchMessage, patchThread } from "../agent/table-writes";
import { claimOnce, MESSENGER_CLAIM_TTL_MS } from "../lib/claim-once";
import { timingSafeEqual } from "../lib/crypto";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { getUserTier } from "../lib/rate-limiter";
import { chargeRound, loadTaskAccount, taskAccessProblem } from "../tasks/account";
import { patchRow, withoutUndefined } from "../lib/patch";
import { generatePairingCode, hashPairingCode, PAIRING_CODE_TTL_MS } from "./lib/pairing";
import { deleteShardRoute, setShardRoute } from "../lib/shard-routes";
import { ownedStorageKeys } from "../lib/storage-ownership";
import { isStorageRef, STORAGE_REF_PREFIX } from "../lib/storage-ref";
import { MESSENGER_MAX_OUTBOUND_FILES } from "./lib/media";
import { MESSENGER_REPLY_TOOL_GROUPS, normalizeReplyToolGroups } from "./lib/reply-tools";
import { MAX_LENGTH } from "../lib/validators";

const messengerPlatformSchema = v.union(
    v.literal("telegram"),
    v.literal("slack"),
    v.literal("discord"),
    v.literal("whatsapp"),
    v.literal("line"),
    v.literal("feishu"),
    v.literal("teams"),
    v.literal("wechat"),
);
const connectionStatusSchema = v.union(v.literal("active"), v.literal("paused"), v.literal("disconnected"));

// ============================================================================
// cRPC-exposed queries/mutations (authenticated)
// ============================================================================

/**
 * List all messenger connections for the current user.
 *
 * Native `v.*` validators, not `v.from(zod)`: codegen cannot infer through the
 * zod wrapper, so the generated reference was `unknown` and every field read on
 * the frontend failed. The optional columns are declared as `T | null` — not
 * `T | undefined` — because the handler deliberately coerces absent values with
 * `?? null` so the wire shape has a stable key set.
 *
 * `metadata` is `v.any()` (inferring `unknown`, not `any`) because the column
 * itself is `v.any()` in the schema. Nothing writes anything but `null` into it
 * today; declaring it `v.null()` would make the query throw the day something
 * does.
 */
export const getConnections = authQuery
    .output(
        v.array(
            v.object({
                _creationTime: v.number(),
                _id: v.id("messengerConnections"),
                connectedAt: v.number(),
                displayName: v.union(v.string(), v.null()),
                lastMessageAt: v.union(v.number(), v.null()),
                metadata: v.any(),
                /** Whether a platform contact has paired (`/pair <code>`); only a paired contact is answered. */
                paired: v.boolean(),
                /** When the outstanding pairing code expires, if one is outstanding. The code itself is never readable. */
                pairingCodeExpiresAt: v.union(v.number(), v.null()),
                platform: v.union(
                    v.literal("telegram"),
                    v.literal("slack"),
                    v.literal("discord"),
                    v.literal("whatsapp"),
                    v.literal("line"),
                    v.literal("feishu"),
                    v.literal("teams"),
                    v.literal("wechat"),
                ),
                platformChatId: v.union(v.string(), v.null()),
                platformUserId: v.union(v.string(), v.null()),
                platformUsername: v.union(v.string(), v.null()),
                /** Tools for replies: off unless the owner enabled them; `groups` normalised (`messenger/lib/reply-tools.ts`). */
                replyTools: v.object({ enabled: v.boolean(), groups: v.array(v.string()) }),
                status: v.union(v.literal("active"), v.literal("paused"), v.literal("disconnected")),
                userId: v.string(),
            }),
        ),
    )
    .query(async ({ ctx: context }) => {
        const { userId } = context.user;

        const connections = await context.db
            .query("messengerConnections")
            .withIndex("by_user_and_platform", (q) => q.eq("userId", userId))
            .collect();

        return connections.map((c) => {
            return {
                _creationTime: c._creationTime,
                _id: c._id,
                connectedAt: c.connectedAt,
                displayName: c.displayName ?? null,
                lastMessageAt: c.lastMessageAt ?? null,
                metadata: c.metadata ?? null,
                paired: Boolean(c.platformUserId),
                pairingCodeExpiresAt: c.pairingCodeHash && c.pairingCodeExpiresAt ? c.pairingCodeExpiresAt : null,
                platform: c.platform,
                platformChatId: c.platformChatId ?? null,
                platformUserId: c.platformUserId ?? null,
                platformUsername: c.platformUsername ?? null,
                replyTools: { enabled: c.replyTools?.enabled === true, groups: normalizeReplyToolGroups(c.replyTools?.groups) },
                status: c.status,
                userId: c.userId,
            };
        });
    });

/** A fresh pairing code: its hash and expiry go on the row, the code goes back once to the owner. */
const newPairingCode = async (): Promise<{ code: string; expiresAt: number; hash: string }> => {
    const code = generatePairingCode();

    return { code, expiresAt: Date.now() + PAIRING_CODE_TTL_MS, hash: await hashPairingCode(code) };
};

const vPairingCodeOutput = v.object({ pairingCode: v.string(), pairingCodeExpiresAt: v.number() });

/**
 * Create (or reactivate) a messenger connection.
 *
 * A NEW connection answers nobody until a contact sends `/pair <code>`; the code
 * is returned here, once. A reactivated connection keeps its paired contact and
 * gets no code (`regeneratePairingCode` re-pairs it).
 */
export const createConnection = authMutation
    .use(rateLimit("messenger/connect"))
    .input({
        displayName: v.optional(v.string().max(MAX_LENGTH.short)),
        platform: v.from(messengerPlatformSchema),
    })
    .output(v.object({ connectionId: v.string(), pairingCode: v.union(v.string(), v.null()), pairingCodeExpiresAt: v.union(v.number(), v.null()) }))
    .mutation(async ({ args: { displayName, platform }, ctx: context }) => {
        const { userId } = context.user;

        // Check for existing active connection on this platform
        const existing = await context.db
            .query("messengerConnections")
            .withIndex("by_user_and_platform", (q) => q.eq("userId", userId).eq("platform", platform))
            .first();

        if (existing && existing.status === "active") {
            throw new LunoraError("CONFLICT", `You already have an active ${platform} connection. Disconnect it first.`);
        }

        // If there's a disconnected one, reactivate it
        if (existing) {
            const pairing = existing.platformUserId ? null : await newPairingCode();

            await context.db.patch(
                existing._id,
                withoutUndefined({
                    connectedAt: context.now,
                    displayName: displayName ?? existing.displayName,
                    pairingCodeExpiresAt: pairing?.expiresAt,
                    pairingCodeHash: pairing?.hash,
                    status: "active",
                }),
            );

            context.log.event("messenger.create_connection", { platform, reactivated: true });

            return { connectionId: existing._id as string, pairingCode: pairing?.code ?? null, pairingCodeExpiresAt: pairing?.expiresAt ?? null };
        }

        const pairing = await newPairingCode();
        const insertedId = await context.db.insert("messengerConnections", {
            connectedAt: context.now,
            displayName: displayName ?? null,
            lastMessageAt: null,
            metadata: null,
            pairingCodeExpiresAt: pairing.expiresAt,
            pairingCodeHash: pairing.hash,
            platform,
            platformChatId: null,
            platformUserId: null,
            platformUsername: null,
            status: "active",
            userId,
        });

        // Its webhook names only the connection; this is how it finds the shard.
        await setShardRoute(context, "messenger", insertedId as string, userId);

        context.log.event("messenger.create_connection", { platform, reactivated: false });

        return { connectionId: insertedId as string, pairingCode: pairing.code, pairingCodeExpiresAt: pairing.expiresAt };
    });

/**
 * Issue a new pairing code for one of the caller's connections. This UNPAIRS the
 * current contact: the bot answers nobody until the new code is sent. The code is
 * returned once; only its hash is stored.
 */
export const regeneratePairingCode = authMutation
    .use(rateLimit("messenger/connect"))
    .input({ connectionId: v.id("messengerConnections") })
    .output(vPairingCodeOutput)
    .mutation(async ({ args: { connectionId }, ctx: context }) => {
        const connection = await context.db.get(connectionId);

        if (!connection || connection.userId !== context.user.userId) {
            throw new LunoraError("NOT_FOUND", "Connection not found");
        }

        const pairing = await newPairingCode();

        await patchRow(context.db, connection, {
            pairingCodeExpiresAt: pairing.expiresAt,
            pairingCodeHash: pairing.hash,
            platformChatId: undefined,
            platformUserId: undefined,
            platformUsername: undefined,
        });

        context.log.event("messenger.regenerate_pairing_code", { connectionId });

        return { pairingCode: pairing.code, pairingCodeExpiresAt: pairing.expiresAt };
    });

/** Update a messenger connection status (pause/resume/disconnect) */
export const updateConnectionStatus = authMutation
    .use(rateLimit("messenger/disconnect"))
    .input({
        connectionId: v.string().max(MAX_LENGTH.id),
        status: v.from(connectionStatusSchema),
    })
    .mutation(async ({ args: { connectionId, status }, ctx: context }) => {
        const { userId } = context.user;

        const connection = await context.db.get(connectionId as Id<"messengerConnections">);

        if (!connection) {
            throw new LunoraError("NOT_FOUND", "Connection not found");
        }

        if (connection.userId !== userId) {
            throw new LunoraError("FORBIDDEN", "Not your connection");
        }

        await context.db.patch(connection._id, { status });

        context.log.event("messenger.update_connection_status", { status });
    });

/**
 * Turn tools on or off for a connection's replies and pick their groups. Only
 * the owner, only through the app — nothing a platform message says reaches
 * this setting.
 */
export const updateConnectionReplyTools = authMutation
    .use(rateLimit("messenger/connect"))
    .input({
        connectionId: v.id("messengerConnections"),
        enabled: v.boolean(),
        groups: v
            .array(v.string().max(MAX_LENGTH.short))
            .check((value) => value.length <= MESSENGER_REPLY_TOOL_GROUPS.length, { message: "Too many tool groups" }),
    })
    .output(v.null())
    .mutation(async ({ args: { connectionId, enabled, groups }, ctx: context }) => {
        const connection = await context.db.get(connectionId);

        if (!connection || connection.userId !== context.user.userId) {
            throw new LunoraError("NOT_FOUND", "Connection not found");
        }

        await context.db.patch(connection._id, { replyTools: { enabled, groups: normalizeReplyToolGroups(groups) } });

        context.log.event("messenger.update_connection_reply_tools", { enabled, groupCount: groups.length });

        return null;
    });

/** Delete a messenger connection */
export const deleteConnection = authMutation
    .use(rateLimit("messenger/disconnect"))
    .input({
        connectionId: v.string().max(MAX_LENGTH.id),
    })
    .mutation(async ({ args: { connectionId }, ctx: context }) => {
        const { userId } = context.user;

        const connection = await context.db.get(connectionId as Id<"messengerConnections">);

        if (!connection) {
            throw new LunoraError("NOT_FOUND", "Connection not found");
        }

        if (connection.userId !== userId) {
            throw new LunoraError("FORBIDDEN", "Not your connection");
        }

        await context.db.delete(connection._id);
        await deleteShardRoute(context, "messenger", connection._id);

        context.log.event("messenger.delete_connection", { platform: connection.platform });
    });

// ============================================================================
// Internal functions (used by webhook handlers)
// ============================================================================

/**
 * The rate-limit tier of a connection's OWNER, for the inbound webhook path.
 *
 * Webhooks carry no session, so the tier has to come from the user row. Same
 * rule as the chat HTTP path (`getUserTier`): admins get premium, everyone else
 * free, and a missing owner falls back to free rather than failing the message.
 */
export const getOwnerRateLimitTier = internalQuery
    .input({ userId: v.string() })
    .output(v.union(v.literal("free"), v.literal("premium")))
    .query(async ({ args: { userId }, ctx }) => {
        const owner = await ctx.db.user.findFirst({ where: { _id: userId as Id<"user"> } });
        const ownerTierInput = owner ? { isAdmin: owner.role === "admin", plan: (owner as { plan?: "premium" | null }).plan } : null;

        return getUserTier(ownerTierInput) === "premium" ? "premium" : "free";
    });

export const getConnectionById = internalQuery
    .input({
        connectionId: v.id("messengerConnections"),
    })
    .query(async ({ args: { connectionId }, ctx }) => ctx.db.get(connectionId));

export const getConnectionByPlatformChat = internalQuery
    .input({
        platform: v.string(),
        platformChatId: v.string(),
    })
    .query(async ({ args: { platform, platformChatId }, ctx }) => {
        // `platform` arrives as a bare string (webhook path segment) but the index
        // is keyed on the literal union, so narrow before querying.
        const parsed = messengerPlatformSchema.safeParse(platform);

        if (!parsed.ok) {
            return null;
        }

        return ctx.db
            .query("messengerConnections")
            .withIndex("by_platform_and_chatId", (q) => q.eq("platform", parsed.value).eq("platformChatId", platformChatId))
            .first();
    });

export const getConnectionByPlatformUser = internalQuery
    .input({
        platform: v.string(),
        platformUserId: v.string(),
    })
    .query(async ({ args: { platform, platformUserId }, ctx }) => {
        // See `getConnectionByPlatformChat`: the index needs the literal union.
        const parsed = messengerPlatformSchema.safeParse(platform);

        if (!parsed.ok) {
            return null;
        }

        return ctx.db
            .query("messengerConnections")
            .withIndex("by_platform_and_userId", (q) => q.eq("platform", parsed.value).eq("platformUserId", platformUserId))
            .first();
    });

/**
 * Bind the sender of a `/pair <code>` message to an UNPAIRED connection when the
 * code matches and has not expired. Check and write share one transaction, and
 * the code is consumed, so two racing senders cannot both pair.
 */
export const pairConnection = internalMutation
    .input({
        codeHash: v.string(),
        connectionId: v.id("messengerConnections"),
        displayName: v.optional(v.string()),
        platformChatId: v.string(),
        platformUserId: v.string(),
        platformUsername: v.optional(v.string()),
    })
    .output(v.boolean())
    .mutation(async ({ args: { codeHash, connectionId, displayName, platformChatId, platformUserId, platformUsername }, ctx }) => {
        const connection = await ctx.db.get(connectionId);

        if (
            !connection ||
            connection.platformUserId ||
            !connection.pairingCodeHash ||
            !connection.pairingCodeExpiresAt ||
            connection.pairingCodeExpiresAt < ctx.now ||
            !timingSafeEqual(connection.pairingCodeHash, codeHash)
        ) {
            return false;
        }

        await patchRow(ctx.db, connection, {
            pairingCodeExpiresAt: undefined,
            pairingCodeHash: undefined,
            platformChatId,
            platformUserId,
            ...(platformUsername && { platformUsername }),
            ...(displayName && { displayName }),
        });

        return true;
    });

export const touchConnection = internalMutation
    .input({
        connectionId: v.id("messengerConnections"),
    })
    .mutation(async ({ args: { connectionId }, ctx }) => {
        await ctx.db.patch(connectionId, { lastMessageAt: ctx.now });
    });

export const findOrCreateMessengerThread = internalMutation
    .input({
        externalThreadId: v.string(),
        messengerConnectionId: v.id("messengerConnections"),
        source: v.string(),
        title: v.optional(v.string()),
        userId: v.string(),
    })
    .mutation(async ({ args: { externalThreadId, messengerConnectionId, source, title, userId }, ctx }) => {
        // Look for existing thread with this external ID using the compound index
        const existing = await ctx.db
            .query("threads")
            .withIndex("by_userId_externalThreadId", (q) => q.eq("userId", userId).eq("externalThreadId", externalThreadId))
            .first();

        if (existing && !existing.deleted) {
            return { isNew: false, threadId: existing._id };
        }

        // Create a new thread
        const threadId = await insertThread(ctx.db, {
            externalThreadId,
            messengerConnectionId,
            source,
            status: "active",
            tags: [source],
            title: title ?? `${source.charAt(0).toUpperCase() + source.slice(1)} Chat`,
            updatedAt: ctx.now,
            userId,
        });

        return { isNew: true, threadId };
    });

/** A stored attachment as a message part: a `storage:` reference, signed when the message is read. */
const vStoredMediaPart = v.union(
    v.object({ image: v.string(), mediaType: v.string(), type: v.literal("image") }),
    v.object({ data: v.string(), filename: v.optional(v.string()), mediaType: v.string(), type: v.literal("file") }),
);

/**
 * Save a sender's message, in the webhook — so every message takes its place
 * in the thread in ARRIVAL order. A media message is saved `pending` there
 * (its caption only) and completed by the reply action once its attachments
 * are stored ({@link completeMessengerMessage}): `parts` for what the model
 * reads directly (images, PDFs) and `fileIds` for every stored file, which is
 * what lets a part be signed (`agent/stored-media.ts`) and keeps the files
 * counted while the message exists.
 */
export const saveMessengerMessage = internalMutation
    .input({
        fileIds: v.optional(v.array(v.id("chatFiles"))),
        parts: v.optional(v.array(vStoredMediaPart)),
        /** A media message whose attachments are still being downloaded. */
        pending: v.optional(v.boolean()),
        text: v.string(),
        threadId: v.id("threads"),
        userId: v.string(),
    })
    .output(v.object({ messageId: v.id("messages"), order: v.number() }))
    .mutation(async ({ args: { fileIds, parts, pending, text, threadId, userId }, ctx }) => {
        // Get next order number
        const lastMessage = await ctx.db
            .query("messages")
            .withIndex("by_threadId_order_stepOrder", (q) => q.eq("threadId", threadId))
            .order("desc")
            .first();

        const order = lastMessage ? (lastMessage.order ?? 0) + 1 : 0;
        const attached = fileIds && fileIds.length > 0 ? fileIds : undefined;
        const messageId = await insertMessageRow(ctx.db, {
            ...(attached && { fileIds: attached }),
            message: {
                content: [...(text ? [{ text, type: "text" as const }] : []), ...(parts ?? [])],
                role: "user",
            },
            order,
            status: pending ? "pending" : "completed",
            stepOrder: 0,
            text,
            threadId,
            tool: false,
            userId,
        });

        if (attached) {
            await changeRefcount(ctx, [], attached);
        }

        // Update thread timestamp
        await patchThread(ctx.db, threadId, { updatedAt: ctx.now });

        return { messageId, order };
    });

/**
 * Complete a media message the webhook saved `pending`: its stored
 * attachments go in after the text, in the place it already holds. `false`
 * when the row is gone (the thread was deleted meanwhile).
 */
export const completeMessengerMessage = internalMutation
    .input({
        fileIds: v.optional(v.array(v.id("chatFiles"))),
        messageId: v.id("messages"),
        parts: v.optional(v.array(vStoredMediaPart)),
        text: v.string(),
    })
    .output(v.boolean())
    .mutation(async ({ args: { fileIds, messageId, parts, text }, ctx }) => {
        const row = await ctx.db.get(messageId);

        if (!row) {
            return false;
        }

        const attached = fileIds && fileIds.length > 0 ? fileIds : undefined;

        await patchMessage(ctx.db, messageId, {
            ...(attached && { fileIds: attached }),
            message: { content: [...(text ? [{ text, type: "text" as const }] : []), ...(parts ?? [])], role: "user" },
            status: "completed",
            text,
        });

        if (attached) {
            await changeRefcount(ctx, (row.fileIds ?? []) as Id<"chatFiles">[], attached);
        }

        return true;
    });

/** Messages scanned for the sender's newest and any still-pending one. */
const REPLY_SCAN = 40;

/**
 * A media message still `pending` after this long is taken as abandoned (its
 * reply action died), so it no longer holds back the thread's replies.
 */
export const MESSENGER_PENDING_STALE_MS = 10 * 60 * 1000;

const MESSENGER_REPLY_SCOPE = "messenger-reply";

/** Pure: which of the thread's newest rows (newest first) a reply may answer now — see {@link claimThreadReply}. */
export const planThreadReply = (
    rows: ReadonlyArray<{ _creationTime: number; _id: string; message?: unknown; status: string }>,
    now: number,
): { newestUserMessageId: string } | { waitFor: "pending-media" } | undefined => {
    const users = rows.filter((row) => (row.message as { role?: string } | undefined)?.role === "user");

    if (users.some((row) => row.status === "pending" && now - row._creationTime < MESSENGER_PENDING_STALE_MS)) {
        return { waitFor: "pending-media" };
    }

    const [newest] = users;

    return newest ? { newestUserMessageId: newest._id } : undefined;
};

/**
 * Whether this reply action should answer now, and to what. Messages arrive
 * one reply action each, but a burst gets ONE reply: the first action to
 * find nothing still being downloaded claims the thread's newest message and
 * answers everything up to it; the others find the claim taken. While a media
 * message is still pending nobody answers — its own action answers once it
 * is complete, so "photo, then text" is answered once, with the photo.
 */
export const claimThreadReply = internalMutation
    .input({ threadId: v.id("threads"), userId: v.string() })
    .output(v.union(v.object({ claimed: v.literal(true), newestUserMessageId: v.string() }), v.object({ claimed: v.literal(false) })))
    .mutation(async ({ args: { threadId, userId }, ctx }) => {
        const rows = await ctx.db
            .query("messages")
            .withIndex("by_threadId_order_stepOrder", (q) => q.eq("threadId", threadId))
            .order("desc")
            .take(REPLY_SCAN);
        const plan = planThreadReply(rows, ctx.now);

        if (!plan || "waitFor" in plan) {
            return { claimed: false as const };
        }

        const claimed = await claimOnce(ctx, MESSENGER_REPLY_SCOPE, `${threadId}:${plan.newestUserMessageId}`, MESSENGER_CLAIM_TTL_MS, userId);

        return claimed ? { claimed: true as const, newestUserMessageId: plan.newestUserMessageId } : { claimed: false as const };
    });

/**
 * Append an assistant-side note to a messenger thread — used when a reply could
 * not be delivered (e.g. WhatsApp's 24h window had closed), so the bot owner
 * sees why the sender got no answer.
 */
export const saveMessengerNotice = internalMutation
    .input({
        text: v.string(),
        threadId: v.id("threads"),
        userId: v.string(),
    })
    .output(v.null())
    .mutation(async ({ args: { text, threadId, userId }, ctx }) => {
        const lastMessage = await ctx.db
            .query("messages")
            .withIndex("by_threadId_order_stepOrder", (q) => q.eq("threadId", threadId))
            .order("desc")
            .first();

        await insertMessageRow(ctx.db, {
            message: {
                content: [{ text, type: "text" }],
                role: "assistant",
            },
            order: lastMessage ? (lastMessage.order ?? 0) + 1 : 0,
            status: "completed",
            stepOrder: 0,
            text,
            threadId,
            tool: false,
            userId,
        });

        return null;
    });

/** Messages scanned for media, newest first — well past what a reply's context window holds. */
const RECENT_MEDIA_SCAN = 40;

const hasMediaPart = (content: unknown): boolean =>
    Array.isArray(content) &&
    content.some((part) => (part as { type?: unknown } | null)?.type === "image" || (part as { type?: unknown } | null)?.type === "file");

/**
 * Whether the thread's recent messages carry images or files. A reply to such
 * a thread needs a model that reads them — the older ones are still in its
 * context after the sender goes back to plain text.
 */
export const threadHasRecentMedia = internalQuery
    .input({ threadId: v.id("threads") })
    .output(v.boolean())
    .query(async ({ args: { threadId }, ctx }) => {
        const recent = await ctx.db
            .query("messages")
            .withIndex("by_threadId_order_stepOrder", (q) => q.eq("threadId", threadId))
            .order("desc")
            .take(RECENT_MEDIA_SCAN);

        return recent.some((row) => hasMediaPart((row.message as { content?: unknown } | undefined)?.content));
    });

/**
 * The files the latest reply produced — image and file parts of the
 * assistant rows after the last user message — to send back to the sender.
 * Only storage the thread's owner holds a grant for is returned, so a reply
 * cannot hand out someone else's file.
 */
export const listReplyMedia = internalQuery
    .input({ threadId: v.id("threads"), userId: v.string() })
    .output(v.array(v.object({ filename: v.optional(v.string()), key: v.string(), mediaType: v.string() })))
    .query(async ({ args: { threadId, userId }, ctx }) => {
        const recent = await ctx.db
            .query("messages")
            .withIndex("by_threadId_order_stepOrder", (q) => q.eq("threadId", threadId))
            .order("desc")
            .take(RECENT_MEDIA_SCAN);
        const found: { filename?: string; key: string; mediaType: string }[] = [];

        for (const row of recent) {
            const message = row.message as { content?: unknown; role?: string } | undefined;

            if (message?.role === "user") {
                break;
            }

            if (message?.role !== "assistant" || !Array.isArray(message.content)) {
                continue;
            }

            const media = (message.content as { data?: unknown; filename?: unknown; image?: unknown; mediaType?: unknown; type?: unknown }[]).filter(
                (part) => part.type === "image" || part.type === "file",
            );

            for (const part of media) {
                const reference = part.type === "image" ? part.image : part.data;

                if (isStorageRef(reference) && typeof part.mediaType === "string") {
                    found.push({
                        ...(typeof part.filename === "string" && { filename: part.filename }),
                        key: reference.slice(STORAGE_REF_PREFIX.length),
                        mediaType: part.mediaType,
                    });
                }
            }
        }

        const owned = await ownedStorageKeys(
            ctx.db,
            userId,
            found.map((file) => file.key),
        );

        // Rows were read newest first; send in the order they were written.
        return found
            .filter((file) => owned.has(file.key))
            .toReversed()
            .slice(0, MESSENGER_MAX_OUTBOUND_FILES);
    });

/**
 * The reply-tool setting of the connection a messenger thread belongs to — read
 * from the thread's own `messengerConnectionId`, never from anything the
 * inbound message carried. `null` (no tools) unless thread and connection are
 * both the owner's.
 */
export const getReplyToolSetting = internalQuery
    .input({ threadId: v.id("threads"), userId: v.string() })
    .output(v.union(v.null(), v.object({ enabled: v.boolean(), groups: v.optional(v.array(v.string())) })))
    .query(async ({ args: { threadId, userId }, ctx }) => {
        const thread = await ctx.db.get(threadId);

        if (!thread || thread.userId !== userId || !thread.messengerConnectionId) {
            return null;
        }

        const connection = await ctx.db.get(thread.messengerConnectionId);

        if (!connection || connection.userId !== userId || !connection.replyTools) {
            return null;
        }

        return { enabled: connection.replyTools.enabled, ...(connection.replyTools.groups && { groups: connection.replyTools.groups }) };
    });

/**
 * Charge a tool-enabled reply as one headless round (`tasks/account.ts:chargeRound`):
 * the owner's daily chat quota and the headless-runs ceiling, admins exempt.
 * Tools inside it charge their own buckets (image generation), and the model
 * calls are billed as credits by the gateway, as in the web chat.
 * `"unavailable"` for an owner who may not run headless work (anonymous, gone).
 */
export const chargeReplyToolRound = internalMutation
    .input({ userId: v.string() })
    .output(v.union(v.literal("charged"), v.literal("limit"), v.literal("unavailable")))
    .mutation(async ({ args: { userId }, ctx }) => {
        const account = await loadTaskAccount(ctx, userId);

        if (!account || taskAccessProblem(account)) {
            return "unavailable" as const;
        }

        return (await chargeRound(ctx, userId, account)) ? ("charged" as const) : ("limit" as const);
    });
