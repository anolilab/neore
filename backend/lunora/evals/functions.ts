/**
 * Evals — the public surface: datasets of cases, runs of a dataset against a
 * target (a skill, a model plus system prompt, or knowledge-base retrieval),
 * per-case results and a run-to-run comparison.
 *
 * The runner's state machine lives in `evals/internal.ts` and the scoring in
 * `evals/metrics.ts`. Every row here is the caller's own: each procedure loads by
 * id and compares `userId`, and a row that belongs to someone else answers
 * NOT_FOUND, never FORBIDDEN, so ids cannot be probed.
 */
import { MODEL_LOOKUP } from "@neore/ai/models";
import type { Infer } from "lunorash/server";
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { enqueueJob } from "../lib/job-queue";
import { internalMutation } from "../_generated/server";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { patchById } from "../lib/patch";
import { canReadSkill } from "../skills/access";
import { loadTaskAccount } from "../tasks/account";
import { isTaskModelAllowed } from "../tasks/logic";
import type { CaseDraft } from "./import";
import { normalizeCaseDraft, parseCaseImport } from "./import";
import { ANONYMOUS_EVALS_MESSAGE, finishRun, loadRunResults, summarize } from "./internal";
import {
    compareRunResults,
    DEFAULT_TOKEN_BUDGET,
    DATASET_DESCRIPTION_MAX,
    DATASET_NAME_MAX,
    MAX_ACTIVE_RUNS_PER_USER,
    MAX_CASES_PER_DATASET,
    MAX_DATASETS_PER_USER,
    parseCostCapUsd,
    parseTokenBudget,
    SYSTEM_PROMPT_MAX,
} from "./metrics";
import {
    vEvalCheck,
    vEvalCheckResult,
    vEvalDatasetKind,
    vEvalResultStatus,
    vEvalRunStatus,
    vEvalSummary,
    vEvalTarget,
    vJudgeVerdict,
    vRetrievalMetrics,
} from "./validators";
import { MAX_LENGTH } from "../lib/validators";

/** Runs listed per dataset, newest first. */
const MAX_RUNS_LISTED = 50;

/** Knowledge files one run may be restricted to. */
const MAX_TARGET_FILES = 50;

/** Rows removed per purge round when a dataset is deleted. */
const PURGE_BATCH = 200;

const RUN_LABEL_MAX = 120;

// ─── Output shapes ───────────────────────────────────────────────────────────

const vDatasetRow = v.object({
    _id: v.id("evalDatasets"),
    caseCount: v.number(),
    createdAt: v.number(),
    description: v.union(v.string(), v.null()),
    judgeEnabled: v.boolean(),
    kind: vEvalDatasetKind,
    name: v.string(),
    updatedAt: v.number(),
});

const vCaseRow = v.object({
    _id: v.id("evalCases"),
    checks: v.array(vEvalCheck),
    createdAt: v.number(),
    expectedAnswer: v.union(v.string(), v.null()),
    expectedSources: v.array(v.string()),
    input: v.string(),
    rubric: v.union(v.string(), v.null()),
    source: v.union(v.literal("manual"), v.literal("import"), v.literal("chat")),
    updatedAt: v.number(),
});

const vDatasetDetail = v.object({
    cases: v.array(vCaseRow),
    dataset: vDatasetRow,
});

const vRunRow = v.object({
    _id: v.id("evalRuns"),
    caseCount: v.number(),
    completedAt: v.union(v.number(), v.null()),
    costCapMicrodollars: v.number(),
    costMicrodollars: v.number(),
    createdAt: v.number(),
    datasetId: v.id("evalDatasets"),
    error: v.union(v.string(), v.null()),
    label: v.union(v.string(), v.null()),
    nextIndex: v.number(),
    status: vEvalRunStatus,
    summary: v.union(vEvalSummary, v.null()),
    target: vEvalTarget,
    tokenBudget: v.number(),
    unpricedTokens: v.number(),
});

