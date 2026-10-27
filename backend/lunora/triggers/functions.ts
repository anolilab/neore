import { MODEL_LOOKUP, parseCustomModelId } from "@neore/ai/models";
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
import type { MutationCtx } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";
import { authAction, authMutation, authQuery, rateLimit } from "../lib/crpc";
import { CLAIM_PREFIX_BATCH, releaseClaim, releaseClaimsWithPrefix, TRIGGER_DELIVERY_SCOPE } from "../lib/claim-once";
import { encryptKey } from "../lib/encryption";
import { patchRow, withoutUndefined } from "../lib/patch";
import type { PayloadFilter } from "./filters";
import { assertValidFilters, evaluateFilters, MAX_FILTER_VALUE_LENGTH, MAX_FILTERS, MAX_PATH_LENGTH, MAX_WEBHOOK_BODY_BYTES } from "./filters";
import type { WebhookPreset } from "./presets";
import { compileWebhookPreset } from "./presets";
import { canBeQuiet } from "./quiet";
import { resolveTimeZone } from "../memory/reflection-logic";
import { findNextCronTime, isHourlyOrSlowerCronExpression } from "./schedule";
import { deleteShardRoute, setShardRoute } from "../lib/shard-routes";
import { noteShardDue } from "../lib/shard-housekeeping";
import { notifyQuietly } from "../notifications/notify";
import { MAX_LENGTH } from "../lib/validators";
import { chargeRound, DAILY_LIMIT_MESSAGE, loadTaskAccount, taskAccessProblem } from "../tasks/account";
import { isTaskModelAllowed } from "../tasks/logic";
import type { WebhookSignatureScheme } from "./validators";
import { vWebhookSignatureScheme } from "./validators";

// "event" stays in the union because existing rows carry it; removing a member is a breaking schema change.
const triggerTypeSchema = v.union(v.literal("schedule"), v.literal("webhook"), v.literal("event"));

/**
 * A provider and one of its events: one object per provider, so a mismatched pair cannot be sent.
 * Written out because codegen reads the literals, not a table; the check below fails to compile when
 * this and `WEBHOOK_PRESETS` (`presets.ts`) drift apart.
 */
const vWebhookPreset = v.union(
    v.object({
        event: v.union(
            v.literal("pull_request_opened"),
            v.literal("pull_request_merged"),
            v.literal("pull_request_review_requested"),
            v.literal("issue_assigned"),
        ),
        provider: v.literal("github"),
    }),
    v.object({
        event: v.union(v.literal("merge_request_opened"), v.literal("merge_request_merged")),
        provider: v.literal("gitlab"),
    }),
);

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const presetValidatorMatchesTable: Equal<Infer<typeof vWebhookPreset>, WebhookPreset> = true;

// eslint-disable-next-line sonarjs/void-use -- type-level assertion; `void` only marks the binding as used.
void presetValidatorMatchesTable;

/** A `custom:<provider>/<model>` names one of the caller's own endpoints; a missing, disabled or browser-only one would fail every run. */
const assertCustomModelRunnable = async (context: Pick<MutationCtx, "runQuery">, model: string, userId: string): Promise<void> => {
    const custom = parseCustomModelId(model);

    if (custom && !(await context.runQuery(internal.chat.custom_providers.isCustomProviderRunnable, { providerId: custom.providerId, userId }))) {
        throw new LunoraError("INVALID_ARGUMENT", "That custom endpoint is missing, disabled or only reachable from your browser.");
    }
};

/** Nothing dispatches an event trigger, so one can be neither created nor edited. Existing rows stay readable and deletable. */
const assertTriggerTypeSupported = (type: "event" | "schedule" | "webhook"): void => {
    if (type === "event") {
        throw new LunoraError("BAD_REQUEST", "Event triggers are not supported yet. Use a schedule or a webhook trigger.");
    }
};

/**
 * A schedule must be a 5-field cron that fires at most hourly. An unchecked
 * expression fires every minute (`getNextCronTime` reads garbage as a wildcard),
 * and each run is a paid agent turn.
 */
