import { LunoraError } from "lunorash/server";
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";
import { isAccountDeletionUnderway } from "../gdpr/deletion-guard";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { memoryLogger } from "../lib/logger";
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
import { localDayOf } from "./reflection-logic";
import { isUsableOn, mergeScopeWindows } from "./retrieve-ranking";
import { lastConfirmedOf, type MemoryType, vMemoryType } from "./taxonomy";
import { deleteVectorRow, patchMessage } from "../agent/table-writes";
import { candidatesOnActivePath } from "../agent/branch-rows";
import { requireOwnedThread, resolveThreadReadAccess } from "../agent/thread-read-access";
import { getVectorIdInfo, type VectorTableId, type VectorTableName } from "../agent/vector/tables";
import { parentKeyOf } from "../lib/rls/scope";
import { MAX_LENGTH } from "../lib/validators";
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

/**
 * Delete the embedding of a memory whose row is already gone. The vector's table is
 * resolved from its id (a memory's embedding is normally `embeddings_1024`) and the
 * embedding carries no memory text, only the vector plus model/table/thread/user ids.
 *
 * This covers the vector ROW in the database. The sync of that delete to the vector
 * index runs after the transaction commits, outside this function, so a failure
 * there is not seen here. When the row delete fails, the failure is never swallowed:
 * it is logged with the ids that find the orphan and retried by
 * {@link retryMemoryVectorDelete} with a growing delay. The retry is scheduled from
 * the mutation, so it exists only if the row delete committed. An id that names no
 * vector table is logged and skipped, so it can never block deleting the memory.
 */
const deleteMemoryVector = async (context: MutationCtx, orphan: OrphanedVector, attempt = 1): Promise<void> => {
    let vectorId: Id<VectorTableName>;
    let vectorTable: VectorTableName;

    try {
        const info = await getVectorIdInfo(context, orphan.embeddingId as VectorTableId);

        // In no embeddings table: the vector is already gone (deleted with its thread, or a retried delete landed).
        if (info === null) {
            return;
        }

        vectorTable = info.tableName;
        vectorId = context.db.asId(info.tableName, orphan.embeddingId);
    } catch (error) {
        memoryLogger.error(`Memory ${orphan.memoryId} of user ${orphan.userId} points at embedding ${orphan.embeddingId}, which is not a vector row id`, error);

        return;
    }

    try {
        await deleteVectorRow(context.db, vectorId, vectorTable);
    } catch (error) {
        // Already gone (a retry of a delete that did land): nothing is orphaned.
        if ((await context.db.get(vectorTable, vectorId).catch(() => undefined)) === null) {
            return;
        }

        if (attempt >= VECTOR_DELETE_ATTEMPTS) {
            memoryLogger.error(
                `Giving up deleting the vector of memory ${orphan.memoryId}: embedding ${orphan.embeddingId} of user ${orphan.userId} is orphaned`,
                error,
            );

            return;
        }

        memoryLogger.warn(`Vector delete failed for memory ${orphan.memoryId} (embedding ${orphan.embeddingId}, user ${orphan.userId}); retrying`, error);

        await context.scheduler.runAfter(VECTOR_DELETE_RETRY_BASE_MS * 2 ** (attempt - 1), internal.memory.functions.retryMemoryVectorDelete, {
            ...orphan,
            attempt: attempt + 1,
        });
    }
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
        await deleteMemoryVector(context, orphan, attempt);

        return null;
    });

/**
 * Delete a specific memory owned by the authenticated user.
 */
