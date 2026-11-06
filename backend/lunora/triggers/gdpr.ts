/**
 * The triggers module's erasure for account deletion (called by
 * `gdpr/steps/residual-deletion-steps.ts`), and its GDPR export (`collectTriggersForExport`,
 * "collect-triggers" in `gdpr/workflows/export-workflow.ts`). Erasure is a plain function over the caller's
 * `ctx`; batching follows `gdpr/batch.ts`.
 */
import { v } from "lunorash/server";

import { internalQuery, type MutationCtx } from "../_generated/server";
import { BATCH, type BatchResult, full } from "../gdpr/batch";

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

/** Triggers in the export, the newest first. A longer list is kept in the app, not exported in full. */
const EXPORT_TRIGGERS_PER_USER = 50;
/** Runs per trigger in the export, the newest; older runs are history (the same bound as the evals export). */
const EXPORT_RUNS_PER_TRIGGER = 20;

/**
 * The user's triggers, their settings and their newest runs with the prompts those runs were given (`executeTrigger`).
 * The webhook secrets are left out. A prompt is cleared 30 days after its run settles (`pruneExpiredRunPrompts`), so the
 * export holds what is still kept.
 */
export const collectTriggersForExport = internalQuery
    .input({ userId: v.string() })
    .output(v.object({ triggers: v.array(v.any()) }))
    .query(async ({ args: { userId }, ctx }) => {
        const triggers = await ctx.db
            .query("triggers")
            .withIndex("by_userId_organizationId", (q) => q.eq("userId", userId))
            .order("desc")
            .take(EXPORT_TRIGGERS_PER_USER);

        return {
            triggers: await Promise.all(
                triggers.map(async (trigger) => {
                    const runs = await ctx.db
                        .query("triggerExecutions")
                        .withIndex("by_triggerId_startedAt", (q) => q.eq("triggerId", trigger._id))
                        .order("desc")
                        .take(EXPORT_RUNS_PER_TRIGGER);

                    return {
                        createdAt: trigger.createdAt,
                        cronExpression: trigger.cronExpression,
                        description: trigger.description,
                        enabled: trigger.enabled,
                        eventSource: trigger.eventSource,
                        filters: trigger.filters,
                        inputTemplate: trigger.inputTemplate,
                        model: trigger.model,
                        name: trigger.name,
                        runs: runs.map((run) => {
                            return {
                                completedAt: run.completedAt ?? null,
                                error: run.error ?? null,
                                prompt: run.prompt ?? null,
                                startedAt: run.startedAt,
                                status: run.status,
                                threadId: run.threadId ?? null,
                            };
                        }),
                        systemPrompt: trigger.systemPrompt,
                        timezone: trigger.timezone,
                        type: trigger.type,
                        webhookSignatureScheme: trigger.webhookSignatureScheme ?? null,
                    };
                }),
            ),
        };
    });
