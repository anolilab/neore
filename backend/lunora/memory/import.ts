/**
 * Bringing in what another assistant remembers about the user. The user asks that
 * assistant to list its memory, pastes the answer, reviews a preview and saves the
 * facts they kept. Two stateless actions: nothing is stored until the save, and the
 * saved rows are ordinary `memories` (source `imported`), so the memory export and
 * account deletion cover them. Rules for the paste live in `./import-logic.ts`.
 */
import type { ModelFilterRules } from "@neore/ai/models";
import { generateText, Output } from "ai";
import { LunoraError, v } from "lunorash/server";
import z from "zod/v4";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import type { ActionCtx } from "../_generated/server";
import { validateVectorDimension, type VectorDimension } from "../agent/vector/tables";
import { loadModelFilterRules } from "../chat/lib/model-filter-rules";
import { authAction, rateLimit } from "../lib/crpc";
import { gatewayFetch } from "../lib/services";
import { getUtilityModel, NO_ALLOWED_UTILITY_MODEL_MESSAGE, NoAllowedUtilityModelError } from "../lib/utility-model";
import { findSimilarMemoryByJaccard, findSimilarMemoryByVector, getMemoryEmbeddingModel, MEMORY_EMBEDDING_MODEL_NAME, runBeliefRevision } from "./extract";
import {
    applyImportLabels,
    buildImportLabelPrompt,
    IMPORT_LABEL_SYSTEM_PROMPT,
    IMPORT_MAX_FACT_CHARS,
    IMPORT_MAX_FACTS,
    IMPORT_MAX_INPUT_CHARS,
    type ImportApp,
    type ImportedFact,
    sanitizeImportedFacts,
    splitImportedText,
} from "./import-logic";
import { MEMORY_TYPES } from "./taxonomy";

/**
 * Existing memories a save dedupes against. Wider than extraction's 50, so a repeat
 * import of a full paste finds every row it wrote the first time.
 */
const IMPORT_DEDUP_WINDOW = 1000;

/** Imported facts were stated by the user's own assistant, not by the user: high, not full, confidence. */
const IMPORTED_CONFIDENCE = 80;
const IMPORTED_IMPORTANCE = 60;

const requireMemoryEnabled = async (ctx: ActionCtx, userId: string): Promise<void> => {
    if (!(await ctx.runQuery(internal.memory.functions.isMemoryEnabled, { userId }))) {
        throw new LunoraError("FORBIDDEN", "Turn on memory before bringing in memories");
    }
};

const utilityModelFor = async (ctx: ActionCtx, userId: string, rules: ModelFilterRules) => {
    try {
        return await getUtilityModel(gatewayFetch(ctx), { rules, userId });
    } catch (error) {
        if (error instanceof NoAllowedUtilityModelError) {
            throw new LunoraError("FORBIDDEN", NO_ALLOWED_UTILITY_MODEL_MESSAGE);
        }

        throw error;
    }
};

/** Embeddings for the facts, or nulls when the user's rules refuse the model or the call fails (Jaccard dedup then). */
const embedFacts = async (ctx: ActionCtx, userId: string, rules: ModelFilterRules, texts: string[]): Promise<(number[] | null)[]> => {
    try {
        const { embeddingModelAllowed } = await import("../chat/lib/gateway-embedding-model");

        if (texts.length > 0 && embeddingModelAllowed(rules)) {
            const { embedMany } = await import("../agent/client/search");
            const { embeddings } = await embedMany(ctx, {
                embeddingModel: await getMemoryEmbeddingModel(gatewayFetch(ctx), rules),
                threadId: undefined,
                userId,
                values: texts,
            });

            return embeddings;
        }
    } catch (error) {
        console.warn("[memory/import] Embedding failed, deduping by text:", error);
    }

    return texts.map(() => null);
};

interface ImportResult {
    added: number;
    alreadyKnown: number;
    updated: number;
}

