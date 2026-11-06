/**
 * Guest links: a thread's owner hands out a link, and whoever holds it can LEAVE a message that waits for
 * the owner (plans/coding-workbench.md 5.2). Nothing a guest writes runs anything.
 *
 * - A held message is a row in `threadGuestMessages`, not a `messages` row: no agent context, title,
 *   summary or usage job ever reads it, and the post schedules nothing. It reaches the owner's own client
 *   only through {@link sendHeldGuestMessage}, which hands it over for the ordinary send path (the owner's
 *   credits, model and limits); `/chat/start` saves the note's own text into the chat and marks the note
 *   sent (`markGuestNoteSent`), so the guest sees it as sent only once it is in the conversation.
 * - The link is a bearer capability to POST, not to read. Its token is shown once and stored as a hash; the
 *   first browser to post is bound with a token of its own (also stored as a hash), and every later post or
 *   view must present it. The guest's view is their own messages and whether the owner took them up.
 * - A link lasts 24 hours and ends sooner on revoke, archive or deletion of the thread
 *   ({@link revokeGuestLinksForThread}); the housekeeping sweep removes the lapsed ones.
 * - The guest model is the free model: a guest never names one, and a guest message costs nothing until sent.
 *
 * An anonymous request names no shard, so the link hash is routed to the owner (`shardRoutes`, `guest-link`)
 * and the write runs there as the system; the internal mutation re-checks everything itself.
 */
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalMutation, internalQuery } from "../_generated/server";
import { requireOwnedThread, requireOwnedThreadIgnoringLock } from "../agent/thread-read-access";
import { refuseHostThread } from "../acp/lib/host-thread";
import { GUEST_POST_CLAIM_TTL_MS, GUEST_POST_SCOPE, claimOnce, hasClaim } from "../lib/claim-once";
import { timingSafeEqual } from "../lib/crypto";
import { callOnShard } from "../lib/cross-shard";
import { authMutation, authQuery, publicAction, rateLimit } from "../lib/crpc";
import { createRatelimit, getRateLimitKey, rateLimitGuard, shareLinkBucket } from "../lib/rate-limiter";
import { noteShardActivity } from "../lib/shard-housekeeping";
import { currentShard, ROOT_SHARD_KEY } from "../lib/shard-context";
import { deleteShardRoute, setShardRoute, shardRouteOwner } from "../lib/shard-routes";
import { runAfterOnShard } from "../lib/shard-scheduler";
import { isThreadLocked } from "../lib/thread-lock";
import { MAX_LENGTH } from "../lib/validators";
import {
    cleanGuestText,
    deleteGuestLink,
    GUEST_LINK_TTL_MS,
    GUEST_MAX_HELD_PER_LINK,
    GUEST_MAX_ROWS_PER_LINK,
    GUEST_TOKEN_MAX_LENGTH,
    hashGuestToken,
    newGuestToken,
    dropGuestLinkRoutes,
    removeGuestLinkRows,
    revokeGuestLinksForThread,
} from "./lib/guest-link-store";

const SWEEP_BATCH = 50;

const vGuestMessageStatus = v.union(v.literal("held"), v.literal("sent"));

const vHoldOutcome = v.union(
    v.object({ messageId: v.string(), minted: v.boolean(), ok: v.literal(true) }),
    // A retry of a post the shard already wrote: answered as accepted, with no note written and nothing charged.
    v.object({ duplicate: v.literal(true), minted: v.boolean(), ok: v.literal(true) }),
    v.object({
        ok: v.literal(false),
        reason: v.union(
            v.literal("closed"),
            v.literal("full"),
            v.literal("invalid"),
            v.literal("limited"),
            v.literal("other_browser"),
            v.literal("request_reused"),
        ),
    }),
);

const tooLong = (token: string): boolean => token.length === 0 || token.length > GUEST_TOKEN_MAX_LENGTH;

// ---------------------------------------------------------------------------
// The owner
// ---------------------------------------------------------------------------

