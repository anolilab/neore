/**
 * `updateTriggerStats` after a failure and then a success: the success must
 * CLEAR `lastError`. It used to patch `lastError: undefined`, which the runtime
 * refuses, so every successful run after a failed one threw in its bookkeeping.
 *
 * And a schedule is checked when it is saved: `getNextCronTime` reads garbage as
 * a wildcard, so an unchecked expression fires every minute.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { CLAIM_PREFIX_BATCH, purgeClaimsWithPrefix, TRIGGER_DELIVERY_CLAIM_TTL_MS, TRIGGER_DELIVERY_SCOPE } from "../lib/claim-once";
import {
    assertComputerRoutine,
    createTrigger,
    deleteTrigger,
    getTriggerExecutions,
    setTriggerEnabled,
    testRunTrigger,
    updateTrigger,
    updateTriggerStats,
} from "./functions";
import { compileWebhookPreset } from "./presets";
import { findNextCronTime } from "./schedule";

// `user` is a `.global()` (D1) table the in-memory harness cannot write, so the
// session is read straight off the harness identity.
const { registry, sessionFrom } = vi.hoisted(() => {
    return {
        registry: new Map<string, unknown>(),
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: null, id: context.auth.userId, isAdmin: false, userId: context.auth.userId } : null,
    };
});

// `testRunTrigger` reads the trigger through `ctx.runQuery(internal.…)`.
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

beforeAll(async () => {
    registerModule(registry, "triggers_functions", await import("./functions"));
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        rateLimitGuard: async () => undefined,
    };
});

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

const record = async (args: Record<string, unknown>): Promise<void> => {
    await harness.run(async (ctx: any) => await ctx.runMutation(updateTriggerStats, args));
};

const readTrigger = async (id: string): Promise<any> => await harness.run(async (ctx: any) => await ctx.db.get(id));

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("updateTriggerStats", () => {
    it("records a failure, then clears it on the next success", async () => {
        const triggerId = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("triggers", {
                    createdAt: 1,
                    cronExpression: "0 9 * * *",
                    enabled: true,
                    model: "m",
                    name: "Daily",
                    triggerCount: 0,
                    type: "schedule",
                    updatedAt: 1,
                    userId: "user-a",
                }),
        );

        await record({ error: "boom", lastTriggeredAt: 10, triggerId });

        const failed = await readTrigger(triggerId);

        expect(failed).toMatchObject({ lastError: "boom", lastTriggeredAt: 10, triggerCount: 1 });

        await record({ lastTriggeredAt: 20, nextTriggerAt: 99, triggerId });

        const recovered = await readTrigger(triggerId);

        expect(recovered).toMatchObject({ cronExpression: "0 9 * * *", lastTriggeredAt: 20, name: "Daily", nextTriggerAt: 99, triggerCount: 2 });
        // Removed, not nulled: a `null` would fail `getTriggers`' output validator.
        expect("lastError" in recovered).toBe(false);
        expect(recovered._id).toBe(triggerId);
    });
});

describe("trigger schedules", () => {
    const as = () => harness.withIdentity({ userId: "user-a" } as never);
    const schedule = (cronExpression?: string) => {
        return { cronExpression, model: "m", name: "Daily", type: "schedule" };
    };

    it("refuses an expression the parser would read as a wildcard, on create and on update", async () => {
        for (const garbage of ["every day", "0 9 * *", "60 * * * *", "1-5/2 * * * *"]) {
            await expect(as().mutation(createTrigger as never, schedule(garbage) as never), garbage).rejects.toThrow("5-field cron expression");
        }

        await expect(as().mutation(createTrigger as never, schedule() as never)).rejects.toThrow("5-field cron expression");

        const { triggerId } = (await as().mutation(createTrigger as never, schedule("0 9 * * 1") as never)) as { triggerId: string };

        await expect(as().mutation(updateTrigger as never, { cronExpression: "nope", triggerId } as never)).rejects.toThrow("5-field cron expression");
        const trigger = await readTrigger(triggerId);

        expect(trigger.cronExpression).toBe("0 9 * * 1");
    });

    it("does not ask a webhook trigger for a schedule", async () => {
        await expect(as().mutation(createTrigger as never, { model: "m", name: "Hook", type: "webhook" } as never)).resolves.toMatchObject({
            triggerId: expect.any(String),
        });
    });

    it("stores no next run for a webhook trigger, even when it is sent a cron expression", async () => {
        const { triggerId } = (await as().mutation(createTrigger as never, { model: "m", name: "Hook", type: "webhook" } as never)) as { triggerId: string };

        await as().mutation(updateTrigger as never, { cronExpression: "0 9 * * 1", triggerId } as never);

        const trigger = await readTrigger(triggerId);

        expect(trigger.nextTriggerAt).toBeUndefined();
    });

    it("enabling a schedule whose stored run has passed arms the next future run, not that stale one", async () => {
        const { triggerId } = (await as().mutation(createTrigger as never, schedule("0 9 * * 1") as never)) as { triggerId: string };
        const stale = Date.now() - 60_000;

        // Left by a schedule that was edited and then stayed disabled past its time.
        await harness.run(async (ctx: any) => await ctx.db.patch(triggerId, { nextTriggerAt: stale }));
        await as().mutation(setTriggerEnabled as never, { enabled: true, triggerId } as never);

        const trigger = await readTrigger(triggerId);

        expect(trigger.nextTriggerAt).toBeGreaterThan(Date.now());
    });
});
describe("a routine's bot computer", () => {
    it("needs a bot and a schedule", () => {
        expect(() => assertComputerRoutine({ botComputer: true, botId: undefined, type: "schedule" })).toThrow("Only a routine with a bot");
        expect(() => assertComputerRoutine({ botComputer: true, botId: "bot-a", type: "webhook" })).toThrow("Only a scheduled routine");
        expect(() => assertComputerRoutine({ botComputer: true, botId: "bot-a", type: "schedule" })).not.toThrow();
        expect(() => assertComputerRoutine({ botComputer: false, botId: undefined, type: "webhook" })).not.toThrow();
    });

    it("is cleared with the bot, so a routine with no bot has no computer", async () => {
        const triggerId = (await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("triggers", {
                    botComputer: true,
                    botId: "bot-a",
                    createdAt: 1,
                    cronExpression: "0 9 * * 1",
                    enabled: false,
                    model: "m",
                    name: "Daily",
                    triggerCount: 0,
                    type: "schedule",
                    updatedAt: 1,
                    userId: "user-a",
                }),
        )) as string;

        await harness.withIdentity({ userId: "user-a" } as never).mutation(updateTrigger as never, { botId: null, triggerId } as never);

        const cleared = await readTrigger(triggerId);

        expect(cleared.botId).toBeUndefined();
        expect(cleared.botComputer).toBeUndefined();
    });
});

describe("event triggers", () => {
    it("are refused on create, and an existing one cannot be edited", async () => {
        const as = harness.withIdentity({ userId: "user-a" } as never);

        await expect(as.mutation(createTrigger as never, { model: "m", name: "Ev", type: "event" } as never)).rejects.toThrow(
            "Event triggers are not supported",
        );

        const triggerId = (await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("triggers", {
                    createdAt: 1,
                    enabled: false,
                    model: "m",
                    name: "Old event",
                    triggerCount: 0,
                    type: "event",
                    updatedAt: 1,
                    userId: "user-a",
                }),
        )) as string;

        await expect(as.mutation(updateTrigger as never, { name: "Renamed", triggerId } as never)).rejects.toThrow("Event triggers are not supported");

        // Still readable.
        expect(await readTrigger(triggerId)).toMatchObject({ name: "Old event", type: "event" });
    });
});

describe("testRunTrigger", () => {
    // The run reads the trigger when it starts, after this action returned. Enabling the
    // trigger only for the action's length meant a disabled trigger never ran.
    it("runs a disabled trigger without enabling it", async () => {
        const as = harness.withIdentity({ userId: "user-a" } as never);
        const { triggerId } = (await as.mutation(
            createTrigger as never,
            { cronExpression: "0 9 * * 1", model: "m", name: "Daily", type: "schedule" } as never,
        )) as {
            triggerId: string;
        };
        const before = await readTrigger(triggerId);

        await as.action(testRunTrigger as never, { triggerId } as never);

        // No payload: the run uses the schedule's own input, not the generic test text a webhook gets.
        expect(harness.scheduler.list().map((job) => job.args)).toEqual([{ ignoreDisabled: true, triggerId }]);

        const after = await readTrigger(triggerId);

        expect(after.enabled).toBe(false);
        expect(after.updatedAt).toBe(before.updatedAt);
    });

    it("passes a test payload the user typed to a disabled schedule's manual run", async () => {
        const as = harness.withIdentity({ userId: "user-a" } as never);
        const { triggerId } = (await as.mutation(
            createTrigger as never,
            { cronExpression: "0 9 * * 1", model: "m", name: "Daily", type: "schedule" } as never,
        )) as {
            triggerId: string;
        };

        await as.action(testRunTrigger as never, { testPayload: "summarise the inbox", triggerId } as never);

        expect(harness.scheduler.list().map((job) => job.args)).toEqual([{ ignoreDisabled: true, payload: "summarise the inbox", triggerId }]);
    });
});

describe("updateTrigger on a new schedule", () => {
    const NOW = Date.parse("2026-03-12T10:30:00Z");

    const insertSchedule = async (enabled: boolean): Promise<string> =>
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("triggers", {
                    createdAt: NOW,
                    cronExpression: "0 9 * * 1",
                    enabled,
                    model: "m",
                    name: "Weekly",
                    nextTriggerAt: findNextCronTime("0 9 * * 1", NOW),
                    triggerCount: 0,
                    type: "schedule",
                    updatedAt: NOW,
                    userId: "user-a",
                }),
        );

    beforeEach(() => {
        harness.close();
        harness = lunoraTest(schema as never, { now: NOW } as never);
    });

    it("moves the next run to the new schedule", async () => {
        const triggerId = await insertSchedule(true);

        await harness.withIdentity({ userId: "user-a" } as never).mutation(updateTrigger as never, { cronExpression: "0 12 * * *", triggerId } as never);

        const updated = await readTrigger(triggerId);

        expect(updated.nextTriggerAt).toBe(findNextCronTime("0 12 * * *", NOW));
        expect(updated.nextTriggerAt).toBe(Date.parse("2026-03-12T12:00:00Z"));
    });

    it("keeps a due run the tick has not taken when the expression is re-saved unchanged", async () => {
        const due = NOW - 60_000;
        const triggerId = await insertSchedule(true);

        await harness.run(async (ctx: any) => await ctx.db.patch(triggerId, { nextTriggerAt: due }));
        await harness.withIdentity({ userId: "user-a" } as never).mutation(updateTrigger as never, { cronExpression: "0 9 * * 1", triggerId } as never);

        const kept = await readTrigger(triggerId);

        expect(kept.nextTriggerAt).toBe(due);
    });

    it("refuses a schedule that never fires on an enabled trigger, and clears the time on a disabled one", async () => {
        const as = harness.withIdentity({ userId: "user-a" } as never);
        const enabledId = await insertSchedule(true);

        await expect(as.mutation(updateTrigger as never, { cronExpression: "0 9 30 2 *", triggerId: enabledId } as never)).rejects.toThrow("never fires");

        const disabledId = await insertSchedule(false);

        await as.mutation(updateTrigger as never, { cronExpression: "0 9 30 2 *", triggerId: disabledId } as never);

        expect("nextTriggerAt" in (await readTrigger(disabledId))).toBe(false);
    });
});

const asOwner = () => harness.withIdentity({ userId: "user-a" } as never);
const webhook = { model: "m", name: "Hook", type: "webhook" };
const dailySchedule = { cronExpression: "0 9 * * 1", model: "m", name: "Daily", type: "schedule" };

/** Create a webhook trigger as the owner and read the stored row back. */
const createWebhook = async (args: Record<string, unknown> = {}): Promise<{ row: any; triggerId: string }> => {
    const { triggerId } = (await asOwner().mutation(createTrigger as never, { ...webhook, ...args } as never)) as { triggerId: string };

    return { row: await readTrigger(triggerId), triggerId };
};