const assertCronExpression = (cronExpression: string): void => {
    if (!isHourlyOrSlowerCronExpression(cronExpression)) {
        throw new LunoraError(
            "BAD_REQUEST",
            'Schedule must be a 5-field cron expression (read in the trigger time zone, UTC by default) that runs at most hourly, e.g. "0 9 * * 1"',
        );
    }
};

/**
 * A zone the scheduler would read as UTC (`resolveTimeZone`) is a typo here, not UTC:
 * the row would show the typed name beside a cron that runs in UTC.
 */
const assertTimeZone = (timeZone: string): void => {
    if (resolveTimeZone(timeZone) !== timeZone) {
        throw new LunoraError("BAD_REQUEST", "Unknown time zone");
    }
};

/**
 * The next run to arm when a schedule trigger is enabled. Nothing else sets `nextTriggerAt` before the
 * first run, and the due query only matches a set value, so an enabled trigger without one never fired.
 * A stored time already in the past is stale on the way from disabled to enabled: a disabled trigger keeps
 * whatever time it had, and enabling must not run it at once. An enabled trigger's due time is still live
 * (the tick has not run it yet), so it is kept. `undefined` when there is no such run: it is never stored as a due time.
 */
const firstRunOf = (trigger: Doc<"triggers">, now: number): number | undefined =>
    trigger.type === "schedule" && trigger.cronExpression && (trigger.nextTriggerAt === undefined || (trigger.enabled !== true && trigger.nextTriggerAt < now))
        ? findNextCronTime(trigger.cronExpression, now, trigger.timezone)
        : undefined;

/**
 * The filters to store: validated, webhook triggers only, and `undefined` for
 * none (an empty set is stored as no field, so the row stays as it was).
 */
const checkedFilters = (filters: PayloadFilter[] | undefined, type: Doc<"triggers">["type"]): PayloadFilter[] | undefined => {
    if (!filters || filters.length === 0) {
        return undefined;
    }

    if (type !== "webhook") {
        throw new LunoraError("INVALID_ARGUMENT", "Only a webhook trigger has payload filters.");
    }

    assertValidFilters(filters);

    return filters;
};

/**
 * The filters and signature scheme a new trigger is stored with, after every check
 * that belongs to the webhook-only arguments. A provider preset supplies both, so it
 * may not come with `filters`, and an explicit scheme must be the provider's: a
 * mismatch would verify the sender with the wrong credential. A webhook without a
 * preset is "timestamped" unless it names a scheme; other types store neither.
 */
const webhookSetup = (
    args: { filters?: PayloadFilter[]; webhookPreset?: WebhookPreset; webhookSignatureScheme?: WebhookSignatureScheme },
    type: Doc<"triggers">["type"],
): { filters: PayloadFilter[] | undefined; webhookSignatureScheme: WebhookSignatureScheme | undefined } => {
    if (type !== "webhook") {
        if (args.webhookSignatureScheme !== undefined) {
            throw new LunoraError("INVALID_ARGUMENT", "Only a webhook trigger has a signature scheme.");
        }

        if (args.webhookPreset) {
            throw new LunoraError("INVALID_ARGUMENT", "Only a webhook trigger has a provider preset.");
        }

        return { filters: checkedFilters(args.filters, type), webhookSignatureScheme: undefined };
    }

    if (!args.webhookPreset) {
        return { filters: checkedFilters(args.filters, type), webhookSignatureScheme: args.webhookSignatureScheme ?? "timestamped" };
    }

    if (args.filters && args.filters.length > 0) {
        throw new LunoraError("INVALID_ARGUMENT", "A provider preset sets its own filters. Leave the filters out.");
    }

    const compiled = compileWebhookPreset(args.webhookPreset);

    if (args.webhookSignatureScheme !== undefined && args.webhookSignatureScheme !== compiled.scheme) {
        throw new LunoraError("INVALID_ARGUMENT", "The signature scheme does not match the provider.");
    }

    return { filters: compiled.filters, webhookSignatureScheme: compiled.scheme };
};

