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
import { type DedupMemory, embedMemoryFacts, findSimilarMemoryByJaccard, findSimilarMemoryByVector, saveMemoryVectors, type WordSetCache } from "./dedup";
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
    IMPORT_MAX_VECTOR_LOOKUPS,
    IMPORT_MEMORY_OFF_MESSAGE,
    IMPORT_WIDE_WINDOW_ROWS,
    isLongEnoughFact,
    type ImportApp,
    type ImportedFact,
    looksSensitive,
    sanitizeImportedFacts,
    splitImportedText,
    vImportApp,
} from "./import-logic";
import { logRedaction, redactMemoryText } from "./redact";
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
 * A fact the save planned, with the vector computed for it. `confirm` marks a fact planned as a confirmation of a
 * near-match; `merge` and `supersede` are the write the decision asked for.
 */
interface PlannedFact {
    confirm?: { base: string; memoryId: Id<"memories"> };
    embedding: number[] | null;
    fact: ImportedFact;
    merge?: { base: string; confidence: number; memory: string; memoryId: Id<"memories"> };
    // Whether the merged text lost a secret to redaction, for the save's redaction event.
    mergeRedacted?: boolean;
    supersede?: { base: string; memoryId: Id<"memories"> };
}

/**
 * Saves the facts through the same dedup and belief revision as extraction: a fact
 * already remembered is confirmed, not repeated, so importing the same list twice adds nothing.
 * Every count is taken from what the one write applied, never from what the planning expected.
 */
