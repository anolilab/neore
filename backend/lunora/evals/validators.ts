/**
 * The eval domain's column validators, declared once: `schema.ts` builds the
 * `evalDatasets` / `evalCases` / `evalRuns` / `evalResults` tables from them and
 * the procedures reuse them for their arguments and outputs.
 *
 * Inline `v.union(...)` / `v.object({...})` literals only: codegen resolves an
 * inline validator expression, not one built by a call or a spread const.
 */
import { v } from "lunorash/server";

export const vEvalDatasetKind = v.union(v.literal("agent"), v.literal("rag"));

export const vEvalCheckKind = v.union(
    v.literal("exact"),
    v.literal("contains"),
    v.literal("not_contains"),
    v.literal("regex"),
    v.literal("json_schema"),
    v.literal("max_latency_ms"),
    v.literal("max_cost_usd"),
);

/** A deterministic check on a case. `value` is always a string; numeric kinds parse it. */
export const vEvalCheck = v.object({
    kind: vEvalCheckKind,
    value: v.string(),
});

/** How a check came out. `pass: null` means "could not be measured" (e.g. no cost reported) and counts neither way. */
export const vEvalCheckResult = v.object({
    detail: v.optional(v.string()),
    kind: vEvalCheckKind,
    pass: v.union(v.boolean(), v.null()),
    value: v.string(),
});

/**
 * What a run evaluates:
 *
 * - `skill`: an agent (skill) run headless, as a task would run it;
 * - `model`: a model plus an optional system prompt, run headless;
 * - `knowledge`: retrieval over knowledge files (all indexed ones when
 *   `fileIds` is empty), then an answer grounded in what was retrieved.
 */
export const vEvalTarget = v.union(
    v.object({ kind: v.literal("skill"), model: v.optional(v.string()), skillId: v.id("skills") }),
    v.object({ kind: v.literal("model"), model: v.string(), systemPrompt: v.optional(v.string()) }),
    v.object({ fileIds: v.array(v.id("knowledgeFiles")), kind: v.literal("knowledge"), model: v.optional(v.string()) }),
);

export const vEvalRunStatus = v.union(v.literal("running"), v.literal("completed"), v.literal("cancelled"), v.literal("failed"), v.literal("cost_capped"));

export const vEvalResultStatus = v.union(v.literal("running"), v.literal("scored"), v.literal("error"), v.literal("skipped"));

export const vJudgeVerdict = v.object({
    reasons: v.array(v.string()),
    score: v.number(),
});

export const vRetrievalMetrics = v.object({
    contextPrecision: v.number(),
    contextRecall: v.number(),
    hitAtK: v.number(),
    k: v.number(),
    latencyMs: v.number(),
    mrr: v.number(),
    retrieved: v.array(v.object({ fileId: v.optional(v.string()), fileName: v.string(), relevant: v.boolean(), score: v.number() })),
});

/** Aggregate scores over a run's results; `null` where no result measured that metric. */
export const vEvalSummary = v.object({
    avgContextPrecision: v.union(v.number(), v.null()),
    avgContextRecall: v.union(v.number(), v.null()),
    avgFaithfulness: v.union(v.number(), v.null()),
    avgJudgeScore: v.union(v.number(), v.null()),
    avgLatencyMs: v.union(v.number(), v.null()),
    avgScore: v.union(v.number(), v.null()),
    checkPassRate: v.union(v.number(), v.null()),
    errored: v.number(),
    hitRate: v.union(v.number(), v.null()),
    mrr: v.union(v.number(), v.null()),
    passed: v.number(),
    passRate: v.union(v.number(), v.null()),
    scored: v.number(),
    skipped: v.number(),
    total: v.number(),
    totalCostMicrodollars: v.number(),
});
