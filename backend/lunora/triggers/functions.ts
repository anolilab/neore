import type { Infer } from "lunorash/server";

/**
 * Trigger CRUD functions.
 *
 * Exposed via cRPC for the frontend trigger settings page. Handles creating,
 * listing, updating, enabling/disabling, and deleting triggers.
 *
 * Internal functions are used by the schedule provider and webhook handler.
 */
import { LunoraError } from "lunorash/server";
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { authAction, authMutation, authQuery, rateLimit } from "../lib/crpc";
import { encryptKey } from "../lib/encryption";
import { patchRow, withoutUndefined } from "../lib/patch";
import { isValidCronExpression } from "./schedule";
import { deleteShardRoute, setShardRoute } from "../lib/shard-routes";
import { noteShardDue } from "../lib/shard-housekeeping";
import { notifyQuietly } from "../notifications/notify";
import { MAX_LENGTH } from "../lib/validators";

const triggerTypeSchema = v.union(v.literal("schedule"), v.literal("webhook"), v.literal("event"));

/** `getNextCronTime` reads garbage as a wildcard, so an unchecked expression would fire every minute. */
const assertCronExpression = (cronExpression: string): void => {
    if (!isValidCronExpression(cronExpression)) {
        throw new LunoraError("BAD_REQUEST", 'Schedule must be a 5-field cron expression (UTC), e.g. "0 9 * * 1"');
    }
};

// ============================================================================
// cRPC-exposed queries/mutations (authenticated)
// ============================================================================

/** List all triggers for the current user */
const vGetTriggersOutput = v.array(
    v.object({
        _creationTime: v.number(),
        _id: v.string(),
        createdAt: v.number(),
        cronExpression: v.union(v.string(), v.null()),
        description: v.union(v.string(), v.null()),
        enabled: v.boolean(),
        inputTemplate: v.union(v.string(), v.null()),
        lastError: v.union(v.string(), v.null()),
        lastTriggeredAt: v.union(v.number(), v.null()),
        model: v.string(),
        name: v.string(),
        nextTriggerAt: v.union(v.number(), v.null()),
        searchMode: v.union(v.string(), v.null()),
        systemPrompt: v.union(v.string(), v.null()),
        timezone: v.union(v.string(), v.null()),
        triggerCount: v.number(),
        type: v.string(),
        updatedAt: v.number(),
    }),
);

export const getTriggers = authQuery.output(v.from(vGetTriggersOutput)).query(async ({ ctx: context }): Promise<Infer<typeof vGetTriggersOutput>> => {
    const { userId } = context.user;

    const userTriggers = await context.db
        .query("triggers")
        .withIndex("by_userId_organizationId", (q) => q.eq("userId", userId))
        .collect();

    return userTriggers.map((t) => {
        return {
            _creationTime: t._creationTime,
            _id: t._id as string,
            createdAt: t.createdAt,
            cronExpression: t.cronExpression ?? null,
            description: t.description ?? null,
            enabled: t.enabled === true,
            inputTemplate: t.inputTemplate ?? null,
            lastError: t.lastError ?? null,
            lastTriggeredAt: t.lastTriggeredAt ?? null,
            model: t.model,
            name: t.name,
            nextTriggerAt: t.nextTriggerAt ?? null,
            searchMode: t.searchMode ?? null,
            systemPrompt: t.systemPrompt ?? null,
            timezone: t.timezone ?? null,
            triggerCount: t.triggerCount ?? 0,
            type: t.type,
            updatedAt: t.updatedAt,
        };
    });
});