export const importFacts = async (ctx: ActionCtx, args: { app: ImportApp; facts: ReadonlyArray<ImportedFact>; userId: string }): Promise<ImportResult> => {
    await requireMemoryEnabled(ctx, args.userId);

    const facts = sanitizeImportedFacts(args.facts);
    const result: ImportResult = { added: 0, alreadyKnown: 0, updated: 0 };

    if (facts.length === 0) {
        return result;
    }

    const rules = await loadModelFilterRules(ctx, args.userId);
    // As in extraction, an unpinned fact past its end date is no match: the pasted fact is saved anew.
    const activeOn = Date.now();
    const embeddings = await embedMemoryFacts(
        ctx,
        args.userId,
        rules,
        facts.map((fact) => fact.memory),
        "[memory/import]",
    );
    const words: WordSetCache = new Map();
    let model: Awaited<ReturnType<typeof getUtilityModelForUser>> | undefined;
    // Set once the user has no allowed utility model: the rest of the save does not ask again.
    let modelUnavailable = false;

    // The working set is the near-match window. It is widened once, the first time a fact has to be matched by words
    // (no vector, or past the vector budget), so an import that every fact can match by vector never reads the wide window.
    let existing: DedupMemory[] = await ctx.runQuery(internal.memory.functions.getActiveMemoriesForUser, {
        activeOn,
        limit: IMPORT_DEDUP_WINDOW,
        userId: args.userId,
    });
    let widened = false;

    // Rows of this save as they now read: merged text for a reword, gone once superseded. Kept across a widen.
    const rewordedText = new Map<string, string>();
    // Rows a fact of this save superseded: still active until the save, but no longer a match.
    const retired = new Set<string>();
    // Rows a fact of this save reworded: their stored vector is of the old text, so a later fact is compared by words.
    const reworded = new Set<string>();

    const widen = async () => {
        if (widened) {
            return;
        }

        widened = true;

        const fetched: DedupMemory[] = await ctx.runQuery(internal.memory.functions.getActiveMemoriesForUser, {
            activeOn,
            limit: IMPORT_WIDE_WINDOW_ROWS,
            userId: args.userId,
        });
        const fetchedIds = new Set(fetched.map((row) => row._id));
        // Rows already read past the window by a vector hit stay in the working set.
        const carried = existing.filter((row) => !fetchedIds.has(row._id));

        existing = [...fetched, ...carried]
            .filter((row) => !retired.has(row._id))
            .map((row) => (rewordedText.has(row._id) ? { ...row, memory: rewordedText.get(row._id) ?? row.memory } : row));
    };

    const planned: PlannedFact[] = [];
    let revisions = 0;
    let lookups = 0;

    for (const [index, fact] of facts.entries()) {
        const embedding = embeddings[index] ?? null;
        const vectorAllowed = embedding !== null && lookups < IMPORT_MAX_VECTOR_LOOKUPS;
        let byVector: Awaited<ReturnType<typeof findSimilarMemoryByVector>> = null;

        if (embedding && vectorAllowed) {
            lookups += 1;
            byVector = await findSimilarMemoryByVector(ctx, { activeOn, botId: undefined, embedding, existing, retired, userId: args.userId }).catch(
                (error: unknown) => {
                    console.warn("[memory/import] Vector dedup failed, deduping by text:", error);

                    return null;
                },
            );
        }

        // A row read past the window joins the working set, so later facts and the pinned check see it too.
        if (byVector && !existing.includes(byVector.row)) {
            existing.push(byVector.row);
        }

        const usableVector = byVector && !reworded.has(byVector.id) ? byVector : null;

        // No usable vector match (no embedding, budget spent, a failed search, or a hit on a reworded row): the fact is matched
        // by words over the wide window, so a near-match past the first window is found.
        if (!usableVector) {
            await widen();
        }

        const similar = usableVector ?? findSimilarMemoryByJaccard(fact.memory, existing, words);
        // Later facts compare against the row as this save leaves it: merged text, or gone once superseded.
        const match = similar ? existing.find((row) => row._id === similar.id) : undefined;
        let action: "ADD" | "IGNORE" | "SUPERSEDE" | "UPDATE" = "ADD";
        let memory = "";
        let mergeRedacted = false;

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

                // A merge that is nothing but a secret is no merge.
                const cleaned = cleanImportLine(merged);
                const redacted = redactMemoryText(cleaned);

                memory = redacted ?? "";
                mergeRedacted = redacted !== cleaned;
                action =
                    revision.action === "UPDATE" &&
                    (merged.length > IMPORT_MAX_FACT_CHARS || memory.length > IMPORT_MAX_FACT_CHARS || !isLongEnoughFact(memory) || looksSensitive(memory))
                        ? "ADD"
                        : revision.action;
            } catch (error) {
                console.error("[memory/import] Belief revision failed, saving as new:", error);

                modelUnavailable = !model;
            }
        }

        if (similar && action === "IGNORE") {
            planned.push({ confirm: { base: similar.memory, memoryId: similar.id }, embedding, fact });
        } else if (similar && action === "UPDATE") {
            planned.push({
                embedding,
                fact,
                merge: { base: similar.memory, confidence: Math.max(IMPORTED_CONFIDENCE, similar.confidence ?? 50), memory, memoryId: similar.id },
                mergeRedacted,
            });

            reworded.add(similar.id);
            rewordedText.set(similar.id, memory);

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

    const confirms = planned.flatMap((plan) => (plan.confirm ? [{ confirm: plan.confirm, plan }] : []));
    const writes = planned.filter((plan) => !plan.confirm);

    if (writes.length === 0 && confirms.length === 0) {
        return result;
    }

    // One write for the whole save: a confirmation that cannot apply is inserted by it, so no half-applied save is left behind.
    const outcome = await ctx.runMutation(internal.memory.functions.saveImportedMemoryBatch, {
        app: args.app,
        confirms: confirms.map(({ confirm, plan }) => {
            return { base: confirm.base, memory: plan.fact.memory, memoryId: confirm.memoryId, type: plan.fact.type };
        }),
        facts: writes.map(({ fact, merge, supersede }) => {
            return { memory: fact.memory, merge, supersede, type: fact.type };
        }),
        userId: args.userId,
    });

    const applied = [
        ...outcome.confirms.map((status, index) => {
            return { outcome: status, plan: confirms[index]!.plan };
        }),
        ...outcome.facts.map((status, index) => {
            return { outcome: status, plan: writes[index]! };
        }),
    ];

    for (const {
        outcome: { status },
    } of applied) {
        switch (status) {
            case "added": {
                result.added += 1;
                break;
            }
            case "known": {
                result.alreadyKnown += 1;
                break;
            }
            case "updated": {
                result.updated += 1;
                break;
            }
            default: {
                // "dropped": the save's backstop left out a fact that was only a secret.
                break;
            }
        }
    }

    // Counts only, and only for what the save wrote: a merge that was only a secret was refused and its fact saved as
    // new, so it counts as neither; a fact the save's backstop left out counts as dropped.
    logRedaction(ctx.log, "import", {
        dropped: applied.filter(({ outcome: { status } }) => status === "dropped").length,
        redacted: applied.filter(({ outcome: { status }, plan }) => status === "updated" && plan.mergeRedacted === true).length,
    });

    // A merged row gets its new vector from the re-embed the save scheduled; a new row takes the fact's.
    await saveMemoryVectors(
        ctx,
        args.userId,
        applied.map(({ outcome: { memoryId, status }, plan }) => {
            return { memoryId: status === "added" ? memoryId : null, text: plan.fact.memory, vector: plan.embedding };
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