/** Makes the thread's guest link (replacing any earlier one). The token comes back once; only its hash is kept. */
export const createGuestLink = authMutation
    .use(rateLimit("sharing/create"))
    .input({ threadId: v.id("threads") })
    .output(v.object({ expiresAt: v.number(), linkToken: v.string() }))
    .mutation(async ({ args: { threadId }, ctx: context }) => {
        const { userId } = context.user;
        // The owner alone, and not a locked chat without its proof: a link into a locked chat would be a way around the lock.
        const thread = await requireOwnedThread(context, threadId, userId);

        if (thread.deleted === true || thread.isTemporary === true || thread.status === "archived") {
            throw new LunoraError("BAD_REQUEST", "This chat cannot be given a guest link.");
        }

        refuseHostThread(thread, "given a guest link");
        // The old rows go first and their routes last: a failure before the end leaves the old link reachable.
        const replacedHashes = await removeGuestLinkRows(context, threadId);

        const linkToken = newGuestToken();
        const linkHash = await hashGuestToken(linkToken);
        const expiresAt = context.now + GUEST_LINK_TTL_MS;

        await context.db.insert("threadGuestLinks", { createdAt: context.now, expiresAt, linkHash, threadId, userId });
        await setShardRoute(context, "guest-link", linkHash, userId);

        for (const replacedHash of replacedHashes) {
            await deleteShardRoute(context, "guest-link", replacedHash);
        }

        // So housekeeping visits this shard after the link lapses, even when the owner is not seen again.
        await noteShardActivity(context, userId);

        context.log.event("chat.create_guest_link", { created: true });

        return { expiresAt, linkToken };
    });

/** Withdraws the guest link and everything guests left on it. */
export const revokeGuestLink = authMutation
    .use(rateLimit("sharing/update"))
    .input({ threadId: v.id("threads") })
    .output(v.null())
    .mutation(async ({ args: { threadId }, ctx: context }) => {
        await requireOwnedThreadIgnoringLock(context, threadId, context.user.userId);
        await revokeGuestLinksForThread(context, threadId);
        context.log.event("chat.revoke_guest_link", { revoked: true });

        return null;
    });

/** The thread's live link (never its token) and the messages waiting on it, for the owner's thread view. */
export const getGuestLink = authQuery
    .input({ threadId: v.id("threads"), unlockProof: v.optional(v.string().max(MAX_LENGTH.short)) })
    .output(
        v.object({
            link: v.union(v.object({ bound: v.boolean(), expiresAt: v.number() }), v.null()),
            messages: v.array(v.object({ createdAt: v.number(), id: v.string(), status: vGuestMessageStatus, text: v.string() })),
        }),
    )
    .query(async ({ args: { threadId, unlockProof }, ctx: context }) => {
        await requireOwnedThread(context, threadId, context.user.userId, unlockProof);

        const link = await context.db
            .query("threadGuestLinks")
            .withIndex("by_thread", (q) => q.eq("threadId", threadId))
            .first();

        if (!link || link.expiresAt <= context.now) {
            return { link: null, messages: [] };
        }

        const rows = await context.db
            .query("threadGuestMessages")
            .withIndex("by_link", (q) => q.eq("linkId", link._id))
            .take(GUEST_MAX_ROWS_PER_LINK);

        return {
            link: { bound: link.guestHash !== undefined, expiresAt: link.expiresAt },
            messages: rows.map((row) => {
                return { createdAt: row.createdAt, id: row._id as string, status: row.status, text: row.text };
            }),
        };
    });

/**
 * The owner's Send: hands back the guest's text so the owner's client sends it through the ordinary send path
 * (this procedure runs no model and starts no run itself). The client must send the text with this message's id as
 * `guestMessageId` on `/chat/start`: that marks it as guest text, so the quick approval check never reads it as the owner's.
 * The message stays HELD until `/chat/start` saves it ({@link markGuestNoteSent}), so a send that failed can be retried and the
 * guest never sees a failed one as sent. A message already sent is not handed out again.
 */
export const sendHeldGuestMessage = authMutation
    .use(rateLimit("guest/review"))
    .input({ messageId: v.id("threadGuestMessages"), unlockProof: v.optional(v.string().max(MAX_LENGTH.short)) })
    .output(v.object({ text: v.string(), threadId: v.string() }))
    .mutation(async ({ args: { messageId, unlockProof }, ctx: context }) => {
        const { userId } = context.user;
        const row = await context.db.get("threadGuestMessages", messageId);

        if (!row || row.userId !== userId) {
            throw new LunoraError("NOT_FOUND", "That message is no longer waiting.");
        }

        await requireOwnedThread(context, row.threadId, userId, unlockProof);

        const link = await context.db.get("threadGuestLinks", row.linkId);

        if (!link || link.expiresAt <= context.now) {
            throw new LunoraError("NOT_FOUND", "That guest link has ended.");
        }

        if (row.status === "sent") {
            throw new LunoraError("BAD_REQUEST", "That message was already sent.");
        }

        context.log.event("chat.send_guest_message", { handedOut: true });

        return { text: row.text, threadId: row.threadId as string };
    });