/** Create a new trigger */
export const createTrigger = authMutation
    .use(rateLimit("triggers/create"))
    .input({
        cronExpression: v.optional(v.string().max(MAX_LENGTH.short)),
        description: v.optional(v.string().max(MAX_LENGTH.long)),
        inputTemplate: v.optional(v.string().max(MAX_LENGTH.document)),
        model: v.string().max(MAX_LENGTH.short),
        name: v.string().max(MAX_LENGTH.short),
        searchMode: v.optional(v.string().max(MAX_LENGTH.short)),
        systemPrompt: v.optional(v.string().max(MAX_LENGTH.document)),
        timezone: v.optional(v.string().max(MAX_LENGTH.short)),
        type: v.from(triggerTypeSchema),
    })
    .output(v.object({ triggerId: v.string(), webhookSecret: v.optional(v.string()) }))
    .mutation(async ({ args, ctx: context }) => {
        const { userId } = context.user;
        const now = context.now;

        // `v.from(zodSchema)` surfaces the field as `unknown` on the args type, so
        // re-parse here to recover the `"schedule" | "webhook" | "event"` union the
        // `triggers` table declares.
        const triggerType = triggerTypeSchema.parse(args.type);

        if (args.cronExpression !== undefined || triggerType === "schedule") {
            assertCronExpression(args.cronExpression ?? "");
        }

        // Generate webhook secret for webhook triggers
        const plaintextSecret = triggerType === "webhook" ? crypto.randomUUID() : undefined;
        // Encrypt the secret before storing — only the encrypted form is persisted
        const webhookSecret = plaintextSecret ? await encryptKey(plaintextSecret, "tool-keys") : undefined;
        const inserted = await context.db.insert("triggers", {
            createdAt: now,
            cronExpression: args.cronExpression,
            description: args.description,
            enabled: false, // Start disabled — user must explicitly enable
            inputTemplate: args.inputTemplate,
            model: args.model,
            name: args.name,
            searchMode: args.searchMode,
            systemPrompt: args.systemPrompt,
            timezone: args.timezone,
            triggerCount: 0,
            type: triggerType,
            updatedAt: now,
            userId,
            webhookSecret,
        });

        // A webhook names only the trigger; this is how it finds the shard.
        await setShardRoute(context, "trigger", inserted as string, userId);
        // `db.insert` returns the branded id STRING, not a row and not an array. The
        // `Array.isArray(...)` narrowing produced an `any` branch, which is the only
        // reason `.id` compiled — at runtime it read `.id` off a string, so
        // `createTrigger` returned `{ triggerId: undefined }`. Fourth site with this
        // shape (see also workflow/presence, system-prompts, messenger).
        const triggerId = inserted;

        // Return the plaintext secret once so the user can configure their webhook sender.
        // It is never returned again — only the encrypted form is stored.
        context.log.event("triggers.create_trigger", { hasWebhookSecret: plaintextSecret !== undefined, type: triggerType });

        return {
            triggerId: triggerId as string,
            ...(plaintextSecret && { webhookSecret: plaintextSecret }),
        };
    });

/** Update an existing trigger */
export const updateTrigger = authMutation
    .use(rateLimit("triggers/update"))
    .input({
        cronExpression: v.optional(v.string().max(MAX_LENGTH.short)),
        description: v.optional(v.string().max(MAX_LENGTH.long)),
        inputTemplate: v.optional(v.string().max(MAX_LENGTH.document)),
        model: v.optional(v.string().max(MAX_LENGTH.short)),
        name: v.optional(v.string().max(MAX_LENGTH.short)),
        searchMode: v.optional(v.string().max(MAX_LENGTH.short)),
        systemPrompt: v.optional(v.string().max(MAX_LENGTH.document)),
        timezone: v.optional(v.string().max(MAX_LENGTH.short)),
        triggerId: v.id("triggers"),
    })
    .mutation(async ({ args, ctx: context }) => {
        const { userId } = context.user;
        const trigger = await context.db.get(args.triggerId as Id<"triggers">);

        if (!trigger || trigger.userId !== userId) {
            throw new LunoraError("NOT_FOUND", "Trigger not found");
        }

        const patch: {
            cronExpression?: string;
            description?: string;
            inputTemplate?: string;
            model?: string;
            name?: string;
            searchMode?: string;
            systemPrompt?: string;
            timezone?: string;
            updatedAt: number;
        } = { updatedAt: context.now };

        if (args.name !== undefined) patch.name = args.name;

        if (args.description !== undefined) patch.description = args.description;

        if (args.model !== undefined) patch.model = args.model;

        if (args.systemPrompt !== undefined) patch.systemPrompt = args.systemPrompt;

        if (args.searchMode !== undefined) patch.searchMode = args.searchMode;

        if (args.cronExpression !== undefined) {
            assertCronExpression(args.cronExpression);
            patch.cronExpression = args.cronExpression;
        }

        if (args.timezone !== undefined) patch.timezone = args.timezone;

        if (args.inputTemplate !== undefined) patch.inputTemplate = args.inputTemplate;

        await context.db.patch(args.triggerId as Id<"triggers">, withoutUndefined(patch));

        if (trigger.enabled === true) {
            // The root tick only visits shards with timed work due (`lib/shard-housekeeping.ts`).
            await noteShardDue(context, context.now, userId);
        }

        context.log.event("triggers.update_trigger", { enabled: trigger.enabled === true });
    });

