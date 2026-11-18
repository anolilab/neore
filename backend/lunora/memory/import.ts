/**
 * Bringing in what another assistant remembers about the user. The user asks that
 * assistant to list its memory, pastes the answer, reviews a preview and saves the
 * facts they kept. Two stateless actions: nothing is stored until the save, and the
 * saved rows are ordinary `memories` (source `imported`), so the memory export and
 * account deletion cover them. Rules for the paste live in `./import-logic.ts`.
 */
import { generateText, Output } from "ai";
import { LunoraError, v } from "lunorash/server";
import z from "zod/v4";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import type { ActionCtx } from "../_generated/server";
import { getUtilityModelForUser, loadModelFilterRules } from "../chat/lib/model-filter-rules";
import { authAction, rateLimit } from "../lib/crpc";
import { gatewayFetch } from "../lib/services";
import { type DedupMemory, embedMemoryFacts, findSimilarMemoryByJaccard, findSimilarMemoryByVector, saveMemoryVectors } from "./dedup";
import { runBeliefRevision } from "./extract";
import {
    applyImportLabels,
    buildImportLabelPrompt,
    IMPORT_LABEL_SYSTEM_PROMPT,
    IMPORTED_CONFIDENCE,
    cleanImportLine,
    IMPORT_MAX_FACT_CHARS,
    IMPORT_MAX_FACTS,
    IMPORT_MAX_INPUT_CHARS,
    IMPORT_MEMORY_OFF_MESSAGE,
    isLongEnoughFact,
    type ImportApp,
    type ImportedFact,
    looksSensitive,
    sanitizeImportedFacts,
    splitImportedText,
    vImportApp,
} from "./import-logic";
import { REFLECTION_LIMITS } from "./reflection-logic";
import { MEMORY_TYPES, vMemoryType } from "./taxonomy";

/**
 * Existing memories the near-match dedup reads (`getActiveMemoriesForUser`: by type, then
 * newest). Wider than extraction's 50; an exact repeat past it is still caught by the save.
 */
const IMPORT_DEDUP_WINDOW = 1000;

/**
 * Belief-revision calls one save may make. Past it a near-match is saved as new, as a failed
 * revision is: the client chooses the facts, so this bounds what one save can spend.
 */
const IMPORT_MAX_REVISIONS = 20;
/** Reasoning utility models spend output tokens before they answer: the caps leave room for that. */
const REVISION_MAX_OUTPUT_TOKENS = REFLECTION_LIMITS.maxOutputTokensPerCall;
const LABEL_MAX_OUTPUT_TOKENS = 8000;