/**
 * The options only a scheduled bot routine can have, checked on the state the
 * routine ends up in: its computer, and posting only when there is something to
 * report. A webhook payload is untrusted input, so it never drives a shell and
 * is never skipped. Both flags share one eligibility rule (`canBeQuiet`).
 */
export const assertBotRoutineOptions = (routine: {
    botComputer: boolean;
    botId: string | undefined;
    quietWhenEmpty: boolean;
    type: Doc<"triggers">["type"];
}): void => {
    for (const [requested, ability] of [
        [routine.botComputer, "use the bot's computer"],
        [routine.quietWhenEmpty, "be quiet when it has nothing to report"],
    ] as const) {
        if (requested && !canBeQuiet(routine)) {
            throw new LunoraError("INVALID_ARGUMENT", routine.botId ? `Only a scheduled routine can ${ability}.` : `Only a routine with a bot can ${ability}.`);
        }
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
        filters: v.array(
            v.object({
                op: v.union(
                    v.literal("equals"),
                    v.literal("not_equals"),
                    v.literal("contains"),
                    v.literal("starts_with"),
                    v.literal("exists"),
                    v.literal("not_exists"),
                ),
                path: v.string(),
                value: v.union(v.string(), v.null()),
            }),
        ),
        inputTemplate: v.union(v.string(), v.null()),
        lastError: v.union(v.string(), v.null()),
        lastTriggeredAt: v.union(v.number(), v.null()),
        model: v.string(),
        name: v.string(),
        nextTriggerAt: v.union(v.number(), v.null()),
        quietWhenEmpty: v.boolean(),
        searchMode: v.union(v.string(), v.null()),
        systemPrompt: v.union(v.string(), v.null()),
        timezone: v.union(v.string(), v.null()),
        triggerCount: v.number(),
        type: v.string(),
        updatedAt: v.number(),
        webhookSignatureScheme: v.union(vWebhookSignatureScheme, v.null()),
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
            filters: (t.filters ?? []).map((filter) => {
                return { op: filter.op, path: filter.path, value: filter.value ?? null };
            }),
            inputTemplate: t.inputTemplate ?? null,
            lastError: t.lastError ?? null,
            lastTriggeredAt: t.lastTriggeredAt ?? null,
            model: t.model,
            name: t.name,
            nextTriggerAt: t.nextTriggerAt ?? null,
            quietWhenEmpty: t.quietWhenEmpty === true,
            searchMode: t.searchMode ?? null,
            systemPrompt: t.systemPrompt ?? null,
            timezone: t.timezone ?? null,
            triggerCount: t.triggerCount ?? 0,
            type: t.type,
            updatedAt: t.updatedAt,
            webhookSignatureScheme: t.type === "webhook" ? (t.webhookSignatureScheme ?? "timestamped") : null,
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
        // Webhook triggers only. The whole set replaces the stored one; an empty array clears it.
        // At most MAX_FILTERS entries; `assertValidFilters` checks the rest of the grammar.
        filters: v.optional(
            v
                .array(
                    v.object({
                        op: v.union(
                            v.literal("equals"),
                            v.literal("not_equals"),
                            v.literal("contains"),
                            v.literal("starts_with"),
                            v.literal("exists"),
                            v.literal("not_exists"),
                        ),
                        path: v.string().max(MAX_PATH_LENGTH),
                        value: v.optional(v.string().max(MAX_FILTER_VALUE_LENGTH)),
                    }),
                )
                .check((value) => value.length <= MAX_FILTERS, { message: `at most ${String(MAX_FILTERS)} payload filters` }),
        ),
        inputTemplate: v.optional(v.string().max(MAX_LENGTH.document)),
        model: v.string().max(MAX_LENGTH.short),
        name: v.string().max(MAX_LENGTH.short),
        // Bot routines only. Skips a run that has nothing to report (`triggers/quiet.ts`); unset means off.
        quietWhenEmpty: v.optional(v.boolean()),
        searchMode: v.optional(v.string().max(MAX_LENGTH.short)),
        systemPrompt: v.optional(v.string().max(MAX_LENGTH.document)),
        timezone: v.optional(v.string().max(MAX_LENGTH.short)),
        type: v.from(triggerTypeSchema),
        // Webhook triggers only. Compiles to the event's filters and the provider's scheme; takes no `filters`.
        webhookPreset: v.optional(vWebhookPreset),
        // Webhook triggers only; unset means "timestamped". Fixed at creation, with the secret.
        webhookSignatureScheme: v.optional(vWebhookSignatureScheme),
    })
    .output(v.object({ triggerId: v.string(), webhookSecret: v.optional(v.string()) }))
    .mutation(async ({ args, ctx: context }) => {
        const { userId } = context.user;
        const { now } = context;

        // `v.from(zodSchema)` surfaces the field as `unknown` on the args type, so
        // re-parse here to recover the `"schedule" | "webhook" | "event"` union the
        // `triggers` table declares.
        const triggerType = triggerTypeSchema.parse(args.type);

        assertTriggerTypeSupported(triggerType);

        await assertCustomModelRunnable(context, args.model, userId);

        const timezone = args.timezone?.trim() || undefined;

        if (timezone !== undefined) assertTimeZone(timezone);

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

        assertBotRoutineOptions({ botComputer: args.botComputer === true, botId: args.botId, quietWhenEmpty: args.quietWhenEmpty === true, type: triggerType });

        const { filters, webhookSignatureScheme } = webhookSetup(args, triggerType);

        const inserted = await context.db.insert("triggers", {
            botComputer: args.botComputer === true ? true : undefined,
            botId: args.botId as Id<"bots"> | undefined,
            createdAt: now,
            cronExpression: args.cronExpression,
            description: args.description,
            enabled: false, // Start disabled — user must explicitly enable
            filters,
            inputTemplate: args.inputTemplate,
            model: args.model,
            name: args.name,
            quietWhenEmpty: args.quietWhenEmpty === true ? true : undefined,
            searchMode: args.searchMode,
            systemPrompt: args.systemPrompt,
            timezone,
            triggerCount: 0,
            type: triggerType,
            updatedAt: now,
            userId,
            webhookSecret,
            webhookSignatureScheme,
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
        // `null` clears the description; `undefined` leaves it as it is.
        description: v.optional(v.union(v.string().max(MAX_LENGTH.long), v.null())),
        // Webhook triggers only. The whole set replaces the stored one; an empty array clears it.
        // At most MAX_FILTERS entries; `assertValidFilters` checks the rest of the grammar.
        filters: v.optional(
            v
                .array(
                    v.object({
                        op: v.union(
                            v.literal("equals"),
                            v.literal("not_equals"),
                            v.literal("contains"),
                            v.literal("starts_with"),
                            v.literal("exists"),
                            v.literal("not_exists"),
                        ),
                        path: v.string().max(MAX_PATH_LENGTH),
                        value: v.optional(v.string().max(MAX_FILTER_VALUE_LENGTH)),
                    }),
                )
                .check((value) => value.length <= MAX_FILTERS, { message: `at most ${String(MAX_FILTERS)} payload filters` }),
        ),
        inputTemplate: v.optional(v.string().max(MAX_LENGTH.document)),
        model: v.optional(v.string().max(MAX_LENGTH.short)),
        name: v.optional(v.string().max(MAX_LENGTH.short)),
        quietWhenEmpty: v.optional(v.boolean()),
        // Set by callers that must not edit a live trigger (the public API): refused inside this transaction when the row is enabled.
        requireDisabled: v.optional(v.boolean()),
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

        assertTriggerTypeSupported(trigger.type);

        if (args.requireDisabled === true && trigger.enabled === true) {
            throw new LunoraError("CONFLICT", "The trigger is enabled. Disable it in the app before changing it.");
        }

        if (args.model !== undefined && args.model !== trigger.model) {
            await assertCustomModelRunnable(context, args.model, userId);
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

        if (args.description !== undefined && args.description !== null) patch.description = args.description;

        if (args.model !== undefined) patch.model = args.model;

        if (args.systemPrompt !== undefined) patch.systemPrompt = args.systemPrompt;

        if (args.searchMode !== undefined) patch.searchMode = args.searchMode;

        // Only a schedule has a next run. A new schedule, or a new time zone, moves it; the old time would fire once more on the old schedule.
        // A disabled schedule may store one too: enabling replaces it if it has passed (`firstRunOf`).
        // Re-saving the same expression and zone keeps a pending due time, so a run the tick has not taken yet still fires.
        // Zones are compared as the scheduler reads them (`resolveTimeZone`).
        // An absent or empty zone is no change.
        const isSchedule = trigger.type === "schedule";
        const storedZone = trigger.timezone;
        const requestedZone = args.timezone?.trim() || undefined;

        if (requestedZone !== undefined) assertTimeZone(requestedZone);

        const zoneChanged = requestedZone !== undefined && resolveTimeZone(requestedZone) !== resolveTimeZone(storedZone);
        const nextZone = zoneChanged ? requestedZone : storedZone;
        const nextCron = args.cronExpression ?? trigger.cronExpression;
        const cronChanged = args.cronExpression !== undefined && args.cronExpression !== trigger.cronExpression;
        let nextTriggerAt: number | undefined;

        if (isSchedule) {
            const touched = args.cronExpression !== undefined || zoneChanged;
            const kept = trigger.nextTriggerAt !== undefined && !cronChanged && !zoneChanged;
            const recomputed = touched && nextCron !== undefined ? findNextCronTime(nextCron, context.now, nextZone) : undefined;

            // A zone-only edit of a row whose stored expression no longer parses keeps its due time:
            // the tick switches such a schedule off with a reason, which dropping the time would hide.
            nextTriggerAt = !touched || kept || (!cronChanged && recomputed === undefined) ? trigger.nextTriggerAt : recomputed;
        }

        if (args.cronExpression !== undefined) {
            assertCronExpression(args.cronExpression);
            patch.cronExpression = args.cronExpression;

            if (trigger.enabled === true && isSchedule && nextTriggerAt === undefined) {
                throw new LunoraError("BAD_REQUEST", "This schedule never fires within the next 28 years. Check its day and month.");
            }
        }

        if (zoneChanged) {
            patch.timezone = requestedZone;
        }

        if (args.inputTemplate !== undefined) patch.inputTemplate = args.inputTemplate;

        // Clearing the bot clears its computer and quiet flags too: a routine without a bot has neither.
        const botCleared = args.botId === null;
        const nextBotId = args.botId === undefined ? trigger.botId : (args.botId ?? undefined);
        // A different bot starts without the computer permission the previous bot had: the owner grants it again.
        const botChanged = args.botId !== undefined && args.botId !== trigger.botId;
        // A routine that cannot have the flags (a webhook, or no bot) drops ones it still stores from before the rule, so an update that does not ask for them is never refused over them.
        // Only a request for `true` is refused (`assertBotRoutineOptions`); `false` always clears.
        const cannotHaveFlags = !canBeQuiet({ botId: nextBotId, type: trigger.type });
        const keptComputer = botChanged || cannotHaveFlags ? undefined : trigger.botComputer;
        const keptQuiet = cannotHaveFlags ? undefined : trigger.quietWhenEmpty;
        const nextComputer = botCleared ? undefined : (args.botComputer ?? keptComputer);
        const nextQuiet = botCleared ? undefined : (args.quietWhenEmpty ?? keptQuiet);

        // An unchanged bot is not re-checked, so a routine whose bot was deleted stays editable.
        if (args.botId && args.botId !== trigger.botId && !(await context.runQuery(internal.bots.functions.getBotForRun, { botId: args.botId, userId }))) {
            throw new LunoraError("NOT_FOUND", "Bot not found");
        }

        assertBotRoutineOptions({ botComputer: nextComputer === true, botId: nextBotId, quietWhenEmpty: nextQuiet === true, type: trigger.type });

        const filters = checkedFilters(args.filters, trigger.type);

        // `patchRow` removes a field set to `undefined`, which a plain patch cannot do.
        await patchRow(context.db, trigger, {
            ...withoutUndefined(patch),
            // `null` removes the description.
            ...(args.description === null && { description: undefined }),
            // `undefined` removes a stale time; enabling recomputes it (`firstRunOf`).
            // Also clears a time a non-schedule trigger stored before this check existed.
            ...((args.cronExpression !== undefined || zoneChanged || !isSchedule) && { nextTriggerAt }),
            ...(args.botId !== undefined && { botId: nextBotId }),
            // An empty array removes the filters; leaving the argument out leaves them as they are.
            ...(args.filters !== undefined && { filters }),
            ...((args.botId !== undefined || args.botComputer !== undefined || cannotHaveFlags) && { botComputer: nextComputer === true ? true : undefined }),
            ...((args.botId !== undefined || args.quietWhenEmpty !== undefined || cannotHaveFlags) && {
                quietWhenEmpty: nextQuiet === true ? true : undefined,
            }),
        });

        if (trigger.enabled === true && nextTriggerAt !== undefined) {
            // The root tick only visits shards with timed work due (`lib/shard-housekeeping.ts`).
            await noteShardDue(context, nextTriggerAt, userId);
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

        // Its webhook replay claims (`lib/claim-once.ts`) expire on their own within minutes, except a
        // `gitlab-token` trigger's delivery claims, which last for years: one batch is cleared here, the rest on the scheduler.
        await Promise.allSettled(executions.map((row) => context.db.delete(row._id)));

        // Delete the trigger
        await context.db.delete(args.triggerId as Id<"triggers">);

        const deliveryPrefix = `${args.triggerId}:`;

        if (await releaseClaimsWithPrefix(context, TRIGGER_DELIVERY_SCOPE, deliveryPrefix, CLAIM_PREFIX_BATCH)) {
            await context.scheduler.runAfter(0, internal.lib.claim_once.purgeClaimsWithPrefix, { prefix: deliveryPrefix, scope: TRIGGER_DELIVERY_SCOPE });
        }

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
        limit: v.optional(v.number().check((value) => Number.isSafeInteger(value) && value >= 1 && value <= 100, { message: "Invalid limit" })),
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
            // One row over the limit: a trigger keeps one filtered (skipped) row, so the extra one only covers a racing duplicate.
            .take((args.limit ?? 20) + 1);

        // At most one filtered row is shown (the newest), so misses never push real runs out of the list.
        let seenFiltered = false;
        const visible = executions.filter((entry) => {
            if (entry.status !== "filtered") {
                return true;
            }

            const keep = !seenFiltered;

            seenFiltered = true;

            return keep;
        });

        return visible.slice(0, args.limit ?? 20).map((entry) => {
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
        // A schedule's input is its template, so only a payload the user typed overrides it (`executeTrigger`).
        const payload = trigger.type === "schedule" ? args.testPayload : args.testPayload || trigger.inputTemplate || "Manual test run triggered.";

        // The run reads the trigger only when it starts, after this action has returned, so it is told to run a disabled one.
        // `manual`: a quiet routine posts a run the user asked for, whatever the workspace holds.
        await context.scheduler.runAfter(0, internal.triggers.execute.executeTrigger, {
            ignoreDisabled: true,
            manual: true,
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
        // When the run began its agent; a quiet routine omits it for a run that never created a thread (`quiet.ts`).
        lastTriggeredAt: v.optional(v.number()),
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
        // `lastTriggeredAt` only moves forward: a run that started earlier but finishes last (a long manual
        // "Run now" over a scheduled run) must not pull a quiet routine's window back over what was already reported.
        const advancesWindow = lastTriggeredAt !== undefined && lastTriggeredAt > (trigger.lastTriggeredAt ?? -Infinity);

        await patchRow(ctx.db, trigger, {
            lastError: error,
            triggerCount: (trigger.triggerCount ?? 0) + 1,
            updatedAt: ctx.now,
            ...withoutUndefined({ lastTriggeredAt: advancesWindow ? lastTriggeredAt : undefined, nextTriggerAt }),
        });

        return null;
    });

/**
 * Takes a quiet run's window: moves `lastTriggeredAt` from the value the run read (`expected`) to `windowStart`, and
 * says whether it did. Two overlapping runs read the same window, so only the first can move it; the other is
 * refused, instead of posting a second thread for the activity the first reports. A run that then posts nothing
 * gives it back with {@link releaseQuietWindow}.
 */
export const reserveQuietWindow = internalMutation
    .input({ expected: v.optional(v.number()), triggerId: v.id("triggers"), windowStart: v.number() })
    .output(v.boolean())
    .mutation(async ({ args: { expected, triggerId, windowStart }, ctx }) => {
        const trigger = await ctx.db.get(triggerId);

        if (!trigger || trigger.lastTriggeredAt !== expected) {
            return false;
        }

        await patchRow(ctx.db, trigger, { lastTriggeredAt: windowStart });

        return true;
    });

/**
 * Gives {@link reserveQuietWindow} back: moves the window to `expected` unless it is already earlier. A later run may
 * have moved it on in the meantime, and the activity this run did not post must still be in the next window; the
 * activity that run reported is then read twice, which is harmless where a missed one is not. Idempotent, so a retry
 * after a failed release is safe.
 */
export const releaseQuietWindow = internalMutation
    .input({ expected: v.optional(v.number()), triggerId: v.id("triggers") })
    .output(v.null())
    .mutation(async ({ args: { expected, triggerId }, ctx }) => {
        const trigger = await ctx.db.get(triggerId);

        if (trigger?.lastTriggeredAt !== undefined && (expected === undefined || expected < trigger.lastTriggeredAt)) {
            await patchRow(ctx.db, trigger, { lastTriggeredAt: expected });
        }

        return null;
    });

/** The write behind {@link recordFilteredExecution}: the trigger's ONE filtered (skipped) row, created or moved to the front. */
const recordFiltered = async (ctx: MutationCtx, triggerId: Id<"triggers">, reason: string): Promise<void> => {
    // The trigger may have been deleted after the run read it. Its
    // deletion cleared the history, so a row written now would outlive it.
    if (!(await ctx.db.get(triggerId))) {
        return;
    }

    const latest = await ctx.db
        .query("triggerExecutions")
        .withIndex("by_triggerId_status", (q) => q.eq("triggerId", triggerId).eq("status", "filtered"))
        .first();

    if (latest) {
        await patchRow(ctx.db, latest, { completedAt: ctx.now, error: reason, startedAt: ctx.now });

        return;
    }

    await ctx.db.insert("triggerExecutions", { completedAt: ctx.now, error: reason, startedAt: ctx.now, status: "filtered", triggerId });
};

/**
 * Gives a delivery's replay claim back. A short-lived claim left behind only makes a redelivery read as a replay
 * until its TTL, so a failure is logged and the refusal stands. A `permanent` one lasts for years: a failed
 * release throws, undoing this admission, so `executeTrigger` retries the release durably instead of losing it.
 */
const giveBackClaim = async (
    ctx: MutationCtx,
    claim: { claimedAt: number; key: string; scope: string },
    triggerId: Id<"triggers">,
    permanent: boolean,
): Promise<void> => {
    try {
        await releaseClaim(ctx, claim.scope, claim.key, claim.claimedAt);
    } catch (error) {
        if (permanent) {
            throw error;
        }

        console.error(`[Triggers] Could not release the replay claim of trigger ${triggerId}:`, error);
    }
};

/**
 * Charges one run before the paid call. A trigger draws on the same daily
 * task-run quota and model allowlist as a task round (`tasks/internal.ts`), so a
 * schedule cannot run more agent turns than a task can. Returns the refusal
 * reason, or `null` when the run may go ahead.
 *
 * A webhook delivery passes its body as `filterPayload`: the filters the webhook
 * handler checked may have been tightened since, so they are evaluated again here,
 * against the trigger as it is NOW and in the same mutation as the charge. A
 * delivery that no longer matches is recorded as filtered (replacing the running
 * row `executionId` names), is never charged, and answers `{ filtered }`.
 */
export const admitTriggerRun = internalMutation
    .input({
        // The webhook delivery's replay claim. A delivery refused here gives it back, as the handler does for one
        // that misses the filters, so the owner can fix them and redeliver the same signed body.
        claim: v.optional(v.object({ claimedAt: v.number(), key: v.string().max(MAX_LENGTH.key), scope: v.string().max(MAX_LENGTH.short) })),
        executionId: v.optional(v.id("triggerExecutions")),
        filterPayload: v.optional(v.string().max(MAX_WEBHOOK_BODY_BYTES)),
        // The claim is permanent (`gitlab-token`), so ANY refusal gives it back, not only a filter miss: a delivery that never ran may be redelivered.
        releaseUnlessRun: v.optional(v.boolean()),
        triggerId: v.id("triggers"),
    })
    .output(v.union(v.null(), v.string(), v.object({ filtered: v.string() })))
    .mutation(async ({ args: { claim, executionId, filterPayload, releaseUnlessRun, triggerId }, ctx }) => {
        const refused = async (reason: string): Promise<string> => {
            if (claim && releaseUnlessRun) {
                await giveBackClaim(ctx, claim, triggerId, true);
            }

            return reason;
        };
        const trigger = await ctx.db.get(triggerId);

        if (!trigger) {
            return await refused("Trigger not found");
        }

        if (filterPayload !== undefined) {
            const verdict = evaluateFilters(trigger.filters, filterPayload);

            if (!verdict.matched) {
                const reason = verdict.reason.slice(0, 500);

                await recordFiltered(ctx, triggerId, reason);

                const running = executionId ? await ctx.db.get(executionId) : null;

                if (running && running.triggerId === triggerId && running.status === "running") {
                    await ctx.db.delete(running._id);
                }

                if (claim) {
                    await giveBackClaim(ctx, claim, triggerId, releaseUnlessRun === true);
                }

                return { filtered: reason };
            }
        }

        const account = await loadTaskAccount(ctx, trigger.userId);
        const problem = taskAccessProblem(account);

        if (problem || !account) {
            return await refused(problem ?? "Your account no longer exists.");
        }

        const { DEFAULT_CHAT_MODEL } = await import("@neore/ai/constants");
        // The model the run uses (`execute.ts`): a bot's current model first, so the check and the run agree.
        const bot = trigger.botId ? await ctx.db.get(trigger.botId) : null;
        const model = bot?.model || trigger.model || DEFAULT_CHAT_MODEL;

        if (!isTaskModelAllowed(model, (id) => MODEL_LOOKUP.get(id))) {
            return await refused(`The model '${model}' is no longer available for triggers. Pick another model and enable the trigger again.`);
        }

        if (!(await chargeRound(ctx, trigger.userId, account))) {
            return await refused(DAILY_LIMIT_MESSAGE);
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

/**
 * Record a run that was skipped: a verified delivery that failed the trigger's
 * payload filters, or a quiet routine's scheduled run with nothing to report
 * (`quiet.ts`). It ran nothing: no `admitTriggerRun` charge, no `triggerCount` /
 * `lastTriggeredAt` change, no notification (`updateExecution` would send one).
 * The payload is NOT stored: it is untrusted, up to 1 MB, and can be replayed at
 * the delivery limit. A trigger keeps ONE filtered row, found by
 * `by_triggerId_status` however many runs followed it and moved to the front by
 * each skip, so a sender whose events miss the filters (even alternating with
 * runs) cannot fill the history or push the real runs out of the list. The
 * status is "filtered" for both causes; `error` holds the reason.
 */
export const recordFilteredExecution = internalMutation
    .input({
        reason: v.string().max(MAX_LENGTH.short),
        triggerId: v.id("triggers"),
    })
    .output(v.null())
    .mutation(async ({ args: { reason, triggerId }, ctx }) => {
        await recordFiltered(ctx, triggerId, reason);

        return null;
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