/** Enable or disable a trigger */
export const setTriggerEnabled = authMutation
    .use(rateLimit("triggers/update"))
    .input({
        enabled: v.boolean(),
        triggerId: v.id("triggers"),
    })
    .mutation(async ({ args, ctx: context }) => {
        const { userId } = context.user;
        const trigger = await context.db.get(args.triggerId as Id<"triggers">);

        if (!trigger || trigger.userId !== userId) {
            throw new LunoraError("NOT_FOUND", "Trigger not found");
        }

        await context.db.patch(args.triggerId as Id<"triggers">, {
            enabled: args.enabled,
            updatedAt: context.now,
        });

        if (args.enabled) {
            // The root tick only visits shards with timed work due (`lib/shard-housekeeping.ts`).
            await noteShardDue(context, trigger.nextTriggerAt ?? context.now, userId);
        }

        context.log.event("triggers.set_trigger_enabled", { enabled: args.enabled });
    });

/** Delete a trigger */
export const deleteTrigger = authMutation
    .use(rateLimit("triggers/delete"))
    .input({
        triggerId: v.id("triggers"),
    })
    .mutation(async ({ args, ctx: context }) => {
        const { userId } = context.user;
        const trigger = await context.db.get(args.triggerId as Id<"triggers">);

        if (!trigger || trigger.userId !== userId) {
            throw new LunoraError("NOT_FOUND", "Trigger not found");
        }

        // Delete associated execution logs
        const executions = await context.db
            .query("triggerExecutions")
            .withIndex("by_triggerId_startedAt", (q) => q.eq("triggerId", args.triggerId as Id<"triggers">))
            .collect();

        // Its webhook replay claims (`lib/claim-once.ts`) expire on their own within minutes.
        await Promise.allSettled(executions.map((row) => context.db.delete(row._id)));

        // Delete the trigger
        await context.db.delete(args.triggerId as Id<"triggers">);
        await deleteShardRoute(context, "trigger", args.triggerId);

        context.log.event("triggers.delete_trigger", { executionsDeleted: executions.length });
    });

/** Get execution history for a trigger */
const vGetTriggerExecutionsOutput = v.array(
    v.object({
        _id: v.string(),
        completedAt: v.union(v.number(), v.null()),
        error: v.union(v.string(), v.null()),
        startedAt: v.number(),
        status: v.string(),
        threadId: v.union(v.string(), v.null()),
    }),
);

export const getTriggerExecutions = authQuery
    .input({
        limit: v.optional(v.number()),
        triggerId: v.id("triggers"),
    })
    .output(v.from(vGetTriggerExecutionsOutput))
    .query(async ({ args, ctx: context }): Promise<Infer<typeof vGetTriggerExecutionsOutput>> => {
        const { userId } = context.user;

        // Verify trigger ownership
        const trigger = await context.db.get(args.triggerId as Id<"triggers">);

        if (!trigger || trigger.userId !== userId) {
            throw new LunoraError("NOT_FOUND", "Trigger not found");
        }

        const executions = await context.db
            .query("triggerExecutions")
            .withIndex("by_triggerId_startedAt", (q) => q.eq("triggerId", args.triggerId as Id<"triggers">))
            .order("desc")
            .take(args.limit ?? 20);

        return executions.map((entry) => {
            return {
                _id: entry._id as string,
                completedAt: entry.completedAt ?? null,
                error: entry.error ?? null,
                startedAt: entry.startedAt,
                status: entry.status as string,
                threadId: entry.threadId ?? null,
            };
        });
    });

/** Manually execute a trigger for testing (does not require trigger to be enabled) */
export const testRunTrigger = authAction
    .use(rateLimit("triggers/create"))
    .input({
        testPayload: v.optional(v.string().max(MAX_LENGTH.document)),
        triggerId: v.id("triggers"),
    })
    .action(async ({ args, ctx: context }) => {
        const { userId } = context.user;

        // Verify trigger ownership
        const trigger = await context.runQuery(internal.triggers.functions.getTriggerInternal, {
            triggerId: args.triggerId as Id<"triggers">,
        });

        if (!trigger || trigger.userId !== userId) {
            throw new LunoraError("NOT_FOUND", "Trigger not found");
        }

        // Temporarily enable the trigger so executeTrigger doesn't bail
        const wasEnabled = trigger.enabled === true;

        if (!wasEnabled) {
            await context.runMutation(internal.triggers.functions.setTriggerEnabledInternal, {
                enabled: true,
                triggerId: args.triggerId as Id<"triggers">,
            });
        }

        try {
            const payload = args.testPayload || trigger.inputTemplate || "Manual test run triggered.";

            await context.scheduler.runAfter(0, internal.triggers.execute.executeTrigger, {
                payload,
                triggerId: args.triggerId as Id<"triggers">,
            });
        } finally {
            // Restore original enabled state
            if (!wasEnabled) {
                await context.runMutation(internal.triggers.functions.setTriggerEnabledInternal, {
                    enabled: false,
                    triggerId: args.triggerId as Id<"triggers">,
                });
            }
        }

        context.log.event("triggers.test_run_trigger", { wasEnabled });
    });

