/**
 * The eval runner's state machine, server-side only.
 *
 * ## Orchestration
 *
 * On the scheduler, like tasks: a run is its cases, one at a time, each a
 * single action (`evals/execute.ts:runEvalCase`) bracketed by two mutations.
 * {@link claimCase} decides whether case `index` may run and charges it;
 * {@link completeCase} records the outcome and schedules case `index + 1`, or
 * finishes the run. Cases run strictly in sequence, so a run never holds more
 * than one agent at a time, and a user's concurrency is capped by how many runs
 * they may have in flight (`MAX_ACTIVE_RUNS_PER_USER`).
 *
 * ## Idempotency
 *
 * The claim inserts the case's `evalResults` row and refuses when one exists for
 * `(runId, index)` or when `index` is not the run's `nextIndex`; completion only
 * finishes a row still `running`. A retried action, a duplicate schedule or a
 * case finishing after the user cancelled all resolve to a no-op.
 *
 * ## Crash recovery
 *
 * No cron: each claim schedules {@link reapCase} past the longest a case may
 * take. If the case is still `running` then, its action died without reporting,
 * so the reaper records it as an error and moves the run on.
 *
 * ## Cost controls
 *
 * Every case is charged to the same daily limits a task round is
 * (`tasks/account.ts:chargeRound`), in the claim's transaction. The run's cost
 * cap is checked before each case against what the run has spent so far
 * — or, for cases no price was reported for, their tokens against the run's
 * token budget (`nextCaseBudget`).
 */
import { MODEL_LOOKUP } from "@neore/ai/models";
import type { Infer } from "lunorash/server";
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";
import { isAccountDeletionUnderway } from "../gdpr/deletion-guard";
import { enqueueJob } from "../lib/job-queue";
import { withoutUndefined } from "../lib/patch";
import { chargeRound, loadTaskAccount } from "../tasks/account";
import { isTaskModelAllowed } from "../tasks/logic";
import type { EvalSummary } from "./metrics";
import { aggregateResults, DEFAULT_TOKEN_BUDGET, MAX_CASES_PER_DATASET, nextCaseBudget, unpricedCaseTokens } from "./metrics";
import { vEvalCheck, vEvalCheckResult, vEvalDatasetKind, vEvalTarget, vJudgeVerdict, vRetrievalMetrics } from "./validators";
import { notifyQuietly } from "../notifications/notify";

/** Longer than any case may take: a headless run plus retrieval and two judge calls. */
export const STALE_CASE_MS = 20 * 60_000;

export const ANONYMOUS_EVALS_MESSAGE = "Evals need an account. Sign up to run evals.";

export const EVAL_DAILY_LIMIT_MESSAGE = "The run stopped: you've reached your daily limit for agent runs. Start it again tomorrow.";

export const TOKEN_BUDGET_MESSAGE =
    "The run stopped at its token budget: no cost was reported for its cases (your own API key or a custom endpoint), so their tokens were counted instead.";

const TIMED_OUT_MESSAGE = "The case stopped responding and was abandoned.";

type RunStatus = Doc<"evalRuns">["status"];

/** A run's results in case order, bounded by the per-dataset ceiling a run snapshots under. */
export const loadRunResults = async (ctx: QueryCtx, runId: Id<"evalRuns">): Promise<Doc<"evalResults">[]> =>
    await ctx.db
        .query("evalResults")
        .withIndex("by_run_and_index", (q) => q.eq("runId", runId))
        .take(MAX_CASES_PER_DATASET + 1);

export const summarize = (results: ReadonlyArray<Doc<"evalResults">>, total: number): EvalSummary =>
    aggregateResults(
        results.map((result) => {
            return {
                checks: result.checks,
                costMicrodollars: result.costMicrodollars,
                faithfulness: result.faithfulness,
                judge: result.judge,
                latencyMs: result.latencyMs,
                passed: result.passed,
                retrieval: result.retrieval,
                score: result.score,
                status: result.status,
            };
        }),
        total,
    );

/** What a run has spent so far, as stored on it. */
interface Spend {
    costMicrodollars: number;
    unpricedTokens: number;
}

/** Ends a run in a terminal status, with its aggregate computed from the results written so far. */
export const finishRun = async (
    ctx: MutationCtx,
    run: Doc<"evalRuns">,
    status: Exclude<RunStatus, "running">,
    patch: Partial<Spend> & { error?: string; nextIndex?: number } = {},
): Promise<void> => {
    const results = await loadRunResults(ctx, run._id);
    const now = Date.now();

    await ctx.db.patch(
        run._id,
        withoutUndefined({
            completedAt: now,
            costMicrodollars: patch.costMicrodollars,
            error: patch.error,
            nextIndex: patch.nextIndex,
            status,
            summary: summarize(results, run.caseIds.length),
            unpricedTokens: patch.unpricedTokens,
            updatedAt: now,
        }),
    );

    // Only the transition out of `running` is news, and a cancel is the user's own doing.
    if (run.status === "running" && status !== "cancelled") {
        const dataset = await ctx.db.get(run.datasetId);

        await notifyQuietly(ctx, {
            dedupeKey: `eval:${run._id}`,
            link: "/evals",
            outcome: status === "completed" ? "success" : "failure",
            title: run.label ?? dataset?.name ?? "Eval run",
            type: "eval",
            userId: run.userId,
            ...(patch.error && { body: patch.error }),
        });
    }
};