const vResultRow = v.object({
    _id: v.id("evalResults"),
    answer: v.union(v.string(), v.null()),
    caseId: v.id("evalCases"),
    checks: v.array(vEvalCheckResult),
    costMicrodollars: v.union(v.number(), v.null()),
    error: v.union(v.string(), v.null()),
    faithfulness: v.union(vJudgeVerdict, v.null()),
    index: v.number(),
    input: v.string(),
    judge: v.union(vJudgeVerdict, v.null()),
    latencyMs: v.union(v.number(), v.null()),
    passed: v.union(v.boolean(), v.null()),
    retrieval: v.union(vRetrievalMetrics, v.null()),
    score: v.union(v.number(), v.null()),
    status: vEvalResultStatus,
    threadId: v.union(v.string(), v.null()),
    tokens: v.union(v.number(), v.null()),
});

const vRunDetail = v.object({
    results: v.array(vResultRow),
    run: vRunRow,
    summary: vEvalSummary,
});

const vComparison = v.object({
    baseline: vRunRow,
    candidate: vRunRow,
    cases: v.array(
        v.object({
            baselinePassed: v.union(v.boolean(), v.null()),
            baselineScore: v.union(v.number(), v.null()),
            baselineStatus: v.union(vEvalResultStatus, v.null()),
            candidatePassed: v.union(v.boolean(), v.null()),
            candidateScore: v.union(v.number(), v.null()),
            candidateStatus: v.union(vEvalResultStatus, v.null()),
            caseId: v.id("evalCases"),
            change: v.union(v.literal("improved"), v.literal("regressed"), v.literal("unchanged"), v.literal("missing")),
            input: v.string(),
            scoreDelta: v.union(v.number(), v.null()),
        }),
    ),
    improved: v.number(),
    regressed: v.number(),
    unchanged: v.number(),
});

const vDatasetList = v.array(vDatasetRow);

const vRunList = v.array(vRunRow);

