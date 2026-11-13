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

import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";
import { isHostRunThread } from "../acp/lib/host-thread";
import { admittedThreadDb } from "../agent/admitted-thread-db";
import { requireOwnedThread, requireOwnedThreadIgnoringLock } from "../agent/thread-read-access";
import {
    claimFence,
    claimOnce,
    claimRow,
    GUEST_SEND_LEASE_MS,
    GUEST_POST_CLAIM_TTL_MS,
    GUEST_POST_SCOPE,
    GUEST_SEND_CLAIM_TTL_MS,
    GUEST_SEND_SCOPE,
    hasClaim,
    recordClaimResult,
    releaseClaim,
} from "../lib/claim-once";
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
    GUEST_LINK_TTL_MS,
    GUEST_MAX_HELD_PER_LINK,
    GUEST_MAX_ROWS_PER_LINK,
    GUEST_ROUTE_BATCH,
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
import { guestNoteIdOf } from "../lib/guest-text";

const SWEEP_BATCH = 50;

/** Notes or links per export page. */
const EXPORT_PAGE = 100;

/** The most links of a thread read when looking for waiting notes: a thread has one live link at a time. */
const GUEST_LINK_SCAN = 10;

/** Removal batches a new link may run to clear the ones it replaces. */
const REPLACE_PASSES = 4;

const vGuestMessageStatus = v.union(v.literal("held"), v.literal("sent"));

const vHoldOutcome = v.union(
    v.object({ messageId: v.string(), minted: v.boolean(), ok: v.literal(true) }),
    // A retry of a post the shard already wrote: answered as accepted, with no second note and no second charge.
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
            v.literal("unsendable"),
        ),
    }),
);

const vGuestView = v.object({
    expiresAt: v.number(),
    messages: v.array(v.object({ createdAt: v.number(), status: vGuestMessageStatus, text: v.string() })),
});

/** The shape `newGuestToken` mints: 64 lowercase hex characters. A browser naming its own token must use it. */
const GUEST_TOKEN_SHAPE = /^[0-9a-f]{64}$/u;

/** A request id the browser picks for one post: 8 to 64 letters, digits or dashes. */
const REQUEST_ID_SHAPE = /^[A-Za-z0-9-]{8,64}$/u;

const tooLong = (token: string): boolean => token.length === 0 || token.length > GUEST_TOKEN_MAX_LENGTH;

/** The notes on the thread's live links that still wait for the owner. A lapsed link's notes are hidden and do not count. */
const waitingNotes = async (context: MutationCtx, threadId: Id<"threads">): Promise<Id<"threadGuestMessages">[]> => {
    const waiting: Id<"threadGuestMessages">[] = [];
    const links = await context.db
        .query("threadGuestLinks")
        .withIndex("by_thread_expiresAt", (q) => q.eq("threadId", threadId).gt("expiresAt", context.now))
        .take(GUEST_LINK_SCAN);

    for (const link of links) {
        const notes = await context.db
            .query("threadGuestMessages")
            .withIndex("by_link", (q) => q.eq("linkId", link._id))
            .take(GUEST_MAX_ROWS_PER_LINK);

        waiting.push(...notes.filter((note) => note.status === "held").map((note) => note._id));
    }

    return waiting;
};

const hasWaitingNotes = async (context: MutationCtx, threadId: Id<"threads">): Promise<boolean> => {
    const waiting = await waitingNotes(context, threadId);

    return waiting.length > 0;
};

// ---------------------------------------------------------------------------
// The owner
// ---------------------------------------------------------------------------

