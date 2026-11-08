/**
 * Guest links: a thread's owner hands out a link, and whoever holds it can LEAVE a message that waits for
 * the owner. Nothing a guest writes runs anything.
 *
 * - A held message is a row in `threadGuestMessages`, not a `messages` row: no agent context, title,
 *   summary or usage job ever reads it, and the post schedules nothing.
 * - The link is a bearer capability to POST, not to read. Its token is shown once and stored as a hash; the
 *   first browser to post is bound with a server-minted token of its own (also stored as a hash), and every
 *   later post or view must present it. The guest's view is their own messages and their status.
 * - A link lasts 24 hours and ends sooner on revoke, and when the thread is archived, trashed, deleted, locked or
 *   made temporary ({@link withdrawGuestLinksForThread}); the housekeeping sweep removes the lapsed ones.
 *
 * An anonymous request names no shard, so the link hash is routed to the owner (`shardRoutes`, `guest-link`)
 * and the write runs there as the system; the internal mutation re-checks everything itself.
 */
import { LunoraError, v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { refuseHostThread } from "../acp/lib/host-thread";
import { requireOwnedThread, requireOwnedThreadIgnoringLock } from "../agent/thread-read-access";
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
import { isWorkerThread } from "../sub-agents/worker-thread";
import {
    cleanGuestText,
    deleteGuestLink,
    GUEST_LINK_REMOVAL_CAP,
    GUEST_LINK_TTL_MS,
    GUEST_MAX_HELD_PER_LINK,
    GUEST_MAX_ROWS_PER_LINK,
    GUEST_ROUTE_DROP_ATTEMPTS,
    GUEST_TOKEN_MAX_LENGTH,
    hashGuestToken,
    newGuestToken,
    newRemovalBudget,
    removeGuestLinkRows,
    scheduleGuestLinkRouteDrop,
    unsendableGuestText,
    withdrawGuestLinksForThread,
} from "./lib/guest-link-store";

const SWEEP_BATCH = 50;

/** The most hashes one route removal takes: a removal batch's links (`GUEST_LINK_REMOVAL_CAP`, `SWEEP_BATCH`). */
const GUEST_ROUTE_BATCH = Math.max(GUEST_LINK_REMOVAL_CAP, SWEEP_BATCH);

/** Notes or links per export page. */
const EXPORT_PAGE = 100;

/** The most links of a thread read when looking for waiting notes: a thread has one live link at a time. */
const GUEST_LINK_SCAN = 10;

/** Removal batches a new link may run to clear the ones it replaces. */
const REPLACE_PASSES = 4;

const vGuestMessageStatus = v.union(v.literal("held"), v.literal("sent"));

const vHoldOutcome = v.union(
    v.object({ messageId: v.string(), minted: v.boolean(), ok: v.literal(true) }),
    v.object({
        ok: v.literal(false),
        reason: v.union(
            v.literal("closed"),
            v.literal("full"),
            v.literal("invalid"),
            v.literal("limited"),
            v.literal("other_browser"),
            v.literal("unsendable"),
        ),
    }),
);

const vGuestView = v.object({
    expiresAt: v.number(),
    messages: v.array(v.object({ createdAt: v.number(), status: vGuestMessageStatus, text: v.string() })),
});

const tooLong = (token: string): boolean => token.length === 0 || token.length > GUEST_TOKEN_MAX_LENGTH;

/** Whether a note on a live link of the thread still waits for the owner. A lapsed link's notes are hidden and do not count. */
const hasWaitingNotes = async (context: MutationCtx, threadId: Id<"threads">): Promise<boolean> => {
    const links = await context.db
        .query("threadGuestLinks")
        .withIndex("by_thread_expiresAt", (q) => q.eq("threadId", threadId).gt("expiresAt", context.now))
        .take(GUEST_LINK_SCAN);

    for (const link of links) {
        const notes = await context.db
            .query("threadGuestMessages")
            .withIndex("by_link", (q) => q.eq("linkId", link._id))
            .take(GUEST_MAX_ROWS_PER_LINK);

        if (notes.some((note) => note.status === "held")) {
            return true;
        }
    }

    return false;
};

// ---------------------------------------------------------------------------
// The owner
// ---------------------------------------------------------------------------

/** Makes the thread's guest link (replacing any earlier one). The token comes back once; only its hash is kept. */
export const createGuestLink = authMutation
    .use(rateLimit("sharing/create"))
    .input({ discardWaiting: v.optional(v.boolean()), threadId: v.id("threads") })
    .output(v.object({ expiresAt: v.number(), linkToken: v.string() }))
    .mutation(async ({ args: { discardWaiting, threadId }, ctx: context }) => {
        const { userId } = context.user;
        // The owner alone, and never a locked chat: this takes no unlock proof, and a link into a locked chat would be a way around the lock.
        const thread = await requireOwnedThread(context, threadId, userId);

        // As the withdrawal paths: an archived, trashed, temporary or locked thread holds no link. A locked one must not
        // either way, since changing its passcode re-stamps `lockedAt` without withdrawing links.
        if (thread.deleted === true || thread.isTemporary === true || thread.status === "archived" || isThreadLocked(thread)) {
            throw new LunoraError("BAD_REQUEST", "This chat cannot be given a guest link.");
        }

        refuseHostThread(thread, "given a guest link");

        // A worker's conversation takes turns only through a dispatch, so a note left in it could never be sent.
        if (await isWorkerThread(context, threadId)) {
            throw new LunoraError("BAD_REQUEST", "A worker's conversation cannot be given a guest link.");
        }

        // A new link replaces the old one and everything on it, so notes still waiting are not dropped silently.
        if (discardWaiting !== true && (await hasWaitingNotes(context, threadId))) {
            throw new LunoraError("BAD_REQUEST", "Deal with the waiting guest messages first, or discard them to make a new link.");
        }

        // A few batches cover any thread a guest can fill (a link holds at most `GUEST_MAX_ROWS_PER_LINK` notes). Past that the
        // call is refused whole, so nothing is half-removed and a revoke (which carries on in the background) clears the way.
        const replacedHashes: string[] = [];
        let removed = { done: false, hashes: [] as string[] };

        for (let pass = 0; pass < REPLACE_PASSES && !removed.done; pass += 1) {
            removed = await removeGuestLinkRows(context, threadId, context.now);
            replacedHashes.push(...removed.hashes);
        }

        if (!removed.done) {
            throw new LunoraError("CONFLICT", "Revoke the earlier guest link first, then make a new one.");
        }

        const linkToken = newGuestToken();
        const linkHash = await hashGuestToken(linkToken);
        const expiresAt = context.now + GUEST_LINK_TTL_MS;

        await context.db.insert("threadGuestLinks", { createdAt: context.now, expiresAt, linkHash, threadId, userId });
        await setShardRoute(context, "guest-link", linkHash, userId);
        // The replaced links' routes go in a job that runs only once this write commits.
        await scheduleGuestLinkRouteDrop(context, replacedHashes);
        // So housekeeping visits this shard after the link lapses, even when the owner is not seen again.
        await noteShardActivity(context, userId);
        context.log.event("chat.create_guest_link", { created: true });

        return { expiresAt, linkToken };
    });

/** Withdraws the guest link and everything guests left on it. Works on a locked chat, so the owner can always withdraw. */
export const revokeGuestLink = authMutation
    .use(rateLimit("sharing/update"))
    .input({ threadId: v.id("threads") })
    .output(v.null())
    .mutation(async ({ args: { threadId }, ctx: context }) => {
        await requireOwnedThreadIgnoringLock(context, threadId, context.user.userId);
        await withdrawGuestLinksForThread(context, threadId);
        context.log.event("chat.revoke_guest_link", { revoked: true });

        return null;
    });

/** The thread's live link (never its token) and the messages left on it, for the owner's thread view. */
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
            .withIndex("by_thread_expiresAt", (q) => q.eq("threadId", threadId).gt("expiresAt", context.now))
            .first();

        if (!link) {
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
        text: v.string().max(MAX_LENGTH.long),
    })
    .use(rateLimit("guest/message"))
    .output(v.object({ guestToken: v.optional(v.string()) }))
    .action(async ({ args: { guestToken, linkToken, text }, ctx: context }): Promise<{ guestToken?: string }> => {
        const notActive = new LunoraError("NOT_FOUND", "This link is not active.");

        if (tooLong(linkToken) || (guestToken !== undefined && tooLong(guestToken))) {
            throw notActive;
        }

        const refusal = unsendableGuestText(text);

        if (refusal !== undefined) {
            throw new LunoraError("BAD_REQUEST", refusal);
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
        const fresh = newGuestToken();
        const outcome = await callOnShard(
            internal.chat.guest_links.holdGuestMessage,
            {
                freshGuestHash: await hashGuestToken(fresh),
                linkHash,
                presentedGuestHash: guestToken === undefined ? undefined : await hashGuestToken(guestToken),
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
                case "unsendable": {
                    throw new LunoraError("BAD_REQUEST", unsendableGuestText(text) ?? "This message cannot be left.");
                }
                default: {
                    throw notActive;
                }
            }
        }

        context.log.event("chat.post_guest_message", { bound: outcome.minted });

        return outcome.minted ? { guestToken: fresh } : {};
    });

/** The guest's own messages on the link and their status. Nothing of the thread. */
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
        if (await callOnShard(internal.chat.guest_links.isBoundGuest, { guestHash, linkHash }, { shardKey: ownerId })) {
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
        text: v.string().max(MAX_LENGTH.long),
    })
    .output(vHoldOutcome)
    .mutation(async ({ args: { freshGuestHash, linkHash, presentedGuestHash, text }, ctx }) => {
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
            isThreadLocked(thread) ||
            (await isWorkerThread(ctx, thread._id))
        ) {
            return closed;
        }

        if (unsendableGuestText(text) !== undefined) {
            return { ok: false, reason: "unsendable" } as const;
        }

        const clean = cleanGuestText(text);

        if (clean === null) {
            return { ok: false, reason: "invalid" } as const;
        }

        // The first poster binds the link; after that only that browser's token passes.
        const minted = link.guestHash === undefined;

        if (!minted && (presentedGuestHash === undefined || !timingSafeEqual(presentedGuestHash, link.guestHash ?? ""))) {
            return { ok: false, reason: "other_browser" } as const;
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

        return { messageId: messageId as string, minted, ok: true } as const;
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
 * One page of a thread's guest links for the owner's data export, notes or none: when each was made and when it lapses.
 * Never the token's hash, which is a credential, not the owner's data.
 */
export const listGuestLinksForExport = internalQuery
    .input({ cursor: v.union(v.string().max(MAX_LENGTH.cursor), v.null()), threadId: v.id("threads") })
    .output(
        v.object({
            continueCursor: v.union(v.string(), v.null()),
            isDone: v.boolean(),
            page: v.array(v.object({ createdAt: v.number(), expiresAt: v.number() })),
        }),
    )
    .query(async ({ args, ctx }) => {
        const result = await ctx.db
            .query("threadGuestLinks")
            .withIndex("by_thread_expiresAt", (q) => q.eq("threadId", args.threadId))
            .paginate({ cursor: args.cursor, numItems: EXPORT_PAGE });

        return {
            continueCursor: result.continueCursor,
            isDone: result.isDone,
            page: result.page.map((row) => {
                return { createdAt: row.createdAt, expiresAt: row.expiresAt };
            }),
        };
    });

/**
 * One page of a thread's guest notes for the owner's data export (`gdpr/steps.ts#collectConversations`), which reads
 * pages until `isDone`.
 */
export const listGuestNotesForExport = internalQuery
    .input({ cursor: v.union(v.string().max(MAX_LENGTH.cursor), v.null()), threadId: v.id("threads") })
    .output(
        v.object({
            continueCursor: v.union(v.string(), v.null()),
            isDone: v.boolean(),
            page: v.array(v.object({ createdAt: v.number(), status: vGuestMessageStatus, text: v.string() })),
        }),
    )
    .query(async ({ args, ctx }) => {
        const result = await ctx.db
            .query("threadGuestMessages")
            .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
            .paginate({ cursor: args.cursor, numItems: EXPORT_PAGE });

        return {
            continueCursor: result.continueCursor,
            isDone: result.isDone,
            page: result.page.map((row) => {
                return { createdAt: row.createdAt, status: row.status, text: row.text };
            }),
        };
    });

/**
 * The rest of a thread's guest links after a write that removed only the first batch (`withdrawGuestLinksForThread`):
 * only links made by `before`, when that write ran.
 */
export const continueGuestLinkRemoval = internalMutation
    .input({ before: v.number(), threadId: v.id("threads") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await withdrawGuestLinksForThread(ctx, args.threadId, args.before);

        return null;
    });

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
        const budget = newRemovalBudget();
        let unfinished = false;

        for (const link of lapsed) {
            const hash = await deleteGuestLink(ctx, link, budget);

            // Once the call's message budget is spent a link keeps its row; the continuation below finishes it.
            if (hash === undefined) {
                unfinished = true;
                break;
            }

            routes.push(hash);
        }

        // The routes go in a job that runs only once these deletes commit (`scheduleGuestLinkRouteDrop`).
        await scheduleGuestLinkRouteDrop(ctx, routes);

        // A full batch or an unfinished link may have left more behind: carry on now rather than at the shard's next housekeeping.
        if (unfinished || lapsed.length >= SWEEP_BATCH) {
            // Named, not defaulted: the continuation must stay on this owner's shard.
            await runAfterOnShard(ctx.scheduler, 0, internal.chat.guest_links.sweepGuestLinks, {}, currentShard() ?? ROOT_SHARD_KEY);
        }

        return null;
    });