const vImportResult = v.object({
    errors: v.array(v.object({ line: v.number(), message: v.string() })),
    imported: v.number(),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const toDatasetRow = (dataset: Doc<"evalDatasets">): Infer<typeof vDatasetRow> => {
    return {
        _id: dataset._id,
        caseCount: dataset.caseCount,
        createdAt: dataset.createdAt,
        description: dataset.description ?? null,
        judgeEnabled: dataset.judgeEnabled,
        kind: dataset.kind,
        name: dataset.name,
        updatedAt: dataset.updatedAt,
    };
};

const toRunRow = (run: Doc<"evalRuns">): Infer<typeof vRunRow> => {
    return {
        _id: run._id,
        caseCount: run.caseIds.length,
        completedAt: run.completedAt ?? null,
        costCapMicrodollars: run.costCapMicrodollars,
        costMicrodollars: run.costMicrodollars,
        createdAt: run.createdAt,
        datasetId: run.datasetId,
        error: run.error ?? null,
        label: run.label ?? null,
        nextIndex: run.nextIndex,
        status: run.status,
        summary: run.summary ?? null,
        target: run.target,
        tokenBudget: run.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
        unpricedTokens: run.unpricedTokens ?? 0,
    };
};

const toResultRow = (result: Doc<"evalResults">): Infer<typeof vResultRow> => {
    return {
        _id: result._id,
        answer: result.answer ?? null,
        caseId: result.caseId,
        checks: result.checks,
        costMicrodollars: result.costMicrodollars ?? null,
        error: result.error ?? null,
        faithfulness: result.faithfulness ?? null,
        index: result.index,
        input: result.input,
        judge: result.judge ?? null,
        latencyMs: result.latencyMs ?? null,
        passed: result.passed ?? null,
        retrieval: result.retrieval ?? null,
        score: result.score ?? null,
        status: result.status,
        threadId: result.threadId ?? null,
        tokens: result.tokens ?? null,
    };
};

const requireOwnedDataset = async (ctx: QueryCtx, datasetId: Id<"evalDatasets">, userId: string): Promise<Doc<"evalDatasets">> => {
    const dataset = await ctx.db.get(datasetId);

    if (!dataset || dataset.userId !== userId) {
        throw new LunoraError("NOT_FOUND", "Dataset not found");
    }

    return dataset;
};

const requireOwnedCase = async (ctx: QueryCtx, caseId: Id<"evalCases">, userId: string): Promise<Doc<"evalCases">> => {
    const evalCase = await ctx.db.get(caseId);

    if (!evalCase || evalCase.userId !== userId) {
        throw new LunoraError("NOT_FOUND", "Case not found");
    }

    return evalCase;
};

const requireOwnedRun = async (ctx: QueryCtx, runId: Id<"evalRuns">, userId: string): Promise<Doc<"evalRuns">> => {
    const run = await ctx.db.get(runId);

    if (!run || run.userId !== userId) {
        throw new LunoraError("NOT_FOUND", "Run not found");
    }

    return run;
};

/** Evals start headless agent runs, so — like tasks — an anonymous account may not use them. */
const requireEvalAccount = async (ctx: QueryCtx, userId: string): Promise<void> => {
    const account = await loadTaskAccount(ctx, userId);

    if (!account || account.isAnonymous) {
        throw new LunoraError("FORBIDDEN", ANONYMOUS_EVALS_MESSAGE);
    }
};

const optionalText = (value: string | undefined, max: number, label: string): string | undefined => {
    const trimmed = value?.trim();

    if (!trimmed) {
        return undefined;
    }

    if (trimmed.length > max) {
        throw new LunoraError("BAD_REQUEST", `${label} must be ${String(max)} characters or less`);
    }

    return trimmed;
};

const requiredText = (value: string, max: number, label: string): string => {
    const text = optionalText(value, max, label);

    if (!text) {
        throw new LunoraError("BAD_REQUEST", `${label} is required`);
    }

    return text;
};

const loadCases = async (ctx: QueryCtx, datasetId: Id<"evalDatasets">): Promise<Doc<"evalCases">[]> =>
    await ctx.db
        .query("evalCases")
        .withIndex("by_dataset_and_createdAt", (q) => q.eq("datasetId", datasetId))
        .take(MAX_CASES_PER_DATASET);

const requireDraft = (raw: Parameters<typeof normalizeCaseDraft>[0]): CaseDraft => {
    const result = normalizeCaseDraft(raw);

    if (!result.ok) {
        throw new LunoraError("BAD_REQUEST", result.errors.join(". "));
    }

    return result.draft;
};

const touchDataset = async (ctx: MutationCtx, dataset: Doc<"evalDatasets">, caseCountDelta: number): Promise<void> => {
    await ctx.db.patch(dataset._id, { caseCount: Math.max(0, dataset.caseCount + caseCountDelta), updatedAt: Date.now() });
};

/** Validates a run target against what the caller may use; returns it with free text trimmed. */
const resolveTarget = async (
    ctx: QueryCtx,
    { organizationId, userId }: { organizationId?: string; userId: string },
    dataset: Doc<"evalDatasets">,
    target: Infer<typeof vEvalTarget>,
): Promise<Infer<typeof vEvalTarget>> => {
    const allowed = (model: string) => isTaskModelAllowed(model, (id) => MODEL_LOOKUP.get(id));

    if (target.model && !allowed(target.model)) {
        throw new LunoraError("BAD_REQUEST", `The model '${target.model}' is not available for evals`);
    }

    if ((target.kind === "knowledge") !== (dataset.kind === "rag")) {
        throw new LunoraError(
            "BAD_REQUEST",
            dataset.kind === "rag" ? "A retrieval dataset runs against knowledge files" : "Knowledge-file targets need a retrieval dataset",
        );
    }

    if (target.kind === "skill") {
        const skill = await ctx.db.skills.findFirst({ where: { _id: target.skillId } });

        if (!skill || !canReadSkill(skill, { organizationId, userId })) {
            throw new LunoraError("NOT_FOUND", "Skill not found");
        }

        const userSkill = await ctx.db
            .query("userSkills")
            .withIndex("by_user_and_skill", (q) => q.eq("userId", userId).eq("skillId", target.skillId))
            .first();

        if (!userSkill?.enabled) {
            throw new LunoraError("BAD_REQUEST", `Enable the skill '/${skill.slug}' before evaluating it`);
        }

        return target;
    }

    if (target.kind === "model") {
        const systemPrompt = optionalText(target.systemPrompt, SYSTEM_PROMPT_MAX, "System prompt");

        return systemPrompt ? { kind: "model", model: target.model, systemPrompt } : { kind: "model", model: target.model };
    }

    const fileIds = [...new Set(target.fileIds)];

    if (fileIds.length > MAX_TARGET_FILES) {
        throw new LunoraError("BAD_REQUEST", `A run can search at most ${String(MAX_TARGET_FILES)} files`);
    }

    for (const fileId of fileIds) {
        const file = await ctx.db.get(fileId);

        if (!file || file.userId !== userId) {
            throw new LunoraError("NOT_FOUND", "Knowledge file not found");
        }
    }

    return { fileIds, kind: "knowledge", ...(target.model && { model: target.model }) };
};

// ─── Datasets ────────────────────────────────────────────────────────────────

export const listDatasets = authQuery
    .input({})
    .output(v.from(vDatasetList))
    .query(async ({ ctx }) => {
        const datasets = await ctx.db
            .query("evalDatasets")
            .withIndex("by_user_and_updatedAt", (q) => q.eq("userId", ctx.user.userId))
            .order("desc")
            .take(MAX_DATASETS_PER_USER);

        return datasets.map((dataset) => toDatasetRow(dataset));
    });

export const getDataset = authQuery
    .input({ datasetId: v.id("evalDatasets") })
    .output(v.from(vDatasetDetail))
    .query(async ({ args, ctx }) => {
        const dataset = await requireOwnedDataset(ctx, args.datasetId, ctx.user.userId);
        const cases = await loadCases(ctx, dataset._id);

        return {
            cases: cases.map((evalCase) => {
                return {
                    _id: evalCase._id,
                    checks: evalCase.checks,
                    createdAt: evalCase.createdAt,
                    expectedAnswer: evalCase.expectedAnswer ?? null,
                    expectedSources: evalCase.expectedSources,
                    input: evalCase.input,
                    rubric: evalCase.rubric ?? null,
                    source: evalCase.source,
                    updatedAt: evalCase.updatedAt,
                };
            }),
            dataset: toDatasetRow(dataset),
        };
    });

export const createDataset = authMutation
    .use(rateLimit("evals/create"))
    .input({
        description: v.optional(v.string().max(MAX_LENGTH.long)),
        judgeEnabled: v.optional(v.boolean()),
        kind: v.union(v.literal("agent"), v.literal("rag")),
        name: v.string().max(MAX_LENGTH.short),
    })
    .output(v.object({ datasetId: v.id("evalDatasets") }))
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;

        await requireEvalAccount(ctx, userId);

        const existing = await ctx.db
            .query("evalDatasets")
            .withIndex("by_user_and_updatedAt", (q) => q.eq("userId", userId))
            .take(MAX_DATASETS_PER_USER);

        if (existing.length >= MAX_DATASETS_PER_USER) {
            throw new LunoraError("BAD_REQUEST", `You can have at most ${String(MAX_DATASETS_PER_USER)} datasets`);
        }

        const now = ctx.now;
        const datasetId = await ctx.db.insert("evalDatasets", {
            caseCount: 0,
            createdAt: now,
            description: optionalText(args.description, DATASET_DESCRIPTION_MAX, "Description"),
            judgeEnabled: args.judgeEnabled ?? true,
            kind: args.kind,
            name: requiredText(args.name, DATASET_NAME_MAX, "Name"),
            updatedAt: now,
            userId,
        });

        ctx.log.event("evals.create_dataset", { judgeEnabled: args.judgeEnabled ?? true, kind: args.kind });

        return { datasetId };
    });