/** The owner's client, after its ordinary send of a guest message went through: the guest now sees it as sent. */
export const confirmGuestMessageSent = authMutation
    .use(rateLimit("guest/review"))
    .input({ messageId: v.id("threadGuestMessages"), unlockProof: v.optional(v.string().max(MAX_LENGTH.short)) })
    .output(v.null())
    .mutation(async ({ args: { messageId, unlockProof }, ctx: context }) => {
        const { userId } = context.user;
        const row = await context.db.get("threadGuestMessages", messageId);

        if (!row || row.userId !== userId) {
            throw new LunoraError("NOT_FOUND", "That message is no longer waiting.");
        }

        await requireOwnedThread(context, row.threadId, userId, unlockProof);

        // The note is taken as sent when its text is saved into the chat (`/chat/start`). A confirmation alone proves nothing,
        // so it is refused until that has happened.
        if (row.status !== "sent") {
            throw new LunoraError("BAD_REQUEST", "That message was not sent yet.");
        }

        context.log.event("chat.confirm_guest_message_sent", { sent: true });

        return null;
    });

/** The owner's Dismiss: the message is deleted. On a locked chat it needs the same unlock proof as Send. */
export const dismissHeldGuestMessage = authMutation
    .use(rateLimit("guest/review"))
    .input({ messageId: v.id("threadGuestMessages"), unlockProof: v.optional(v.string().max(MAX_LENGTH.short)) })
    .output(v.null())
    .mutation(async ({ args: { messageId, unlockProof }, ctx: context }) => {
        const row = await context.db.get("threadGuestMessages", messageId);

        if (!row || row.userId !== context.user.userId) {
            throw new LunoraError("NOT_FOUND", "That message is no longer waiting.");
        }

        await requireOwnedThread(context, row.threadId, context.user.userId, unlockProof);

        // A sent message is the guest's record of what was said: the owner may not take it back off the link.
        if (row.status !== "held") {
            throw new LunoraError("BAD_REQUEST", "A message that was already sent cannot be dismissed.");
        }

        await context.db.delete("threadGuestMessages", messageId);
        context.log.event("chat.dismiss_guest_message", { dismissed: true });

        return null;
    });

// ---------------------------------------------------------------------------
// The guest
// ---------------------------------------------------------------------------

/**
 * Leaves a message on the link. The first post binds the link to this browser and returns its token, once;
 * the browser keeps it and presents it on every later call. Unknown, lapsed and withdrawn links answer alike.
 */
export const postGuestMessage = publicAction
    .input({
        guestToken: v.optional(v.string().max(MAX_LENGTH.short)),
        linkToken: v.string().max(MAX_LENGTH.short),
        // The client's id for this one post, reused by its retry after a lost reply: the same id and text write one note.
        requestId: v.optional(
            v
                .string()
                .max(MAX_LENGTH.short)
                .check((value) => REQUEST_ID_SHAPE.test(value), { message: "Invalid request id" }),
        ),
        text: v.string().max(MAX_LENGTH.long),
    })
    .use(rateLimit("guest/message"))
    .output(v.object({ guestToken: v.optional(v.string()) }))
    .action(async ({ args: { guestToken, linkToken, requestId, text }, ctx: context }): Promise<{ guestToken?: string }> => {
        const notActive = new LunoraError("NOT_FOUND", "This link is not active.");

        if (tooLong(linkToken) || (guestToken !== undefined && tooLong(guestToken))) {
            throw notActive;
        }

        const clean = cleanGuestText(text);

        if (clean === null) {
            throw new LunoraError("BAD_REQUEST", "A message must have text and stay short.");
        }

        const linkHash = await hashGuestToken(linkToken);
        const ownerId = await context.runQuery(internal.chat.guest_links.getGuestLinkOwner, { linkHash });

        if (!ownerId) {
            throw notActive;
        }

        // The per-link limit is charged on the owner's shard, after the browser check (`holdGuestMessage`):
        // charged here, posts refused as another browser's would use up the bound guest's allowance.
        // A browser may name the token it will keep before its first post, so a lost reply can be retried with it. Only a
        // token of the minted shape is taken; anything else gets a minted one.
        const fresh = guestToken !== undefined && GUEST_TOKEN_SHAPE.test(guestToken) ? guestToken : newGuestToken();
        const outcome = await callOnShard(
            internal.chat.guest_links.holdGuestMessage,
            {
                freshGuestHash: await hashGuestToken(fresh),
                linkHash,
                presentedGuestHash: guestToken === undefined ? undefined : await hashGuestToken(guestToken),
                requestHash: requestId === undefined ? undefined : await hashGuestToken(`${requestId}\n${clean}`),
                requestKey: requestId === undefined ? undefined : await hashGuestToken(requestId),
                text: clean,
            },
            { shardKey: ownerId },
        );

        if (!outcome.ok) {
            switch (outcome.reason) {
                case "full": {
                    throw new LunoraError("BAD_REQUEST", "The owner has not read the earlier messages yet. Try again later.");
                }
                case "invalid": {
                    throw new LunoraError("BAD_REQUEST", "A message must have text and stay short.");
                }
                case "limited": {
                    throw new LunoraError("TOO_MANY_REQUESTS", "Too many messages on this link. Please try again later.");
                }
                case "other_browser": {
                    throw new LunoraError("FORBIDDEN", "This link is already in use in another browser.");
                }
                case "request_reused": {
                    throw new LunoraError("BAD_REQUEST", "That request id was already used for a different message.");
                }
                default: {
                    throw notActive;
                }
            }
        }

        context.log.event("chat.post_guest_message", { bound: outcome.minted });

        return outcome.minted ? { guestToken: fresh } : {};
    });

