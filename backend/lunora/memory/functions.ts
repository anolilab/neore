import { LunoraError } from "lunorash/server";
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { isAccountDeletionUnderway } from "../gdpr/deletion-guard";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { memoryLogger } from "../lib/logger";
import { noteShardDue } from "../lib/shard-housekeeping";
import { isThreadLocked } from "../lib/thread-lock";
import { patchById, patchRow, withoutUndefined } from "../lib/patch";
import { runAfterOnShard } from "../lib/shard-scheduler";
import { dateColumns, factDatesOf, hasFactDates, isExpired, normalizeFactDates, restatedDates, sameFactDates, userFactDates } from "./dates";
import {
    type ImportApp,
    importDedupKey,
    IMPORT_ACCOUNT_DELETING_MESSAGE,
    IMPORT_MEMORY_OFF_MESSAGE,
    IMPORT_WIDE_WINDOW_ROWS,
    IMPORTED_CONFIDENCE,
    IMPORTED_IMPORTANCE,
    vImportApp,
} from "./import-logic";
import { botOwnerRows } from "./bot-owner";
import { type MemoryEvidence, newestEvidence, vMemoryEvidence } from "./evidence";
import { logRedaction, redactMemoryText } from "./redact";
import { DROPPED_DIGEST_SUMMARY, localDayOf } from "./reflection-logic";
import { byNewest, isUsableOn, KEYWORD_LOOKUP_LIMIT, keywordLookupOf, lookupSearchesOf, mergeScopeWindows, scopesOf } from "./retrieve-ranking";
import { lastConfirmedOf, MEMORY_TYPES, type MemoryType, vMemoryType } from "./taxonomy";
import { deleteVectorRow, patchMessage } from "../agent/table-writes";
import { candidatesOnActivePath } from "../agent/branch-rows";
import { requireOwnedThread, resolveThreadReadAccess } from "../agent/thread-read-access";
import { getVectorIdInfo, type VectorTableId, type VectorTableName } from "../agent/vector/tables";
import { parentKeyOf } from "../lib/rls/scope";
import { MAX_LENGTH } from "../lib/validators";
import { MAX_KEYWORD_TERMS } from "../knowledge/hybrid";
import { isSearchIndexBuilding } from "../lib/search-index";
import { findLiveGrant } from "../agent/live-grant";

/**
 * Whether the user turned memory on. OPT-IN: absent means off. Memory extraction reads every
 * conversation and derives statements about the user, so it must not start because nobody
 * has visited the setting yet. Enabling it is a deliberate act.
 */
export const readMemoryEnabled = async (ctx: Pick<QueryCtx, "db">, userId: string): Promise<boolean> => {
    const settings = await ctx.db
        .query("userSettings")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique();

    return settings?.memoryEnabled === true;
};

/** Most memories one user-facing read looks at. */
const MEMORY_READ_CAP = 2000;

/**
 * The row as the settings UI sees it. `botNames` holds the names of the user's bots that still exist.
 * The quote itself is read on expand (`getMemorySource`), so this live list never reads a thread.
 */
type BotOwnerRow = { deleted: boolean; ownerId: string };

const toMemoryView = (m: Doc<"memories">, botNames: ReadonlyMap<string, string>, owners: ReadonlyMap<string, BotOwnerRow>, userId: string) => {
    const botId = m.botId as string | undefined;
    // The `botOwners` row is the authority, read for every unnamed bot. A deleted row, or one naming this user (whose bot
    // is not here any more), is a bot that is gone. No row says nothing: rows exist only for bots created since
    // `botOwners`, so an older bot may still be live.
    const row = botId === undefined ? undefined : owners.get(botId);
    const named = botId !== undefined && botNames.has(botId);

    return {
        _creationTime: m._creationTime,
        _id: m._id as string,
        // Unset with `fromBot` set: the bot was deleted, or it is the bot of whoever shared the chat (on their shard).
        botName: botId === undefined ? undefined : botNames.get(botId),
        // Set only on a bot memory whose bot another user owns and still has; with no `botName`, it tells a shared chat's bot from a deleted one.
        botOwnedByOther: row !== undefined && row.ownerId !== userId && !row.deleted ? true : undefined,
        // Set only on an unnamed bot memory whose bot has no `botOwners` row: whether it is live or deleted, and whose, is unknown.
        botOwnerUnknown: botId !== undefined && !named && row === undefined ? true : undefined,
        confidence: m.confidence ?? undefined,
        createdAt: m._creationTime,
        // When the words the shown quote came from were said: the date the row shows beside its label.
        evidenceAt: m.evidence?.at,
        fromBot: botId !== undefined,
        hasEvidence: m.evidence !== undefined,
        importance: m.importance ?? undefined,
        importedFrom: m.importedFrom ?? undefined,
        lastConfirmedAt: lastConfirmedOf(m),
        memory: m.memory,
        pinned: m.pinned === true,
        ...factDatesOf(m),
        source: m.source ?? undefined,
        supersededBy: m.supersededBy ?? undefined,
        supersedes: m.supersedes ?? undefined,
        threadId: (m.threadId as string | undefined) ?? undefined,
        type: m.type,
        updatedAt: m.updatedAt ?? undefined,
        version: m.version ?? undefined,
    };
};

/** Loads a memory the caller owns, or throws. */
const requireOwnMemory = async (ctx: Pick<MutationCtx, "db">, memoryId: string, userId: string): Promise<Doc<"memories">> => {
    const memory = await ctx.db.get("memories", memoryId as Id<"memories">);

    if (!memory) {
        throw new LunoraError("NOT_FOUND", "Memory not found");
    }

    if (memory.userId !== userId) {
        throw new LunoraError("FORBIDDEN", "Not authorized to change this memory");
    }

    return memory;
};

/** The user's timezone (`userSettings.timezone`); unset reads as UTC wherever it is used. */
const userTimeZone = async (ctx: Pick<QueryCtx, "db">, userId: string): Promise<string | undefined> => {
    const settings = await ctx.db
        .query("userSettings")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique();

    return settings?.timezone ?? undefined;
};

// ============================================================================
// cRPC Functions (user-facing, authenticated)
// ============================================================================

/**
 * List all active memories for the authenticated user, newest first.
 * Excludes superseded memories by default.
 */
export const listUserMemories = authQuery
    .input({
        includeSuperseded: v.optional(v.boolean()),
    })
    .output(
        v.array(
            v.object({
                _creationTime: v.number(),
                _id: v.string(),
                botName: v.optional(v.string()),
                botOwnedByOther: v.optional(v.boolean()),
                botOwnerUnknown: v.optional(v.boolean()),
                confidence: v.optional(v.number()),
                createdAt: v.number(),
                eventEnd: v.optional(v.string()),
                eventStart: v.optional(v.string()),
                evidenceAt: v.optional(v.number()),
                fromBot: v.boolean(),
                hasEvidence: v.boolean(),
                importance: v.optional(v.number()),
                importedFrom: v.optional(vImportApp),
                lastConfirmedAt: v.number(),
                memory: v.string(),
                pinned: v.boolean(),
                source: v.optional(v.string()),
                supersededBy: v.optional(v.string()),
                supersedes: v.optional(v.string()),
                threadId: v.optional(v.string()),
                type: v.union(v.literal("identity"), v.literal("preference"), v.literal("context"), v.literal("activity"), v.literal("experience")),
                updatedAt: v.optional(v.number()),
                validUntil: v.optional(v.string()),
                version: v.optional(v.number()),
            }),
        ),
    )
    .query(async ({ args: { includeSuperseded }, ctx: context }) => {
        const { userId } = context.user;

        const memories = await context.db
            .query("memories")
            .withIndex("by_userId_type", (q) => q.eq("userId", userId))
            .take(MEMORY_READ_CAP);

        // Filter out superseded memories unless explicitly requested
        const filtered = includeSuperseded ? memories : memories.filter((m) => !m.supersededBy);

        // "Learned by <bot>": one read per distinct bot; a deleted bot has no name.
        const botIds = [...new Set(filtered.map((m) => m.botId).filter((id): id is Id<"bots"> => id !== undefined))];
        const bots = await Promise.all(botIds.map(async (id) => context.db.get("bots", id)));
        const botNames = new Map(bots.filter((bot): bot is Doc<"bots"> => bot !== null && bot.userId === userId).map((bot) => [bot._id as string, bot.name]));

        // A bot another user owns is not on this shard, so its name is unknown here; its `botOwners` row says who owns it and whether it was deleted.
        const unnamedBotIds = botIds.filter((id) => !botNames.has(id as string)).map((id) => id as string);
        const owners = await botOwnerRows(context, unnamedBotIds);

        // The index orders by type first, so recency is imposed here.
        return filtered.toSorted((a, b) => b._creationTime - a._creationTime).map((m) => toMemoryView(m, botNames, owners, userId));
    });

/**
 * Why a memory is there, read when its row is expanded: the user's own words
 * and where to open the chat they were in.
 *
 * - `quote` is hidden while that chat is locked: the words stay behind its passcode, and `quoteHidden` says so
 *   (a memory rewritten since has no quote, which reads differently).
 * - `threadId` (and `messageId` while that message still exists) only when the
 *   caller can open the chat now: not gone, in the trash, locked (no passcode
 *   proof is taken here) or no longer readable by them. Short of a lock, the quote stays.
 *
 * `null` for a memory that is not the caller's.
 */
/** Whether `userId` holds an unexpired grant to another person's thread (`threadAccess`, global, so readable from any shard). */
const holdsThreadGrant = async (context: Pick<QueryCtx, "db">, threadId: string, userId: string): Promise<boolean> => {
    // Primary: a replica that lags a revocation would still show the grant.
    const grant = await findLiveGrant(context, threadId as Id<"threads">, userId, { primary: true });

    return grant !== null && (grant.expiresAt === undefined || grant.expiresAt >= Date.now());
};

/** Rows `getMemorySource` walks back from the chat's newest message to find out whether a quote's message is on display. */
const SOURCE_PATH_WALK_LIMIT = 2000;