/** Makes the thread's guest link (replacing any earlier one). The token comes back once; only its hash is kept. */
export const createGuestLink = authMutation
    .use(rateLimit("sharing/create"))
    .input({ discardWaiting: v.optional(v.boolean()), threadId: v.id("threads") })
    .output(v.object({ expiresAt: v.number(), id: v.string(), linkToken: v.string() }))
    .mutation(async ({ args: { discardWaiting, threadId }, ctx: context }) => {
        const { userId } = context.user;
        // The owner alone, and never a locked chat: this takes no unlock proof, and a link into a locked chat would be a way around the lock.
        const thread = await requireOwnedThread(context, threadId, userId);

        // As the withdrawal paths: an archived, trashed, temporary or locked thread holds no link. A locked one must not
        // either way, since changing its passcode re-stamps `lockedAt` without withdrawing links.
        if (thread.deleted === true || thread.isTemporary === true || thread.status === "archived" || isThreadLocked(thread)) {
            throw new LunoraError("BAD_REQUEST", "This chat cannot be given a guest link.", { data: { code: "GUEST_LINK_NOT_ALLOWED" } });
        }

        // A coding-agent thread runs on the owner's computer, never from a guest's note: refused with the same code.
        if (isHostRunThread(thread)) {
            throw new LunoraError("BAD_REQUEST", "A coding-agent thread runs on your computer and cannot be given a guest link.", {
                data: { code: "GUEST_LINK_NOT_ALLOWED" },
            });
        }

        // A worker's conversation takes turns only through a dispatch, so a note left in it could never be sent.
        if (await isWorkerThread(context, threadId)) {
            throw new LunoraError("BAD_REQUEST", "A worker's conversation cannot be given a guest link.", { data: { code: "GUEST_LINK_NOT_ALLOWED" } });
        }

        // A new link replaces the old one and everything on it, so notes still waiting are not dropped silently.
        if (discardWaiting !== true && (await hasWaitingNotes(context, threadId))) {
            throw new LunoraError("BAD_REQUEST", "Deal with the waiting guest messages first, or discard them to make a new link.", {
                data: { code: "GUEST_NOTES_WAITING" },
            });
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

        const linkId = await context.db.insert("threadGuestLinks", { createdAt: context.now, expiresAt, linkHash, threadId, userId });

        await setShardRoute(context, "guest-link", linkHash, userId);
        // The replaced links' routes go in a job that runs only once this write commits.
        await scheduleGuestLinkRouteDrop(context, replacedHashes);
        // So housekeeping visits this shard after the link lapses, even when the owner is not seen again.
        await noteShardActivity(context, userId);
        context.log.event("chat.create_guest_link", { created: true });

        // The id (never secret) lets the owner's panel tell this link from a later one made in the same millisecond.
        return { expiresAt, id: linkId as string, linkToken };
    });

/**
 * Withdraws the guest link and everything guests left on it. Works on a locked chat, so the owner can always withdraw. The
 * owner names the waiting notes they agreed to delete (`confirmedNotes`, none by default): a note they did not see (left
 * since, even in place of one sent meanwhile) is never deleted, the revoke is refused with the count now waiting instead.
 * The owner also names the link they meant (`linkId`): when another tab has replaced it, the live link is not that one
 * and the revoke is refused as an ended link, so a confirmation never takes a link the owner did not see. The reads and
 * the delete are one transaction.
 */
export const revokeGuestLink = authMutation
    .use(rateLimit("sharing/update"))
    .input({
        confirmedNotes: v.optional(v.array(v.id("threadGuestMessages")).max(GUEST_MAX_HELD_PER_LINK)),
        linkId: v.id("threadGuestLinks"),
        threadId: v.id("threads"),
    })
    .output(v.null())
    .mutation(async ({ args: { confirmedNotes = [], linkId, threadId }, ctx: context }) => {
        await requireOwnedThreadIgnoringLock(context, threadId, context.user.userId);

        // Only compared with the owner's own thread's live link: an id from elsewhere never matches and grants nothing.
        const live = await context.db
            .query("threadGuestLinks")
            .withIndex("by_thread_expiresAt", (q) => q.eq("threadId", threadId).gt("expiresAt", context.now))
            .first();

        if (live && live._id !== linkId) {
            throw new LunoraError("NOT_FOUND", "That guest link has ended.", { data: { code: "GUEST_LINK_ENDED" } });
        }

        // Only compared with the owner's own thread's notes: an id from another thread matches nothing and grants nothing.
        const confirmed = new Set<string>(confirmedNotes);
        const waiting = await waitingNotes(context, threadId);

        if (waiting.some((noteId) => !confirmed.has(noteId))) {
            throw new LunoraError("BAD_REQUEST", "Guest messages are waiting that were not confirmed.", {
                data: { code: "GUEST_NOTES_WAITING", waiting: waiting.length },
            });
        }

        await withdrawGuestLinksForThread(context, threadId);
        context.log.event("chat.revoke_guest_link", { revoked: true });

        return null;
    });

/** The thread's live link (never its token) and the messages left on it, for the owner's thread view. */
export const getGuestLink = authQuery
    .input({ threadId: v.id("threads"), unlockProof: v.optional(v.string().max(MAX_LENGTH.short)) })
    .output(
        v.object({
            link: v.union(v.object({ bound: v.boolean(), expiresAt: v.number(), id: v.string() }), v.null()),
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
            link: { bound: link.guestHash !== undefined, expiresAt: link.expiresAt, id: link._id as string },
            messages: rows.map((row) => {
                return { createdAt: row.createdAt, id: row._id as string, status: row.status, text: row.text };
            }),
        };
    });

/** The caller's own note on a live link, in a thread they own (the unlock proof on a locked one): what review acts on. */
const reviewableNote = async (context: Pick<QueryCtx, "db" | "now">, messageId: Id<"threadGuestMessages">, userId: string, unlockProof?: string) => {
    const row = await context.db.get("threadGuestMessages", messageId);

    if (!row || row.userId !== userId) {
        throw new LunoraError("NOT_FOUND", "That message is no longer waiting.", { data: { code: "GUEST_NOTE_GONE" } });
    }

    await requireOwnedThread(context, row.threadId, userId, unlockProof);

    const link = await context.db.get("threadGuestLinks", row.linkId);

    if (!link || link.expiresAt <= context.now) {
        throw new LunoraError("NOT_FOUND", "That guest link has ended.", { data: { code: "GUEST_LINK_ENDED" } });
    }

    return row;
};

/** Whether `/chat/start` holds the note's send: stored (it marked the note sent too), or within its lease (`settleSend` after). */
const sendUnderWay = async (ctx: Pick<QueryCtx, "db" | "now">, messageId: Id<"threadGuestMessages">): Promise<boolean> => {
    const send = await claimRow(ctx, GUEST_SEND_SCOPE, messageId);

    return send !== null && (send.result !== undefined || ctx.now - send.claimedAt < GUEST_SEND_LEASE_MS);
};

/** Messages a settle reads per page, newest first, and the most pages one settle reads. */
const SENT_NOTE_PAGE = 100;
const SENT_NOTE_PAGES = 3;

/** What a settle records when the walk ran out before reaching the send: the note is taken as sent (`findSentNote`). */
const PAST_SCAN = "past-scan";

/**
 * The user message carrying this note's id, written since `since`: pages newest first by `order` (one `paginate` per
 * transaction), each with the rest of its last turn. Past `SENT_NOTE_PAGES`, `PAST_SCAN`: freeing the claim could send twice.
 */
const findSentNote = async (ctx: Pick<MutationCtx, "db">, threadId: Id<"threads">, noteId: string, since: number): Promise<string | undefined> => {
    const db = admittedThreadDb(ctx, threadId);
    let below: number | undefined;

    for (let pages = 0; ; pages += 1) {
        if (pages === SENT_NOTE_PAGES) {
            return PAST_SCAN;
        }

        const page = await db
            .query("messages")
            .withIndex("by_threadId_order_stepOrder", (q) => (below === undefined ? q.eq("threadId", threadId) : q.eq("threadId", threadId).lt("order", below)))
            .order("desc")
            .take(SENT_NOTE_PAGE);
        const last = page.at(-1);
        const full = last !== undefined && page.length === SENT_NOTE_PAGE;
        const rest = full
            ? await db
                  .query("messages")
                  .withIndex("by_threadId_order_stepOrder", (q) => q.eq("threadId", threadId).eq("order", last.order))
                  .take(SENT_NOTE_PAGE)
            : [];
        const sent = [...page, ...rest].find((message) => {
            const { content, role } = (message.message ?? {}) as { content?: unknown; role?: unknown };

            return role === "user" && Array.isArray(content) && (content as { providerOptions?: unknown }[]).some((part) => guestNoteIdOf(part) === noteId);
        });

        if (sent || !full || page.some((message) => message._creationTime < since)) {
            return sent?._id as string | undefined;
        }

        below = last.order;
    }
};

/**
 * Settles a send with no record (dead isolate, failed record, lost save reply): marked sent when its message is in the thread,
 * freed otherwise. Without `now`, only past the lease; `/chat/start` passes `now` for its own failed send.
 */
const settleSend = async (ctx: Pick<MutationCtx, "db" | "now">, messageId: Id<"threadGuestMessages">, now?: { claimedAt: number }): Promise<void> => {
    const send = await claimRow(ctx, GUEST_SEND_SCOPE, messageId);
    const row = await ctx.db.get("threadGuestMessages", messageId);
    const due = now ? send?.claimedAt === now.claimedAt : send !== null && ctx.now - send.claimedAt >= GUEST_SEND_LEASE_MS;

    if (!send || !row || send.result !== undefined || !due) {
        return;
    }

    const savedId = await findSentNote(ctx, row.threadId, messageId, send.claimedAt);

    if (savedId === undefined) {
        await releaseClaim(ctx, GUEST_SEND_SCOPE, messageId, send.claimedAt);
    } else {
        await recordClaimResult(ctx, GUEST_SEND_SCOPE, messageId, send.claimedAt, savedId);
        await ctx.db.patch("threadGuestMessages", messageId, { status: "sent" });
    }
};

/** The note Send and Dismiss act on, a lapsed send settled first. A sent note is answered, not refused: a throw would undo the settle. */
const reviewedAfterSettle = async (context: MutationCtx, userId: string, messageId: Id<"threadGuestMessages">, unlockProof?: string) => {
    await reviewableNote(context, messageId, userId, unlockProof);
    await settleSend(context, messageId);

    const row = (await context.db.get("threadGuestMessages", messageId))!;

    if (row.status === "held" && (await sendUnderWay(context, messageId))) {
        throw new LunoraError("BAD_REQUEST", "That message is being sent.", { data: { code: "GUEST_NOTE_BEING_SENT" } });
    }

    return row;
};

const vReviewArgs = { messageId: v.id("threadGuestMessages"), unlockProof: v.optional(v.string().max(MAX_LENGTH.short)) };

/** The owner's Send: a held note's text for the client to send as `guestMessageId` on `/chat/start`; a sent note answers `sent`. */
export const sendHeldGuestMessage = authMutation
    .use(rateLimit("guest/review"))
    .input(vReviewArgs)
    .output(v.union(v.object({ status: v.literal("ready"), text: v.string(), threadId: v.string() }), v.object({ status: v.literal("sent") })))
    .mutation(async ({ args: { messageId, unlockProof }, ctx: context }) => {
        const row = await reviewedAfterSettle(context, context.user.userId, messageId, unlockProof);

        if (row.status === "sent") {
            return { status: "sent" as const };
        }

        context.log.event("chat.send_guest_message", { handedOut: true });

        return { status: "ready" as const, text: row.text, threadId: row.threadId as string };
    });

/** The owner's Dismiss: a held note is deleted; a sent one stays as the guest's record, answered `sent`. */
export const dismissHeldGuestMessage = authMutation
    .use(rateLimit("guest/review"))
    .input(vReviewArgs)
    .output(v.object({ status: v.union(v.literal("dismissed"), v.literal("sent")) }))
    .mutation(async ({ args: { messageId, unlockProof }, ctx: context }) => {
        const row = await reviewedAfterSettle(context, context.user.userId, messageId, unlockProof);

        if (row.status === "sent") {
            return { status: "sent" as const };
        }

        await context.db.delete("threadGuestMessages", messageId);
        context.log.event("chat.dismiss_guest_message", { dismissed: true });

        return { status: "dismissed" as const };
    });

// ---------------------------------------------------------------------------
// The guest
// ---------------------------------------------------------------------------

/**
 * Leaves a message on the link. The first post binds the link to this browser and returns its token, once;
 * the browser keeps it and presents it on every later call. Unknown, lapsed and withdrawn links answer alike.
 *
 * A browser may name its token before the first post, so a retry of a first post whose reply was lost still binds. The
 * server checks only its shape: the client must draw it from `crypto.getRandomValues` (32 bytes, as hex), keep it per
 * link, and never derive it from the link token, or whoever holds the link could post and read as the guest.
 */
export const postGuestMessage = publicAction
    .input({
        guestToken: v.optional(v.string().max(MAX_LENGTH.short)),
        linkToken: v.string().max(MAX_LENGTH.short),
        // The browser's id for this one post, reused by its retry after a lost reply: the same id and text write one note.
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
        // A browser may name the token it keeps before its first post, so a retry after a lost reply carries the token the
        // link was bound to. Only a token of the minted shape is taken; anything else gets a minted one. Never the link
        // token itself: everyone holding the link would then hold the guest's token too, and read the guest's notes.
        const named = guestToken !== undefined && guestToken !== linkToken && GUEST_TOKEN_SHAPE.test(guestToken);
        const fresh = named ? guestToken : newGuestToken();
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

/** Why `/chat/start` cannot send a note: gone or not the caller's, sent already, its send taken, or its link ended. */
type NoteRefusal = "being-sent" | "ended" | "missing" | "sent";

/** A note `/chat/start` may send for `userId` (theirs, held, on a live link, its send not yet taken), or why it may not. */
const noteForSend = async (
    ctx: Pick<QueryCtx, "db" | "now">,
    messageId: Id<"threadGuestMessages">,
    userId: string,
): Promise<{ refused: NoteRefusal } | { row: Doc<"threadGuestMessages"> }> => {
    const row = await ctx.db.get("threadGuestMessages", messageId);

    if (!row || row.userId !== userId) {
        return { refused: "missing" };
    }

    if (row.status !== "held") {
        return { refused: "sent" };
    }

    const link = await ctx.db.get("threadGuestLinks", row.linkId);

    if (!link || link.expiresAt <= ctx.now) {
        return { refused: "ended" };
    }

    return (await sendUnderWay(ctx, messageId)) ? { refused: "being-sent" } : { row };
};

const vNoteRefusal = v.object({ refused: v.union(v.literal("being-sent"), v.literal("ended"), v.literal("missing"), v.literal("sent")) });

/** `/chat/start`'s read of a note it is asked to send: its text and the chat it was left in, or why it cannot go. */
export const getGuestNoteForSend = internalQuery
    .input({ messageId: v.id("threadGuestMessages"), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.union(v.object({ text: v.string(), threadId: v.string() }), vNoteRefusal))
    .query(async ({ args, ctx }) => {
        const note = await noteForSend(ctx, args.messageId, args.userId);

        return "refused" in note ? note : { text: note.row.text, threadId: note.row.threadId as string };
    });

/** Takes the note's send for `/chat/start`: one winner however often it is sent. Its fence, or why it cannot be sent. */
export const claimGuestNoteSend = internalMutation
    .input({ messageId: v.id("threadGuestMessages"), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.union(v.object({ fence: v.number() }), vNoteRefusal))
    .mutation(async ({ args, ctx }) => {
        // Only the note's owner reaches the settle: marked sent when its message was saved after all, freed otherwise.
        const owned = await ctx.db.get("threadGuestMessages", args.messageId);

        if (owned?.userId !== args.userId) {
            return { refused: "missing" as const };
        }

        await settleSend(ctx, args.messageId);

        const note = await noteForSend(ctx, args.messageId, args.userId);

        if ("refused" in note) {
            return note;
        }

        const fence = await claimFence(ctx, GUEST_SEND_SCOPE, args.messageId, { ttlMs: GUEST_SEND_CLAIM_TTL_MS, userId: args.userId });

        // Another send took it in the meantime.
        return fence === null ? { refused: "being-sent" as const } : { fence };
    });

/** The note is saved as `savedMessageId`: one write records it on the send that still holds the claim and marks the note sent. */
export const recordGuestNoteSent = internalMutation
    .input({ claimedAt: v.number(), messageId: v.id("threadGuestMessages"), savedMessageId: v.string().max(MAX_LENGTH.id) })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        if (!(await recordClaimResult(ctx, GUEST_SEND_SCOPE, args.messageId, args.claimedAt, args.savedMessageId))) {
            return false;
        }

        await ctx.db.patch("threadGuestMessages", args.messageId, { status: "sent" });

        return true;
    });

/**
 * A `/chat/start` send that saved the note as `savedMessageId` and died before its record: its resend (`chat/start-claim.ts`,
 * whose fingerprint binds the note to the claim, so the saved message is this note's) marks the note sent on whatever guest
 * send still holds it, without saving it again. A note already sent is left as it is.
 */
export const recordResumedGuestNoteSent = internalMutation
    .input({ messageId: v.id("threadGuestMessages"), savedMessageId: v.string().max(MAX_LENGTH.id), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        const row = await ctx.db.get("threadGuestMessages", args.messageId);

        if (row?.userId !== args.userId || row.status !== "held") {
            return false;
        }

        const send = await claimRow(ctx, GUEST_SEND_SCOPE, args.messageId);
        const claimedAt = send?.claimedAt ?? (await claimFence(ctx, GUEST_SEND_SCOPE, args.messageId, { ttlMs: GUEST_SEND_CLAIM_TTL_MS, userId: args.userId }));

        if (claimedAt === null || !(await recordClaimResult(ctx, GUEST_SEND_SCOPE, args.messageId, claimedAt, args.savedMessageId))) {
            return false;
        }

        await ctx.db.patch("threadGuestMessages", args.messageId, { status: "sent" });

        return true;
    });

/** `/chat/start` gave up on its send (charge, agent or save failed): settled at once, as a lost reply may have saved it. */
export const releaseGuestNoteSend = internalMutation
    .input({ claimedAt: v.number(), messageId: v.id("threadGuestMessages") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await settleSend(ctx, args.messageId, { claimedAt: args.claimedAt });

        return null;
    });

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

        // A request id names one post. Its retry with the same text is answered without a second note or a second charge; the
        // same id with other text is refused, since it would otherwise write a second note under an id the browser already used.
        const requestClaim = requestKey === undefined ? undefined : `${link._id}:${requestKey}`;
        const textClaim = requestClaim === undefined || requestHash === undefined ? undefined : `${link._id}:${requestHash}`;

        if (requestClaim !== undefined && textClaim !== undefined && (await hasClaim(ctx, GUEST_POST_SCOPE, requestClaim))) {
            return (await hasClaim(ctx, GUEST_POST_SCOPE, textClaim))
                ? ({ duplicate: true, minted, ok: true } as const)
                : ({ ok: false, reason: "request_reused" } as const);
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