const vGuestView = v.object({
    expiresAt: v.number(),
    messages: v.array(v.object({ createdAt: v.number(), status: vGuestMessageStatus, text: v.string() })),
});

/** The guest's own messages on the link and whether the owner took them up. Nothing of the thread. */
export const getGuestView = publicAction
    .input({ guestToken: v.string().max(MAX_LENGTH.short), linkToken: v.string().max(MAX_LENGTH.short) })
    .use(rateLimit("share/view"))
    .output(v.union(vGuestView, v.null()))
    .action(async ({ args: { guestToken, linkToken }, ctx: context }) => {
        if (tooLong(linkToken) || tooLong(guestToken)) {
            return null;
        }

        const linkHash = await hashGuestToken(linkToken);
        const ownerId = await context.runQuery(internal.chat.guest_links.getGuestLinkOwner, { linkHash });

        if (!ownerId) {
            return null;
        }

        const guestHash = await hashGuestToken(guestToken);

        // Only the bound browser's token is charged against the link's allowance, so a stranger's random tokens write
        // no rate-limit rows. The per-address limit above still applies to every view.
        const bound = await callOnShard(internal.chat.guest_links.isBoundGuest, { guestHash, linkHash }, { shardKey: ownerId });

        if (bound) {
            await rateLimitGuard({
                ...context,
                identifier: await shareLinkBucket(`${linkHash}:${guestHash}`),
                rateLimitKey: "share/view",
                user: null,
            } as never);
        }

        return await callOnShard(internal.chat.guest_links.readGuestView, { guestHash, linkHash }, { shardKey: ownerId });
    });

// ---------------------------------------------------------------------------
// Internal: on the owner's shard
// ---------------------------------------------------------------------------

export const getGuestLinkOwner = internalQuery
    .input({ linkHash: v.string().max(MAX_LENGTH.short) })
    .output(v.union(v.string(), v.null()))
    .query(async ({ args: { linkHash }, ctx }) => await shardRouteOwner(ctx, "guest-link", linkHash));

/**
 * Stores the guest's message as HELD. This is the whole of what a guest can cause: one row. It schedules
 * nothing and reads no model, tool or title job; the checks are the link's, the thread's and the browser's.
 */
