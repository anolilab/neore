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
import { MAX_PAYLOAD_LENGTH, sliceUnits } from "./webhook-template";

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
 * Triggers per export page. A page holds settings only, but a trigger's system prompt and Input Template may each hold 2
 * million characters (`MAX_LENGTH.document`): two whole triggers stay under one query's 32 MiB read limit even at three
 * bytes a character.
 */
const EXPORT_TRIGGER_PAGE = 2;

/**
 * Runs per export page, the newest first. A query reads each run row whole, and a run can hold a webhook body of up to
 * 1 MiB, so a page stays inside a transaction's read limit.
 */
const EXPORT_RUN_PAGE = 5;

const withoutPendingPayload = <T extends { pendingRun?: object }>(state: T): T =>
    state.pendingRun === undefined ? state : { ...state, pendingRun: { ...state.pendingRun, payload: undefined } };

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
                    enabledAt: trigger.enabledAt ?? null,
                    eventSource: trigger.eventSource,
                    // A pending run's payload can quote a watched thread the owner may no longer have access to: it stays out.
                    eventState: trigger.eventState ? withoutPendingPayload(trigger.eventState) : null,
                    failureStreak: trigger.failureStreak ?? 0,
                    filters: trigger.filters,
                    id: trigger._id as string,
                    inputTemplate: trigger.inputTemplate,
                    lastError: trigger.lastError ?? null,
                    lastSuccessStartedAt: trigger.lastSuccessStartedAt ?? null,
                    lastTriggeredAt: trigger.lastTriggeredAt ?? null,
                    model: trigger.model,
                    name: trigger.name,
                    nextTriggerAt: trigger.nextTriggerAt ?? null,
                    quietWhenEmpty: trigger.quietWhenEmpty ?? null,
                    searchMode: trigger.searchMode ?? null,
                    systemPrompt: trigger.systemPrompt,
                    timezone: trigger.timezone,
                    triggerCount: trigger.triggerCount ?? 0,
                    type: trigger.type,
                    updatedAt: trigger.updatedAt ?? null,
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
        triggerId: v.id("triggers"),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.object({ cursor: v.union(v.string(), v.null()), readBytes: v.number(), runs: v.array(v.any()) }))
    .query(async ({ args: { cursor, triggerId, userId }, ctx }) => {
        const trigger = await ctx.db.get("triggers", triggerId);

        if (!trigger || trigger.userId !== userId) {
            return { cursor: null, readBytes: 0, runs: [] };
        }

        const page = await ctx.db
            .query("triggerExecutions")
            .withIndex("by_triggerId_startedAt", (q) => q.eq("triggerId", triggerId))
            .order("desc")
            .paginate({ cursor: cursor ?? null, numItems: EXPORT_RUN_PAGE });

        return {
            cursor: page.isDone ? null : page.continueCursor,
            // What this page read, whole rows included: the export action's queries share one read budget.
            readBytes: page.page.reduce((sum, run) => sum + new TextEncoder().encode(JSON.stringify(run)).byteLength, 0),
            runs: page.page.map((run) => {
                const payload = run.payload ?? null;

                return {
                    completedAt: run.completedAt ?? null,
                    error: run.error ?? null,
                    // Cut on a code point, so an emoji at the boundary is kept whole or left out, never halved.
                    payload: payload === null ? null : sliceUnits(payload, MAX_PAYLOAD_LENGTH),
                    payloadTruncated: payload !== null && payload.length > MAX_PAYLOAD_LENGTH,
                    prompt: run.prompt ?? null,
                    startedAt: run.startedAt,
                    status: run.status,
                    threadId: run.threadId ?? null,
                };
            }),
        };
    });