export const getMemorySource = authQuery
    .input({ memoryId: v.string().max(MAX_LENGTH.id) })
    .output(
        v.union(
            v.null(),
            v.object({
                messageId: v.optional(v.string()),
                /** Where the message sits in the thread, so the chat can page back to it however old it is. */
                messageOrder: v.optional(v.number()),
                messageStepOrder: v.optional(v.number()),
                quote: v.optional(v.string()),
                /** When the quoted words were said, read with the quote: the list's date may be older than a newer quote. */
                quoteAt: v.optional(v.number()),
                quoteHidden: v.optional(v.boolean()),
                threadId: v.optional(v.string()),
            }),
        ),
    )
    .query(async ({ args: { memoryId }, ctx: context }) => {
        const { userId } = context.user;
        const memory = await context.db.get("memories", memoryId as Id<"memories">);

        if (!memory || memory.userId !== userId) {
            return null;
        }

        // The evidence names the message the quote came from; older rows only their thread.
        const threadId = memory.evidence?.threadId ?? (memory.threadId as string | undefined);
        const access = threadId === undefined ? null : await resolveThreadReadAccess(context, threadId as Id<"threads">, userId);
        // A quote is shown while its chat can still be read: the user's own chat, in the trash too, or a shared chat they still
        // hold a grant to (it lives on its owner's shard, so only the global grant is seen from here). A chat locked since, one
        // purged, and one whose owner took this user's access away (a former collaborator) keep their words to themselves.
        const readable =
            threadId === undefined ||
            (access?.kind === "full" && (access.thread.deleted !== true || access.thread.userId === userId)) ||
            (access === null && (await holdsThreadGrant(context, threadId, userId)));
        const quoteHidden = !readable && memory.evidence?.quote !== undefined;
        const quote = readable ? memory.evidence?.quote : undefined;
        const quoteAt = quote === undefined ? undefined : memory.evidence?.at;

        if (access?.kind !== "full" || access.thread.deleted === true) {
            return withoutUndefined({ quote, quoteAt, quoteHidden: quoteHidden || undefined });
        }

        const messageId = memory.evidence?.messageId;
        const message = messageId === undefined ? null : await context.db.get("messages", messageId as Id<"messages">);
        // The chat shows only the branch on display: a message on a branch the user left has no row to jump to.
        const leaf = access.thread.activeLeafMessageId;
        let onPath = message !== null && message.threadId === access.thread._id;

        if (message && onPath && leaf) {
            // Bounded: a message further back than the walk reaches links to its chat only.
            const onBranch = await candidatesOnActivePath(context, access.thread._id, leaf, [{ _id: message._id as string, order: message.order }], {
                limit: SOURCE_PATH_WALK_LIMIT,
            });

            onPath = onBranch.has(message._id as string);
        }

        return withoutUndefined({
            messageId: onPath ? messageId : undefined,
            messageOrder: onPath ? message?.order : undefined,
            messageStepOrder: onPath ? (message?.stepOrder ?? 0) : undefined,
            quote,
            quoteAt,
            threadId,
        });
    });

/**
 * Get memory statistics for the authenticated user.
 */
export const getMemoryStats = authQuery
    .output(v.object({ byType: v.record(v.string(), v.number()), pinned: v.number(), total: v.number() }))
    .query(async ({ ctx: context }) => {
        const { userId } = context.user;

        const memories = await context.db
            .query("memories")
            .withIndex("by_userId_type", (q) => q.eq("userId", userId))
            .take(MEMORY_READ_CAP);

        // Only count active (non-superseded) memories
        const active = memories.filter((m) => !m.supersededBy);

        const byType: Record<string, number> = {};

        for (const m of active) {
            const { type } = m;

            byType[type] = (byType[type] ?? 0) + 1;
        }

        return {
            byType,
            pinned: active.filter((m) => m.pinned === true).length,
            total: active.length,
        };
    });

/** Attempts a memory's vector delete gets in all (the first inline, the rest scheduled). */
const VECTOR_DELETE_ATTEMPTS = 5;
const VECTOR_DELETE_RETRY_BASE_MS = 60_000;

type OrphanedVector = { embeddingId: string; memoryId: string; userId: string };

/** A record younger than this may still have its scheduled vector retries on its way (1 + 2 + 4 + 8 minutes). */
const CLEANUP_GRACE_MS = 20 * 60 * 1000;
/** Failed steps a record gets before it is given up on (kept, never retried again). */
const CLEANUP_MAX_ATTEMPTS = 12;
/** 30 minutes after the first failure, doubling to a day: twelve attempts span about a week, so an outage of days is outlasted. */
const CLEANUP_RETRY_BASE_MS = 15 * 60 * 1000;
const CLEANUP_RETRY_MAX_MS = 24 * 60 * 60 * 1000;
/** `dueAt` of a record given up on: the latest date there is, so no pass ever takes it, and the row stays to be found. */
const CLEANUP_NEVER = 8.64e15;

/**
 * Wakes the owner's shard for a cleanup record due at `dueAt`: the census's `nextDueAt`, which the minute tick answers with
 * `runShardTick` for every shard that has one, however long ago its owner was last active (housekeeping stops at 30 days). The
 * same path the retained-rows prune and the stalled guest merges take. A census write that fails is logged by `noteShardDue`
 * and never fails the caller.
 */
const wakeShardForCleanup = async (ctx: Pick<MutationCtx, "db">, userId: string, dueAt: number): Promise<void> => {
    await noteShardDue(ctx, dueAt, userId);
};

/**
 * Starts a scheduler job on the owner's shard that works one cleanup record: the fast path. A failure to schedule is
 * logged and never thrown: the record's `dueAt` stays, and the census wake ({@link wakeShardForCleanup}) and the
 * housekeeping sweep arm it again.
 */
const armMemoryCleanup = async (scheduler: unknown, cleanupId: Id<"memoryCleanups">, userId: string, delayMs: number): Promise<void> => {
    try {
        await runAfterOnShard(scheduler, delayMs, internal.memory.functions.runMemoryCleanup, { cleanupId }, userId);
    } catch (error) {
        memoryLogger.error(`Could not schedule cleanup ${cleanupId} of user ${userId}; the housekeeping sweep will arm it`, error);
    }
};

/**
 * Notes a vector whose delete failed in `memoryCleanups`, in the writing transaction: the row that pointed at it is
 * already cleared or gone, so this is the only reference left. The scheduled retries are a fast path; the record is
 * what {@link runMemoryCleanup} works from when they are lost or give up.
 */
const recordVectorDelete = async (ctx: Pick<MutationCtx, "db" | "now" | "scheduler">, orphan: OrphanedVector): Promise<void> => {
    const [known] = await ctx.db
        .query("memoryCleanups")
        .withIndex("by_embeddingId", (q) => q.eq("embeddingId", orphan.embeddingId))
        .take(1);

    if (!known) {
        const dueAt = ctx.now + CLEANUP_GRACE_MS;
        const cleanupId = await ctx.db.insert("memoryCleanups", {
            dueAt,
            embeddingId: orphan.embeddingId,
            kind: "vector",
            memoryId: orphan.memoryId,
            userId: orphan.userId,
        });

        await wakeShardForCleanup(ctx, orphan.userId, dueAt);
        await armMemoryCleanup(ctx.scheduler, cleanupId, orphan.userId, CLEANUP_GRACE_MS);
    }
};

/**
 * Delete the embedding of a memory whose row is already gone. The vector's table is
 * resolved from its id (a memory's embedding is normally `embeddings_1024`) and the
 * embedding carries no memory text, only the vector plus model/table/thread/user ids.
 *
 * This covers the vector ROW in the database. The sync of that delete to the vector
 * index runs after the transaction commits, outside this function, so a failure
 * there is not seen here. When the row delete fails, the failure is never swallowed:
 * it is logged with the ids that find the orphan, recorded in `memoryCleanups` (in
 * this same transaction, so the reference is never lost) and retried by
 * {@link retryMemoryVectorDelete} with a growing delay. That retry is scheduled from
 * the mutation, so it exists only if the row delete committed; when it cannot be
 * scheduled, or gives up, the record stays and its own scheduler job works it. A failure to
 * find the vector's table is handled the same way, never as "gone": the record is what finds it again.
 *
 * Resolves `true` when nothing is left to delete (done or already gone) and `false` while the vector may still be there.
 */
const deleteMemoryVector = async (
    context: MutationCtx,
    orphan: OrphanedVector,
    { attempt = 1, fromCleanup = false }: { attempt?: number; fromCleanup?: boolean } = {},
): Promise<boolean> => {
    let vectorId: Id<VectorTableName>;
    let vectorTable: VectorTableName;

    try {
        const info = await getVectorIdInfo(context, orphan.embeddingId as VectorTableId);

        // In no embeddings table: the vector is already gone (deleted with its thread, or a retried delete landed).
        if (info === null) {
            return true;
        }

        vectorTable = info.tableName;
        vectorId = context.db.asId(info.tableName, orphan.embeddingId);
    } catch (error) {
        // Not told apart from a failed read: the vector may still be there, so the record stays and the cleanup retries it.
        memoryLogger.error(`Could not find the vector table of embedding ${orphan.embeddingId} of memory ${orphan.memoryId} (user ${orphan.userId})`, error);
        await recordVectorDelete(context, orphan);

        return false;
    }

    try {
        await deleteVectorRow(context.db, vectorId, vectorTable);

        return true;
    } catch (error) {
        // Already gone (a retry of a delete that did land): nothing is orphaned.
        if ((await context.db.get(vectorTable, vectorId).catch(() => undefined)) === null) {
            return true;
        }

        await recordVectorDelete(context, orphan);

        // A cleanup step is a retry of its own: the record counts its attempts and logs the one error where they run out
        // (`noteMemoryCleanupFailure`), and no ladder of scheduled retries is started beside it.
        if (fromCleanup) {
            memoryLogger.warn(`Vector delete failed again for memory ${orphan.memoryId} (embedding ${orphan.embeddingId}, user ${orphan.userId})`, error);

            return false;
        }

        if (attempt >= VECTOR_DELETE_ATTEMPTS) {
            memoryLogger.error(
                `Giving up the scheduled retries of the vector of memory ${orphan.memoryId}: embedding ${orphan.embeddingId} of user ${orphan.userId} stays recorded for its cleanup job`,
                error,
            );

            return false;
        }

        memoryLogger.warn(`Vector delete failed for memory ${orphan.memoryId} (embedding ${orphan.embeddingId}, user ${orphan.userId}); retrying`, error);

        try {
            await context.scheduler.runAfter(VECTOR_DELETE_RETRY_BASE_MS * 2 ** (attempt - 1), internal.memory.functions.retryMemoryVectorDelete, {
                ...orphan,
                attempt: attempt + 1,
            });
        } catch (scheduleError) {
            memoryLogger.error(`Could not schedule the retry of embedding ${orphan.embeddingId}; its cleanup record covers it`, scheduleError);
        }

        return false;
    }
};

/** A retry or a sweep pass over a recorded vector delete: when nothing is left of the vector, its record goes. */
const resumeVectorDelete = async (context: MutationCtx, orphan: OrphanedVector, options: { attempt?: number; fromCleanup?: boolean }): Promise<boolean> => {
    const done = await deleteMemoryVector(context, orphan, options);

    if (done) {
        const records = await context.db
            .query("memoryCleanups")
            .withIndex("by_embeddingId", (q) => q.eq("embeddingId", orphan.embeddingId))
            .take(10);

        for (const record of records) {
            await context.db.delete("memoryCleanups", record._id);
        }
    }

    return done;
};

