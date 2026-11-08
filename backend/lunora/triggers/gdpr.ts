/**
 * The triggers module's erasure for account deletion (called by
 * `gdpr/steps/residual-deletion-steps.ts`), and the pages of its GDPR export (`collectTriggersForExport` and
 * `collectTriggerRunsForExport`, read by `collectAllTriggers` inside the export action `generateExportFile`). Erasure is a
 * plain function over the caller's `ctx`; batching follows `gdpr/batch.ts`.
 */
import { v } from "lunorash/server";

import { internalQuery, type MutationCtx } from "../_generated/server";
import { BATCH, type BatchResult, full } from "../gdpr/batch";
import { MAX_LENGTH } from "../lib/validators";
import { MAX_PAYLOAD_LENGTH } from "./webhook-template";

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

/** Triggers per export page; a page holds settings only, so it stays small. */
const EXPORT_TRIGGER_PAGE = 50;

/**
 * Runs per export page, the newest first. A query reads each run row whole, and a run can hold a webhook body of up to
 * 1 MiB, so a page stays inside a transaction's read limit.
 */
const EXPORT_RUN_PAGE = 20;

/** One page of the user's triggers and their settings, without runs (`collectTriggerRunsForExport`). Secrets are left out. */
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
            triggers: page.page.map((trigger) => {
                return {
                    botComputer: trigger.botComputer ?? null,
                    botId: trigger.botId ?? null,
                    createdAt: trigger.createdAt,
                    cronExpression: trigger.cronExpression,
                    description: trigger.description,
                    enabled: trigger.enabled,
                    eventSource: trigger.eventSource,
                    eventState: trigger.eventState ?? null,
                    filters: trigger.filters,
                    id: trigger._id as string,
                    inputTemplate: trigger.inputTemplate,
                    lastError: trigger.lastError ?? null,
                    model: trigger.model,
                    name: trigger.name,
                    quietWhenEmpty: trigger.quietWhenEmpty ?? null,
                    searchMode: trigger.searchMode ?? null,
                    systemPrompt: trigger.systemPrompt,
                    timezone: trigger.timezone,
                    type: trigger.type,
                    webhookSignatureScheme: trigger.webhookSignatureScheme ?? null,
                };
            }),
        };
    });

/**
 * One page of a trigger's runs, the newest first, with the prompt and the webhook body each was given (`executeTrigger`). A
 * body is cut to the length a prompt frames (`MAX_PAYLOAD_LENGTH`) and marked when cut. A prompt is cleared 28 days after
 * its run settles (`pruneExpiredRunPrompts`), so the export holds what is still kept. Only the owner's trigger is read.
 */
export const collectTriggerRunsForExport = internalQuery
    .input({
        cursor: v.optional(v.union(v.string().max(MAX_LENGTH.cursor), v.null())),
        // One run is enough to say whether a trigger has any; a page of runs can hold up to 1 MiB of webhook body each.
        onlyOne: v.optional(v.boolean()),
        triggerId: v.id("triggers"),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.object({ cursor: v.union(v.string(), v.null()), runs: v.array(v.any()) }))
    .query(async ({ args: { cursor, onlyOne, triggerId, userId }, ctx }) => {
        const trigger = await ctx.db.get("triggers", triggerId);

        if (!trigger || trigger.userId !== userId) {
            return { cursor: null, runs: [] };
        }

        const page = await ctx.db
            .query("triggerExecutions")
            .withIndex("by_triggerId_startedAt", (q) => q.eq("triggerId", triggerId))
            .order("desc")
            .paginate({ cursor: cursor ?? null, numItems: onlyOne === true ? 1 : EXPORT_RUN_PAGE });

        return {
            cursor: page.isDone ? null : page.continueCursor,
            runs: page.page.map((run) => {
                const payload = run.payload ?? null;

                return {
                    completedAt: run.completedAt ?? null,
                    error: run.error ?? null,
                    payload: payload === null ? null : payload.slice(0, MAX_PAYLOAD_LENGTH),
                    payloadTruncated: payload !== null && payload.length > MAX_PAYLOAD_LENGTH,
                    prompt: run.prompt ?? null,
                    startedAt: run.startedAt,
                    status: run.status,
                    threadId: run.threadId ?? null,
                };
            }),
        };
    });