export const updateDataset = authMutation
    .use(rateLimit("evals/update"))
    .input({
        datasetId: v.id("evalDatasets"),
        description: v.optional(v.string().max(MAX_LENGTH.long)),
        judgeEnabled: v.boolean(),
        name: v.string().max(MAX_LENGTH.short),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await requireOwnedDataset(ctx, args.datasetId, ctx.user.userId);

        await patchById(ctx.db, args.datasetId, {
            description: optionalText(args.description, DATASET_DESCRIPTION_MAX, "Description"),
            judgeEnabled: args.judgeEnabled,
            name: requiredText(args.name, DATASET_NAME_MAX, "Name"),
            updatedAt: ctx.now,
        });

        ctx.log.event("evals.update_dataset", { judgeEnabled: args.judgeEnabled });

        return null;
    });

/** Deletes the dataset now; its cases, runs and results go in the background. A run in flight stops at its next claim. */
export const deleteDataset = authMutation
    .use(rateLimit("evals/delete"))
    .input({ datasetId: v.id("evalDatasets") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const dataset = await requireOwnedDataset(ctx, args.datasetId, ctx.user.userId);

        await ctx.db.delete(dataset._id);
        await ctx.scheduler.runAfter(0, internal.evals.functions.purgeDataset, { datasetId: dataset._id, userId: dataset.userId });

        ctx.log.event("evals.delete_dataset", { deleted: true });

        return null;
    });