export const holdGuestMessage = internalMutation
    .input({
        freshGuestHash: v.string().max(MAX_LENGTH.short),
        linkHash: v.string().max(MAX_LENGTH.short),
        presentedGuestHash: v.optional(v.string().max(MAX_LENGTH.short)),
        requestHash: v.optional(v.string().max(MAX_LENGTH.short)),
        requestKey: v.optional(v.string().max(MAX_LENGTH.short)),
        text: v.string().max(MAX_LENGTH.long),
    })
    .output(vHoldOutcome)
    .mutation(async ({ args: { freshGuestHash, linkHash, presentedGuestHash, requestHash, requestKey, text }, ctx }) => {
        const closed = { ok: false, reason: "closed" } as const;
        const link = await ctx.db
            .query("threadGuestLinks")
            .withIndex("by_linkHash", (q) => q.eq("linkHash", linkHash))
            .first();

        if (!link || link.expiresAt <= ctx.now) {
            return closed;
        }

        const thread = await ctx.db.get("threads", link.threadId);

        if (
            !thread ||
            thread.deleted === true ||
            thread.isTemporary === true ||
            thread.status === "archived" ||
            thread.runner === "host" ||
            isThreadLocked(thread)
        ) {
            return closed;
        }

        const clean = cleanGuestText(text);

        if (clean === null) {
            return { ok: false, reason: "invalid" } as const;
        }

        // The first poster binds the link; after that only that browser's token passes.
        const minted = link.guestHash === undefined;

        if (!minted && (presentedGuestHash === undefined || !timingSafeEqual(presentedGuestHash, link.guestHash!))) {
            return { ok: false, reason: "other_browser" } as const;
        }

        // A request id names one post. Its retry with the same text is answered without a second note or charge; the same id
        // with other text is refused, since it would otherwise write a second note under an id the browser already used.
        const requestClaim = requestKey === undefined ? undefined : `${link._id}:${requestKey}`;
        const textClaim = requestClaim === undefined || requestHash === undefined ? undefined : `${link._id}:${requestHash}`;

        if (requestClaim !== undefined && textClaim !== undefined && (await hasClaim(ctx, GUEST_POST_SCOPE, requestClaim))) {
            if (await hasClaim(ctx, GUEST_POST_SCOPE, textClaim)) {
                return { duplicate: true, minted, ok: true } as const;
            }

            return { ok: false, reason: "request_reused" } as const;
        }

        const rows = await ctx.db
            .query("threadGuestMessages")
            .withIndex("by_link", (q) => q.eq("linkId", link._id))
            .take(GUEST_MAX_ROWS_PER_LINK);

        if (rows.length >= GUEST_MAX_ROWS_PER_LINK || rows.filter((row) => row.status === "held").length >= GUEST_MAX_HELD_PER_LINK) {
            return { ok: false, reason: "full" } as const;
        }

        // Per link, and only for the browser the link is bound to (or the post that binds it): a stranger holding
        // the link is refused above and spends nothing of the guest's allowance.
        const perLink = await createRatelimit(getRateLimitKey("guest/message", "public"), ctx.db).limit(await shareLinkBucket(linkHash));

        if (!perLink.ok) {
            return { ok: false, reason: "limited" } as const;
        }

        if (minted) {
            await ctx.db.patch("threadGuestLinks", link._id, { guestHash: freshGuestHash });
        }

        const messageId = await ctx.db.insert("threadGuestMessages", {
            createdAt: ctx.now,
            linkId: link._id,
            status: "held",
            text: clean,
            threadId: link.threadId,
            userId: link.userId,
        });

        if (requestClaim !== undefined && textClaim !== undefined) {
            await claimOnce(ctx, GUEST_POST_SCOPE, requestClaim, GUEST_POST_CLAIM_TTL_MS, link.userId);
            await claimOnce(ctx, GUEST_POST_SCOPE, textClaim, GUEST_POST_CLAIM_TTL_MS, link.userId);
        }

        return { messageId: messageId as string, minted, ok: true } as const;
    });

/**
 * `/chat/start`'s check on a note it is asked to send on: the owner's own note, still waiting, and the chat it was left in.
 * A note sent into another chat would be confirmed against its own link, so the caller compares `threadId` before saving.
 */