const requireMemoryEnabled = async (ctx: ActionCtx, userId: string): Promise<void> => {
    if (!(await ctx.runQuery(internal.memory.functions.isMemoryEnabled, { userId }))) {
        throw new LunoraError("FORBIDDEN", IMPORT_MEMORY_OFF_MESSAGE);
    }
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
    const existing: DedupMemory[] = await ctx.runQuery(internal.memory.functions.getActiveMemoriesForUser, { limit: IMPORT_DEDUP_WINDOW, userId: args.userId });
    const embeddings = await embedMemoryFacts(
        ctx,
        args.userId,
        rules,
        facts.map((fact) => fact.memory),
        "[memory/import]",
    );
    let model: Awaited<ReturnType<typeof getUtilityModelForUser>> | undefined;
    // Set once the user has no allowed utility model: the rest of the save does not ask again.
    let modelUnavailable = false;

    // Every write is planned here and applied by one mutation, which re-checks the setting first.
    const planned: {
        embedding: number[] | null;
        fact: ImportedFact;
        merge?: { base: string; confidence: number; memory: string; memoryId: Id<"memories"> };
        supersede?: { base: string; memoryId: Id<"memories"> };
    }[] = [];
    const toConfirm: { base: string; memoryId: Id<"memories"> }[] = [];
    // Rows a fact of this save superseded: still active until the save, but no longer a match.
    const retired = new Set<string>();

    let revisions = 0;

    for (const [index, fact] of facts.entries()) {
        const embedding = embeddings[index] ?? null;
        const byVector = embedding
            ? await findSimilarMemoryByVector(ctx, { botId: undefined, embedding, existing, retired, userId: args.userId }).catch((error: unknown) => {
                  console.warn("[memory/import] Vector dedup failed, deduping by text:", error);

                  return null;
              })
            : null;

        // A row read past the window joins the working set, so later facts and the pinned check see it too.
        if (byVector && !existing.includes(byVector.row)) {
            existing.push(byVector.row);
        }

        const similar = byVector ?? findSimilarMemoryByJaccard(fact.memory, existing);
        // Later facts compare against the row as this save leaves it: merged text, or gone once superseded.
        const match = similar ? existing.find((row) => row._id === similar.id) : undefined;
        let action: "ADD" | "IGNORE" | "SUPERSEDE" | "UPDATE" = "ADD";
        let memory = "";

        if (similar && similar.score >= 0.95) {
            action = "IGNORE";
        } else if (similar && !modelUnavailable && revisions < IMPORT_MAX_REVISIONS && !match?.pinned) {
            // A pinned row is never reworded or replaced by an import; the fact is saved beside it.
            revisions += 1;

            try {
                model ??= await getUtilityModelForUser(ctx, gatewayFetch(ctx), { userId: args.userId });

                const revision = await runBeliefRevision(model, similar.memory, fact.memory, REVISION_MAX_OUTPUT_TOKENS);

                // The merged text is model output over pasted text: held to the paste's rules, or the fact is saved as new.
                // A merge too long to store whole is not cut, which would drop what it merged.
                const merged = revision.mergedMemory?.trim() ?? "";

                memory = cleanImportLine(merged);
                action =
                    revision.action === "UPDATE" && (merged.length > IMPORT_MAX_FACT_CHARS || !isLongEnoughFact(memory) || looksSensitive(memory))
                        ? "ADD"
                        : revision.action;
            } catch (error) {
                console.error("[memory/import] Belief revision failed, saving as new:", error);

                modelUnavailable = !model;
            }
        }

        if (similar && action === "IGNORE") {
            toConfirm.push({ base: similar.memory, memoryId: similar.id });
            result.alreadyKnown += 1;
        } else if (similar && action === "UPDATE") {
            planned.push({
                embedding,
                fact,
                merge: { base: similar.memory, confidence: Math.max(IMPORTED_CONFIDENCE, similar.confidence ?? 50), memory, memoryId: similar.id },
            });

            if (match) {
                match.memory = memory;
            }
        } else {
            planned.push({ embedding, fact, supersede: action === "SUPERSEDE" && similar ? { base: similar.memory, memoryId: similar.id } : undefined });

            if (action === "SUPERSEDE" && similar) {
                retired.add(similar.id);

                if (match) {
                    existing.splice(existing.indexOf(match), 1);
                }
            }
        }
    }

    if (planned.length === 0 && toConfirm.length === 0) {
        return result;
    }

    const outcomes = await ctx.runMutation(internal.memory.functions.saveImportedMemoryBatch, {
        app: args.app,
        confirms: toConfirm,
        facts: planned.map(({ fact, merge, supersede }) => {
            return { memory: fact.memory, merge, supersede, type: fact.type };
        }),
        userId: args.userId,
    });

    for (const { status } of outcomes) {
        if (status === "added") {
            result.added += 1;
        } else if (status === "updated") {
            result.updated += 1;
        } else {
            result.alreadyKnown += 1;
        }
    }

    // A merged row gets its new vector from the re-embed the save scheduled; a new row takes the fact's.
    await saveMemoryVectors(
        ctx,
        args.userId,
        outcomes.map(({ memoryId, status }, index) => {
            return { memoryId: status === "added" ? memoryId : null, vector: planned[index]?.embedding ?? null };
        }),
        "[memory/import]",
    );

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

    const model = await getUtilityModelForUser(ctx, gatewayFetch(ctx), { userId });
    const { output } = await generateText({
        // One short label per kept line, at most `IMPORT_MAX_FACTS` of them.
        maxOutputTokens: LABEL_MAX_OUTPUT_TOKENS,
        model,
        output: Output.object({
            schema: z.object({
                // A repeated or out-of-range line number is dropped by `applyImportLabels`, not a reason to refuse the whole
                // answer; the output cap bounds the list.
                keep: z.array(z.object({ line: z.int(), type: z.enum(MEMORY_TYPES) })),
            }),
        }),
        prompt: buildImportLabelPrompt(lines),
        system: IMPORT_LABEL_SYSTEM_PROMPT,
    });
    const facts = applyImportLabels(lines, output?.keep ?? []);

    return { cut, dropped: dropped + lines.length - facts.length, facts };
};

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