/** Removes a deleted dataset's rows in batches, rescheduling itself until none are left. */
export const purgeDataset = internalMutation
    .input({ datasetId: v.id("evalDatasets"), userId: v.string() })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const runs = await ctx.db
            .query("evalRuns")
            .withIndex("by_dataset_and_createdAt", (q) => q.eq("datasetId", args.datasetId))
            .take(PURGE_BATCH);
        let removed = 0;

        for (const run of runs) {
            if (run.userId !== args.userId) {
                continue;
            }

            const results = await ctx.db
                .query("evalResults")
                .withIndex("by_run_and_index", (q) => q.eq("runId", run._id))
                .take(PURGE_BATCH - removed);

            await Promise.all(results.map((result) => ctx.db.delete(result._id)));
            removed += results.length;

            if (removed >= PURGE_BATCH) {
                break;
            }

            await ctx.db.delete(run._id);
            removed += 1;
        }

        if (removed < PURGE_BATCH) {
            const cases = await ctx.db
                .query("evalCases")
                .withIndex("by_dataset_and_createdAt", (q) => q.eq("datasetId", args.datasetId))
                .take(PURGE_BATCH - removed);

            await Promise.all(cases.map((evalCase) => ctx.db.delete(evalCase._id)));
            removed += cases.length;
        }

        if (removed >= PURGE_BATCH) {
            await ctx.scheduler.runAfter(0, internal.evals.functions.purgeDataset, args);
        }

        return null;
    });

// ─── Cases ───────────────────────────────────────────────────────────────────

