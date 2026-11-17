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
import { searchVectors } from "../agent/vector/index";
import { validateVectorDimension, type VectorDimension } from "../agent/vector/tables";
import { loadModelFilterRules } from "../chat/lib/model-filter-rules";
import { authAction, rateLimit } from "../lib/crpc";
import { gatewayFetch } from "../lib/services";
import { getUtilityModel, NO_ALLOWED_UTILITY_MODEL_MESSAGE, NoAllowedUtilityModelError } from "../lib/utility-model";
import { findSimilarMemoryByJaccard, getMemoryEmbeddingModel, MEMORY_EMBEDDING_MODEL_NAME, runBeliefRevision } from "./extract";
import {
    applyImportLabels,
    buildImportLabelPrompt,
    IMPORT_LABEL_SYSTEM_PROMPT,
    cleanImportLine,
    IMPORT_MAX_FACT_CHARS,
    IMPORT_MAX_FACTS,
    IMPORT_MAX_INPUT_CHARS,
    IMPORT_MIN_FACT_CHARS,
    type ImportApp,
    type ImportedFact,
    looksSensitive,
    sanitizeImportedFacts,
    splitImportedText,
} from "./import-logic";
import { MEMORY_TYPES } from "./taxonomy";

/**
 * Existing memories the near-match dedup reads (`getActiveMemoriesForUser`: by type, then
 * newest). Wider than extraction's 50; an exact repeat past it is still caught by the save.
 */
const IMPORT_DEDUP_WINDOW = 1000;

/** Imported facts were stated by the user's own assistant, not by the user: high, not full, confidence. */
const IMPORTED_CONFIDENCE = 80;
const IMPORTED_IMPORTANCE = 60;

/**
 * Belief-revision calls one save may make. Past it a near-match is saved as new, as a failed
 * revision is: the client chooses the facts, so this bounds what one save can spend.
 */
const IMPORT_MAX_REVISIONS = 20;
const REVISION_MAX_OUTPUT_TOKENS = 400;

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

type ExistingMemory = { _id: string; confidence?: number | null; embeddingId?: string; memory: string; pinned?: boolean };

/**
 * The user's memory closest to the fact's vector, if it is a near-match (cosine 0.85, as
 * extraction uses). Hits are walked best first: a bot's row (it shares the user's vectors) or
 * one this save superseded is passed over, not taken as "no match". A row past the window is
 * read by its vector id and joins `existing`, so later facts and the pinned check see it too.
 */
