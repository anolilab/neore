/**
 * Memory Compression Pipeline
 *
 * When a thread accumulates many memories, consolidate related ones into
 * higher-level synthesized facts to prevent memory table bloat and surface
 * higher-signal knowledge.
 *
 * Inspired by claude-mem's session-end summarization approach.
 */
import { generateText, Output } from "ai";
import { v } from "lunorash/server";
import z from "zod/v4";

import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { patchThread } from "../agent/table-writes";
import { gatewayFetch } from "../lib/services";
import { getUtilityModel } from "../lib/utility-model";
import { MEMORY_TYPE_GUIDE, MEMORY_TYPES } from "./taxonomy";

const COMPRESSION_SYSTEM_PROMPT = `You are a memory consolidation system. Given a list of related memories, synthesize them into a smaller set of high-quality, comprehensive facts.

Guidelines:
- Merge overlapping or complementary facts into single, richer statements
- Preserve specificity — don't make facts vaguer in order to merge them
- Keep separate facts that are genuinely distinct
- Output 3-6 consolidated facts maximum
- Write in third-person, present tense

${MEMORY_TYPE_GUIDE}`;

// ============================================================================
// Types
// ============================================================================

type ThreadMemory = {
    _id: string;
    confidence?: number | null;
    importance?: number | null;
    memory: string;
    pinned?: boolean;
    source?: string | null;
    type: string;
    updatedAt?: number | null;
};

// ============================================================================
// Config
// ============================================================================

/**
 * Minimum number of thread memories before compression is considered.
 */
const COMPRESSION_THRESHOLD = 15;

/**
 * Only compress memories that haven't been compressed recently (1 hour cooldown).
 */
const COMPRESSION_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * How long a compression lock is held before it expires (allows crash recovery).
 * Shorter than the cooldown so a failed compression can be retried within the hour.
 */
const COMPRESSION_LOCK_MS = 15 * 60 * 1000; // 15 minutes

// ============================================================================
// Schema
// ============================================================================

const compressedFactSchema = z.object({
    confidence: z.int().min(50).max(100),
    importance: z.int().min(30).max(100),
    memory: z.string(),
    type: z.enum(MEMORY_TYPES),
});

// ============================================================================
// Compression Lock (H1 race condition fix)
// ============================================================================

export const tryStartCompression = internalMutation
    .input({ threadId: v.id("threads") })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        const thread = await ctx.db.get(args.threadId);

        if (!thread) {
            return false;
        }

        if (thread.lastCompressionStartedAt) {
            const age = ctx.now - thread.lastCompressionStartedAt;

            if (age < COMPRESSION_LOCK_MS) {
                return false; // Lock still held by another concurrent run
            }
        }

        // Atomically claim the slot
        await patchThread(ctx.db, args.threadId, { lastCompressionStartedAt: ctx.now });

        return true;
    });

// ============================================================================
// Internal Query: fetch thread memories with metadata
// ============================================================================

export const getThreadMemoriesForCompression = internalQuery
    .input({
        threadId: v.id("threads"),
        userId: v.string(),
    })
    .query(async ({ args, ctx }) => {
        const memories = await ctx.db
            .query("memories")
            .withIndex("threadId", (q) => q.eq("threadId", args.threadId))
            .take(500); // safety cap — prevents OOM on very long threads

        // Only active (non-superseded) memories from this thread
        return memories
            .filter((m) => m.userId === args.userId && !m.supersededBy)
            .map((m) => {
                return {
                    _id: m._id,
                    confidence: m.confidence,
                    importance: m.importance,
                    memory: m.memory,
                    pinned: m.pinned === true,
                    source: m.source,
                    type: m.type as string,
                    updatedAt: m.updatedAt,
                };
            });
    });

// ============================================================================
// Main Actions
// ============================================================================