/**
 * Schedules a fresh vector for a memory whose wording changed, on the owner's shard: the row and its vector live
 * there, and a job without a shard key would run where neither does.
 */
export const scheduleMemoryReembed = async (scheduler: unknown, memoryId: Id<"memories">, userId: string): Promise<void> => {
    await runAfterOnShard(scheduler, 0, internal.memory.extract.regenerateMemoryEmbedding, { memoryId, userId }, userId);
};

/**
 * For a write that changed a row's wording: the row's vector encodes the old wording, so it goes now, before the
 * re-embed's model call, and the row is found by keyword until the new vector is attached. Then the re-embed is scheduled.
 */
export const reembedRewordedMemory = async (ctx: MutationCtx, memoryId: Id<"memories">, userId: string): Promise<void> => {
    const row = await ctx.db.get("memories", memoryId);

    if (row?.embeddingId) {
        await patchRow(ctx.db, "memories", row, { embeddingId: undefined });
        await deleteMemoryVector(ctx, { embeddingId: row.embeddingId, memoryId, userId });
    }

    await scheduleMemoryReembed(ctx.scheduler, memoryId, userId);
};

/**
 * Ends a row's life as a current memory: `supersededBy` points at what replaced it (itself, for a decay, an expiry or a
 * compression), and its vector goes in the same write, so a retired row never takes a slot in a meaning search. The row
 * stays as history. The vector delete is a row delete the vector sync follows after commit; a failure of it is logged,
 * recorded in `memoryCleanups` in this write and retried (`deleteMemoryVector`), and never undoes the retirement. Nothing
 * here swallows an error: a write that cannot even record the pending delete fails whole, so the row keeps its `embeddingId`.
 */
export const supersedeMemory = async (ctx: MutationCtx, memoryId: Id<"memories">, supersededBy: Id<"memories">, now: number): Promise<void> => {
    // Read again here: the caller's copy may predate an earlier write of the same mutation, and the row is replaced when its vector link is cleared.
    const row = await ctx.db.get("memories", memoryId);

    if (!row) {
        return;
    }

    const { embeddingId } = row;

    await patchRow(ctx.db, "memories", row, { supersededBy, updatedAt: now, ...(embeddingId && { embeddingId: undefined }) });

    if (!embeddingId) {
        return;
    }

    await deleteMemoryVector(ctx, { embeddingId, memoryId, userId: row.userId ?? "" });
};