// ============================================================================
// Internal functions (used by trigger execution, cron job, webhook handler)
// ============================================================================

export const getTriggerInternal = internalQuery
    .input({ triggerId: v.id("triggers") })
    .query(async ({ args: { triggerId }, ctx }): Promise<Doc<"triggers"> | null> => await ctx.db.get(triggerId));

export const getDueScheduleTriggers = internalQuery
    .input({ now: v.number() })
    // `.output(v.any())` stays as the RUNTIME validator, but the annotation is
    // what consumers actually see: Lunora derives a FunctionReference's `Return`
    // from the handler, never from `.output()`. Without it `checkDueTriggers`
    // received untyped rows and read `cronExpression` / `inputTemplate` through
    // `as any` — on real columns, so the casts were noise, but the same shape
    // would have silently read `undefined` off a renamed field.
    .query(async ({ args: { now }, ctx }): Promise<Doc<"triggers">[]> => {
        // Get all enabled triggers with nextTriggerAt <= now
        const triggers = await ctx.db
            .query("triggers")
            .withIndex("by_enabled_nextTriggerAt", (q) => q.eq("enabled", true).lte("nextTriggerAt", now))
            .collect();

        // Filter to schedule type only
        return triggers.filter((t) => t.type === "schedule");
    });

export const updateTriggerStats = internalMutation
    .input({
        error: v.optional(v.string()),
        lastTriggeredAt: v.number(),
        nextTriggerAt: v.optional(v.number()),
        triggerId: v.id("triggers"),
    })
    .output(v.null())
    .mutation(async ({ args: { error, lastTriggeredAt, nextTriggerAt, triggerId }, ctx }) => {
        const trigger = await ctx.db.get(triggerId);

        if (!trigger) {
            return null;
        }

        // `lastError: undefined` REMOVES the field — a success clears the last
        // failure. A plain patch cannot express that: it refuses `undefined`,
        // and a `null` would fail every read through `getTriggers`' output.
        await patchRow(ctx.db, trigger, {
            lastError: error,
            lastTriggeredAt,
            triggerCount: (trigger.triggerCount ?? 0) + 1,
            updatedAt: ctx.now,
            ...withoutUndefined({ nextTriggerAt }),
        });

        return null;
    });

export const createExecution = internalMutation
    .input({
        payload: v.optional(v.string()),
        triggerId: v.id("triggers"),
    })
    .output(v.id("triggerExecutions"))
    .mutation(async ({ args: { payload, triggerId }, ctx }) => {
        const insertedId = await ctx.db.insert("triggerExecutions", {
            payload,
            startedAt: ctx.now,
            status: "running",
            triggerId,
        });

        return insertedId as Id<"triggerExecutions">;
    });

export const updateExecution = internalMutation
    .input({
        error: v.optional(v.string()),
        executionId: v.id("triggerExecutions"),
        status: v.string(),
        threadId: v.optional(v.string()),
    })
    .output(v.null())
    .mutation(async ({ args: { error, executionId, status, threadId }, ctx }) => {
        await ctx.db.patch(executionId, {
            status,
            ...(threadId && { threadId }),
            ...(error && { error }),
            completedAt: ctx.now,
        });

        if (status === "completed" || status === "failed") {
            const execution = await ctx.db.get(executionId);
            const trigger = execution ? await ctx.db.get(execution.triggerId) : null;

            if (trigger) {
                await notifyQuietly(ctx, {
                    dedupeKey: `trigger:${executionId}`,
                    link: threadId ? `/chat/${threadId}` : "/dashboard/settings/chat/triggers",
                    outcome: status === "completed" ? "success" : "failure",
                    title: trigger.name,
                    type: "trigger",
                    userId: trigger.userId,
                    ...(error && { body: error }),
                });
            }
        }

        return null;
    });

export const setTriggerEnabledInternal = internalMutation
    .input({
        enabled: v.boolean(),
        triggerId: v.id("triggers"),
    })
    .output(v.null())
    .mutation(async ({ args: { enabled, triggerId }, ctx }) => {
        const trigger = await ctx.db.get(triggerId);

        await ctx.db.patch(triggerId, { enabled, updatedAt: ctx.now });

        if (enabled && trigger) {
            await noteShardDue(ctx, trigger.nextTriggerAt ?? ctx.now, trigger.userId);
        }

        return null;
    });