export const createCase = authMutation
    .use(rateLimit("evals/create"))
    .input({
        checks: v.optional(v.array(v.object({ kind: v.string().max(MAX_LENGTH.text), value: v.string().max(MAX_LENGTH.document) }))),
        datasetId: v.id("evalDatasets"),
        expectedAnswer: v.optional(v.string().max(MAX_LENGTH.document)),
        expectedSources: v.optional(v.array(v.string().max(MAX_LENGTH.long))),
        input: v.string().max(MAX_LENGTH.document),
        rubric: v.optional(v.string().max(MAX_LENGTH.document)),
        // `chat` when saved from a message's "Save as eval case" action.
        source: v.optional(v.union(v.literal("manual"), v.literal("chat"))),
    })
    .output(v.object({ caseId: v.id("evalCases") }))
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const dataset = await requireOwnedDataset(ctx, args.datasetId, userId);

        if (dataset.caseCount >= MAX_CASES_PER_DATASET) {
            throw new LunoraError("BAD_REQUEST", `A dataset can have at most ${String(MAX_CASES_PER_DATASET)} cases`);
        }

        const draft = requireDraft(args);
        const now = ctx.now;
        const caseId = await ctx.db.insert("evalCases", {
            ...draft,
            createdAt: now,
            datasetId: dataset._id,
            source: args.source ?? "manual",
            updatedAt: now,
            userId,
        });

        await touchDataset(ctx, dataset, 1);

        ctx.log.event("evals.create_case", { source: args.source ?? "manual" });

        return { caseId };
    });

export const updateCase = authMutation
    .use(rateLimit("evals/update"))
    .input({
        caseId: v.id("evalCases"),
        checks: v.optional(v.array(v.object({ kind: v.string().max(MAX_LENGTH.text), value: v.string().max(MAX_LENGTH.document) }))),
        expectedAnswer: v.optional(v.string().max(MAX_LENGTH.document)),
        expectedSources: v.optional(v.array(v.string().max(MAX_LENGTH.long))),
        input: v.string().max(MAX_LENGTH.document),
        rubric: v.optional(v.string().max(MAX_LENGTH.document)),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const evalCase = await requireOwnedCase(ctx, args.caseId, ctx.user.userId);
        const draft = requireDraft(args);

        await patchById(ctx.db, evalCase._id, {
            checks: draft.checks,
            expectedAnswer: draft.expectedAnswer,
            expectedSources: draft.expectedSources,
            input: draft.input,
            rubric: draft.rubric,
            updatedAt: ctx.now,
        });

        const dataset = await ctx.db.get(evalCase.datasetId);

        if (dataset) {
            await touchDataset(ctx, dataset, 0);
        }

        ctx.log.event("evals.update_case", { updated: true });

        return null;
    });

/** Deletes a case. Past runs keep their results; a run in flight records it as skipped. */
export const deleteCase = authMutation
    .use(rateLimit("evals/delete"))
    .input({ caseId: v.id("evalCases") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const evalCase = await requireOwnedCase(ctx, args.caseId, ctx.user.userId);

        await ctx.db.delete(evalCase._id);

        const dataset = await ctx.db.get(evalCase.datasetId);

        if (dataset) {
            await touchDataset(ctx, dataset, -1);
        }

        ctx.log.event("evals.delete_case", { deleted: true });

        return null;
    });

/** Imports CSV or JSONL (format in `evals/import.ts`). All-or-nothing: any invalid row imports nothing and every problem is returned. */
export const importCases = authMutation
    .use(rateLimit("evals/create"))
    .input({ content: v.string().max(MAX_LENGTH.document), datasetId: v.id("evalDatasets"), format: v.union(v.literal("csv"), v.literal("jsonl")) })
    .output(v.from(vImportResult))
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const dataset = await requireOwnedDataset(ctx, args.datasetId, userId);
        const parsed = parseCaseImport(args.format, args.content, MAX_CASES_PER_DATASET - dataset.caseCount);

        if (!parsed.ok) {
            return { errors: parsed.errors, imported: 0 };
        }

        const now = ctx.now;

        for (const [offset, draft] of parsed.cases.entries()) {
            // Distinct `createdAt`s keep the file's order in the by-creation index.
            await ctx.db.insert("evalCases", { ...draft, createdAt: now + offset, datasetId: dataset._id, source: "import", updatedAt: now, userId });
        }

        await touchDataset(ctx, dataset, parsed.cases.length);

        ctx.log.event("evals.import_cases", { imported: parsed.cases.length });

        return { errors: [], imported: parsed.cases.length };
    });