/** Retry of a memory vector delete that failed (`deleteMemoryVector`). */
export const retryMemoryVectorDelete = internalMutation
    .input({
        attempt: v.number(),
        embeddingId: v.string().max(MAX_LENGTH.id),
        memoryId: v.string().max(MAX_LENGTH.id),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.null())
    .mutation(async ({ args: { attempt, ...orphan }, ctx: context }) => {
        await resumeVectorDelete(context, orphan, { attempt });

        return null;
    });

/** Older versions one delete removes per write; a longer chain goes on in a follow-up write. */
const CHAIN_DELETE_BATCH = 100;
/** Ids of a chain walk one write looks up (a read each), apart from the rows it deletes; the rest are kept in the record. */
const CHAIN_LOOKUP_BATCH = 200;
/** Digests one write cleans; a user with more (a guest merge can copy a whole history in) goes on in a cleanup record. */
const DIGEST_PAGE = 100;

/** Removes a row and, after it, its vector (a vector with no row can be found by a retry; a row pointing at a gone vector cannot). */
const removeMemoryRow = async (ctx: MutationCtx, row: Doc<"memories">, userId: string): Promise<void> => {
    await ctx.db.delete("memories", row._id);

    if (row.embeddingId) {
        await deleteMemoryVector(ctx, { embeddingId: row.embeddingId, memoryId: row._id, userId });
    }
};

/**
 * Takes the deleted memories out of one page ({@link DIGEST_PAGE}) of the user's reflection digests, from `cursor` on.
 * An entry of a deleted id goes; a digest whose entries all went is removed, one that still has others keeps them (and
 * its other fields), without its summary.
 *
 * A digest's summary is model-written text with no pointer to the memories it drew on, so a deleted memory's wording can
 * sit in it with or without an entry in `learned` (a merge or a promotion puts rows in it that the list never names).
 * Nor can a creation time bound which digests could have quoted a row: a guest merge re-creates its rows. So every
 * digest of the user loses its summary ({@link DROPPED_DIGEST_SUMMARY}); nothing is regenerated here, and the digest's
 * other fields stay. Resolves the cursor of the next page, or `null` when the user's digests are all done. The cursor
 * orders rows by `createdAt` and then by their own id, so any number of digests sharing a `createdAt` is walked once; the
 * walk ends at `startedAt`, when the delete began, so a digest saved after it (which `saveMemoryDigest` checked) is left alone.
 */
const removeFromDigests = async (
    ctx: Pick<MutationCtx, "db">,
    userId: string,
    ids: ReadonlySet<string>,
    walk: { cursor: string | null; startedAt: number },
): Promise<string | null> => {
    const { continueCursor, isDone, page } = await ctx.db
        .query("memoryDigests")
        .withIndex("by_userId_createdAt", (q) => q.eq("userId", userId).lte("createdAt", walk.startedAt))
        .paginate({ cursor: walk.cursor, numItems: DIGEST_PAGE });

    for (const digest of page) {
        const learned = digest.learned.filter((entry) => !ids.has(entry.memoryId));

        if (learned.length === 0 && digest.learned.length > 0) {
            await ctx.db.delete("memoryDigests", digest._id);

            continue;
        }

        const listed = learned.length !== digest.learned.length;
        const hasSummary = digest.summary !== DROPPED_DIGEST_SUMMARY;

        if (listed || hasSummary) {
            await ctx.db.patch("memoryDigests", digest._id, { learned, summary: DROPPED_DIGEST_SUMMARY });
        }
    }

    return isDone ? null : continueCursor;
};

/**
 * Removes the older versions of the memories in `frontier` (ids already deleted, or about to be): every row that was
 * superseded by one of them, and so on back, with their vectors and digest entries. Rows are found by the pointer the
 * newer row left in `supersededBy`, so a merge or a promotion by reflection is followed as well as a belief revision.
 *
 * One call is ONE write and nothing in it catches an error: the rows it deletes, their digest entries and the saved
 * frontier move together, or the write throws and none of it happened (the callers' failure handling is outside it, in
 * {@link runMemoryCleanup}). At most {@link CHAIN_DELETE_BATCH} rows per call. What is left is kept in a `memoryCleanups`
 * row of the same write (the ids still to walk: the root is already gone, so a lost follow-up could not otherwise
 * restart the walk), and its id comes back so the caller can continue; `cleanupId` is the row a follow-up continues,
 * moved on or removed once nothing is left. A repeat finds the same rows (a deleted row is gone, the next read starts
 * from the survivors).
 */
const eraseOlderVersions = async (
    ctx: MutationCtx,
    userId: string,
    frontier: ReadonlyArray<Id<"memories">>,
    deleted: ReadonlyArray<string>,
    cleanupId: Id<"memoryCleanups"> | undefined,
    startedAt: number,
): Promise<{ cleanupId: Id<"memoryCleanups"> | null; olderVersions: number }> => {
    const removed = new Set<string>(deleted);
    const pending: Id<"memories">[] = [];
    const queue = [...frontier];
    let budget = CHAIN_DELETE_BATCH;
    let lookups = CHAIN_LOOKUP_BATCH;

    while (queue.length > 0) {
        const id = queue.shift() as Id<"memories">;

        // Out of deletes or of lookups (a read per id, however few rows it holds): this id is walked in the follow-up.
        if (budget <= 0 || lookups <= 0) {
            pending.push(id);
            continue;
        }

        lookups -= 1;

        const older = await ctx.db
            .query("memories")
            .withIndex("by_userId_supersededBy", (q) => q.eq("userId", userId).eq("supersededBy", id))
            .take(budget + 2);
        // A row retired by itself (decay, expiry, compression) is its own `supersededBy`, never someone's older version. It
        // can take one slot of the read, so the read is one longer: what is left after it still shows whether more follow.
        const rows = older.filter((row) => row._id !== id);

        const taken = rows.slice(0, budget);

        for (const row of taken) {
            await removeMemoryRow(ctx, row, userId);
            removed.add(row._id);
            queue.push(row._id);
            budget -= 1;
        }

        // More older rows than the budget allowed: this id is walked again in the follow-up.
        if (rows.length > taken.length) {
            pending.push(id);
        }
    }

    // A step that removed nothing (the rest of a walk that ended) has nothing to take out of the digests.
    const digestsCursor = removed.size > 0 ? await removeFromDigests(ctx, userId, removed, { cursor: null, startedAt }) : null;

    if (digestsCursor !== null) {
        // More digests than one write cleans: the rest is a record of its own, which carries the ids to take out.
        const dueAt = ctx.now + CLEANUP_GRACE_MS;
        const digestsId = await ctx.db.insert("memoryCleanups", {
            cursor: digestsCursor,
            dueAt,
            ids: [...removed],
            kind: "digests",
            startedAt,
            userId,
        });

        await wakeShardForCleanup(ctx, userId, dueAt);
        await armMemoryCleanup(ctx.scheduler, digestsId, userId, 0);
    }

    const olderVersions = removed.size - deleted.length;

    if (pending.length === 0) {
        if (cleanupId) {
            await ctx.db.delete("memoryCleanups", cleanupId);
        }

        return { cleanupId: null, olderVersions };
    }

    // Due after the grace period, as a safety net: the job that continues the walk is armed by the caller.
    const dueAt = ctx.now + CLEANUP_GRACE_MS;

    await wakeShardForCleanup(ctx, userId, dueAt);

    if (cleanupId) {
        // A saved position is progress: the failures counted so far were not in a row, and the backoff is over.
        await ctx.db.patch("memoryCleanups", cleanupId, { attempts: 0, dueAt, frontier: pending });

        return { cleanupId, olderVersions };
    }

    return { cleanupId: await ctx.db.insert("memoryCleanups", { dueAt, frontier: pending, kind: "chain", startedAt, userId }), olderVersions };
};

/**
 * ONE step of one cleanup record, in its own write: a vector delete is tried again, a long chain's delete moves on by one
 * batch, the walk over a user's digests by one page. Atomic: it deletes rows, cleans their digest entries and moves the saved frontier together or throws and changes
 * nothing, so {@link runMemoryCleanup} can count the failure and try the record again. A record already finished is a no-op.
 * `again` asks for another step now; `failed` is a vector that is still there.
 */
export const stepMemoryCleanup = internalMutation
    .input({ cleanupId: v.id("memoryCleanups") })
    .output(v.object({ again: v.boolean(), failed: v.boolean(), userId: v.string() }))
    .mutation(async ({ args, ctx }) => {
        const row = await ctx.db.get("memoryCleanups", args.cleanupId);

        // Absent, or given up on: nothing to work.
        if (!row || (row.attempts ?? 0) >= CLEANUP_MAX_ATTEMPTS) {
            return { again: false, failed: false, userId: row?.userId ?? "" };
        }

        // An account being erased: the erasure removes its walks (`gdpr.ts`), so no walk step runs meanwhile. A vector record still
        // retries: the erasure keeps one whose vector it could not delete.
        if (row.kind !== "vector" && (await isAccountDeletionUnderway(ctx, row.userId))) {
            return { again: false, failed: false, userId: row.userId };
        }

        if (row.kind === "chain") {
            const next = await eraseOlderVersions(ctx, row.userId, row.frontier ?? [], [], row._id, row.startedAt ?? ctx.now);

            return { again: next.cleanupId !== null, failed: false, userId: row.userId };
        }

        if (row.kind === "digests") {
            const next = await removeFromDigests(ctx, row.userId, new Set(row.ids), { cursor: row.cursor ?? null, startedAt: row.startedAt ?? ctx.now });

            if (next === null) {
                await ctx.db.delete("memoryCleanups", row._id);
            } else {
                await ctx.db.patch("memoryCleanups", row._id, { attempts: 0, cursor: next, dueAt: ctx.now + CLEANUP_GRACE_MS });
                await wakeShardForCleanup(ctx, row.userId, ctx.now + CLEANUP_GRACE_MS);
            }

            return { again: next !== null, failed: false, userId: row.userId };
        }

        // A record that names no vector has nothing to retry.
        if (!row.embeddingId) {
            await ctx.db.delete("memoryCleanups", row._id);

            return { again: false, failed: false, userId: row.userId };
        }

        const done = await resumeVectorDelete(ctx, { embeddingId: row.embeddingId, memoryId: row.memoryId ?? "", userId: row.userId }, { fromCleanup: true });

        return { again: false, failed: !done, userId: row.userId };
    });

/**
 * Counts a failed step of a cleanup record and moves the record to the back of the line (`dueAt` out by a backoff, so
 * the oldest-first sweep reaches the others). At {@link CLEANUP_MAX_ATTEMPTS} it is given up on: the row stays, so it can be
 * found, its `dueAt` is out of reach, and one error with the counts is logged. `retryInMs` is `null` when no retry is due.
 */
export const noteMemoryCleanupFailure = internalMutation
    .input({ cleanupId: v.id("memoryCleanups") })
    .output(v.object({ retryInMs: v.union(v.number(), v.null()), userId: v.string() }))
    .mutation(async ({ args, ctx }) => {
        const row = await ctx.db.get("memoryCleanups", args.cleanupId);

        if (!row) {
            return { retryInMs: null, userId: "" };
        }

        const attempts = (row.attempts ?? 0) + 1;

        if (attempts >= CLEANUP_MAX_ATTEMPTS) {
            await ctx.db.patch("memoryCleanups", row._id, { attempts, dueAt: CLEANUP_NEVER });
            memoryLogger.error(`Gave up a ${row.kind} memory cleanup after ${attempts} failed attempts; its record ${row._id} stays`);

            return { retryInMs: null, userId: row.userId };
        }

        const retryInMs = Math.min(CLEANUP_RETRY_BASE_MS * 2 ** attempts, CLEANUP_RETRY_MAX_MS);

        await ctx.db.patch("memoryCleanups", row._id, { attempts, dueAt: ctx.now + retryInMs });
        await wakeShardForCleanup(ctx, row.userId, ctx.now + retryInMs);

        return { retryInMs, userId: row.userId };
    });

/**
 * The scheduler job that works one cleanup record (armed when the record is made, by the housekeeping sweep, and by
 * itself). Each step is its own write ({@link stepMemoryCleanup}); an error is caught here, outside the write, so what
 * the step did is rolled back whole before the failure is counted and the record is armed again with a backoff.
 */
export const runMemoryCleanup = internalAction
    .input({ cleanupId: v.id("memoryCleanups") })
    .output(v.null())
    .action(async ({ args, ctx }) => {
        let step: { again: boolean; failed: boolean; userId: string } | undefined;

        try {
            step = await ctx.runMutation(internal.memory.functions.stepMemoryCleanup, args);
        } catch (error) {
            memoryLogger.error(`A step of memory cleanup ${args.cleanupId} failed and was rolled back`, error);
        }

        if (step && !step.failed) {
            if (step.again) {
                await armMemoryCleanup(ctx.scheduler, args.cleanupId, step.userId, 0);
            }

            return null;
        }

        const failure = await ctx.runMutation(internal.memory.functions.noteMemoryCleanupFailure, args);

        if (failure.retryInMs !== null) {
            await armMemoryCleanup(ctx.scheduler, args.cleanupId, failure.userId, failure.retryInMs);
        }

        return null;
    });

/** Cleanup records one housekeeping pass arms. */
const CLEANUP_SWEEP_BATCH = 20;

/**
 * Housekeeping sweep (`shardSweeps()`) and the shard tick's (`runShardTick`, which reaches a shard past the housekeeping
 * horizon): arms a job for each cleanup record that is due (its own job having been lost, or never scheduled) and pushes the
 * record's `dueAt` out by the grace period. It deletes nothing: the work, with its failure handling, is the job's. A record
 * given up on is never due. Resolves the earliest `dueAt` still to come, which the tick re-arms the shard for.
 */
export const sweepMemoryCleanups = internalMutation
    .input({})
    .output(v.object({ nextDueAt: v.union(v.number(), v.null()) }))
    .mutation(async ({ ctx }) => {
        const rows = await ctx.db
            .query("memoryCleanups")
            .withIndex("by_dueAt", (q) => q.lte("dueAt", ctx.now))
            .take(CLEANUP_SWEEP_BATCH);

        for (const row of rows) {
            await ctx.db.patch("memoryCleanups", row._id, { dueAt: ctx.now + CLEANUP_GRACE_MS });
            await armMemoryCleanup(ctx.scheduler, row._id, row.userId, 0);
        }

        // Past a full batch there are more due: the shard is woken again at once.
        const [next] = await ctx.db
            .query("memoryCleanups")
            .withIndex("by_dueAt", (q) => q.lt("dueAt", CLEANUP_NEVER))
            .take(1);

        if (!next) {
            return { nextDueAt: null };
        }

        return { nextDueAt: rows.length === CLEANUP_SWEEP_BATCH ? ctx.now : next.dueAt };
    });

/**
 * Delete a specific memory owned by the authenticated user, and every older version of it: the rows it superseded
 * (their wording is the same fact, only older) with their vectors, and its entries in the reflection digests.
 */
export const deleteMemory = authMutation
    .use(rateLimit("memory/update"))
    .input({
        memoryId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.null())
    .mutation(async ({ args: { memoryId }, ctx: context }) => {
        const { userId } = context.user;
        const memory = await requireOwnMemory(context, memoryId, userId);

        await removeMemoryRow(context, memory, userId);

        const { cleanupId, olderVersions } = await eraseOlderVersions(context, userId, [memory._id], [memory._id], undefined, context.now);

        if (cleanupId) {
            await armMemoryCleanup(context.scheduler, cleanupId, userId, 0);
        }

        context.log.event("memory.delete_memory", { hadEmbedding: Boolean(memory.embeddingId), olderVersions });

        return null;
    });

/**
 * Edit a memory: its text, its type, or both. Only the owner can edit. An edit
 * is the user vouching for the memory, so it also counts as a confirmation.
 */
export const updateMemory = authMutation
    .use(rateLimit("memory/update"))
    .input({
        // All three dates as the person left them in the editor; an empty or absent one is cleared (`userFactDates`).
        dates: v.optional(
            v.object({
                eventEnd: v.optional(v.string().max(MAX_LENGTH.id)),
                eventStart: v.optional(v.string().max(MAX_LENGTH.id)),
                validUntil: v.optional(v.string().max(MAX_LENGTH.id)),
            }),
        ),
        memory: v.optional(v.string().max(MAX_LENGTH.document)),
        memoryId: v.string().max(MAX_LENGTH.id),
        type: v.optional(v.union(v.literal("identity"), v.literal("preference"), v.literal("context"), v.literal("activity"), v.literal("experience"))),
    })
    .output(v.null())
    .mutation(async ({ args: { dates, memory, memoryId, type }, ctx: context }) => {
        const { userId } = context.user;
        const existing = await requireOwnMemory(context, memoryId, userId);
        const trimmed = memory?.trim();

        // The length check runs first, so the detector only ever sees a short text.
        if (memory !== undefined && (!trimmed || trimmed.length > 1000)) {
            throw new LunoraError("BAD_REQUEST", "A memory must be between 1 and 1000 characters");
        }

        const text = trimmed === undefined ? undefined : redactMemoryText(trimmed);

        if (text === null) {
            throw new LunoraError("BAD_REQUEST", "A memory can't hold only a password, key or token");
        }

        // Each «redacted» marker can be longer than the value it replaced.
        if (text !== undefined && text.length > 1000) {
            throw new LunoraError("BAD_REQUEST", "A memory must be between 1 and 1000 characters");
        }

        const typedDates = dates && userFactDates(dates);

        if (dates && !typedDates) {
            throw new LunoraError("BAD_REQUEST", "Dates must be real days, and an event cannot end before it starts");
        }

        // The person's own edit is the newest statement: its dates replace the row's (`restatedDates`).
        const nextDates = typedDates && restatedDates(factDatesOf(existing), typedDates);
        const { now } = context;
        // A save of the text as it stands is no rewrite, even when redaction would reword a legacy row that holds a secret:
        // only the user's own change moves the row to `manual` and drops its evidence.
        const textChanged = text !== undefined && text !== existing.memory && trimmed !== existing.memory;
        // That save still writes the redacted text, so a secret a legacy row holds does not stay in it.
        const redactedOnly = text !== undefined && text !== existing.memory && trimmed === existing.memory;

        // A text the user rewrote is theirs now: the words it was learned from no longer back it, so its evidence goes.
        await patchRow(context.db, "memories", existing, {
            ...withoutUndefined({
                lastConfirmedAt: now,
                memory: textChanged || redactedOnly ? text : undefined,
                source: textChanged ? ("manual" as const) : undefined,
                type,
                updatedAt: now,
            }),
            ...(nextDates && dateColumns(nextDates)),
            ...(textChanged && { evidence: undefined }),
        });

        // The previous embedding vector is stale once the text changed.
        if (textChanged || redactedOnly) {
            await reembedRewordedMemory(context, existing._id, userId);
        }

        logRedaction(context.log, "edit", { dropped: 0, redacted: (textChanged || redactedOnly) && text !== trimmed ? 1 : 0 });
        context.log.event("memory.update_memory", { datesChanged: nextDates !== undefined, textChanged, typeChanged: type !== undefined });

        return null;
    });

/**
 * Pin or unpin a memory. A pinned memory is never decayed, retired, merged away
 * or promoted by nightly reflection, and does not age in retrieval.
 */
export const setMemoryPinned = authMutation
    .use(rateLimit("memory/update"))
    .input({ memoryId: v.string().max(MAX_LENGTH.id), pinned: v.boolean() })
    .output(v.null())
    .mutation(async ({ args: { memoryId, pinned }, ctx: context }) => {
        const existing = await requireOwnMemory(context, memoryId, context.user.userId);

        await context.db.patch("memories", existing._id, { pinned, updatedAt: context.now });

        context.log.event("memory.set_memory_pinned", { pinned });

        return null;
    });

/** Rows one clear-all call removes; the UI calls again while the count comes back full. */
const CLEAR_BATCH_LIMIT = 500;

/**
 * Clear all memories for the authenticated user — and the reflection digests
 * that quote them. Removes at most {@link CLEAR_BATCH_LIMIT} memories per call.
 */
export const clearAllUserMemories = authMutation
    .use(rateLimit("memory/update"))
    .output(v.number())
    .mutation(async ({ ctx: context }) => {
        const { userId } = context.user;

        const [userMemories, digests] = await Promise.all([
            context.db
                .query("memories")
                .withIndex("by_userId_type", (q) => q.eq("userId", userId))
                .take(CLEAR_BATCH_LIMIT),
            context.db
                .query("memoryDigests")
                .withIndex("by_userId_createdAt", (q) => q.eq("userId", userId))
                .take(CLEAR_BATCH_LIMIT),
        ]);

        await Promise.all([
            ...userMemories.map(async (m) => {
                await context.db.delete("memories", m._id);

                if (m.embeddingId) {
                    await deleteMemoryVector(context, { embeddingId: m.embeddingId, memoryId: m._id, userId });
                }
            }),
            ...digests.map((d) => context.db.delete("memoryDigests", d._id)),
        ]);

        context.log.event("memory.clear_all_user_memories", { digestCount: digests.length, memoryCount: userMemories.length });

        return userMemories.length;
    });

/**
 * "Why was this used": the memories injected into the system prompt for one
 * reply, as they read NOW — a memory edited, superseded or deleted since shows
 * as such rather than disappearing.
 */
export const getMessageMemoryUsage = authQuery
    .input({ messageId: v.string().max(MAX_LENGTH.id), unlockProof: v.optional(v.string().max(MAX_LENGTH.short)) })
    .output(
        v.array(
            v.object({
                memory: v.optional(v.string()),
                memoryId: v.string(),
                pinned: v.optional(v.boolean()),
                score: v.number(),
                status: v.union(v.literal("active"), v.literal("superseded"), v.literal("deleted")),
                threadId: v.optional(v.string()),
                type: v.optional(v.union(v.literal("identity"), v.literal("preference"), v.literal("context"), v.literal("activity"), v.literal("experience"))),
            }),
        ),
    )
    .query(async ({ args: { messageId, unlockProof }, ctx: context }) => {
        const { userId } = context.user;
        // The reply row carries whoever started the run, so it is found through
        // its thread: decide on the thread, admit it, then read the row.
        const threadId = await parentKeyOf(context, "messages", messageId, "threadId");

        if (!threadId) {
            throw new LunoraError("NOT_FOUND", "Message not found");
        }

        const thread = await context.db.get("threads", threadId as Id<"threads">);

        if (thread?.userId !== userId) {
            throw new LunoraError("FORBIDDEN", "Not authorized to view this message");
        }

        await requireOwnedThread(context, threadId as Id<"threads">, userId, unlockProof);

        const message = await context.db.get("messages", messageId as Id<"messages">);

        if (!message) {
            throw new LunoraError("NOT_FOUND", "Message not found");
        }

        return Promise.all(
            (message.retrievedMemories ?? []).map(async ({ memoryId, score }) => {
                const memory = await context.db.get("memories", memoryId as Id<"memories">);

                if (memory?.userId !== userId) {
                    return { memoryId, score, status: "deleted" as const };
                }

                return {
                    memory: memory.memory,
                    memoryId,
                    pinned: memory.pinned === true,
                    score,
                    status: memory.supersededBy ? ("superseded" as const) : ("active" as const),
                    threadId: (memory.threadId as string | undefined) ?? undefined,
                    type: memory.type,
                };
            }),
        );
    });

// ============================================================================
// Internal Functions (used by extraction/retrieval pipeline)
// ============================================================================

const vMemoryInsertFields = {
    botId: v.optional(v.string()),
    confidence: v.optional(v.number()),
    eventEnd: v.optional(v.string()),
    eventStart: v.optional(v.string()),
    evidence: v.optional(vMemoryEvidence),
    importance: v.optional(v.number()),
    importedFrom: v.optional(vImportApp),
    memory: v.string(),
    source: v.optional(v.union(v.literal("auto"), v.literal("manual"), v.literal("compressed"), v.literal("reflection"), v.literal("imported"))),
    supersedes: v.optional(v.id("memories")),
    threadId: v.optional(v.id("threads")),
    type: v.union(v.literal("identity"), v.literal("preference"), v.literal("context"), v.literal("activity"), v.literal("experience")),
    userId: v.string(),
    validUntil: v.optional(v.string()),
};

type MemoryInsert = {
    botId?: string;
    confidence?: number;
    eventEnd?: string;
    eventStart?: string;
    evidence?: MemoryEvidence;
    importance?: number;
    importedFrom?: ImportApp;
    memory: string;
    source?: "auto" | "compressed" | "imported" | "manual" | "reflection";
    supersedes?: Id<"memories">;
    threadId?: Id<"threads">;
    type: MemoryType;
    userId: string;
    validUntil?: string;
};

/**
 * Inserts one memory and points what it supersedes at it. The backstop for every insert: a fact that is nothing but a
 * secret is not saved (`null`), and what it would have superseded stays active.
 */
const insertMemory = async (ctx: MutationCtx, mem: MemoryInsert, now: number): Promise<Id<"memories"> | null> => {
    const memory = redactMemoryText(mem.memory);

    if (memory === null) {
        return null;
    }

    // `insert` drops `undefined` keys itself — only patches need `withoutUndefined`.
    const memoryId = await ctx.db.insert("memories", {
        botId: mem.botId as Id<"bots"> | undefined,
        confidence: mem.confidence,
        eventEnd: mem.eventEnd,
        eventStart: mem.eventStart,
        evidence: mem.evidence,
        importance: mem.importance,
        importedFrom: mem.importedFrom,
        lastConfirmedAt: now,
        memory,
        source: mem.source ?? "auto",
        supersedes: mem.supersedes,
        threadId: mem.threadId,
        type: mem.type,
        updatedAt: now,
        userId: mem.userId,
        validUntil: mem.validUntil,
        version: 1,
    });

    if (mem.supersedes) {
        await supersedeMemory(ctx, mem.supersedes, memoryId, now);
    }

    return memoryId;
};

export const saveMemory = internalMutation
    .input({ ...vMemoryInsertFields })
    .output(v.union(v.id("memories"), v.null()))
    .mutation(async ({ args, ctx }) => insertMemory(ctx, args, ctx.now));

export const saveMemoryBatch = internalMutation
    .input({
        // Compression: the rows the saved facts replace. Checked and retired in this same write, so a row given dates
        // meanwhile (its text would be lost undated) stops the whole save, and nothing is written.
        compressedFrom: v.optional(v.array(v.id("memories"))),
        memories: v.array(
            v.object({
                ...vMemoryInsertFields,
                // Each source with the text the synthesis read: a row revised since is no longer the words the fact was made from.
                evidenceFrom: v.optional(v.array(v.object({ id: v.id("memories"), memory: v.string() }))),
                supersedesBase: v.optional(v.string()),
                supersedesDates: v.optional(
                    v.object({ eventEnd: v.optional(v.string()), eventStart: v.optional(v.string()), validUntil: v.optional(v.string()) }),
                ),
            }),
        ),
    })
    // One entry per memory, in order: `null` where the fact was nothing but a secret and was not saved.
    .output(v.array(v.union(v.id("memories"), v.null())))
    .mutation(async ({ args, ctx }) => {
        const { now } = ctx;
        const memoryIds: (Id<"memories"> | null)[] = [];

        if (args.compressedFrom !== undefined) {
            const owner = args.memories[0]?.userId;
            const originals = await Promise.all(args.compressedFrom.map((id) => ctx.db.get("memories", id)));
            const stillCompressible = originals.every(
                (row) => row && row.userId === owner && !row.supersededBy && row.pinned !== true && !hasFactDates(factDatesOf(row)),
            );

            if (!stillCompressible) {
                return args.memories.map(() => null);
            }
        }

        for (const { evidenceFrom, supersedesBase, supersedesDates, ...mem } of args.memories) {
            // `evidenceFrom` takes the newest quote the named rows hold now, not when the caller read them: a quote
            // the user cleared or a row they deleted meanwhile is not brought back.
            const sources = evidenceFrom
                ? await Promise.all(
                      evidenceFrom.map(async ({ id, memory }) => {
                          return { memory, row: await ctx.db.get("memories", id) };
                      }),
                  )
                : undefined;
            // Only a source still active, in the new memory's scope, and still reading the text the fact was made from: a
            // superseded input's quote is obsolete, and a row revised since would lend its newer quote to older wording.
            const evidence = sources
                ? newestEvidence(
                      sources.flatMap(({ memory, row }) =>
                          row?.userId === mem.userId && !row.supersededBy && (row.botId ?? undefined) === (mem.botId ?? undefined) && row.memory === memory
                              ? [row]
                              : [],
                      ),
                  )
                : mem.evidence;

            // A supersession applies only while its target still reads as the text, and holds the dates, the decision was
            // made on, in the same scope, unpinned and active. Otherwise the new memory is saved beside it.
            const target = mem.supersedes ? await ctx.db.get("memories", mem.supersedes) : null;
            const supersedes =
                target &&
                supersedesBase !== undefined &&
                target.userId === mem.userId &&
                (target.botId ?? undefined) === (mem.botId ?? undefined) &&
                !target.supersededBy &&
                target.pinned !== true &&
                target.memory === supersedesBase &&
                (supersedesDates === undefined || sameFactDates(factDatesOf(target), normalizeFactDates(supersedesDates)))
                    ? mem.supersedes
                    : undefined;

            memoryIds.push(await insertMemory(ctx, { ...mem, evidence, supersedes }, now));
        }

        // The originals are retired by the same write. Each points at itself: `supersededBy` is its own id when compression retired it.
        const compressedFrom = args.compressedFrom ?? [];

        for (const id of compressedFrom) {
            await supersedeMemory(ctx, id, id, now);
        }

        return memoryIds;
    });

/** A save's outcome for one fact or confirmation: the row it landed on, and how. */
type ImportOutcome = { memoryId: Id<"memories">; status: "added" | "known" | "updated" } | { memoryId: null; status: "dropped" };

/** A fact a save writes: a pasted fact, or a confirmation that could not apply, saved as new. */
type PendingFact = { memory: string; supersede?: { base: string; memoryId: Id<"memories"> }; type: MemoryType };

/**
 * Every write of one import, applied together after the memory setting is re-checked, so
 * memory switched off meanwhile leaves the user's rows untouched. In order:
 * - a planned merge (`merge`) rewords its row while that is still the user's own, active,
 *   unpinned and unchanged since it was read; otherwise the fact is saved as new. A merge
 *   whose text another row of the user already holds confirms that row instead, so no two
 *   rows end up with one text;
 * - `confirms` are marked confirmed while they still read as the text the fact matched, or
 *   while a merge of this save reworded them (the merged text holds what they matched). A
 *   confirmation that cannot apply is saved as new in this same write, never dropped;
 * - the other facts are inserted, minus any whose text the user already has (that row is
 *   confirmed instead). It runs in the mutation because one shard's mutations run one at a
 *   time: a second save of the same paste sees what the first wrote, and a repeat past the
 *   action's dedup window is still found.
 * A row this save confirmed or reworded is never superseded by a later fact of the same save,
 * because its text is what the save is keeping.
 * An unpinned row past its end date is no match for any of these, as in extraction: it is
 * neither reworded, confirmed nor superseded, and the fact is saved beside it.
 */
export const saveImportedMemoryBatch = internalMutation
    .input({
        app: vImportApp,
        confirms: v.array(v.object({ base: v.string(), memory: v.string(), memoryId: v.id("memories"), type: vMemoryType })),
        facts: v.array(
            v.object({
                memory: v.string(),
                merge: v.optional(v.object({ base: v.string(), confidence: v.number(), memory: v.string(), memoryId: v.id("memories") })),
                supersede: v.optional(v.object({ base: v.string(), memoryId: v.id("memories") })),
                type: vMemoryType,
            }),
        ),
        // The background file import sets it: a batch claimed before an account deletion must write nothing once it is under way.
        refuseDuringDeletion: v.optional(v.boolean()),
        userId: v.string(),
    })
    .output(
        // `dropped`: the save's backstop left out a fact that was only a secret, so no row holds it.
        v.object({
            confirms: v.array(
                v.object({
                    memoryId: v.union(v.id("memories"), v.null()),
                    status: v.union(v.literal("added"), v.literal("dropped"), v.literal("known"), v.literal("updated")),
                }),
            ),
            facts: v.array(
                v.object({
                    memoryId: v.union(v.id("memories"), v.null()),
                    status: v.union(v.literal("added"), v.literal("dropped"), v.literal("known"), v.literal("updated")),
                }),
            ),
        }),
    )
    .mutation(async ({ args, ctx }) => {
        const { now } = ctx;

        if (!(await readMemoryEnabled(ctx, args.userId))) {
            throw new LunoraError("FORBIDDEN", IMPORT_MEMORY_OFF_MESSAGE);
        }

        // In the writing mutation, so a save and the deletion sweep never interleave: nothing is written once deletion is under way.
        if (args.refuseDuringDeletion === true && (await isAccountDeletionUnderway(ctx, args.userId))) {
            throw new LunoraError("FORBIDDEN", IMPORT_ACCOUNT_DELETING_MESSAGE);
        }

        const today = localDayOf(now, await userTimeZone(ctx, args.userId));
        const ownActive = (row: Doc<"memories"> | null): row is Doc<"memories"> =>
            row?.userId === args.userId && !row.botId && !row.supersededBy && (row.pinned === true || !isExpired(row, today));

        // The user's own active rows, newest first: a bot's rows and superseded history never use up the read. Kept in step
        // with every reword and retirement below, so each check sees the texts as this save leaves them.
        const { page: own } = await ctx.db.memories.findMany({
            limit: IMPORT_WIDE_WINDOW_ROWS,
            orderBy: [{ _creationTime: "desc" }],
            where: { botId: { isNull: true }, supersededBy: { isNull: true }, userId: args.userId },
        });
        // Every active row by its text: two rows may hold one text, and retiring or rewording one leaves the other.
        // The last id of a text is the one a match confirms, the most recently indexed.
        const textOf = new Map<Id<"memories">, string>();
        const idsByText = new Map<string, Id<"memories">[]>();
        const indexRow = (memoryId: Id<"memories">, key: string) => {
            idsByText.set(key, [...(idsByText.get(key) ?? []).filter((id) => id !== memoryId), memoryId]);
            textOf.set(memoryId, key);
        };
        const unindexRow = (memoryId: Id<"memories">) => {
            const key = textOf.get(memoryId);

            if (key === undefined) {
                return;
            }

            textOf.delete(memoryId);

            const rest = (idsByText.get(key) ?? []).filter((id) => id !== memoryId);

            if (rest.length > 0) {
                idsByText.set(key, rest);
            } else {
                idsByText.delete(key);
            }
        };
        const knownId = (key: string): Id<"memories"> | undefined => idsByText.get(key)?.at(-1);

        // An unpinned row past its end date is no match: it is not indexed, so a fact with its text is saved beside it.
        for (const row of own) {
            if (ownActive(row)) {
                indexRow(row._id, importDedupKey(row.memory));
            }
        }

        const reword = (memoryId: Id<"memories">, key: string) => {
            unindexRow(memoryId);
            indexRow(memoryId, key);
        };
        // A superseded row is no longer a match for a later fact of this batch.
        const retire = (memoryId: Id<"memories"> | undefined) => {
            if (memoryId !== undefined) {
                unindexRow(memoryId);
            }
        };

        const outcomes: (ImportOutcome | undefined)[] = args.facts.map(() => undefined);
        const confirmOutcomes: (ImportOutcome | undefined)[] = args.confirms.map(() => undefined);
        // Rows this save confirmed or reworded: a later supersede must not retire them.
        const kept = new Set<Id<"memories">>();
        // The texts each reworded row's merges consumed: a confirmation of one of them still holds once merged.
        const reworded = new Map<Id<"memories">, Set<string>>();
        const reembed = new Set<Id<"memories">>();

        for (const [index, { merge }] of args.facts.entries()) {
            const target = merge ? await ctx.db.get("memories", merge.memoryId) : null;
            // The backstop, as in `insertMemory`. A merge that is only a secret is no merge: the fact is saved as new below.
            const merged = merge ? redactMemoryText(merge.memory) : null;

            // The row must still read as the text the merge was built from: an edit or another save meanwhile is not overwritten.
            if (!merge || merged === null || !ownActive(target) || target.pinned === true || target.memory !== merge.base) {
                continue;
            }

            const key = importDedupKey(merged);
            const twin = (idsByText.get(key) ?? []).findLast((id) => id !== target._id);

            // The merged text is already another row's: that row is confirmed, and the target keeps its own text.
            if (twin !== undefined && twin !== target._id) {
                await ctx.db.patch("memories", twin, { lastConfirmedAt: now });
                kept.add(twin);

                outcomes[index] = { memoryId: twin, status: "known" };

                continue;
            }

            await ctx.db.patch("memories", target._id, { confidence: merge.confidence, lastConfirmedAt: now, memory: merged, updatedAt: now });
            reword(target._id, key);
            kept.add(target._id);
            reworded.set(target._id, new Set([...(reworded.get(target._id) ?? []), merge.base]));

            // The merged text needs its own vector, or a repeat import matches the old one and revises again.
            // Once per row, though two facts of the paste may merge into it.
            if (!reembed.has(target._id)) {
                reembed.add(target._id);
                await reembedRewordedMemory(ctx, target._id, args.userId);
            }

            outcomes[index] = { memoryId: target._id, status: "updated" };
        }

        const unconfirmed: { index: number; memory: string; type: MemoryType }[] = [];

        for (const [index, { base, memory, memoryId, type }] of args.confirms.entries()) {
            const row = await ctx.db.get("memories", memoryId);

            // A row this save reworded still holds what the confirmation matched, in its merged text.
            if (ownActive(row) && (reworded.get(memoryId)?.has(base) || row.memory === base)) {
                await ctx.db.patch("memories", memoryId, { lastConfirmedAt: now });
                kept.add(memoryId);

                confirmOutcomes[index] = { memoryId, status: "known" };
            } else {
                unconfirmed.push({ index, memory, type });
            }
        }

        // Facts still unwritten, then the confirmations that could not apply, each saved as new.
        const pending: { fact: PendingFact; index: number; slot: "confirms" | "facts" }[] = [
            ...args.facts.flatMap((fact, index) => (outcomes[index] ? [] : [{ fact, index, slot: "facts" as const }])),
            ...unconfirmed.map(({ index, memory, type }) => {
                return { fact: { memory, type }, index, slot: "confirms" as const };
            }),
        ];

        const settle = (slot: "confirms" | "facts", index: number, outcome: ImportOutcome) => {
            if (slot === "facts") {
                outcomes[index] = outcome;
            } else {
                confirmOutcomes[index] = outcome;
            }
        };

        for (const { fact, index, slot } of pending) {
            // The backstop, as in `insertMemory`: the action already left out a line that was only a secret.
            const text = redactMemoryText(fact.memory);

            if (text === null) {
                settle(slot, index, { memoryId: null, status: "dropped" });
                continue;
            }

            const key = importDedupKey(text);
            const known = knownId(key);
            // The row the action planned to supersede ends only while it is still the user's own active, unpinned
            // row with the text the decision read: another save may have ended, removed or edited it, or the user
            // pinned it, meanwhile. Otherwise the fact is saved beside it.
            const planned = fact.supersede ? await ctx.db.get("memories", fact.supersede.memoryId) : null;
            // A fact whose exact text is already a row is known: a supersession planned against another row does not apply.
            const supersedes =
                ownActive(planned) && planned.pinned !== true && planned.memory === fact.supersede?.base && known === undefined && !kept.has(planned._id)
                    ? planned._id
                    : undefined;

            let outcome: ImportOutcome;

            if (known) {
                await ctx.db.patch("memories", known, { lastConfirmedAt: now });

                if (supersedes) {
                    await supersedeMemory(ctx, supersedes, known, now);
                }

                kept.add(known);
                outcome = { memoryId: known, status: "known" };
            } else {
                const memoryId = await insertMemory(
                    ctx,
                    {
                        confidence: IMPORTED_CONFIDENCE,
                        importance: IMPORTED_IMPORTANCE,
                        importedFrom: args.app,
                        memory: text,
                        source: "imported",
                        supersedes,
                        type: fact.type,
                        userId: args.userId,
                    },
                    now,
                );

                if (memoryId === null) {
                    outcome = { memoryId: null, status: "dropped" };
                } else {
                    indexRow(memoryId, key);
                    outcome = { memoryId, status: "added" };
                }
            }

            settle(slot, index, outcome);
            retire(supersedes);
        }

        // One outcome per fact and per confirmation, in order: the action pairs them with its inputs by index.
        const finished = (list: (ImportOutcome | undefined)[]): ImportOutcome[] =>
            list.map((outcome) => {
                if (!outcome) {
                    throw new LunoraError("INTERNAL", "[memory/import] A fact was left without an outcome");
                }

                return outcome;
            });

        return { confirms: finished(confirmOutcomes), facts: finished(outcomes) };
    });

/**
 * Links stored vectors to their memories, each only while the row still reads as the text its
 * vector was computed from. A rejected vector and the one a linked row lets go of are deleted in
 * this same write, through the retrying delete, so a failed delete is retried rather than lost.
 */
export const linkMemoryEmbeddings = internalMutation
    .input({
        links: v.array(v.object({ embeddingId: v.string(), memoryId: v.id("memories"), text: v.string() })),
        userId: v.string(),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        for (const link of args.links) {
            const row = await ctx.db.get("memories", link.memoryId);

            // A row retired while its re-embed ran takes no vector: it would only crowd the search again.
            if (row?.userId === args.userId && !row.supersededBy && row.memory === link.text) {
                if (row.embeddingId && row.embeddingId !== link.embeddingId) {
                    await deleteMemoryVector(ctx, { embeddingId: row.embeddingId, memoryId: link.memoryId, userId: args.userId });
                }

                await ctx.db.patch("memories", link.memoryId, { embeddingId: link.embeddingId });
            } else {
                await deleteMemoryVector(ctx, { embeddingId: link.embeddingId, memoryId: link.memoryId, userId: args.userId });
            }
        }

        return null;
    });

/**
 * Extraction's belief-revision UPDATE: rewords one row only while it is still the user's own (or the bot's own, for
 * its scope), active, unpinned and reads as the text the decision was made on. The old vector is dropped and the re-embed
 * scheduled in the same write (`reembedRewordedMemory`), so a revision never commits without its re-embed. Returns whether it applied; when it did not, the caller
 * saves the fact as new.
 */
export const reviseExtractedMemory = internalMutation
    .input({
        base: v.string(),
        botId: v.optional(v.string()),
        confidence: v.number(),
        // The newer statement's dates, replacing all three columns (`restatedDates`); absent keeps the row's.
        dates: v.optional(v.object({ eventEnd: v.optional(v.string()), eventStart: v.optional(v.string()), validUntil: v.optional(v.string()) })),
        // The words the revision's new wording came from; without them the row keeps its own quote.
        evidence: v.optional(vMemoryEvidence),
        lastConfirmedAt: v.number(),
        memory: v.string(),
        memoryId: v.id("memories"),
        // The row's dates as the revision was planned: a person's date edit made since then is not overwritten.
        observed: v.optional(v.object({ eventEnd: v.optional(v.string()), eventStart: v.optional(v.string()), validUntil: v.optional(v.string()) })),
        userId: v.string(),
    })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        const row = await ctx.db.get("memories", args.memoryId);

        if (!row || row.userId !== args.userId || (row.botId ?? undefined) !== (args.botId ?? undefined) || row.supersededBy || row.pinned === true) {
            return false;
        }

        // The backstop, as in `insertMemory`: a revision that is nothing but a secret does not apply, so the caller saves
        // the fact as new, as for any revision that cannot apply.
        const memory = redactMemoryText(args.memory);

        if (row.memory !== args.base || memory === null) {
            return false;
        }

        if (args.observed && !sameFactDates(factDatesOf(row), normalizeFactDates(args.observed))) {
            return false;
        }

        // The quote goes with the wording it explains: a row quoting words said later than the revision's would otherwise
        // show them beside a text the earlier, perhaps conflicting, words decided.
        const { evidence } = args;

        await patchRow(ctx.db, "memories", row, {
            ...withoutUndefined({
                confidence: args.confidence,
                evidence,
                lastConfirmedAt: args.lastConfirmedAt,
                memory,
                // Generated text is never the user's words: a revision of a row the user wrote makes it auto, so it is not
                // labelled "Added by you". Any other source (imported, compressed, reflection) keeps its label and its
                // place in compression, and a revision that keeps the wording changes no source.
                source: row.source === "manual" && memory !== row.memory ? ("auto" as const) : undefined,
                updatedAt: ctx.now,
            }),
            ...(args.dates && dateColumns(args.dates)),
        });

        if (memory !== row.memory) {
            await reembedRewordedMemory(ctx, args.memoryId, args.userId);
        }

        return true;
    });