describe("webhook payload filters", () => {
    const as = asOwner;
    const filter = { op: "equals", path: "action", value: "opened" };

    it("stores a valid set on create, replaces it on update and clears it with an empty set", async () => {
        const { triggerId } = await createWebhook({ filters: [filter] });

        const storedFilters = async () => {
            const row = await readTrigger(triggerId);

            return row.filters;
        };

        expect(await storedFilters()).toEqual([filter]);

        const next = { op: "exists", path: "pull_request.number" };

        await as().mutation(updateTrigger as never, { filters: [next], triggerId } as never);
        expect(await storedFilters()).toEqual([next]);

        await as().mutation(updateTrigger as never, { name: "Renamed", triggerId } as never);
        expect(await storedFilters()).toEqual([next]);

        await as().mutation(updateTrigger as never, { filters: [], triggerId } as never);
        expect(await storedFilters()).toBeUndefined();
    });

    it("refuses more than 10 filters, a path past 8 segments, and a comparison without a value", async () => {
        const tooMany = Array.from({ length: 11 }, (_, index) => {
            return { ...filter, value: String(index) };
        });

        await expect(as().mutation(createTrigger as never, { ...webhook, filters: tooMany } as never)).rejects.toThrow("at most 10");
        await expect(as().mutation(createTrigger as never, { ...webhook, filters: [{ op: "exists", path: "a.b.c.d.e.f.g.h.i" }] } as never)).rejects.toThrow(
            "8 deep",
        );
        await expect(as().mutation(createTrigger as never, { ...webhook, filters: [{ op: "equals", path: "a" }] } as never)).rejects.toThrow("needs a value");
    });

    it("refuses a path longer than the argument cap", async () => {
        await expect(as().mutation(createTrigger as never, { ...webhook, filters: [{ op: "exists", path: "a".repeat(201) }] } as never)).rejects.toThrow();
    });

    it("keeps filters to webhook triggers", async () => {
        await expect(as().mutation(createTrigger as never, { ...dailySchedule, filters: [filter] } as never)).rejects.toThrow("Only a webhook trigger");

        const { triggerId } = (await as().mutation(createTrigger as never, dailySchedule as never)) as { triggerId: string };

        await expect(as().mutation(updateTrigger as never, { filters: [filter], triggerId } as never)).rejects.toThrow("Only a webhook trigger");
    });
});