export const deleteMemory = authMutation
    .use(rateLimit("memory/update"))
    .input({
        memoryId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.null())
    .mutation(async ({ args: { memoryId }, ctx: context }) => {
        const memory = await requireOwnMemory(context, memoryId, context.user.userId);

        await context.db.delete("memories", memory._id);

        // The row goes first: a vector with no row is an orphan a retry can find, a row
        // pointing at a deleted vector is not.
        if (memory.embeddingId) {
            await deleteMemoryVector(context, { embeddingId: memory.embeddingId, memoryId: memory._id, userId: context.user.userId });
        }

        context.log.event("memory.delete_memory", { hadEmbedding: Boolean(memory.embeddingId) });

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
const insertMemory = async (ctx: Pick<MutationCtx, "db">, mem: MemoryInsert, now: number): Promise<Id<"memories"> | null> => {
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
        await ctx.db.patch("memories", mem.supersedes, { supersededBy: memoryId, updatedAt: now });
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
            await ctx.db.patch("memories", id, { supersededBy: id, updatedAt: now });
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
                    await ctx.db.patch("memories", supersedes, { supersededBy: known, updatedAt: now });
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

            if (row?.userId === args.userId && row.memory === link.text) {
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
const ACTIVE_READ_MAX_ROWS = 1500;

/**
 * Memories a run may read or dedupe against. Without `botId` only the user's own
 * memories (no bot). With `botId`, that bot's memories, plus the user's own ones
 * when `includeUserWide` (a bot chat reads what the user already knows). Writes
 * pass `botId` WITHOUT `includeUserWide`: a bot's extraction never matches or
 * edits a user memory. With `activeOn` (an instant), an unpinned fact whose end
 * date is before that day in the user's timezone is left out: retrieval never injects it.
 */
export const getActiveMemoriesForUser = internalQuery
    .input({
        activeOn: v.optional(v.number()),
        botId: v.optional(v.string()),
        includeUserWide: v.optional(v.boolean()),
        limit: v.optional(v.number()),
        /** The day of `activeOn` is read in this timezone; without it, in the user's stored one. */
        timeZone: v.optional(v.string()),
        userId: v.string(),
    })
    .query(async ({ args, ctx }) => {
        const limit = args.limit ?? 50;
        const today = args.activeOn === undefined ? undefined : localDayOf(args.activeOn, args.timeZone ?? (await userTimeZone(ctx, args.userId)));

        // Each scope is read through its own index, so one scope's rows never use up
        // another's window. A null `botId` is the user's own memories.
        const scopes: (string | null)[] = [args.botId ?? null];

        if (args.botId !== undefined && args.includeUserWide === true) {
            scopes.push(null);
        }

        // The active-row index, so superseded rows are never read. Paged until `limit` usable rows or the scope ends,
        // so expired rows cannot fill the window; at most `ACTIVE_READ_MAX_ROWS` rows (or one page), a bounded read.
        const perScope = await Promise.all(
            scopes.map(async (scope) => {
                const kept: Doc<"memories">[] = [];
                let cursor: string | null = null;

                const maxRows = Math.max(limit, ACTIVE_READ_MAX_ROWS);

                for (let read = 0; read < maxRows && kept.length < limit; read += limit) {
                    const result = await ctx.db
                        .query("memories")
                        .withIndex("by_userId_botId_active", (q) =>
                            q
                                .eq("userId", args.userId)
                                .eq("botId", scope as Id<"bots"> | null)
                                .eq("supersededBy", null),
                        )
                        .order("desc")
                        .paginate({ cursor, numItems: limit });

                    kept.push(...result.page.filter((m) => isUsableOn(m, today)));

                    if (result.isDone) {
                        break;
                    }

                    cursor = result.continueCursor;
                }

                return kept;
            }),
        );

        const memories = mergeScopeWindows(perScope, limit);

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

                return {
                    _creationTime: memory._creationTime,
                    _id: memory._id as string,
                    botId: memory.botId,
                    confidence: memory.confidence,
                    embeddingId,
                    importance: memory.importance,
                    memory: memory.memory,
                    pinned: memory.pinned === true,
                    type: memory.type,
                    ...factDatesOf(memory),
                };
            }),
        );

        return settled.filter((r): r is NonNullable<typeof r> => r !== null);
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