export const updateMemoryInternal = internalMutation
    .input({
        confidence: v.optional(v.number()),
        // Replaces all three date columns; a date left out is removed (`restatedDates`).
        dates: v.optional(v.object({ eventEnd: v.optional(v.string()), eventStart: v.optional(v.string()), validUntil: v.optional(v.string()) })),
        embeddingId: v.optional(v.string()),
        importance: v.optional(v.number()),
        lastConfirmedAt: v.optional(v.number()),
        memory: v.optional(v.string()),
        memoryId: v.id("memories"),
    })
    .mutation(async ({ args, ctx }) => {
        const existing = await ctx.db.get("memories", args.memoryId);

        if (!existing) {
            return;
        }

        // A rewording that is nothing but a secret keeps the row's text.
        const text = args.memory === undefined ? undefined : (redactMemoryText(args.memory) ?? undefined);
        const textChanged = text !== undefined && text !== existing.memory;

        // Absent fields keep their value; `dates` replaces the three date columns (`patchById` removes an `undefined` key).
        await patchById(ctx.db, "memories", args.memoryId, {
            ...withoutUndefined({
                confidence: args.confidence,
                embeddingId: args.embeddingId,
                importance: args.importance,
                lastConfirmedAt: args.lastConfirmedAt,
                memory: textChanged ? text : undefined,
                updatedAt: ctx.now,
            }),
            // Cleaned as an extractor's dates are: no malformed day, no end without a start or before it.
            ...(args.dates && dateColumns(normalizeFactDates(args.dates))),
        });

        // The old vector encodes the old wording: replace it, so search never finds a row by text it no longer holds.
        if (textChanged && existing.userId) {
            await reembedRewordedMemory(ctx, args.memoryId, existing.userId);
        }
    });