/** What the argument validator names when it refuses. */
const PRESET_ARGUMENT = /webhookPreset/u;
const SCHEME_ARGUMENT = /webhookSignatureScheme/u;

describe("webhook provider presets", () => {
    const preset = { event: "pull_request_opened", provider: "github" } as const;

    it("stores the event's filters and the provider's scheme", async () => {
        const merged = { event: "pull_request_merged", provider: "github" } as const;
        const { row } = await createWebhook({ webhookPreset: merged });

        expect(row.webhookSignatureScheme).toBe(compileWebhookPreset(merged).scheme);
        expect(row.filters).toEqual(compileWebhookPreset(merged).filters);
    });

    it("stores the GitLab scheme for a GitLab preset", async () => {
        const opened = { event: "merge_request_opened", provider: "gitlab" } as const;
        const { row } = await createWebhook({ webhookPreset: opened });

        expect(row.webhookSignatureScheme).toBe("gitlab-token");
        expect(row.filters).toEqual(compileWebhookPreset(opened).filters);
    });

    it("stores 'timestamped' for a hand-written webhook with no scheme, and the scheme it names otherwise", async () => {
        const unnamed = await createWebhook();
        const named = await createWebhook({ webhookSignatureScheme: "gitlab-token" });

        expect(unnamed.row.webhookSignatureScheme).toBe("timestamped");
        expect(named.row.webhookSignatureScheme).toBe("gitlab-token");
    });

    it("does not accept an event that belongs to another provider", async () => {
        await expect(
            asOwner().mutation(createTrigger as never, { ...webhook, webhookPreset: { event: "merge_request_merged", provider: "github" } } as never),
        ).rejects.toThrow(PRESET_ARGUMENT);

        // The same call with the provider's own event is accepted, so the refusal is the pairing.
        await expect(createWebhook({ webhookPreset: { event: "pull_request_merged", provider: "github" } })).resolves.toBeDefined();
    });

    it("refuses a preset together with filters", async () => {
        await expect(
            asOwner().mutation(createTrigger as never, { ...webhook, filters: [{ op: "exists", path: "a" }], webhookPreset: preset } as never),
        ).rejects.toThrow("sets its own filters");
    });

    it("refuses an explicit scheme that is not the provider's", async () => {
        await expect(
            asOwner().mutation(createTrigger as never, { ...webhook, webhookPreset: preset, webhookSignatureScheme: "gitlab-token" } as never),
        ).rejects.toThrow("does not match the provider");
    });

    it("accepts an explicit scheme that is the provider's", async () => {
        const { row } = await createWebhook({ webhookPreset: preset, webhookSignatureScheme: "native" });

        expect(row.webhookSignatureScheme).toBe("native");
    });

    it("keeps a preset and a scheme to webhook triggers", async () => {
        await expect(asOwner().mutation(createTrigger as never, { ...dailySchedule, webhookPreset: preset } as never)).rejects.toThrow(
            "Only a webhook trigger has a provider preset",
        );
        await expect(asOwner().mutation(createTrigger as never, { ...dailySchedule, webhookSignatureScheme: "native" } as never)).rejects.toThrow(
            "Only a webhook trigger has a signature scheme",
        );
    });

    it("does not accept the Linear scheme", async () => {
        await expect(asOwner().mutation(createTrigger as never, { ...webhook, webhookSignatureScheme: "linear" } as never)).rejects.toThrow(SCHEME_ARGUMENT);
    });
});