export const maybeCompressThreadMemories = internalAction
    .input({
        threadId: v.id("threads"),
        userId: v.string(),
    })
    .action(async ({ args, ctx }) => {
        const threadMemories = (await ctx.runQuery(internal.memory.compress.getThreadMemoriesForCompression, {
            threadId: args.threadId,
            userId: args.userId,
        })) as ThreadMemory[];

        if (threadMemories.length < COMPRESSION_THRESHOLD) {
            return;
        }

        // Check if we've compressed this thread recently
        const mostRecentCompressed = threadMemories
            .filter((m: ThreadMemory) => m.source === "compressed")
            .toSorted((a: ThreadMemory, b: ThreadMemory) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];

        if (mostRecentCompressed?.updatedAt) {
            const timeSinceLastCompression = Date.now() - mostRecentCompressed.updatedAt;

            if (timeSinceLastCompression < COMPRESSION_COOLDOWN_MS) {
                return;
            }
        }

        await ctx.runAction(internal.memory.compress.compressThreadMemories, {
            threadId: args.threadId,
            userId: args.userId,
        });
    });

export const compressThreadMemories = internalAction
    .input({
        threadId: v.id("threads"),
        userId: v.string(),
    })
    .action(async ({ args, ctx }) => {
        // Acquire atomic lock to prevent concurrent compression runs on the same thread (H1).
        // The runtime's optimistic concurrency guarantees only one caller wins the read-then-write in tryStartCompression.
        const claimed = await ctx.runMutation(internal.memory.compress.tryStartCompression, {
            threadId: args.threadId,
        });

        if (!claimed) {
            return; // Another compression is already in progress
        }

        const threadMemories = (await ctx.runQuery(internal.memory.compress.getThreadMemoriesForCompression, {
            threadId: args.threadId,
            userId: args.userId,
        })) as ThreadMemory[];

        // Skip manually-added and pinned memories; only compress auto-extracted ones
        const autoMemories = threadMemories.filter((m: ThreadMemory) => m.source === "auto" && !m.pinned);

        if (autoMemories.length < COMPRESSION_THRESHOLD) {
            return;
        }

        const memoriesList = autoMemories.map((m: ThreadMemory) => `- [${m.type}] ${m.memory}`).join("\n");

        // LLM synthesis
        let synthesizedFacts: z.infer<typeof compressedFactSchema>[] = [];
        let usage: { inputTokens?: number; outputTokens?: number } = {};

        try {
            const model = await getUtilityModel(gatewayFetch(ctx), { threadId: args.threadId, userId: args.userId });
            const result = await generateText({
                model,
                output: Output.object({
                    schema: z.object({
                        facts: z.array(compressedFactSchema),
                    }),
                }),
                prompt: `MEMORIES TO CONSOLIDATE:\n${memoriesList}\n\nSynthesize these into a smaller set of high-quality facts.`,
                system: COMPRESSION_SYSTEM_PROMPT,
            });

            usage = result.usage;

            if (result.output?.facts) {
                synthesizedFacts = result.output.facts;
            }
        } catch (error) {
            console.error("[memory/compress] LLM compression failed:", error);

            return;
        }

        ctx.log.event("memory.compress_thread", {
            inputMemories: autoMemories.length,
            inputTokens: usage.inputTokens,
            outputFacts: synthesizedFacts.length,
            outputTokens: usage.outputTokens,
        });

        if (synthesizedFacts.length === 0 || synthesizedFacts.length >= autoMemories.length) {
            // No compression gain
            return;
        }

        // Mark all original auto-memories as superseded by the first new memory (chain anchor)
        // then save the synthesized set
        const oldIds = autoMemories.map((m: ThreadMemory) => m._id as Id<"memories">);

        // Save compressed memories
        await ctx.runMutation(internal.memory.functions.saveMemoryBatch, {
            // `supersedes: undefined` is explicit — a nested `v.optional()`
            // renders as a required key.
            memories: synthesizedFacts.map((f) => {
                return {
                    confidence: f.confidence,
                    importance: f.importance,
                    memory: f.memory,
                    source: "compressed" as const,
                    supersedes: undefined,
                    threadId: args.threadId,
                    type: f.type,
                    userId: args.userId,
                };
            }),
        });

        // Mark originals as superseded (use a sentinel string to indicate compression)
        for (const oldId of oldIds) {
            await ctx.runMutation(internal.memory.functions.markMemorySupersededByCompression, {
                memoryId: oldId,
                userId: args.userId,
            });
        }
    });