export const getGuestNoteForSend = internalQuery
    .input({ messageId: v.id("threadGuestMessages"), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.union(v.object({ status: vGuestMessageStatus, text: v.string(), threadId: v.string() }), v.null()))
    .query(async ({ args, ctx }) => {
        const row = await ctx.db.get("threadGuestMessages", args.messageId);

        if (!row || row.userId !== args.userId) {
            return null;
        }

        // A note on a lapsed link is no longer sendable, as the owner's Send refuses it, even before the sweep removes it.
        const link = await ctx.db.get("threadGuestLinks", row.linkId);

        if (!link || link.expiresAt <= ctx.now) {
            return null;
        }

        return { status: row.status, text: row.text, threadId: row.threadId as string };
    });

/**
 * `/chat/start` saved the held note's text as the owner's message: the note is taken, so the guest sees it as sent. Only a
 * held note of the caller's is taken; any other row is left as it is.
 */
export const markGuestNoteSent = internalMutation
    .input({ messageId: v.id("threadGuestMessages"), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const row = await ctx.db.get("threadGuestMessages", args.messageId);

        if (row && row.userId === args.userId && row.status === "held") {
            await ctx.db.patch("threadGuestMessages", args.messageId, { status: "sent" });
        }

        return null;
    });

/** `getGuestView`'s read: the guest's own rows, only for the browser the link is bound to. */
export const readGuestView = internalQuery
    .input({ guestHash: v.string().max(MAX_LENGTH.short), linkHash: v.string().max(MAX_LENGTH.short) })
    .output(v.union(vGuestView, v.null()))
    .query(async ({ args: { guestHash, linkHash }, ctx }) => {
        const link = await ctx.db
            .query("threadGuestLinks")
            .withIndex("by_linkHash", (q) => q.eq("linkHash", linkHash))
            .first();

        if (!link || link.expiresAt <= ctx.now || link.guestHash === undefined || !timingSafeEqual(guestHash, link.guestHash)) {
            return null;
        }

        const rows = await ctx.db
            .query("threadGuestMessages")
            .withIndex("by_link", (q) => q.eq("linkId", link._id))
            .take(GUEST_MAX_ROWS_PER_LINK);

        return {
            expiresAt: link.expiresAt,
            messages: rows.map((row) => {
                return { createdAt: row.createdAt, status: row.status, text: row.text };
            }),
        };
    });

/**
 * A thread's guest notes, held and sent, for the owner's data export (`gdpr/steps.ts#collectConversations`). Bounded by the
 * same per-link cap a guest can fill, so one thread's export never reads more than a link could hold.
 */
export const listGuestNotesForExport = internalQuery
    .input({ threadId: v.id("threads") })
    .output(v.array(v.object({ createdAt: v.number(), status: vGuestMessageStatus, text: v.string() })))
    .query(async ({ args, ctx }) => {
        const rows = await ctx.db
            .query("threadGuestMessages")
            .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
            .take(GUEST_MAX_ROWS_PER_LINK);

        return rows.map((row) => {
            return { createdAt: row.createdAt, status: row.status, text: row.text };
        });
    });

/** Whether `guestHash` is the browser the live link is bound to. Read on the owner's shard, before any charge. */
export const isBoundGuest = internalQuery
    .input({ guestHash: v.string().max(MAX_LENGTH.short), linkHash: v.string().max(MAX_LENGTH.short) })
    .output(v.boolean())
    .query(async ({ args: { guestHash, linkHash }, ctx }) => {
        const link = await ctx.db
            .query("threadGuestLinks")
            .withIndex("by_linkHash", (q) => q.eq("linkHash", linkHash))
            .first();

        return link !== null && link.expiresAt > ctx.now && link.guestHash !== undefined && timingSafeEqual(guestHash, link.guestHash);
    });

/** The shape `newGuestToken` mints: 64 lowercase hex characters. */
const GUEST_TOKEN_SHAPE = /^[0-9a-f]{64}$/;

/** A request id the browser picks for one post: 8 to 64 letters, digits or dashes. */
const REQUEST_ID_SHAPE = /^[A-Za-z0-9-]{8,64}$/u;

/** Housekeeping sweep (`shardSweeps()`): links past their 24 hours go, with what guests left on them. */
export const sweepGuestLinks = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx }) => {
        const lapsed = await ctx.db
            .query("threadGuestLinks")
            .withIndex("by_expiresAt", (q) => q.lte("expiresAt", ctx.now))
            .take(SWEEP_BATCH);

        const routes: string[] = [];

        for (const link of lapsed) {
            routes.push(await deleteGuestLink(ctx, link));
        }

        // The rows went first: a route removed before a failed write would leave a live link unreachable.
        await dropGuestLinkRoutes(ctx, routes);

        // A full batch may have left more behind: carry on now rather than at the shard's next housekeeping.
        if (lapsed.length >= SWEEP_BATCH) {
            // Named, not defaulted: the continuation must stay on this owner's shard, and this shard's key is the one it runs on.
            await runAfterOnShard(ctx.scheduler, 0, internal.chat.guest_links.sweepGuestLinks, {}, currentShard() ?? ROOT_SHARD_KEY);
        }

        return null;
    });