describe("getTriggerExecutions", () => {
    const as = () => harness.withIdentity({ userId: "user-a" } as never);

    const seed = async (completed: number) => {
        const { triggerId } = (await as().mutation(createTrigger as never, { model: "m", name: "Hook", type: "webhook" } as never)) as { triggerId: string };

        await harness.run(async (ctx: any) => {
            await ctx.db.insert("triggerExecutions", { startedAt: completed + 1, status: "filtered", triggerId });

            for (let n = 1; n <= completed; n += 1) {
                await ctx.db.insert("triggerExecutions", { startedAt: n, status: "completed", triggerId });
            }
        });

        return triggerId;
    };

    it("returns the full 100 rows at the top of the range, the filtered row among them", async () => {
        const triggerId = await seed(110);
        const rows = (await as().query(getTriggerExecutions as never, { limit: 100, triggerId } as never)) as { status: string }[];

        expect(rows).toHaveLength(100);
        expect(rows[0]?.status).toBe("filtered");
    });

    it("accepts the bounds 1 and 100 and refuses 0, 101, fractions and non-finite limits", async () => {
        const triggerId = await seed(2);

        expect(await as().query(getTriggerExecutions as never, { limit: 1, triggerId } as never)).toHaveLength(1);
        expect(await as().query(getTriggerExecutions as never, { limit: 100, triggerId } as never)).toHaveLength(3);

        for (const limit of [0, 101, -1, 1.5, NaN, Infinity]) {
            await expect(as().query(getTriggerExecutions as never, { limit, triggerId } as never)).rejects.toThrow();
        }
    });
});

