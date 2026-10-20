import { MODEL_LOOKUP } from "@neore/ai/models";
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
import { findNextCronTime, isHourlyOrSlowerCronExpression } from "./schedule";
import { deleteShardRoute, setShardRoute } from "../lib/shard-routes";
import { noteShardDue } from "../lib/shard-housekeeping";
import { notifyQuietly } from "../notifications/notify";
import { MAX_LENGTH } from "../lib/validators";
import { chargeRound, DAILY_LIMIT_MESSAGE, loadTaskAccount, taskAccessProblem } from "../tasks/account";
import { isTaskModelAllowed } from "../tasks/logic";

const triggerTypeSchema = v.union(v.literal("schedule"), v.literal("webhook"), v.literal("event"));

/**
 * A schedule must be a 5-field cron that fires at most hourly. An unchecked
 * expression fires every minute (`getNextCronTime` reads garbage as a wildcard),
 * and each run is a paid agent turn.
 */
const assertCronExpression = (cronExpression: string): void => {
    if (!isHourlyOrSlowerCronExpression(cronExpression)) {
        throw new LunoraError("BAD_REQUEST", 'Schedule must be a 5-field cron expression (UTC) that runs at most hourly, e.g. "0 9 * * 1"');
    }
};

/**
 * The first run of a schedule trigger that has never run. Nothing else sets
 * `nextTriggerAt` before the first run, and the due query only matches a set
 * value, so an enabled trigger without one never fired. `undefined` when there is
 * no such run: it is never stored as a due time.
 */
const firstRunOf = (trigger: Doc<"triggers">, now: number): number | undefined =>
    trigger.type === "schedule" && trigger.cronExpression && trigger.nextTriggerAt === undefined ? findNextCronTime(trigger.cronExpression, now) : undefined;

/**
 * A routine may use its bot's computer only when it has a bot and runs on a
 * schedule. A webhook payload is untrusted input, so it never drives a shell.
 */