// ─── Runs ────────────────────────────────────────────────────────────────────

export const listRuns = authQuery
    .input({ datasetId: v.id("evalDatasets") })
    .output(v.from(vRunList))
    .query(async ({ args, ctx }) => {
        await requireOwnedDataset(ctx, args.datasetId, ctx.user.userId);

        const runs = await ctx.db
            .query("evalRuns")
            .withIndex("by_dataset_and_createdAt", (q) => q.eq("datasetId", args.datasetId))
            .order("desc")
            .take(MAX_RUNS_LISTED);

        return runs.filter((run) => run.userId === ctx.user.userId).map((run) => toRunRow(run));
    });

/** A run with every result so far and a live aggregate — the stored summary is only written when the run ends. */
export const getRun = authQuery
    .input({ runId: v.id("evalRuns") })
    .output(v.from(vRunDetail))
    .query(async ({ args, ctx }) => {
        const run = await requireOwnedRun(ctx, args.runId, ctx.user.userId);
        const results = await loadRunResults(ctx, run._id);

        return {
            results: results.map((result) => toResultRow(result)),
            run: toRunRow(run),
            summary: summarize(results, run.caseIds.length),
        };
    });

export const startRun = authMutation
    .use(rateLimit("evals/run"))
    .input({
        // US dollars; defaults to $1.
        costCapUsd: v.optional(v.number()),
        datasetId: v.id("evalDatasets"),
        label: v.optional(v.string().max(MAX_LENGTH.short)),
        target: v.union(
            v.object({ kind: v.literal("skill"), model: v.optional(v.string().max(MAX_LENGTH.short)), skillId: v.id("skills") }),
            v.object({ kind: v.literal("model"), model: v.string().max(MAX_LENGTH.short), systemPrompt: v.optional(v.string().max(MAX_LENGTH.document)) }),
            v.object({ fileIds: v.array(v.id("knowledgeFiles")), kind: v.literal("knowledge"), model: v.optional(v.string().max(MAX_LENGTH.short)) }),
        ),
        // Tokens the run may spend on cases no cost is reported for; defaults to 200k.
        tokenBudget: v.optional(v.number()),
    })
    .output(v.object({ runId: v.id("evalRuns") }))
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const organizationId = ctx.user.activeOrganization?.id;

        await requireEvalAccount(ctx, userId);

        const dataset = await requireOwnedDataset(ctx, args.datasetId, userId);
        const costCap = parseCostCapUsd(args.costCapUsd);

        if (typeof costCap !== "number") {
            throw new LunoraError("BAD_REQUEST", costCap.error);
        }

        const tokenBudget = parseTokenBudget(args.tokenBudget);

        if (typeof tokenBudget !== "number") {
            throw new LunoraError("BAD_REQUEST", tokenBudget.error);
        }

        const target = await resolveTarget(ctx, { organizationId, userId }, dataset, args.target);
        const active = await ctx.db
            .query("evalRuns")
            .withIndex("by_user_and_status", (q) => q.eq("userId", userId).eq("status", "running"))
            .take(MAX_ACTIVE_RUNS_PER_USER);

        if (active.length >= MAX_ACTIVE_RUNS_PER_USER) {
            throw new LunoraError(
                "TOO_MANY_REQUESTS",
                `You can have at most ${String(MAX_ACTIVE_RUNS_PER_USER)} eval runs in progress. Wait for one to finish or cancel it.`,
            );
        }

        const cases = await loadCases(ctx, dataset._id);

        if (cases.length === 0) {
            throw new LunoraError("BAD_REQUEST", "Add at least one case before running the dataset");
        }

        const now = ctx.now;
        const runId = await ctx.db.insert("evalRuns", {
            caseIds: cases.map((evalCase) => evalCase._id),
            costCapMicrodollars: costCap,
            costMicrodollars: 0,
            createdAt: now,
            datasetId: dataset._id,
            datasetKind: dataset.kind,
            judgeEnabled: dataset.judgeEnabled,
            label: optionalText(args.label, RUN_LABEL_MAX, "Label"),
            nextIndex: 0,
            organizationId,
            status: "running",
            target,
            tokenBudget,
            unpricedTokens: 0,
            updatedAt: now,
            userId,
        });

        // Jobs queue (`lib/job-queue.ts`); a redelivery is refused by `claimCase`.
        await enqueueJob(internal.evals.execute.runEvalCase, { index: 0, runId });

        ctx.log.event("evals.start_run", { caseCount: cases.length, targetKind: args.target.kind });

        return { runId };
    });