/**
 * Marks memories as confirmed now — a restated fact the extractor recognised as
 * already known. Only the owner's rows are touched.
 */
export const confirmMemories = internalMutation
    .input({
        confirms: v.array(v.object({ base: v.string(), evidence: v.optional(vMemoryEvidence), memoryId: v.id("memories") })),
        userId: v.string(),
    })
    .output(v.array(v.number()))
    .mutation(async ({ args, ctx }) => {
        const { now } = ctx;
        // Indexes of the confirmations that did not apply: their row no longer reads as the text the fact matched.
        const unconfirmed: number[] = [];

        for (const [index, { base, evidence, memoryId }] of args.confirms.entries()) {
            const memory = await ctx.db.get("memories", memoryId);

            if (memory?.userId === args.userId && !memory.supersededBy && memory.memory === base) {
                // A restatement brings its quote to a memory that has none (a legacy row); a quote it already has stays.
                await ctx.db.patch(
                    "memories",
                    memoryId,
                    withoutUndefined({ evidence: memory.evidence === undefined ? evidence : undefined, lastConfirmedAt: now }),
                );
            } else {
                unconfirmed.push(index);
            }
        }

        return unconfirmed;
    });

/** Rows one scope's active read reads at most, unless `limit` (one page) is more. */
export const ACTIVE_READ_MAX_ROWS = 1500;

