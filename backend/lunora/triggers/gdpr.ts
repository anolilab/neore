/**
 * The triggers module's erasure for account deletion (called by
 * `gdpr/steps/residual-deletion-steps.ts`), and its GDPR export (`collectTriggersForExport`,
 * "collect-triggers" in `gdpr/workflows/export-workflow.ts`). Erasure is a plain function over the caller's
 * `ctx`; batching follows `gdpr/batch.ts`.
 */
import { v } from "lunorash/server";

import { internalQuery, type MutationCtx } from "../_generated/server";
import { BATCH, type BatchResult, full } from "../gdpr/batch";
import { MAX_LENGTH } from "../lib/validators";

/** Triggers with their run history. A trigger whose history is longer than one batch stays for the next round. */
export const eraseTriggersForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const triggers = await ctx.db
        .query("triggers")
        .withIndex("by_userId_organizationId", (q) => q.eq("userId", userId))
        .take(BATCH);

    let hasMore = false;

    for (const trigger of triggers) {
        const executions = await ctx.db
            .query("triggerExecutions")
            .withIndex("by_triggerId_startedAt", (q) => q.eq("triggerId", trigger._id))
            .take(BATCH);

        await Promise.all(executions.map((row) => ctx.db.delete("triggerExecutions", row._id)));

        if (full(executions)) {
            hasMore = true;
            continue;
        }

        await ctx.db.delete("triggers", trigger._id);
    }

    return { hasMore: hasMore || full(triggers) };
};

/**
 * Triggers per export page: one. A query reads each run row whole, and a run can hold a webhook body of up to 1 MiB, so one
 * trigger's `EXPORT_RUNS_PER_TRIGGER` newest runs stay inside a transaction's read limit. Each page is one workflow step.
 */
const EXPORT_TRIGGER_PAGE = 1;
/** Runs per trigger in the export, the newest; older runs are history (the same bound as the evals export). */
const EXPORT_RUNS_PER_TRIGGER = 20;

/**
 * One page of the user's triggers, their settings and their newest runs with the prompts and webhook bodies those runs were given
 * (`executeTrigger`). The webhook secrets are left out. A prompt is cleared 30 days after its run settles
 * (`pruneExpiredRunPrompts`), so the export holds what is still kept. `cursor` is `null` on the last page.
 */
export const collectTriggersForExport = internalQuery
    .input({
        cursor: v.optional(v.union(v.string().max(MAX_LENGTH.cursor), v.null())),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.object({ cursor: v.union(v.string(), v.null()), triggers: v.array(v.any()) }))
    .query(async ({ args: { cursor, userId }, ctx }) => {
        const page = await ctx.db
            .query("triggers")
            .withIndex("by_userId_organizationId", (q) => q.eq("userId", userId))
            .paginate({ cursor: cursor ?? null, numItems: EXPORT_TRIGGER_PAGE });

        return {
            cursor: page.isDone ? null : page.continueCursor,
            triggers: await Promise.all(
                page.page.map(async (trigger) => {
                    const runs = await ctx.db
                        .query("triggerExecutions")
                        .withIndex("by_triggerId_startedAt", (q) => q.eq("triggerId", trigger._id))
                        .order("desc")
                        .take(EXPORT_RUNS_PER_TRIGGER);

                    return {
                        botComputer: trigger.botComputer ?? null,
                        botId: trigger.botId ?? null,
                        createdAt: trigger.createdAt,
                        cronExpression: trigger.cronExpression,
                        description: trigger.description,
                        enabled: trigger.enabled,
                        eventSource: trigger.eventSource,
                        filters: trigger.filters,
                        inputTemplate: trigger.inputTemplate,
                        model: trigger.model,
                        name: trigger.name,
                        quietWhenEmpty: trigger.quietWhenEmpty ?? null,
                        runs: runs.map((run) => {
                            return {
                                completedAt: run.completedAt ?? null,
                                error: run.error ?? null,
                                payload: run.payload ?? null,
                                prompt: run.prompt ?? null,
                                startedAt: run.startedAt,
                                status: run.status,
                                threadId: run.threadId ?? null,
                            };
                        }),
                        searchMode: trigger.searchMode ?? null,
                        systemPrompt: trigger.systemPrompt,
                        timezone: trigger.timezone,
                        type: trigger.type,
                        webhookSignatureScheme: trigger.webhookSignatureScheme ?? null,
                    };
                }),
            ),
        };
    });
