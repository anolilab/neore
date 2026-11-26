/**
 * Bringing in what another assistant remembers about the user. The user asks that
 * assistant to list its memory, pastes the answer, reviews a preview and saves the
 * facts they kept. Two stateless actions: nothing is stored until the save, and the
 * saved rows are ordinary `memories` (source `imported`), so the memory export and
 * account deletion cover them. Rules for the paste live in `./import-logic.ts`. A small text or JSON file takes the same
 * write path in one call (`importMemoryFile`; its rules are in `./import-file-logic.ts`).
 */
import { generateText, Output } from "ai";
import { LunoraError, v } from "lunorash/server";
import z from "zod/v4";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import type { ActionCtx } from "../_generated/server";
import { getUtilityModelForUser, loadModelFilterRules } from "../chat/lib/model-filter-rules";
import { lowReasoningUtilityOptions } from "../chat/lib/reasoning-options";
import { authAction, rateLimit } from "../lib/crpc";
import { enqueueJob } from "../lib/job-queue";
import { gatewayFetch } from "../lib/services";
import {
    decideFact,
    type DedupMemory,
    embedMemoryFacts,
    findSimilarMemoryByJaccard,
    findSimilarMemoryByVector,
    saveMemoryVectors,
    type WordSetCache,
} from "./dedup";
import { runBeliefRevision } from "./extract";
import {
    MEMORY_FILE_INLINE_MAX_ENTRIES,
    MEMORY_FILE_MAX_BYTES,
    MEMORY_FILE_TOO_LARGE_MESSAGE,
    type MemoryFileEntry,
    MemoryFileError,
    parseMemoryFile,
    type ParsedMemoryFile,
} from "./import-file-logic";
import {
    applyImportLabels,
    buildImportLabelPrompt,
    IMPORT_LABEL_SYSTEM_PROMPT,
    IMPORTED_CONFIDENCE,
    cleanImportLine,
    IMPORT_MAX_FACT_CHARS,
    IMPORT_MAX_FACTS,
    IMPORT_MAX_INPUT_CHARS,
    IMPORT_DEDUP_CALL_BUDGET,
    IMPORT_LOOKUP_CALL_SHARE,
    IMPORT_LOOKUP_CALLS,
    IMPORT_ACCOUNT_DELETING_MESSAGE,
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
import { MEMORY_TYPES, type MemoryType, vMemoryType } from "./taxonomy";

/**
 * Existing memories the near-match dedup reads (`getActiveMemoriesForUser`: by type, then
 * newest). Wider than extraction's 50; an exact repeat past it is still caught by the save.
 */
const IMPORT_DEDUP_WINDOW = 1000;

/** Reasoning utility models spend output tokens before they answer: the calls ask for low effort, and the caps leave room. */
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
export const importFacts = async (
    ctx: ActionCtx,
    args: { app: ImportApp; facts: ReadonlyArray<ImportedFact>; refuseDuringDeletion?: boolean; userId: string },
): Promise<ImportResult> => {
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
    // Vector and model calls spent on dedup so far, against `IMPORT_DEDUP_CALL_BUDGET`; `lookupCalls` is the lookups' part.
    let spent = 0;
    let lookupCalls = 0;

    for (const [index, fact] of facts.entries()) {
        const embedding = embeddings[index] ?? null;
        const vectorAllowed =
            embedding !== null && lookupCalls + IMPORT_LOOKUP_CALLS <= IMPORT_LOOKUP_CALL_SHARE && spent + IMPORT_LOOKUP_CALLS <= IMPORT_DEDUP_CALL_BUDGET;
        let byVector: Awaited<ReturnType<typeof findSimilarMemoryByVector>> = null;

        if (embedding && vectorAllowed) {
            spent += IMPORT_LOOKUP_CALLS;
            lookupCalls += IMPORT_LOOKUP_CALLS;
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
        // A pinned row is never reworded or replaced by an import (`decideFact`); the fact is saved beside it.
        const canRevise = !modelUnavailable && spent < IMPORT_DEDUP_CALL_BUDGET;
        const decision = await decideFact(similar, {
            // The merged text is model output over pasted text: held to the paste's rules, or the fact is saved as new.
            // A merge too long to store whole is not cut, which would drop what it merged; one that is only a secret is no merge.
            acceptMerge: (mergedMemory) => {
                const merged = mergedMemory.trim();
                const cleaned = cleanImportLine(merged);
                const memory = redactMemoryText(cleaned) ?? "";

                if (merged.length > IMPORT_MAX_FACT_CHARS || memory.length > IMPORT_MAX_FACT_CHARS || !isLongEnoughFact(memory) || looksSensitive(memory)) {
                    return undefined;
                }

                return { memory, redacted: memory !== cleaned };
            },
            logPrefix: "[memory/import]",
            revise: canRevise
                ? async (existingMemory) => {
                      spent += 1;
                      // No allowed model: the rest of the save does not ask again.
                      model ??= await getUtilityModelForUser(ctx, gatewayFetch(ctx), { userId: args.userId }).catch((error: unknown) => {
                          modelUnavailable = true;
                          throw error;
                      });

                      return await runBeliefRevision(model, existingMemory, fact.memory, REVISION_MAX_OUTPUT_TOKENS);
                  }
                : undefined,
        });

        switch (decision.action) {
            case "IGNORE": {
                planned.push({ confirm: { base: decision.similar.memory, memoryId: decision.similar.id }, embedding, fact });
                break;
            }

            case "SUPERSEDE": {
                planned.push({ embedding, fact, supersede: { base: decision.similar.memory, memoryId: decision.similar.id } });
                retired.add(decision.similar.id);

                if (match) {
                    existing.splice(existing.indexOf(match), 1);
                }

                break;
            }

            case "UPDATE": {
                const { memory, redacted } = decision.merge;

                planned.push({
                    embedding,
                    fact,
                    merge: {
                        base: decision.similar.memory,
                        confidence: Math.max(IMPORTED_CONFIDENCE, decision.similar.confidence ?? 50),
                        memory,
                        memoryId: decision.similar.id,
                    },
                    mergeRedacted: redacted,
                });

                reworded.add(decision.similar.id);
                rewordedText.set(decision.similar.id, memory);

                if (match) {
                    match.memory = memory;
                }

                break;
            }

            default: {
                planned.push({ embedding, fact });
                break;
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
        ...(args.refuseDuringDeletion === true && { refuseDuringDeletion: true }),
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

    const facts = applyImportLabels(lines, await askImportLabels(ctx, userId, lines));

    return { cut, dropped: dropped + lines.length - facts.length, facts };
};

/**
 * The labelling model's answer for the lines: the numbered lines it keeps, each with a type. It is the rule that drops
 * what is not a durable fact about the person, and sensitive personal information such as a medical diagnosis
 * (`IMPORT_LABEL_SYSTEM_PROMPT`). One model call; fails closed when no model is allowed.
 */
const askImportLabels = async (ctx: ActionCtx, userId: string, lines: ReadonlyArray<string>): Promise<ReadonlyArray<{ line: number; type: MemoryType }>> => {
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
        providerOptions: lowReasoningUtilityOptions(model),
        system: IMPORT_LABEL_SYSTEM_PROMPT,
    });

    return output?.keep ?? [];
};

/**
 * The file entries the paste's labelling rule keeps, in file order, each with the type the file gave it. One model
 * call for the whole batch (an inline file is one batch), plus the model lookup (about 3 queries): about 4 more
 * subrequests on top of `importFacts`' worst case (40 in `import.test.ts`), so an inline file stays under 50.
 */
export const keepLabelledEntries = async (ctx: ActionCtx, userId: string, entries: ReadonlyArray<MemoryFileEntry>): Promise<MemoryFileEntry[]> => {
    const labels = await askImportLabels(
        ctx,
        userId,
        entries.map(({ memory }) => memory),
    );
    const kept = new Set(labels.map(({ line }) => line));

    return entries.filter((_, index) => kept.has(index + 1));
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

/** Batches stored per write of a background import, so one write stays far under the request body cap (a batch is at most 25 entries of 500 characters). */
const STORE_BATCHES_PER_WRITE = 20;

/**
 * Imports a text or JSON file: parsed and bounded by `parseMemoryFile` at once, a refusal returned before anything is
 * stored. A file of at most `MEMORY_FILE_INLINE_MAX_ENTRIES` entries is written in this call, one batch, through
 * `importFacts`, so the embedding, redaction, dedup and per-user write rules are the paste import's. A larger file is
 * stored as parsed, redacted batches and imported by a background job (`./import-job.ts`); the answer is then the job.
 */
export const importMemoryFile = authAction
    .input({
        // The file's text is the user's memories: masked in the request logs.
        content: v.sensitive(v.string().check((content) => content.length <= MEMORY_FILE_MAX_BYTES, { message: MEMORY_FILE_TOO_LARGE_MESSAGE })),
        format: v.union(v.literal("text"), v.literal("json")),
    })
    .use(rateLimit("memory/import"))
    .output(
        v.union(
            v.object({
                duplicates: v.number(),
                imported: v.number(),
                invalid: v.number(),
                tooLong: v.number(),
                updated: v.number(),
            }),
            v.object({ jobId: v.id("memoryImportJobs"), queued: v.literal(true), total: v.number() }),
        ),
    )
    .action(async ({ args, ctx }) => {
        const { userId } = ctx.user;

        await requireMemoryEnabled(ctx, userId);

        let parsed: ParsedMemoryFile;

        try {
            parsed = parseMemoryFile(args.content, args.format);
        } catch (error) {
            if (error instanceof MemoryFileError) {
                throw new LunoraError("BAD_REQUEST", error.message);
            }

            throw error;
        }

        if (parsed.entries > MEMORY_FILE_INLINE_MAX_ENTRIES) {
            const jobId = await ctx.runMutation(internal.memory.import_job.prepareImportJob, {
                batchCount: parsed.batches.length,
                duplicates: parsed.duplicates,
                invalid: parsed.invalid,
                tooLong: parsed.tooLong,
                total: parsed.total,
                userId,
            });

            try {
                for (let first = 0; first < parsed.batches.length; first += STORE_BATCHES_PER_WRITE) {
                    await ctx.runMutation(internal.memory.import_job.storeImportBatches, {
                        batches: parsed.batches.slice(first, first + STORE_BATCHES_PER_WRITE),
                        firstIndex: first,
                        jobId,
                        userId,
                    });
                }

                if (!(await ctx.runMutation(internal.memory.import_job.beginImportJob, { jobId, userId }))) {
                    throw new LunoraError("FORBIDDEN", IMPORT_ACCOUNT_DELETING_MESSAGE);
                }

                // After the start committed, so the delivery finds the job queued with batch 0 next.
                await enqueueJob(internal.memory.import_job.runMemoryImportBatch, { index: 0, jobId }, { shardKey: userId });
            } catch (error) {
                // Ends the job, so it neither blocks the next import nor leaves entries behind.
                await ctx
                    .runMutation(internal.memory.import_job.failImportBatch, { index: 0, jobId, message: "The import could not be started." })
                    .catch(() => undefined);

                throw error;
            }

            ctx.log.event("memory.import_file", { entries: parsed.entries, format: args.format, queued: true, total: parsed.total, userId });

            return { jobId, queued: true as const, total: parsed.total };
        }

        // Duplicates inside the file were left out by the parse; those against stored memories are counted by the write.
        const result = { duplicates: parsed.duplicates, imported: 0, invalid: parsed.invalid, tooLong: parsed.tooLong, updated: 0 };

        for (const batch of parsed.batches) {
            // The paste's labelling rule (no sensitive personal information, such as a medical diagnosis) holds for a file too.
            // A model call, so it stays here in the action, once per batch; an inline file is one batch. Counted as invalid.
            const facts = await keepLabelledEntries(ctx, userId, batch);

            result.invalid += batch.length - facts.length;

            if (facts.length === 0) {
                continue;
            }

            const saved = await importFacts(ctx, { app: "other", facts, userId });

            result.duplicates += saved.alreadyKnown;
            result.imported += saved.added;
            result.updated += saved.updated;
        }

        ctx.log.event("memory.import_file", { ...result, format: args.format, userId });

        return result;
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