/**
 * Memories a run may read or dedupe against. Without `botId` only the user's own
 * memories (no bot). With `botId`, that bot's memories, plus the user's own ones
 * when `includeUserWide` (a bot chat reads what the user already knows). Writes
 * pass `botId` WITHOUT `includeUserWide`: a bot's extraction never matches or
 * edits a user memory. With `activeOn` (an instant), an unpinned fact whose end
 * date is before that day in the user's timezone is left out: retrieval never injects it.
 *
 * The window is the first `limit` rows of each scope in index order (type descending, then newest) by default.
 * With `newestFirst` it is the newest `limit` rows whatever the type: retrieval scores only the window, so a
 * window filled by type would hold `preference` and `identity` rows and never an `activity` one. That reads the
 * newest rows of each type and merges them, within the same total read budget.
 */
export const getActiveMemoriesForUser = internalQuery
    .input({
        activeOn: v.optional(v.number()),
        botId: v.optional(v.string()),
        includeUserWide: v.optional(v.boolean()),
        limit: v.optional(v.number()),
        newestFirst: v.optional(v.boolean()),
        /** The day of `activeOn` is read in this timezone; without it, in the user's stored one. */
        timeZone: v.optional(v.string()),
        userId: v.string(),
    })
    .query(async ({ args, ctx }) => {
        const limit = args.limit ?? 50;
        const today = args.activeOn === undefined ? undefined : localDayOf(args.activeOn, args.timeZone ?? (await userTimeZone(ctx, args.userId)));

        // Each scope is read through its own index, so one scope's rows never use up
        // another's window. A null `botId` is the user's own memories.
        const scopes = scopesOf(args);

        // The active-row index, so superseded rows are never read. The index holds no end date, so an expired row is
        // dropped after it is read: each range is paged until it has `limit` usable rows or ends. The ranges of a scope
        // (one, or one per type) share ONE budget of `maxRows` rows (or one page), taken a page per open range per round,
        // so a type buried in expired rows may use what the others did not need, and the read stays bounded.
        const readScope = async (scope: string | null, types: ReadonlyArray<MemoryType | undefined>, maxRows: number): Promise<Doc<"memories">[]> => {
            const ranges = types.map((type) => {
                return { cursor: null as string | null, done: false, kept: [] as Doc<"memories">[], type };
            });
            let read = 0;

            while (read < maxRows) {
                const open = ranges.filter((range) => !range.done && range.kept.length < limit);

                if (open.length === 0) {
                    break;
                }

                const round = open.slice(0, Math.max(1, Math.floor((maxRows - read) / limit)));
                const pages = await Promise.all(
                    round.map(
                        async (range) =>
                            await ctx.db
                                .query("memories")
                                .withIndex("by_userId_botId_active", (q) => {
                                    const active = q
                                        .eq("userId", args.userId)
                                        .eq("botId", scope as Id<"bots"> | null)
                                        .eq("supersededBy", null);

                                    return range.type === undefined ? active : active.eq("type", range.type);
                                })
                                .order("desc")
                                .paginate({ cursor: range.cursor, numItems: limit }),
                    ),
                );

                for (const [index, page] of pages.entries()) {
                    const range = round[index]!;

                    // An empty page still counts, so the loop always ends.
                    read += Math.max(page.page.length, 1);
                    range.kept.push(...page.page.filter((m) => isUsableOn(m, today)));
                    range.done = page.isDone;
                    range.cursor = page.continueCursor;
                }
            }

            return ranges.flatMap((range) => range.kept);
        };

        const perScope = await Promise.all(
            scopes.map(async (scope) => {
                if (args.newestFirst !== true) {
                    return await readScope(scope, [undefined], Math.max(limit, ACTIVE_READ_MAX_ROWS));
                }

                // Within a type the index is newest first, so the newest `limit` of the scope are among each type's own.
                const rows = await readScope(scope, MEMORY_TYPES, Math.max(limit, ACTIVE_READ_MAX_ROWS));

                return rows.toSorted(byNewest).slice(0, limit);
            }),
        );

        const memories = mergeScopeWindows(perScope, limit, args.newestFirst === true ? byNewest : undefined);

        return memories.map((m) => {
            return {
                _id: m._id,
                confidence: m.confidence,
                createdAt: m._creationTime,
                embeddingId: m.embeddingId ?? undefined,
                importance: m.importance,
                lastConfirmedAt: lastConfirmedOf(m),
                memory: m.memory,
                pinned: m.pinned === true,
                type: m.type,
                ...factDatesOf(m),
            };
        });
    });