/**
 * Removes the routes of removed links (`scheduleGuestLinkRouteDrop`), after the write that removed them committed. A hash
 * whose link row still exists keeps its route. A failed delete is tried again later, with a growing wait, up to
 * `GUEST_ROUTE_DROP_ATTEMPTS` times; after that the route is left to account erasure (`deleteShardRoutesOf`).
 */
export const dropGuestLinkRoutesJob = internalMutation
    .input({ attempt: v.number(), linkHashes: v.array(v.string().max(MAX_LENGTH.short)).max(GUEST_ROUTE_BATCH) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const failed: string[] = [];

        for (const linkHash of args.linkHashes) {
            const row = await ctx.db
                .query("threadGuestLinks")
                .withIndex("by_linkHash", (q) => q.eq("linkHash", linkHash))
                .first();

            if (row) {
                continue;
            }

            try {
                await deleteShardRoute(ctx, "guest-link", linkHash);
            } catch (error) {
                console.error("[guest-links] Failed to drop the route of a removed link:", error);
                failed.push(linkHash);
            }
        }

        if (failed.length > 0 && args.attempt + 1 < GUEST_ROUTE_DROP_ATTEMPTS) {
            await scheduleGuestLinkRouteDrop(ctx, failed, args.attempt + 1);
        }

        return null;
    });
