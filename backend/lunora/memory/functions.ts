import { LunoraError } from "lunorash/server";
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { withoutUndefined } from "../lib/patch";
import { lastConfirmedOf, type MemoryType } from "./taxonomy";
import { deleteVectorRow, patchMessage } from "../agent/table-writes";
import { admitOwnedThread } from "../agent/thread-read-access";
import { parentKeyOf } from "../lib/rls/scope";
import { MAX_LENGTH } from "../lib/validators";

/** Most memories one user-facing read looks at. */
const MEMORY_READ_CAP = 2000;

/** The row as the settings UI sees it. */
const toMemoryView = (m: Doc<"memories">) => {
    return {
        _creationTime: m._creationTime,
        _id: m._id as string,
        confidence: m.confidence ?? undefined,
        createdAt: m._creationTime,
        importance: m.importance ?? undefined,
        lastConfirmedAt: lastConfirmedOf(m),
        memory: m.memory,
        pinned: m.pinned === true,
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
    const memory = await ctx.db.get(memoryId as Id<"memories">);

    if (!memory) {
        throw new LunoraError("NOT_FOUND", "Memory not found");
    }

    if (memory.userId !== userId) {
        throw new LunoraError("FORBIDDEN", "Not authorized to change this memory");
    }

    return memory;
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
                confidence: v.optional(v.number()),
                createdAt: v.number(),
                importance: v.optional(v.number()),
                lastConfirmedAt: v.number(),
                memory: v.string(),
                pinned: v.boolean(),
                source: v.optional(v.string()),
                supersededBy: v.optional(v.string()),
                supersedes: v.optional(v.string()),
                threadId: v.optional(v.string()),
                type: v.union(v.literal("identity"), v.literal("preference"), v.literal("context"), v.literal("activity"), v.literal("experience")),
                updatedAt: v.optional(v.number()),
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

        // The index orders by type first, so recency is imposed here.
        return filtered.toSorted((a, b) => b._creationTime - a._creationTime).map((m) => toMemoryView(m));
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

        // Delete orphaned embedding vector so it doesn't pollute vector search results.
        // Memory embeddings are always text-embedding-004 (768-dim → embeddings_768).
        if (memory.embeddingId) {
            try {
                await deleteVectorRow(context.db, context.db.asId("embeddings_768", memory.embeddingId));
            } catch {
                // Embedding already gone or dimension mismatch — not fatal
            }
        }

        await context.db.delete(memory._id);

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
        memory: v.optional(v.string().max(MAX_LENGTH.document)),
        memoryId: v.string().max(MAX_LENGTH.id),
        type: v.optional(v.union(v.literal("identity"), v.literal("preference"), v.literal("context"), v.literal("activity"), v.literal("experience"))),
    })
    .output(v.null())
    .mutation(async ({ args: { memory, memoryId, type }, ctx: context }) => {
        const { userId } = context.user;
        const existing = await requireOwnMemory(context, memoryId, userId);
        const text = memory?.trim();

        if (memory !== undefined && (!text || text.length > 1000)) {
            throw new LunoraError("BAD_REQUEST", "A memory must be between 1 and 1000 characters");
        }

        const now = context.now;
        const textChanged = text !== undefined && text !== existing.memory;

        await context.db.patch(
            existing._id,
            withoutUndefined({
                lastConfirmedAt: now,
                memory: textChanged ? text : undefined,
                source: textChanged ? ("manual" as const) : undefined,
                type,
                updatedAt: now,
            }),
        );

        // The previous embedding vector is stale once the text changed.
        if (textChanged) {
            await context.scheduler.runAfter(0, internal.memory.extract.regenerateMemoryEmbedding, {
                memoryId: existing._id,
                userId,
            });
        }

        context.log.event("memory.update_memory", { textChanged, typeChanged: type !== undefined });

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

        await context.db.patch(existing._id, { pinned, updatedAt: context.now });

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
                if (m.embeddingId) {
                    await deleteVectorRow(context.db, context.db.asId("embeddings_768", m.embeddingId)).catch(() => undefined);
                }

                await context.db.delete(m._id);
            }),
            ...digests.map((d) => context.db.delete(d._id)),
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
    .input({ messageId: v.string().max(MAX_LENGTH.id) })
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
    .query(async ({ args: { messageId }, ctx: context }) => {
        const { userId } = context.user;
        // The reply row carries whoever started the run, so it is found through
        // its thread: decide on the thread, admit it, then read the row.
        const threadId = await parentKeyOf(context, messageId, "threadId");

        if (!threadId) {
            throw new LunoraError("NOT_FOUND", "Message not found");
        }

        const thread = await context.db.get(threadId as Id<"threads">);

        if (thread?.userId !== userId) {
            throw new LunoraError("FORBIDDEN", "Not authorized to view this message");
        }

        admitOwnedThread(context, thread, userId);

        const message = await context.db.get(messageId as Id<"messages">);

        if (!message) {
            throw new LunoraError("NOT_FOUND", "Message not found");
        }

        return Promise.all(
            (message.retrievedMemories ?? []).map(async ({ memoryId, score }) => {
                const memory = await context.db.get(memoryId as Id<"memories">);

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
    confidence: v.optional(v.number()),
    importance: v.optional(v.number()),
    memory: v.string(),
    source: v.optional(v.union(v.literal("auto"), v.literal("manual"), v.literal("compressed"), v.literal("reflection"))),
    supersedes: v.optional(v.id("memories")),
    threadId: v.optional(v.id("threads")),
    type: v.union(v.literal("identity"), v.literal("preference"), v.literal("context"), v.literal("activity"), v.literal("experience")),
    userId: v.string(),
};

type MemoryInsert = {
    confidence?: number;
    importance?: number;
    memory: string;
    source?: "auto" | "compressed" | "manual" | "reflection";
    supersedes?: Id<"memories">;
    threadId?: Id<"threads">;
    type: MemoryType;
    userId: string;
};

/** Inserts one memory and points what it supersedes at it. */
const insertMemory = async (ctx: Pick<MutationCtx, "db">, mem: MemoryInsert, now: number): Promise<Id<"memories">> => {
    // `insert` drops `undefined` keys itself — only patches need `withoutUndefined`.
    const memoryId = await ctx.db.insert("memories", {
        confidence: mem.confidence,
        importance: mem.importance,
        lastConfirmedAt: now,
        memory: mem.memory,
        source: mem.source ?? "auto",
        supersedes: mem.supersedes,
        threadId: mem.threadId,
        type: mem.type,
        updatedAt: now,
        userId: mem.userId,
        version: 1,
    });

    if (mem.supersedes) {
        await ctx.db.patch(mem.supersedes, { supersededBy: memoryId, updatedAt: now });
    }

    return memoryId;
};

export const saveMemory = internalMutation
    .input({ ...vMemoryInsertFields })
    .output(v.id("memories"))
    .mutation(async ({ args, ctx }) => insertMemory(ctx, args, ctx.now));

export const saveMemoryBatch = internalMutation
    .input({
        memories: v.array(v.object({ ...vMemoryInsertFields })),
    })
    .output(v.array(v.id("memories")))
    .mutation(async ({ args, ctx }) => {
        const now = ctx.now;
        const memoryIds: Id<"memories">[] = [];

        for (const mem of args.memories) {
            memoryIds.push(await insertMemory(ctx, mem, now));
        }

        return memoryIds;
    });

export const updateMemoryInternal = internalMutation
    .input({
        confidence: v.optional(v.number()),
        embeddingId: v.optional(v.string()),
        importance: v.optional(v.number()),
        lastConfirmedAt: v.optional(v.number()),
        memory: v.optional(v.string()),
        memoryId: v.id("memories"),
    })
    .mutation(async ({ args, ctx }) => {
        await ctx.db.patch(
            args.memoryId,
            withoutUndefined({
                confidence: args.confidence,
                embeddingId: args.embeddingId,
                importance: args.importance,
                lastConfirmedAt: args.lastConfirmedAt,
                memory: args.memory,
                updatedAt: ctx.now,
            }),
        );
    });

/**
 * Marks memories as confirmed now — a restated fact the extractor recognised as
 * already known. Only the owner's rows are touched.
 */
export const confirmMemories = internalMutation
    .input({ memoryIds: v.array(v.id("memories")), userId: v.string() })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const now = ctx.now;

        for (const memoryId of args.memoryIds) {
            const memory = await ctx.db.get(memoryId);

            if (memory?.userId === args.userId && !memory.supersededBy) {
                await ctx.db.patch(memoryId, { lastConfirmedAt: now });
            }
        }

        return null;
    });

export const getActiveMemoriesForUser = internalQuery
    .input({
        limit: v.optional(v.number()),
        userId: v.string(),
    })
    .query(async ({ args, ctx }) => {
        const limit = args.limit ?? 50;

        // Over-fetch to account for superseded entries being filtered out
        const memories = await ctx.db
            .query("memories")
            .withIndex("by_userId_type", (q) => q.eq("userId", args.userId))
            .order("desc")
            .take(limit * 3);

        // Filter out superseded memories and limit
        return memories
            .filter((m) => !m.supersededBy)
            .slice(0, limit)
            .map((m) => {
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
        embeddingIds: v.array(v.string()),
        userId: v.string(),
    })
    .query(async ({ args, ctx }) => {
        const settled = await Promise.all(
            args.embeddingIds.map(async (embeddingId) => {
                const memory = await ctx.db
                    .query("memories")
                    .withIndex("embeddingId", (q) => q.eq("embeddingId", embeddingId))
                    .unique();

                if (!memory || memory.userId !== args.userId || memory.supersededBy) {
                    return null;
                }

                return {
                    _creationTime: memory._creationTime,
                    _id: memory._id as string,
                    confidence: memory.confidence,
                    embeddingId,
                    importance: memory.importance,
                    memory: memory.memory,
                    type: memory.type,
                };
            }),
        );

        return settled.filter((r): r is NonNullable<typeof r> => r !== null);
    });

export const markMemorySupersededByCompression = internalMutation.input({ memoryId: v.id("memories"), userId: v.string() }).mutation(async ({ args, ctx }) => {
    const memory = await ctx.db.get(args.memoryId);

    // Ownership guard: skip silently if memory doesn't exist or belongs to another user
    if (!memory || memory.userId !== args.userId) {
        return;
    }

    // Idempotency guard: if already superseded (e.g. by a concurrent compression run),
    // do nothing. This is the defence-in-depth layer for H1.
    if (memory.supersededBy) {
        return;
    }

    await ctx.db.patch(args.memoryId, {
        // Sentinel: memory points to itself to signal "retired by compression".
        // All active-memory queries filter by !supersededBy, so this record
        // is hidden from normal queries without needing a separate boolean field.
        supersededBy: args.memoryId,
        updatedAt: ctx.now,
    });
});

export const getMemoryById = internalQuery.input({ memoryId: v.id("memories") }).query(async ({ args, ctx }) => ctx.db.get(args.memoryId));

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
        const message = await ctx.db.get(args.messageId);

        if (!message || args.memories.length === 0) {
            return null;
        }

        const thread = await ctx.db.get(message.threadId);

        if (thread?.userId !== args.userId) {
            return null;
        }

        await patchMessage(ctx.db, args.messageId, { retrievedMemories: args.memories });

        return null;
    });

export const isMemoryEnabled = internalQuery
    .input({ userId: v.string() })
    .output(v.boolean())
    .query(async ({ args: { userId }, ctx }) => {
        const settings = await ctx.db
            .query("userSettings")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .unique();

        // OPT-IN. Absent means off: memory extraction reads every conversation and
        // derives statements about the user, so it must not start because nobody
        // has visited the setting yet. Enabling it is a deliberate act.
        return settings?.memoryEnabled ?? false;
    });

/**
 * Whether a thread is a temporary chat. Temporary chats are meant to leave no
 * trace, so the extraction gate skips them.
 */
export const isThreadTemporary = internalQuery
    .input({ threadId: v.id("threads") })
    .output(v.boolean())
    .query(async ({ args, ctx }) => {
        const thread = await ctx.db.get(args.threadId);

        return thread?.isTemporary === true;
    });