export const getMemoryByEmbeddingId = internalQuery.input({ embeddingId: v.string() }).query(async ({ args, ctx }) => {
    const memory = await ctx.db
        .query("memories")
        .withIndex("embeddingId", (q) => q.eq("embeddingId", args.embeddingId))
        .unique();

    if (!memory) {
        return null;
    }

    return {
        _id: memory._id,
        confidence: memory.confidence,
        importance: memory.importance,
        memory: memory.memory,
        supersededBy: memory.supersededBy,
        type: memory.type,
    };
});

/** What retrieval reads of a stored memory. */
const retrievalRowOf = (memory: Doc<"memories">) => {
    return {
        _creationTime: memory._creationTime,
        _id: memory._id as string,
        botId: memory.botId,
        confidence: memory.confidence,
        embeddingId: memory.embeddingId,
        importance: memory.importance,
        lastConfirmedAt: lastConfirmedOf(memory),
        memory: memory.memory,
        pinned: memory.pinned === true,
        type: memory.type,
        ...factDatesOf(memory),
    };
};

export const getMemoriesByEmbeddingIds = internalQuery
    .input({
        /** As in `getActiveMemoriesForUser`: an unpinned fact past its end date on that day is left out. */
        activeOn: v.optional(v.number()),
        embeddingIds: v.array(v.string()),
        timeZone: v.optional(v.string()),
        userId: v.string(),
    })
    .query(async ({ args, ctx }) => {
        const today = args.activeOn === undefined ? undefined : localDayOf(args.activeOn, args.timeZone ?? (await userTimeZone(ctx, args.userId)));
        const settled = await Promise.all(
            args.embeddingIds.map(async (embeddingId) => {
                const memory = await ctx.db
                    .query("memories")
                    .withIndex("embeddingId", (q) => q.eq("embeddingId", embeddingId))
                    .unique();

                if (
                    !memory ||
                    memory.userId !== args.userId ||
                    memory.supersededBy ||
                    (today !== undefined && memory.pinned !== true && isExpired(memory, today))
                ) {
                    return null;
                }

                return { ...retrievalRowOf(memory), embeddingId };
            }),
        );

        return settled.filter((r): r is NonNullable<typeof r> => r !== null);
    });

/**
 * The keyword leg of retrieval: one search-index lookup per term (at most `MAX_KEYWORD_TERMS`, each reading
 * `KEYWORD_LOOKUP_LIMIT` rows) over the user's rows. Each keeps whole-token matches only and, as in
 * `getMemoriesByEmbeddingIds`, leaves out a superseded row and an unpinned fact past its end date, and a row of a scope
 * the chat does not read, before its cut (`keywordLookupOf`); it also says how many usable rows hold the term.
 */
export const searchMemoriesByKeyword = internalQuery
    .input({
        activeOn: v.optional(v.number()),
        botId: v.optional(v.string()),
        includeUserWide: v.optional(v.boolean()),
        /** `keywordLookupTerms`: the index is asked for every token of a term, so an identifier is looked up whole. */
        terms: v.array(v.object({ code: v.boolean(), term: v.string(), tokens: v.array(v.string()) })),
        timeZone: v.optional(v.string()),
        userId: v.string(),
    })
    .output(
        v.array(
            v.object({
                code: v.boolean(),
                complete: v.boolean(),
                corpusRows: v.number(),
                // `retrievalRowOf`: what ranking reads of a stored memory.
                hits: v.array(
                    v.object({
                        _creationTime: v.number(),
                        _id: v.string(),
                        botId: v.optional(v.id("bots")),
                        confidence: v.optional(v.number()),
                        embeddingId: v.optional(v.string()),
                        eventEnd: v.optional(v.string()),
                        eventStart: v.optional(v.string()),
                        importance: v.optional(v.number()),
                        lastConfirmedAt: v.number(),
                        memory: v.string(),
                        pinned: v.boolean(),
                        type: vMemoryType,
                        validUntil: v.optional(v.string()),
                    }),
                ),
                term: v.string(),
            }),
        ),
    )
    .query(async ({ args, ctx }) => {
        const today = args.activeOn === undefined ? undefined : localDayOf(args.activeOn, args.timeZone ?? (await userTimeZone(ctx, args.userId)));

        const settled = await Promise.allSettled(
            args.terms.slice(0, MAX_KEYWORD_TERMS).map(async (term) => {
                // One search per spelling; the index ANDs each one's tokens (a prefix match on the last), and
                // `keywordLookupOf` then wants the whole identifier, however the row writes it.
                const pages = await Promise.all(
                    lookupSearchesOf(term).map(
                        async (search) =>
                            await ctx.db
                                .query("memories")
                                .withSearchIndex("search_memory_text", (q) => q.search("memory", search).eq("userId", args.userId))
                                .take(KEYWORD_LOOKUP_LIMIT),
                    ),
                );
                const rows = [...new Map(pages.flat().map((row) => [row._id, row])).values()];
                const complete = pages.every((page) => page.length < KEYWORD_LOOKUP_LIMIT);
                const lookup = keywordLookupOf(term, rows, { botId: args.botId, includeUserWide: args.includeUserWide }, today, complete);

                return { ...lookup, hits: lookup.hits.map((m) => retrievalRowOf(m)) };
            }),
        );
        const failed = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        const building = failed.find((result) => isSearchIndexBuilding(result.reason));

        // The index still backfilling refuses every term: the caller reports that state, not a failed lookup.
        if (building !== undefined) {
            throw building.reason;
        }

        if (failed.length > 0) {
            // One term the index refused loses only that term. The cause is logged, never the term: it is the user's words.
            const causes = failed.map(({ reason }) => {
                return {
                    ...(reason instanceof LunoraError && { code: reason.code }),
                    message: reason instanceof Error ? reason.message : String(reason),
                    name: reason instanceof Error ? reason.name : typeof reason,
                };
            });

            ctx.log.event("memory.keyword_lookup_failed", { failed: failed.length, terms: settled.length });

            if (failed.length === settled.length) {
                memoryLogger.error(`Every keyword lookup failed (${String(failed.length)} terms)`, causes);
            } else {
                for (const cause of causes) {
                    memoryLogger.warn("A keyword lookup failed; the other terms still count", cause);
                }
            }
        }

        return settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    });

export const getMemoryById = internalQuery.input({ memoryId: v.id("memories") }).query(async ({ args, ctx }) => ctx.db.get("memories", args.memoryId));

/**
 * Records which memories were injected into a reply's system prompt, on the
 * reply's first row — the id the UI message carries.
 */
export const recordRetrievedMemories = internalMutation
    .input({
        memories: v.array(v.object({ memoryId: v.string(), score: v.number() })),
        messageId: v.id("messages"),
        userId: v.string(),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const message = await ctx.db.get("messages", args.messageId);

        if (!message || args.memories.length === 0) {
            return null;
        }

        const thread = await ctx.db.get("threads", message.threadId);

        // A locked chat's message rows are not written to (its proof is not here).
        if (!thread || thread.userId !== args.userId || isThreadLocked(thread)) {
            return null;
        }

        await patchMessage(ctx.db, args.messageId, { retrievedMemories: args.memories });

        return null;
    });

export const getUserTimeZone = internalQuery
    .input({ userId: v.string() })
    .output(v.union(v.string(), v.null()))
    .query(async ({ args, ctx }) => (await userTimeZone(ctx, args.userId)) ?? null);

export const isMemoryEnabled = internalQuery
    .input({ userId: v.string() })
    .output(v.boolean())
    .query(async ({ args: { userId }, ctx }) => readMemoryEnabled(ctx, userId));

/**
 * Whether a thread is a temporary chat. Temporary chats are meant to leave no
 * trace, so the extraction gate skips them.
 */
export const isThreadTemporary = internalQuery
    .input({ threadId: v.id("threads") })
    .output(v.boolean())
    .query(async ({ args, ctx }) => {
        const thread = await ctx.db.get("threads", args.threadId);

        return thread?.isTemporary === true;
    });

/** A locked chat's exchange is never mined for memories (`memory/extract.ts`), whatever the caller holds. */
export const isThreadLockedForMemory = internalQuery
    .input({ threadId: v.id("threads") })
    .output(v.boolean())
    .query(async ({ args, ctx }) => {
        const thread = await ctx.db.get("threads", args.threadId);

        return thread !== null && isThreadLocked(thread);
    });