/**
 * After case `nextIndex - 1` finished: schedule the next case, or finish the
 * run when that was the last one. A run no longer `running` (cancelled while the
 * case was in flight) only records the spend and refreshes its aggregate.
 */
const advance = async (ctx: MutationCtx, run: Doc<"evalRuns">, nextIndex: number, spend: Spend): Promise<void> => {
    if (run.status !== "running") {
        await finishRun(ctx, run, run.status, spend);

        return;
    }

    if (nextIndex >= run.caseIds.length) {
        await finishRun(ctx, run, "completed", { ...spend, nextIndex });

        return;
    }

    await ctx.db.patch(run._id, { ...spend, nextIndex, updatedAt: Date.now() });
    // Jobs queue (`lib/job-queue.ts`); a redelivery is refused by `claimCase`.
    await enqueueJob(internal.evals.execute.runEvalCase, { index: nextIndex, runId: run._id });
};

const vClaim = v.union(
    v.null(),
    v.object({
        caseId: v.id("evalCases"),
        checks: v.array(vEvalCheck),
        datasetKind: vEvalDatasetKind,
        expectedAnswer: v.optional(v.string()),
        expectedSources: v.array(v.string()),
        input: v.string(),
        judgeEnabled: v.boolean(),
        organizationId: v.optional(v.string()),
        resultId: v.id("evalResults"),
        rubric: v.optional(v.string()),
        target: vEvalTarget,
        userId: v.string(),
    }),
);

/**
 * Claims case `index` of a run: inserts its result row and charges it. `null`
 * means "not yours to run" — the run is not running, the index is not next, or
 * the case was already claimed — or that the run ended here instead:
 *
 * - the account is being deleted: the run is cancelled silently;
 * - the account is anonymous or gone, the target's model is no longer allowed,
 *   or a daily limit is spent: the run fails with the reason;
 * - the run has spent its cost cap: it ends `cost_capped`.
 *
 * A case deleted since the run started is recorded as `skipped` and the run
 * moves on.
 */
export const claimCase = internalMutation
    .input({ index: v.number(), runId: v.id("evalRuns") })
    .output(v.from(vClaim))
    .mutation(async ({ args: { index, runId }, ctx }) => {
        const run = await ctx.db.get(runId);

        if (!run || run.status !== "running" || run.nextIndex !== index) {
            return null;
        }

        const existing = await ctx.db
            .query("evalResults")
            .withIndex("by_run_and_index", (q) => q.eq("runId", runId).eq("index", index))
            .first();

        if (existing) {
            return null;
        }

        if (index >= run.caseIds.length) {
            await finishRun(ctx, run, "completed");

            return null;
        }

        if (await isAccountDeletionUnderway(ctx, run.userId)) {
            await finishRun(ctx, run, "cancelled");

            return null;
        }

        const account = await loadTaskAccount(ctx, run.userId);

        if (!account || account.isAnonymous) {
            await finishRun(ctx, run, "failed", { error: account ? ANONYMOUS_EVALS_MESSAGE : "Your account no longer exists." });

            return null;
        }

        const budget = nextCaseBudget({
            capMicrodollars: run.costCapMicrodollars,
            spentMicrodollars: run.costMicrodollars,
            tokenBudget: run.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
            unpricedTokens: run.unpricedTokens ?? 0,
        });

        if (budget !== "ok") {
            await finishRun(ctx, run, "cost_capped", budget === "tokens" ? { error: TOKEN_BUDGET_MESSAGE } : {});

            return null;
        }

        const { target } = run;

        if (target.model && !isTaskModelAllowed(target.model, (id) => MODEL_LOOKUP.get(id))) {
            await finishRun(ctx, run, "failed", { error: `The model '${target.model}' is no longer available. Pick another model and run again.` });

            return null;
        }

        const caseId = run.caseIds[index]!;
        const evalCase = await ctx.db.get(caseId);
        const now = ctx.now;

        if (!evalCase || evalCase.userId !== run.userId) {
            await ctx.db.insert("evalResults", {
                caseId,
                checks: [],
                completedAt: now,
                error: "The case was deleted after the run started.",
                index,
                input: "",
                runId,
                startedAt: now,
                status: "skipped",
                userId: run.userId,
            });
            await advance(ctx, run, index + 1, { costMicrodollars: run.costMicrodollars, unpricedTokens: run.unpricedTokens ?? 0 });

            return null;
        }

        if (!(await chargeRound(ctx, run.userId, account))) {
            await finishRun(ctx, run, "failed", { error: EVAL_DAILY_LIMIT_MESSAGE });

            return null;
        }

        const resultId = await ctx.db.insert("evalResults", {
            caseId,
            checks: [],
            index,
            input: evalCase.input,
            runId,
            startedAt: now,
            status: "running",
            userId: run.userId,
        });

        await ctx.scheduler.runAfter(STALE_CASE_MS, internal.evals.internal.reapCase, { resultId });

        return {
            caseId,
            checks: evalCase.checks,
            datasetKind: run.datasetKind,
            expectedAnswer: evalCase.expectedAnswer ?? undefined,
            expectedSources: evalCase.expectedSources,
            input: evalCase.input,
            judgeEnabled: run.judgeEnabled,
            organizationId: run.organizationId ?? undefined,
            resultId,
            rubric: evalCase.rubric ?? undefined,
            target,
            userId: run.userId,
        };
    });

