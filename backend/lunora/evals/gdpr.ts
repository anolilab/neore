/**
 * Eval datasets, cases, runs and results in the GDPR export and account deletion.
 *
 * Wired into `gdpr/workflows/export-workflow.ts` ("collect-evals") and
 * `gdpr/workflows/deletion-workflow.ts` — twice, like tasks: "stop-user-evals"
 * early, before any step a case could write a thread behind (`claimCase` also
 * refuses once the deletion request exists), and "delete-user-evals" late, for
 * what a case already in flight left. Deletion follows the residual steps'
 * contract (`gdpr/steps/residual-deletion-steps.ts`): at most `BATCH` rows per
 * table per call, `{ hasMore }` back, idempotent on retry.
 */
import { v } from "lunorash/server";

import { internalMutation, internalQuery } from "../_generated/server";
import { MAX_CASES_PER_DATASET, MAX_DATASETS_PER_USER } from "./metrics";

const BATCH = 100;

/** Runs per dataset in the export — the newest; older ones are history. */
const EXPORT_RUNS_PER_DATASET = 20;

export const collectEvalsForExport = internalQuery
    .input({ userId: v.string() })
    .output(v.object({ datasets: v.array(v.any()) }))
    .query(async ({ args: { userId }, ctx }) => {
        const datasets = await ctx.db
            .query("evalDatasets")
            .withIndex("by_user_and_updatedAt", (q) => q.eq("userId", userId))
            .take(MAX_DATASETS_PER_USER);

        return {
            datasets: await Promise.all(
                datasets.map(async (dataset) => {
                    const [cases, runs] = await Promise.all([
                        ctx.db
                            .query("evalCases")
                            .withIndex("by_dataset_and_createdAt", (q) => q.eq("datasetId", dataset._id))
                            .take(MAX_CASES_PER_DATASET),
                        ctx.db
                            .query("evalRuns")
                            .withIndex("by_dataset_and_createdAt", (q) => q.eq("datasetId", dataset._id))
                            .order("desc")
                            .take(EXPORT_RUNS_PER_DATASET),
                    ]);

                    const withResults = await Promise.all(
                        runs.map(async ({ caseIds: _caseIds, ...run }) => {
                            const results = await ctx.db
                                .query("evalResults")
                                .withIndex("by_run_and_index", (q) => q.eq("runId", run._id))
                                .take(MAX_CASES_PER_DATASET);

                            return { ...run, results };
                        }),
                    );

                    return { ...dataset, cases, runs: withResults };
                }),
            ),
        };
    });

export const deleteUserEvals = internalMutation
    .input({ userId: v.string() })
    .output(v.object({ hasMore: v.boolean() }))
    .mutation(async ({ args: { userId }, ctx }) => {
        const [results, runs, cases, datasets] = await Promise.all([
            ctx.db
                .query("evalResults")
                .withIndex("by_user", (q) => q.eq("userId", userId))
                .take(BATCH),
            ctx.db
                .query("evalRuns")
                .withIndex("by_user_and_status", (q) => q.eq("userId", userId))
                .take(BATCH),
            ctx.db
                .query("evalCases")
                .withIndex("by_user", (q) => q.eq("userId", userId))
                .take(BATCH),
            ctx.db
                .query("evalDatasets")
                .withIndex("by_user_and_updatedAt", (q) => q.eq("userId", userId))
                .take(BATCH),
        ]);

        await Promise.all([...results, ...runs, ...cases, ...datasets].map((row) => ctx.db.delete(row._id)));

        return { hasMore: [results, runs, cases, datasets].some((rows) => rows.length >= BATCH) };
    });