describe("deleteTrigger", () => {
    const as = () => harness.withIdentity({ userId: "user-a" } as never);

    const seed = async (deliveries: number) => {
        const { triggerId } = (await as().mutation(createTrigger as never, { model: "m", name: "Hook", type: "webhook" } as never)) as { triggerId: string };

        await harness.run(async (ctx: any) => {
            await ctx.db.insert("triggerExecutions", { startedAt: 1, status: "completed", triggerId });

            for (let n = 0; n < deliveries; n += 1) {
                await ctx.db.insert("idempotencyClaims", {
                    claimedAt: 1,
                    expiresAt: TRIGGER_DELIVERY_CLAIM_TTL_MS,
                    key: `${triggerId}:evt-${String(n)}:digest`,
                    scope: TRIGGER_DELIVERY_SCOPE,
                });
            }
        });

        return triggerId;
    };

    const claimKeys = async (): Promise<string[]> => {
        const rows = await harness.run(async (ctx: any) => await ctx.db.query("idempotencyClaims").collect());

        return rows.map((row: { key: string }) => row.key);
    };

    it("removes the trigger's delivery claims with it, and nobody else's", async () => {
        const triggerId = await seed(3);
        const other = await seed(2);

        // A delivery id is header text: one with a character past the BMP sorts above any U+FFFF bound.
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("idempotencyClaims", { claimedAt: 1, expiresAt: 2, key: `${triggerId}:😀:digest`, scope: TRIGGER_DELIVERY_SCOPE }),
        );

        await as().mutation(deleteTrigger as never, { triggerId } as never);

        expect(await readTrigger(triggerId)).toBeNull();
        expect(await readTrigger(other)).not.toBeNull();
        const remaining = await claimKeys();

        expect(remaining).toHaveLength(2);
        expect(remaining.every((key) => key.startsWith(`${other}:`))).toBe(true);
        expect(harness.scheduler.list()).toEqual([]);
    });

    it("hands what is left past one batch to a scheduled purge", async () => {
        const triggerId = await seed(CLAIM_PREFIX_BATCH + 4);

        await as().mutation(deleteTrigger as never, { triggerId } as never);

        expect(await claimKeys()).toHaveLength(4);
        expect(harness.scheduler.list().map((job) => job.args)).toEqual([{ prefix: `${triggerId}:`, scope: TRIGGER_DELIVERY_SCOPE }]);

        await harness.run(async (ctx: any) => await ctx.runMutation(purgeClaimsWithPrefix, { prefix: `${triggerId}:`, scope: TRIGGER_DELIVERY_SCOPE }));
        expect(await claimKeys()).toEqual([]);
    });
});