/** Stops a run. A case already in flight finishes in the background and is still recorded. */
export const cancelRun = authMutation
    .use(rateLimit("evals/update"))
    .input({ runId: v.id("evalRuns") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const run = await requireOwnedRun(ctx, args.runId, ctx.user.userId);

        if (run.status !== "running") {
            throw new LunoraError("CONFLICT", "This run is not in progress");
        }

        await finishRun(ctx, run, "cancelled");

        ctx.log.event("evals.cancel_run", { cancelled: true });

        return null;
    });

export const deleteRun = authMutation
    .use(rateLimit("evals/delete"))
    .input({ runId: v.id("evalRuns") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const run = await requireOwnedRun(ctx, args.runId, ctx.user.userId);
        const results = await loadRunResults(ctx, run._id);

        await Promise.all(results.map((result) => ctx.db.delete(result._id)));
        await ctx.db.delete(run._id);

        ctx.log.event("evals.delete_run", { resultCount: results.length });

        return null;
    });

/** Case-by-case regression view: `baseline` is the earlier run, `candidate` the one being judged. */
export const compareRuns = authQuery
    .input({ baselineRunId: v.id("evalRuns"), candidateRunId: v.id("evalRuns") })
    .output(v.from(vComparison))
    .query(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const [baseline, candidate] = await Promise.all([requireOwnedRun(ctx, args.baselineRunId, userId), requireOwnedRun(ctx, args.candidateRunId, userId)]);
        const [baseResults, candidateResults] = await Promise.all([loadRunResults(ctx, baseline._id), loadRunResults(ctx, candidate._id)]);
        const toComparable = (results: Doc<"evalResults">[]) =>
            results.map((result) => {
                return { caseId: result.caseId as string, passed: result.passed, score: result.score, status: result.status };
            });
        const comparison = compareRunResults(toComparable(baseResults), toComparable(candidateResults));
        const inputs = new Map<string, string>(
            [...baseResults, ...candidateResults].filter((result) => result.input).map((result) => [result.caseId as string, result.input]),
        );

        return {
            baseline: toRunRow({ ...baseline, summary: summarize(baseResults, baseline.caseIds.length) }),
            candidate: toRunRow({ ...candidate, summary: summarize(candidateResults, candidate.caseIds.length) }),
            cases: comparison.cases.map((entry) => {
                return {
                    baselinePassed: entry.baseline?.passed ?? null,
                    baselineScore: entry.baseline?.score ?? null,
                    baselineStatus: entry.baseline?.status ?? null,
                    candidatePassed: entry.candidate?.passed ?? null,
                    candidateScore: entry.candidate?.score ?? null,
                    candidateStatus: entry.candidate?.status ?? null,
                    caseId: entry.caseId as Id<"evalCases">,
                    change: entry.change,
                    input: inputs.get(entry.caseId) ?? "",
                    scoreDelta: entry.scoreDelta ?? null,
                };
            }),
            improved: comparison.improved,
            regressed: comparison.regressed,
            unchanged: comparison.unchanged,
        };
    });