/**
 * Saves the facts through the same dedup and belief revision as extraction: a fact
 * already remembered is confirmed, not repeated, so importing the same list twice adds nothing.
 */
export const importFacts = async (ctx: ActionCtx, args: { app: ImportApp; facts: ReadonlyArray<ImportedFact>; userId: string }): Promise<ImportResult> => {
    await requireMemoryEnabled(ctx, args.userId);

    const facts = sanitizeImportedFacts(args.facts);
    const result: ImportResult = { added: 0, alreadyKnown: 0, updated: 0 };

    if (facts.length === 0) {
        return result;
    }

    const rules = await loadModelFilterRules(ctx, args.userId);
    const existing = await ctx.runQuery(internal.memory.functions.getActiveMemoriesForUser, { limit: IMPORT_DEDUP_WINDOW, userId: args.userId });
    const embeddings = await embedFacts(
        ctx,
        args.userId,
        rules,
        facts.map((fact) => fact.memory),
    );
    let model: Awaited<ReturnType<typeof utilityModelFor>> | undefined;

    const toSave: { embedding: number[] | null; fact: ImportedFact; supersedes: Id<"memories"> | undefined }[] = [];
    const toConfirm: Id<"memories">[] = [];
    // New facts join the dedup list, so two near-identical lines in one paste save once.
    const added: { _id: string; memory: string }[] = [];

    for (const [index, fact] of facts.entries()) {
        const embedding = embeddings[index] ?? null;
        let similar = embedding ? await findSimilarMemoryByVector(ctx, args.userId, embedding, existing).catch(() => null) : null;

        similar ??= findSimilarMemoryByJaccard(fact.memory, existing);

        if (!similar && findSimilarMemoryByJaccard(fact.memory, added)) {
            result.alreadyKnown += 1;
            continue;
        }

        let action: "ADD" | "IGNORE" | "SUPERSEDE" | "UPDATE" = "ADD";
        let mergedMemory: string | undefined;

        if (similar && similar.score >= 0.95) {
            action = "IGNORE";
        } else if (similar) {
            try {
                model ??= await utilityModelFor(ctx, args.userId, rules);
                ({ action, mergedMemory } = await runBeliefRevision(model, similar.memory, fact.memory));
            } catch (error) {
                console.error("[memory/import] Belief revision failed, saving as new:", error);
            }
        }

        if (similar && action === "IGNORE") {
            toConfirm.push(similar.id);
            result.alreadyKnown += 1;
        } else if (similar && action === "UPDATE" && mergedMemory) {
            await ctx.runMutation(internal.memory.functions.updateMemoryInternal, {
                confidence: Math.max(IMPORTED_CONFIDENCE, similar.confidence ?? 50),
                lastConfirmedAt: Date.now(),
                memory: mergedMemory.slice(0, IMPORT_MAX_FACT_CHARS),
                memoryId: similar.id,
            });
            result.updated += 1;
        } else if (action !== "UPDATE") {
            toSave.push({ embedding, fact, supersedes: action === "SUPERSEDE" ? similar?.id : undefined });
            added.push({ _id: String(index), memory: fact.memory });
        }
    }

    if (toConfirm.length > 0) {
        await ctx.runMutation(internal.memory.functions.confirmMemories, { memoryIds: toConfirm, userId: args.userId });
    }

    if (toSave.length === 0) {
        return result;
    }

    const savedIds = await ctx.runMutation(internal.memory.functions.saveMemoryBatch, {
        memories: toSave.map(({ fact, supersedes }) => {
            return {
                botId: undefined,
                confidence: IMPORTED_CONFIDENCE,
                importance: IMPORTED_IMPORTANCE,
                importedFrom: args.app,
                memory: fact.memory,
                source: "imported" as const,
                supersedes,
                threadId: undefined,
                type: fact.type,
                userId: args.userId,
            };
        }),
    });

    result.added = savedIds.length;

    // The vectors are a retrieval aid: a failure leaves the rows found by keyword search.
    try {
        const withVector = savedIds.flatMap((memoryId, index) => {
            const vector = toSave[index]?.embedding;

            return vector && vector.length > 0 ? [{ memoryId, vector }] : [];
        });

        if (withVector.length > 0) {
            const dimension = withVector[0]!.vector.length;

            validateVectorDimension(dimension);

            const embeddingIds = await ctx.runMutation(internal.agent.vector.insertBatch, {
                vectorDimension: dimension as VectorDimension,
                vectors: withVector.map(({ vector }) => {
                    return { messageId: undefined, model: MEMORY_EMBEDDING_MODEL_NAME, table: "memories", threadId: undefined, userId: args.userId, vector };
                }),
            });

            for (const [index, { memoryId }] of withVector.entries()) {
                const embeddingId = embeddingIds[index];

                if (embeddingId) {
                    await ctx.runMutation(internal.memory.functions.updateMemoryInternal, { embeddingId: embeddingId as string, memoryId });
                }
            }
        }
    } catch (error) {
        console.error("[memory/import] Embedding save failed:", error);
    }

    return result;
};