export const assertComputerRoutine = (routine: { botComputer: boolean; botId: string | undefined; type: Doc<"triggers">["type"] }): void => {
    if (!routine.botComputer) {
        return;
    }

    if (!routine.botId) {
        throw new LunoraError("INVALID_ARGUMENT", "Only a routine with a bot can use the bot's computer.");
    }

    if (routine.type !== "schedule") {
        throw new LunoraError("INVALID_ARGUMENT", "Only a scheduled routine can use the bot's computer.");
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
        botComputer: v.boolean(),
        botId: v.union(v.string(), v.null()),
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
            botComputer: t.botComputer === true,
            botId: t.botId ?? null,
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
        botComputer: v.optional(v.boolean()),
        botId: v.optional(v.string().max(MAX_LENGTH.id)),
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
        const { now } = context;

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

        // A routine can only name a bot the caller owns; a foreign id is a refusal, not a silent plain routine.
        if (args.botId && !(await context.runQuery(internal.bots.functions.getBotForRun, { botId: args.botId, userId }))) {
            throw new LunoraError("NOT_FOUND", "Bot not found");
        }

        assertComputerRoutine({ botComputer: args.botComputer === true, botId: args.botId, type: triggerType });

        const inserted = await context.db.insert("triggers", {
            botComputer: args.botComputer === true ? true : undefined,
            botId: args.botId as Id<"bots"> | undefined,
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
        botComputer: v.optional(v.boolean()),
        // `null` clears the bot; `undefined` leaves it as it is.
        botId: v.optional(v.union(v.string().max(MAX_LENGTH.id), v.null())),
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

        // A new schedule moves the next run; the old time would fire once more on the old schedule.
        const nextTriggerAt = args.cronExpression === undefined ? trigger.nextTriggerAt : findNextCronTime(args.cronExpression, context.now);

        if (args.cronExpression !== undefined) {
            assertCronExpression(args.cronExpression);
            patch.cronExpression = args.cronExpression;

            if (trigger.enabled === true && trigger.type === "schedule" && nextTriggerAt === undefined) {
                throw new LunoraError("BAD_REQUEST", "This schedule never fires within the next 28 years. Check its day and month.");
            }
        }

        if (args.timezone !== undefined) patch.timezone = args.timezone;

        if (args.inputTemplate !== undefined) patch.inputTemplate = args.inputTemplate;

        // Clearing the bot clears its computer flag too: a routine without a bot has no computer.
        const nextBotId = args.botId === undefined ? trigger.botId : (args.botId ?? undefined);
        // A different bot starts without the computer permission the previous bot had: the owner grants it again.
        const botChanged = args.botId !== undefined && args.botId !== trigger.botId;
        const keptComputer = botChanged ? undefined : trigger.botComputer;
        const nextComputer = nextBotId === undefined ? undefined : (args.botComputer ?? keptComputer);

        // An unchanged bot is not re-checked, so a routine whose bot was deleted stays editable.
        if (args.botId && args.botId !== trigger.botId && !(await context.runQuery(internal.bots.functions.getBotForRun, { botId: args.botId, userId }))) {
            throw new LunoraError("NOT_FOUND", "Bot not found");
        }

        assertComputerRoutine({ botComputer: nextComputer === true, botId: nextBotId, type: trigger.type });

        // `patchRow` removes a field set to `undefined`, which a plain patch cannot do.
        await patchRow(context.db, trigger, {
            ...withoutUndefined(patch),
            // `undefined` removes a stale time; enabling recomputes it (`firstRunOf`).
            ...(args.cronExpression !== undefined && { nextTriggerAt }),
            ...(args.botId !== undefined && { botId: nextBotId }),
            ...((args.botId !== undefined || args.botComputer !== undefined) && { botComputer: nextComputer === true ? true : undefined }),
        });

        if (trigger.enabled === true) {
            // The root tick only visits shards with timed work due (`lib/shard-housekeeping.ts`).
            await noteShardDue(context, nextTriggerAt ?? context.now, userId);
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

        // Enabling re-checks the schedule: one stored before the hourly rule, or one
        // that never fires, must not be armed (see the policy in `checkDueTriggers`).
        if (args.enabled && trigger.type === "schedule" && trigger.cronExpression) {
            assertCronExpression(trigger.cronExpression);
        }

        const firstRun = args.enabled ? firstRunOf(trigger, context.now) : undefined;

        if (args.enabled && trigger.type === "schedule" && trigger.nextTriggerAt === undefined && firstRun === undefined) {
            throw new LunoraError("BAD_REQUEST", "This schedule never fires within the next 28 years. Check its day and month.");
        }

        await context.db.patch(args.triggerId as Id<"triggers">, {
            enabled: args.enabled,
            updatedAt: context.now,
            ...(firstRun !== undefined && { nextTriggerAt: firstRun }),
        });

        if (args.enabled) {
            // The root tick only visits shards with timed work due (`lib/shard-housekeeping.ts`).
            await noteShardDue(context, firstRun ?? trigger.nextTriggerAt ?? context.now, userId);
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

        const wasEnabled = trigger.enabled === true;
        const payload = args.testPayload || trigger.inputTemplate || "Manual test run triggered.";

        // The run reads the trigger only when it starts, after this action has returned, so it is told to run a disabled one.
        await context.scheduler.runAfter(0, internal.triggers.execute.executeTrigger, {
            ignoreDisabled: true,
            payload,
            triggerId: args.triggerId as Id<"triggers">,
        });

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

/**
 * Charges one run before the paid call. A trigger draws on the same daily
 * task-run quota and model allowlist as a task round (`tasks/internal.ts`), so a
 * schedule cannot run more agent turns than a task can. Returns the refusal
 * reason, or `null` when the run may go ahead.
 */
export const admitTriggerRun = internalMutation
    .input({ triggerId: v.id("triggers") })
    .output(v.union(v.null(), v.string()))
    .mutation(async ({ args: { triggerId }, ctx }) => {
        const trigger = await ctx.db.get(triggerId);

        if (!trigger) {
            return "Trigger not found";
        }

        const account = await loadTaskAccount(ctx, trigger.userId);
        const problem = taskAccessProblem(account);

        if (problem || !account) {
            return problem ?? "Your account no longer exists.";
        }

        const { DEFAULT_CHAT_MODEL } = await import("@neore/ai/constants");
        // The model the run uses (`execute.ts`): a bot's current model first, so the check and the run agree.
        const bot = trigger.botId ? await ctx.db.get(trigger.botId) : null;
        const model = bot?.model || trigger.model || DEFAULT_CHAT_MODEL;

        if (!isTaskModelAllowed(model, (id) => MODEL_LOOKUP.get(id))) {
            return `The model '${model}' is no longer available for triggers. Pick another model and enable the trigger again.`;
        }

        if (!(await chargeRound(ctx, trigger.userId, account))) {
            return DAILY_LIMIT_MESSAGE;
        }

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
                    emailOutcome: Boolean(threadId),
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
        const firstRun = enabled && trigger ? firstRunOf(trigger, ctx.now) : undefined;

        await ctx.db.patch(triggerId, { enabled, updatedAt: ctx.now, ...(firstRun !== undefined && { nextTriggerAt: firstRun }) });

        if (enabled && trigger) {
            await noteShardDue(ctx, firstRun ?? trigger.nextTriggerAt ?? ctx.now, trigger.userId);
        }

        return null;
    });