const findSimilarByVector = async (ctx: ActionCtx, userId: string, embedding: number[], existing: ExistingMemory[], retired: ReadonlySet<string>) => {
    validateVectorDimension(embedding.length);

    const results = await searchVectors(ctx, embedding, {
        dimension: embedding.length,
        limit: 5,
        model: MEMORY_EMBEDDING_MODEL_NAME,
        searchAllMessagesForUserId: userId,
        table: "memories",
    });
    const hits = results.filter((hit) => hit._score >= 0.85);
    const missing = hits.map((hit) => hit._id as string).filter((id) => existing.every((memory) => memory.embeddingId !== id));
    const read = missing.length > 0 ? await ctx.runQuery(internal.memory.functions.getMemoriesByEmbeddingIds, { embeddingIds: missing, userId }) : [];

    for (const hit of hits) {
        let row: ExistingMemory | undefined = existing.find((memory) => memory.embeddingId === hit._id);

        if (!row) {
            const found = read.find((memory) => memory.embeddingId === hit._id);

            if (!found || found.botId || retired.has(found._id)) {
                continue;
            }

            row = found;
            existing.push(found);
        }

        return { confidence: row.confidence ?? undefined, id: row._id as Id<"memories">, memory: row.memory, score: hit._score };
    }

    return null;
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
    // New facts join the dedup list, so two near-identical lines in one paste save once. Only a
    // near-exact repeat is dropped: the user checked both, so a merely similar one is kept.
    const added: { _id: string; memory: string }[] = [];
    // Rows a fact of this save superseded: still active until the save, but no longer a match.
    const retired = new Set<string>();

    let revisions = 0;

    for (const [index, fact] of facts.entries()) {
        if ((findSimilarMemoryByJaccard(fact.memory, added)?.score ?? 0) >= 0.95) {
            result.alreadyKnown += 1;
            continue;
        }

        const embedding = embeddings[index] ?? null;
        let similar = embedding
            ? await findSimilarByVector(ctx, args.userId, embedding, existing, retired).catch((error: unknown) => {
                  console.warn("[memory/import] Vector dedup failed, deduping by text:", error);

                  return null;
              })
            : null;

        similar ??= findSimilarMemoryByJaccard(fact.memory, existing);

        // Later facts compare against the row as this save leaves it: merged text, or gone once superseded.
        const match = similar ? existing.find((row) => row._id === similar.id) : undefined;
        let action: "ADD" | "IGNORE" | "SUPERSEDE" | "UPDATE" = "ADD";
        let memory = "";

        if (similar && similar.score >= 0.95) {
            action = "IGNORE";
        } else if (similar && revisions < IMPORT_MAX_REVISIONS && !match?.pinned) {
            // A pinned row is never reworded or replaced by an import; the fact is saved beside it.
            revisions += 1;

            try {
                model ??= await utilityModelFor(ctx, args.userId, rules);

                const revision = await runBeliefRevision(model, similar.memory, fact.memory, REVISION_MAX_OUTPUT_TOKENS);

                // The merged text is model output over pasted text: held to the paste's rules, or the fact is saved as new.
                memory = cleanImportLine(revision.mergedMemory ?? "");
                action = revision.action === "UPDATE" && (memory.length < IMPORT_MIN_FACT_CHARS || looksSensitive(memory)) ? "ADD" : revision.action;
            } catch (error) {
                console.error("[memory/import] Belief revision failed, saving as new:", error);
            }
        }

        if (similar && action === "IGNORE") {
            toConfirm.push(similar.id);
            result.alreadyKnown += 1;
        } else if (similar && action === "UPDATE") {
            await ctx.runMutation(internal.memory.functions.updateMemoryInternal, {
                confidence: Math.max(IMPORTED_CONFIDENCE, similar.confidence ?? 50),
                lastConfirmedAt: Date.now(),
                memory,
                memoryId: similar.id,
            });

            // The merged text needs its own vector, or a repeat import matches the old one and revises again.
            // Never fatal: the merge is saved, and the rest of the paste still has to be.
            try {
                await ctx.scheduler.runAfter(0, internal.memory.extract.regenerateMemoryEmbedding, { memoryId: similar.id, userId: args.userId });
            } catch (error) {
                console.error("[memory/import] Scheduling the re-embed failed:", error);
            }

            if (match) {
                match.memory = memory;
            }

            result.updated += 1;
        } else {
            toSave.push({ embedding, fact, supersedes: action === "SUPERSEDE" ? similar?.id : undefined });
            added.push({ _id: String(index), memory: fact.memory });

            if (action === "SUPERSEDE" && similar) {
                retired.add(similar.id);

                if (match) {
                    existing.splice(existing.indexOf(match), 1);
                }
            }
        }
    }

    if (toConfirm.length > 0) {
        await ctx.runMutation(internal.memory.functions.confirmMemories, { memoryIds: toConfirm, userId: args.userId });
    }

    if (toSave.length === 0) {
        return result;
    }

    const savedIds = await ctx.runMutation(internal.memory.functions.saveImportedMemoryBatch, {
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
        userId: args.userId,
    });
    const known = savedIds.filter((memoryId) => memoryId === null).length;

    result.added = savedIds.length - known;
    result.alreadyKnown += known;

    // The vectors are a retrieval aid: a failure leaves the rows found by keyword search.
    try {
        const withVector = savedIds.flatMap((memoryId, index) => {
            const vector = toSave[index]?.embedding;

            return memoryId && vector && vector.length > 0 ? [{ memoryId, vector }] : [];
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