/**
 * The paste as the facts a save would keep, each with its type. Nothing is stored.
 * Fails closed: without a model allowed to label the lines, nothing is offered.
 */
export const labelImportedText = async (ctx: ActionCtx, userId: string, text: string): Promise<{ cut: number; dropped: number; facts: ImportedFact[] }> => {
    await requireMemoryEnabled(ctx, userId);

    const { cut, dropped, lines } = splitImportedText(text);

    if (lines.length === 0) {
        return { cut, dropped, facts: [] };
    }

    const model = await utilityModelFor(ctx, userId, await loadModelFilterRules(ctx, userId));
    const { output } = await generateText({
        model,
        output: Output.object({
            schema: z.object({ keep: z.array(z.object({ line: z.int().min(1).max(IMPORT_MAX_FACTS), type: z.enum(MEMORY_TYPES) })) }),
        }),
        prompt: buildImportLabelPrompt(lines),
        system: IMPORT_LABEL_SYSTEM_PROMPT,
    });
    const facts = applyImportLabels(lines, output?.keep ?? []);

    return { cut, dropped: dropped + lines.length - facts.length, facts };
};

const vImportApp = v.union(v.literal("chatgpt"), v.literal("claude"), v.literal("gemini"), v.literal("other"));
const vMemoryType = v.union(v.literal("identity"), v.literal("preference"), v.literal("context"), v.literal("activity"), v.literal("experience"));

export const previewMemoryImport = authAction
    .input({ text: v.string().max(IMPORT_MAX_INPUT_CHARS) })
    .use(rateLimit("memory/import"))
    .output(
        v.object({
            cut: v.number(),
            dropped: v.number(),
            facts: v.array(v.object({ memory: v.string(), type: vMemoryType })),
        }),
    )
    .action(async ({ args, ctx }) => {
        const preview = await labelImportedText(ctx, ctx.user.userId, args.text);

        ctx.log.event("memory.import_preview", { cut: preview.cut, dropped: preview.dropped, facts: preview.facts.length, userId: ctx.user.userId });

        return preview;
    });

export const saveImportedMemories = authAction
    .input({
        app: vImportApp,
        facts: v
            .array(v.object({ memory: v.string().max(IMPORT_MAX_FACT_CHARS), type: vMemoryType }))
            .check((facts) => facts.length <= IMPORT_MAX_FACTS, { message: "Too many facts" }),
    })
    .use(rateLimit("memory/import"))
    .output(v.object({ added: v.number(), alreadyKnown: v.number(), updated: v.number() }))
    .action(async ({ args, ctx }) => {
        const result = await importFacts(ctx, { app: args.app, facts: args.facts, userId: ctx.user.userId });

        ctx.log.event("memory.import_save", { app: args.app, ...result, userId: ctx.user.userId });

        return result;
    });