export const vCaseOutcome = v.union(
    v.object({
        // The answer, when the run produced one and only the scoring failed.
        answer: v.optional(v.string()),
        costMicrodollars: v.optional(v.number()),
        error: v.string(),
        kind: v.literal("error"),
        latencyMs: v.optional(v.number()),
        threadId: v.optional(v.string()),
        // Total tokens the case used, when the providers reported usage.
        tokens: v.optional(v.number()),
        // Tokens of the calls no cost was reported for; see `nextCaseBudget`.
        unpricedTokens: v.optional(v.number()),
    }),
    v.object({
        answer: v.string(),
        checks: v.array(vEvalCheckResult),
        costMicrodollars: v.optional(v.number()),
        faithfulness: v.optional(vJudgeVerdict),
        judge: v.optional(vJudgeVerdict),
        kind: v.literal("scored"),
        latencyMs: v.number(),
        passed: v.boolean(),
        retrieval: v.optional(vRetrievalMetrics),
        score: v.optional(v.number()),
        threadId: v.optional(v.string()),
        tokens: v.optional(v.number()),
        unpricedTokens: v.optional(v.number()),
    }),
);

type CaseOutcome = Infer<typeof vCaseOutcome>;

const recordOutcome = async (ctx: MutationCtx, result: Doc<"evalResults">, outcome: CaseOutcome): Promise<void> => {
    const now = Date.now();

    if (outcome.kind === "error") {
        await ctx.db.patch(
            result._id,
            withoutUndefined({
                answer: outcome.answer,
                completedAt: now,
                costMicrodollars: outcome.costMicrodollars,
                error: outcome.error.slice(0, 2000),
                latencyMs: outcome.latencyMs,
                status: "error" as const,
                threadId: outcome.threadId,
                tokens: outcome.tokens,
            }),
        );
    } else {
        await ctx.db.patch(
            result._id,
            withoutUndefined({
                answer: outcome.answer,
                checks: outcome.checks,
                completedAt: now,
                costMicrodollars: outcome.costMicrodollars,
                faithfulness: outcome.faithfulness,
                judge: outcome.judge,
                latencyMs: outcome.latencyMs,
                passed: outcome.passed,
                retrieval: outcome.retrieval,
                score: outcome.score,
                status: "scored" as const,
                threadId: outcome.threadId,
                tokens: outcome.tokens,
            }),
        );
    }

    const run = await ctx.db.get(result.runId);

    if (run) {
        // The runner counts per call; an outcome without a count (the reaper's, or a
        // case that threw) is priced as a whole, estimated from its text if need be.
        const unpriced = outcome.unpricedTokens ?? unpricedCaseTokens(outcome.costMicrodollars, outcome.tokens, `${result.input}${outcome.answer ?? ""}`);

        await advance(ctx, run, result.index + 1, {
            costMicrodollars: run.costMicrodollars + (outcome.costMicrodollars ?? 0),
            unpricedTokens: (run.unpricedTokens ?? 0) + unpriced,
        });
    }
};

/** Records a claimed case's outcome and moves the run on. A result no longer `running` (reaped, or a duplicate) is left alone. */
export const completeCase = internalMutation
    .input({ outcome: v.from(vCaseOutcome), resultId: v.id("evalResults") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const result = await ctx.db.get(args.resultId);

        if (!result || result.status !== "running") {
            return null;
        }

        await recordOutcome(ctx, result, args.outcome);

        return null;
    });

/** Scheduled by every claim: fails a case whose action died without reporting, so the run does not hang. */
export const reapCase = internalMutation
    .input({ resultId: v.id("evalResults") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const result = await ctx.db.get(args.resultId);

        if (!result || result.status !== "running") {
            return null;
        }

        await recordOutcome(ctx, result, { error: TIMED_OUT_MESSAGE, kind: "error" });

        return null;
    });

/** Whether a case may still create a thread for `userId` — an account deletion may have started since the claim. */
export const canRunForUser = internalQuery
    .input({ userId: v.string() })
    .output(v.boolean())
    .query(async ({ args, ctx }) => !(await isAccountDeletionUnderway(ctx, args.userId)));
