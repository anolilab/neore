/**
 * The event scheduler against the real schema: a baseline is recorded without a run, a change starts exactly one,
 * a duplicate tick or a replayed check starts none, a one-shot disarms, a page keeps watching after a cooldown and
 * a streak of failed checks pauses the watcher and tells its owner.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import { HttpError } from "../lib/fetch-timeout";
import schema from "../schema";
import { createExecution, recordFilteredExecution, setTriggerEnabledInternal, switchOffConsumedMoment, updateExecution } from "./functions";
import {
    EVENT_CHECK_LEASE_MS,
    EVENT_FIRE_CLAIM_TTL_MS,
    EVENT_PENDING_RUN_HORIZON_MS,
    EVENT_RUN_MAX_ATTEMPTS,
    dispatchDueEventTriggers,
    latestThreadReply,
    performEventCheck,
    performEventRun,
    recordEventCheck,
    queueEventRun,
} from "./events";
import type { EventCheckContext } from "./event-sources/types";
import { MAX_ACTIVE_EVENT_WATCHERS } from "./event-sources/types";
import { assertWatcherCapacity } from "./events";
import { TRIGGER_PAUSE_AFTER_FAILURES } from "./failure-streak";

const { enqueueJob, noteShardDue, registry } = vi.hoisted(() => {
    return {
        enqueueJob: vi.fn(async (..._arguments: unknown[]) => undefined),
        noteShardDue: vi.fn(async () => undefined),
        registry: new Map<string, unknown>(),
    };
});

// `performEventCheck` reaches `recordEventCheck` through `ctx.runMutation(internal.…)`.
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

beforeAll(async () => {
    registerModule(registry, "triggers_events", await import("./events"));
});

vi.mock("../lib/job-queue", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../lib/job-queue")>()), enqueueJob };
});

vi.mock("../lib/shard-housekeeping", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../lib/shard-housekeeping")>()), noteShardDue };
});

const NOW = 1_800_000_000_000;
const HEX_SHA256_RE = /^[0-9a-f]{64}$/u;
const USER = "user-a";
const PAGE = { cooldownMinutes: 60, intervalMinutes: 15, kind: "page", url: "https://example.com/news" } as const;

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

const insertWatcher = async (overrides: Record<string, unknown> = {}): Promise<string> =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("triggers", {
                createdAt: 1,
                enabled: true,
                eventSource: PAGE,
                eventState: {},
                model: "m",
                name: "Watcher",
                nextTriggerAt: NOW,
                triggerCount: 0,
                type: "event",
                updatedAt: 1,
                userId: USER,
                ...overrides,
            }),
    );

const nextCheckOf = (trigger: { nextTriggerAt: number }): number => trigger.nextTriggerAt;

const readTrigger = async (id: string): Promise<any> => await harness.run(async (ctx: any) => await ctx.db.get(id));

/** The runs a check scheduled for its firings: they are sent to the queue only after the claiming mutation committed. */
const scheduledRuns = (): any[] =>
    harness.scheduler
        .list()
        .filter((job) => "firing" in job.args)
        .map((job) => job.args);

/** One check as the action performs it, with the page the fake network serves. */
const check = async (triggerId: string, html: string, now = NOW): Promise<void> => {
    const trigger = await readTrigger(triggerId);
    const checkContext: EventCheckContext = {
        fetchPage: async () => {
            // "FAIL": the address answers 404, which only its owner can fix. The others heal on their own.
            if (html === "FAIL") {
                throw new HttpError("The page could not be read", 404, "Not Found");
            }

            if (html === "FAIL503") {
                throw new HttpError("The page could not be read", 503, "Service Unavailable");
            }

            if (html === "TIMEOUT") {
                throw new Error("Request timeout after 15000ms");
            }

            return { text: html, truncated: false };
        },
        now,
        scanThread: async () => {
            throw new Error("not used");
        },
    };

    await harness.run(async (ctx: any) => await performEventCheck(ctx, trigger, checkContext));
};

beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    enqueueJob.mockClear();
    noteShardDue.mockClear();
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
    vi.useRealTimers();
});

describe("a page watcher", () => {
    it("records a baseline on the first check and starts no run", async () => {
        const id = await insertWatcher();

        await check(id, "<p>v1</p>");

        expect(enqueueJob).not.toHaveBeenCalled();
        const row = await readTrigger(id);

        expect(row.eventState.hash).toMatch(HEX_SHA256_RE);
        // A phrase-less watcher has no `matched`: a patch refuses a nested `undefined`.
        expect(Object.hasOwn(row.eventState, "matched")).toBe(false);
    });

    it("starts exactly one run when the page changes, and none while it stays the same", async () => {
        const id = await insertWatcher();

        await check(id, "<p>v1</p>");
        await check(id, "<p>v1</p>");

        expect(enqueueJob).not.toHaveBeenCalled();

        await check(id, "<p>v2</p>");

        expect(enqueueJob).not.toHaveBeenCalled();
        expect(scheduledRuns()).toEqual([
            { firing: NOW, payload: expect.stringContaining("The page changed: https://example.com/news"), triggerId: id, userId: USER },
        ]);

        await check(id, "<p>v2</p>");

        expect(scheduledRuns()).toHaveLength(1);
    });

    it("keeps watching after a fire, once the cooldown has passed", async () => {
        const id = await insertWatcher();

        await check(id, "<p>v1</p>");
        await check(id, "<p>v2</p>");

        const row = await readTrigger(id);

        expect(row.enabled).toBe(true);
        expect(row.eventState.firedAt).toBe(NOW);
        expect(row.nextTriggerAt).toBe(NOW + 60 * 60_000);
        expect(noteShardDue).toHaveBeenLastCalledWith(expect.anything(), NOW + 60 * 60_000, USER);
    });

    it("starts no second run when a duplicate check saw the same change", async () => {
        const id = await insertWatcher();

        await check(id, "<p>v1</p>");

        const trigger = await readTrigger(id);
        const record = async (): Promise<{ fired: boolean }> =>
            await harness.run(
                async (ctx: any) =>
                    await ctx.runMutation(recordEventCheck, {
                        fire: { key: "page:abc", summary: "The page changed: x" },
                        read: { checkedAt: trigger.eventState.checkedAt, source: PAGE },
                        state: { ...trigger.eventState, hash: "abc" },
                        triggerId: id,
                    }),
            );

        expect(await record()).toEqual({ fired: true });
        expect(await record()).toEqual({ fired: false });
        expect(scheduledRuns()).toHaveLength(1);
    });

    it("lets the same occurrence fire again once the claim has expired", async () => {
        const id = await insertWatcher();
        const record = async (): Promise<{ fired: boolean }> => {
            const { eventState } = await readTrigger(id);

            return await harness.run(
                async (ctx: any) =>
                    await ctx.runMutation(recordEventCheck, {
                        fire: { key: "page:abc", summary: "x" },
                        read: { checkedAt: eventState.checkedAt, source: PAGE },
                        state: {},
                        triggerId: id,
                    }),
            );
        };

        const first = await record();

        expect(first.fired).toBe(true);

        vi.setSystemTime(NOW + EVENT_FIRE_CLAIM_TTL_MS + 1);

        const again = await record();

        expect(again.fired).toBe(true);
    });

    it("drops the answer of a check that finished after the watcher was switched off", async () => {
        const id = await insertWatcher();

        await harness.run(async (ctx: any) => await ctx.db.patch(id, { enabled: false }));
        await harness.run(
            async (ctx: any) => await ctx.runMutation(recordEventCheck, { fire: { key: "k", summary: "x" }, read: { source: PAGE }, state: {}, triggerId: id }),
        );

        expect(enqueueJob).not.toHaveBeenCalled();
    });
});

describe("a time watcher", () => {
    const AT = NOW + 1000;

    it("fires once at its moment and is disarmed, not switched off", async () => {
        const id = await insertWatcher({ eventSource: { at: AT, kind: "time" }, nextTriggerAt: AT });

        await check(id, "", AT - 1);

        expect(enqueueJob).not.toHaveBeenCalled();
        // Dispatched early: it looks again at its moment, but never sooner than a minute from now.
        const early = await readTrigger(id);

        expect(early.nextTriggerAt).toBe(NOW + 60_000);

        vi.setSystemTime(AT);
        await check(id, "", AT);
        await check(id, "", AT);

        const row = await readTrigger(id);

        expect(scheduledRuns()).toHaveLength(1);
        expect(scheduledRuns()[0]).toMatchObject({ firing: AT, payload: expect.stringContaining("The time has come") });
        expect(row.enabled).toBe(true);
        expect(row.nextTriggerAt).toBeUndefined();
    });

    it("switches itself off when the run it started settles, and not before", async () => {
        const id = await insertWatcher({ eventSource: { at: AT, kind: "time" }, nextTriggerAt: AT });

        vi.setSystemTime(AT);
        await check(id, "", AT);

        const executionId = await harness.run(async (ctx: any) => await ctx.runMutation(createExecution, { firing: AT, triggerId: id }));

        const beforeSettle = await readTrigger(id);

        expect(beforeSettle.enabled).toBe(true);

        await harness.run(async (ctx: any) => await ctx.runMutation(updateExecution, { executionId, status: "completed" }));

        const afterSettle = await readTrigger(id);

        expect(afterSettle.enabled).toBe(false);
    });

    it("switches itself off when a quiet-run skip consumes its firing", async () => {
        const id = await insertWatcher({ eventSource: { at: AT, kind: "time" }, nextTriggerAt: AT });

        vi.setSystemTime(AT);
        await check(id, "", AT);
        await harness.run(async (ctx: any) => await ctx.runMutation(recordFilteredExecution, { firing: AT, reason: "Nothing to report", triggerId: id }));

        const row = await readTrigger(id);

        expect(row.enabled).toBe(false);
    });

    it("switches itself off when its run could not even start, and only once it has fired", async () => {
        const id = await insertWatcher({ eventSource: { at: AT, kind: "time" }, nextTriggerAt: AT });

        await harness.run(async (ctx: any) => await ctx.runMutation(switchOffConsumedMoment, { triggerId: id }));

        const early = await readTrigger(id);

        expect(early.enabled).toBe(true);

        vi.setSystemTime(AT);
        await check(id, "", AT);
        await harness.run(async (ctx: any) => await ctx.runMutation(switchOffConsumedMoment, { firing: AT, triggerId: id }));

        const fired = await readTrigger(id);

        expect(fired.enabled).toBe(false);
    });

    it("is not switched off by a filtered row before it has fired", async () => {
        const id = await insertWatcher({ eventSource: { at: AT, kind: "time" }, nextTriggerAt: AT });

        await harness.run(async (ctx: any) => await ctx.runMutation(recordFilteredExecution, { reason: "Nothing to report", triggerId: id }));

        const row = await readTrigger(id);

        expect(row.enabled).toBe(true);
    });

    it("is not switched off by a test run before it has fired", async () => {
        const id = await insertWatcher({ eventSource: { at: AT, kind: "time" }, nextTriggerAt: AT });
        const executionId = await harness.run(async (ctx: any) => await ctx.runMutation(createExecution, { triggerId: id }));

        await harness.run(async (ctx: any) => await ctx.runMutation(updateExecution, { executionId, status: "completed" }));

        const row = await readTrigger(id);

        expect(row.enabled).toBe(true);
    });

    it("is not switched off by a manual run that settles after it has fired", async () => {
        const id = await insertWatcher({ eventSource: { at: AT, kind: "time" }, nextTriggerAt: AT });

        vi.setSystemTime(AT);
        await check(id, "", AT);

        // "Run now" carries no firing, so it must not consume the one that is still on its way.
        const manual = await harness.run(async (ctx: any) => await ctx.runMutation(createExecution, { triggerId: id }));

        await harness.run(async (ctx: any) => await ctx.runMutation(updateExecution, { executionId: manual, status: "completed" }));
        await harness.run(async (ctx: any) => await ctx.runMutation(switchOffConsumedMoment, { triggerId: id }));

        const row = await readTrigger(id);

        expect(row.enabled).toBe(true);
    });

    it("is not switched off by the run of an earlier firing after it was armed for a new moment", async () => {
        const id = await insertWatcher({ eventSource: { at: AT, kind: "time" }, nextTriggerAt: AT });

        vi.setSystemTime(AT);
        await check(id, "", AT);

        const oldRun = await harness.run(async (ctx: any) => await ctx.runMutation(createExecution, { firing: AT, triggerId: id }));

        // The owner re-arms it for a new moment while the first run is still in flight; that moment fires too.
        const next = AT + 120_000;

        await harness.run(
            async (ctx: any) => await ctx.db.patch(id, { enabled: true, eventSource: { at: next, kind: "time" }, eventState: {}, nextTriggerAt: next }),
        );
        vi.setSystemTime(next);
        await check(id, "", next);
        await harness.run(async (ctx: any) => await ctx.runMutation(updateExecution, { executionId: oldRun, status: "completed" }));
        await harness.run(async (ctx: any) => await ctx.runMutation(recordFilteredExecution, { firing: AT, reason: "Nothing to report", triggerId: id }));
        await harness.run(async (ctx: any) => await ctx.runMutation(switchOffConsumedMoment, { firing: AT, triggerId: id }));

        const row = await readTrigger(id);

        expect(row.enabled).toBe(true);
    });
});

describe("a time watcher that has already fired", () => {
    it("claims no second firing when a stray check reaches it after the claim expired", async () => {
        const AT = NOW + 1000;
        const id = await insertWatcher({ eventSource: { at: AT, kind: "time" }, nextTriggerAt: AT });

        vi.setSystemTime(AT);
        await check(id, "", AT);

        const later = AT + EVENT_FIRE_CLAIM_TTL_MS + 1;

        vi.setSystemTime(later);
        await check(id, "", later);

        expect(scheduledRuns()).toHaveLength(1);
        const row = await readTrigger(id);

        expect(row.eventState.firedAt).toBe(AT);
    });
});

describe("handing a firing to the queue", () => {
    it("schedules the send from the claiming mutation, so a mutation that does not commit sends nothing", async () => {
        const id = await insertWatcher();
        const record = async (): Promise<unknown> =>
            await harness.run(
                async (ctx: any) =>
                    await ctx.runMutation(recordEventCheck, {
                        fire: { key: "k", summary: "x" },
                        read: { source: PAGE },
                        state: {},
                        triggerId: id,
                    }),
            );

        await record();

        expect(enqueueJob).not.toHaveBeenCalled();
        expect(scheduledRuns()).toHaveLength(1);
    });

    it("enqueues under an id taken from the firing, so a repeated send is one run", async () => {
        const id = await insertWatcher();
        const args = { firing: NOW, payload: "x", triggerId: id, userId: USER };

        await queueEventRun(args as never);
        await queueEventRun(args as never);

        expect(enqueueJob).toHaveBeenCalledTimes(2);
        expect(enqueueJob.mock.calls[0]?.[1]).toEqual({ firing: NOW, payload: "x", triggerId: id });
        expect(enqueueJob.mock.calls[0]?.[2]).toMatchObject({ once: { jobId: `event:${id}:${NOW}`, userId: USER }, shardKey: USER });
        expect(enqueueJob.mock.calls[1]?.[2]).toEqual(enqueueJob.mock.calls[0]?.[2]);
    });
});

describe("a queued run whose delivery dies", () => {
    it("names the switch-off of its own firing as the compensation, and that switches a consumed moment off", async () => {
        const id = await insertWatcher({ eventSource: { at: NOW + 1000, kind: "time" }, nextTriggerAt: NOW + 1000 });

        vi.setSystemTime(NOW + 1000);
        await check(id, "", NOW + 1000);

        const [args] = scheduledRuns();

        await queueEventRun(args);

        const { onLapse } = (enqueueJob.mock.calls[0]?.[2] as { once: { onLapse: { args: Record<string, unknown>; ref: { __lunoraRef: string } } } }).once;

        expect(onLapse.args).toEqual({ firing: NOW + 1000, triggerId: id });
        expect(onLapse.ref.__lunoraRef).toContain("switchOffConsumedMoment");

        // `reapLapsedClaims` runs the target with its onLapse args plus the claim key.
        await harness.run(async (ctx: any) => await ctx.runMutation(switchOffConsumedMoment, { ...onLapse.args, claimKey: `event:${id}:${NOW + 1000}` }));

        expect(await readTrigger(id)).toMatchObject({ enabled: false });
    });
});

describe("a send that fails", () => {
    const fireMoment = async (): Promise<{ args: any; id: string }> => {
        const id = await insertWatcher({ eventSource: { at: NOW + 1000, kind: "time" }, nextTriggerAt: NOW + 1000 });

        vi.setSystemTime(NOW + 1000);
        await check(id, "", NOW + 1000);

        return { args: scheduledRuns()[0], id };
    };
    const send = async (args: unknown): Promise<void> => await harness.run(async (ctx: any) => await performEventRun(ctx, args as never));

    it("is repeated under the same job id, so a second send is one run", async () => {
        const { args, id } = await fireMoment();

        enqueueJob.mockRejectedValueOnce(new Error("queue unavailable"));
        await expect(queueEventRun(args)).rejects.toThrow("queue unavailable");
        await queueEventRun(args);

        expect(enqueueJob).toHaveBeenCalledTimes(2);
        expect(await readTrigger(id)).toMatchObject({ enabled: true, eventState: { firedAt: NOW + 1000 } });
    });

    it("keeps the firing pending until the queue has accepted it, then forgets it", async () => {
        const { args, id } = await fireMoment();

        const pending = await readTrigger(id);

        expect(pending.eventState.pendingRun).toEqual({ firing: NOW + 1000, payload: args.payload });

        await send(args);

        const sent = await readTrigger(id);

        expect(enqueueJob).toHaveBeenCalledTimes(1);
        expect(Object.hasOwn(sent.eventState, "pendingRun")).toBe(false);
    });

    it("schedules another attempt instead of losing the firing when the queue refuses", async () => {
        const { args, id } = await fireMoment();
        const before = harness.scheduler.list().length;

        enqueueJob.mockRejectedValueOnce(new Error("queue unavailable"));
        await send(args);

        const retries = harness.scheduler.list().slice(before);

        expect(retries).toHaveLength(1);
        expect(retries[0]!.args).toMatchObject({ attempt: 1, firing: NOW + 1000, triggerId: id });
        expect(await readTrigger(id)).toMatchObject({ enabled: true, eventState: { pendingRun: { firing: NOW + 1000 } } });

        await send(retries[0]!.args);

        const settled = await readTrigger(id);

        expect(enqueueJob).toHaveBeenCalledTimes(2);
        expect(settled.eventState.pendingRun).toBeUndefined();
    });

    it("gives up after the last attempt: the moment is switched off and the owner told", async () => {
        const { args, id } = await fireMoment();

        enqueueJob.mockRejectedValue(new Error("queue unavailable"));
        await send({ ...args, attempt: EVENT_RUN_MAX_ATTEMPTS - 1 });
        enqueueJob.mockReset();

        const row = await readTrigger(id);

        expect(row.enabled).toBe(false);
        expect(row.lastError).toContain("could not be queued");
        expect(row.eventState.pendingRun).toBeUndefined();
    });

    it("sends nothing for a firing that is no longer pending (already sent, or the watcher was re-armed)", async () => {
        const { args, id } = await fireMoment();

        await send(args);
        await send(args);

        expect(enqueueJob).toHaveBeenCalledTimes(1);

        const again = await fireMoment();

        await harness.run(async (ctx: any) => await ctx.db.patch(again.id, { eventState: { armedAt: NOW } }));
        enqueueJob.mockClear();
        await send(again.args);

        expect(enqueueJob).not.toHaveBeenCalled();
        expect(id).not.toBe(again.id);
    });
});

describe("an occurrence that fires while an earlier one is still waiting for the queue", () => {
    const MINUTE = 60_000;
    const changeAt = async (id: string, html: string, now: number): Promise<void> => {
        vi.setSystemTime(now);
        await check(id, html, now);
    };

    it("keeps the earlier run being retried and folds the newer occurrence into it, instead of replacing it", async () => {
        const id = await insertWatcher();

        await check(id, "<p>v1</p>");
        await check(id, "<p>v2</p>");

        const [first] = scheduledRuns();
        const before = harness.scheduler.list().length;

        // The queue refuses the send, so the firing stays pending and a retry is scheduled.
        enqueueJob.mockRejectedValueOnce(new Error("queue unavailable"));
        await harness.run(async (ctx: any) => await performEventRun(ctx, first));

        const [retry] = harness.scheduler.list().slice(before);

        expect(retry!.args).toMatchObject({ attempt: 1, firing: NOW });

        // The outage outlasts the cooldown (60 min): the page changes again.
        await changeAt(id, "<p>v3</p>", NOW + 61 * MINUTE);

        const row = await readTrigger(id);

        expect(row.eventState.pendingRun).toMatchObject({ coalesced: 1, firing: NOW, payload: first.payload });
        expect(row.eventState.firedAt).toBe(NOW + 61 * MINUTE);
        expect(scheduledRuns().filter((args) => args.firing === NOW + 61 * MINUTE)).toHaveLength(0);

        // The retry of the earlier firing still matches, and the queue takes it once.
        await harness.run(async (ctx: any) => await performEventRun(ctx, retry!.args));

        expect(enqueueJob).toHaveBeenCalledTimes(2);
        expect(enqueueJob.mock.calls[1]?.[2]).toMatchObject({ once: { jobId: `event:${id}:${NOW}` } });

        const settled = await readTrigger(id);

        expect(Object.hasOwn(settled.eventState, "pendingRun")).toBe(false);
    });

    it("replaces a pending run that is past the horizon, which no retry can still be settling", async () => {
        const id = await insertWatcher();

        await check(id, "<p>v1</p>");
        await check(id, "<p>v2</p>");

        const [first] = scheduledRuns();

        await changeAt(id, "<p>v3</p>", NOW + EVENT_PENDING_RUN_HORIZON_MS + MINUTE);

        const row = await readTrigger(id);

        expect(row.eventState.pendingRun).toMatchObject({ firing: NOW + EVENT_PENDING_RUN_HORIZON_MS + MINUTE });
        expect(row.eventState.pendingRun.coalesced).toBeUndefined();
        expect(scheduledRuns()).toHaveLength(2);

        await harness.run(async (ctx: any) => await performEventRun(ctx, first));

        expect(enqueueJob).not.toHaveBeenCalled();
    });
});

describe("re-arming a watcher", () => {
    it("drops the answer of a check that started before it was switched off and on again", async () => {
        const id = await insertWatcher();
        const stale = await readTrigger(id);

        await harness.run(async (ctx: any) => await ctx.runMutation(setTriggerEnabledInternal, { enabled: false, triggerId: id }));
        vi.setSystemTime(NOW + 1000);
        await harness.run(async (ctx: any) => await ctx.runMutation(setTriggerEnabledInternal, { enabled: true, triggerId: id }));

        const checkContext: EventCheckContext = {
            fetchPage: async () => {
                return { text: "<p>old look</p>", truncated: false };
            },
            now: NOW,
            scanThread: async () => {
                return {};
            },
        };

        await harness.run(async (ctx: any) => await performEventCheck(ctx, stale, checkContext));

        const row = await readTrigger(id);

        expect(row.eventState.hash).toBeUndefined();
        expect(row.eventState.checkedAt).toBeUndefined();
    });
});

describe("a check that finishes after the watcher was edited", () => {
    it("is dropped, so the old page never becomes the new page's baseline", async () => {
        const id = await insertWatcher();
        const stale = await readTrigger(id);

        // The owner points the watcher at another page while the check of the first one is in flight.
        await harness.run(async (ctx: any) => await ctx.db.patch(id, { eventSource: { ...PAGE, url: "https://example.com/other" }, eventState: {} }));

        const checkContext: EventCheckContext = {
            fetchPage: async () => {
                return { text: "<p>old page</p>", truncated: false };
            },
            now: NOW,
            scanThread: async () => {
                return {};
            },
        };

        await harness.run(async (ctx: any) => await performEventCheck(ctx, stale, checkContext));

        expect(await readTrigger(id)).toMatchObject({ eventSource: { url: "https://example.com/other" }, eventState: {} });
        expect(enqueueJob).not.toHaveBeenCalled();
    });

    it("is dropped when another check finished first", async () => {
        const id = await insertWatcher();
        const stale = await readTrigger(id);

        await check(id, "<p>v1</p>");

        const checkContext: EventCheckContext = {
            fetchPage: async () => {
                return { text: "<p>v2</p>", truncated: false };
            },
            now: NOW,
            scanThread: async () => {
                return {};
            },
        };

        await harness.run(async (ctx: any) => await performEventCheck(ctx, stale, checkContext));

        const row = await readTrigger(id);

        expect(row.eventState.checkFailures).toBeUndefined();
        expect(enqueueJob).not.toHaveBeenCalled();
    });
});

describe("failed checks", () => {
    it("pauses the watcher on the Nth failure in a row and tells its owner, once", async () => {
        const id = await insertWatcher();

        for (let index = 1; index < TRIGGER_PAUSE_AFTER_FAILURES; index += 1) {
            await check(id, "FAIL");
        }

        expect(await readTrigger(id)).toMatchObject({
            enabled: true,
            eventState: { checkFailures: TRIGGER_PAUSE_AFTER_FAILURES - 1 },
            lastError: "The page could not be read: 404 Not Found",
        });
        expect(await harness.run(async (ctx: any) => await ctx.db.query("notifications").collect())).toHaveLength(0);

        await check(id, "FAIL");

        const row = await readTrigger(id);
        const notices = await harness.run(async (ctx: any) => await ctx.db.query("notifications").collect());

        expect(row.enabled).toBe(false);
        expect(row.nextTriggerAt).toBeUndefined();
        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatchObject({ outcome: "failure", title: "Watcher", type: "trigger", userId: USER });
        expect(notices[0].body).toContain("404");
    });

    it("never pauses the watcher for an outage, a timeout or a network error, and waits longer after each", async () => {
        const id = await insertWatcher();
        const waits: number[] = [];

        for (const failure of ["FAIL503", "TIMEOUT", "FAIL503", "TIMEOUT", "FAIL503"]) {
            await check(id, failure);
            const waiting = await readTrigger(id);

            waits.push(waiting.nextTriggerAt - NOW);
        }

        const row = await readTrigger(id);

        expect(row.enabled).toBe(true);
        expect(row.eventState.checkFailures).toBeUndefined();
        expect(row.lastError).toBeDefined();
        expect(waits[0]).toBe(PAGE.intervalMinutes * 60_000);
        expect(waits.slice(1).every((wait, index) => wait > waits[index]!)).toBe(true);
        expect(await harness.run(async (ctx: any) => await ctx.db.query("notifications").collect())).toHaveLength(0);
    });

    it("keeps the cause-fixable streak across an outage in between", async () => {
        const id = await insertWatcher();

        await check(id, "FAIL");
        await check(id, "FAIL503");
        await check(id, "FAIL");

        const stillOn = await readTrigger(id);

        expect(stillOn.enabled).toBe(true);

        await check(id, "FAIL");

        const paused = await readTrigger(id);

        expect(paused.enabled).toBe(false);
    });

    it("forgets the outages, and the error, after a check that works", async () => {
        const id = await insertWatcher();

        await check(id, "FAIL503");
        await check(id, "FAIL503");
        await check(id, "<p>ok</p>");

        const row = await readTrigger(id);

        expect(row.lastError).toBeUndefined();
        expect(row.eventState.checkRetries).toBeUndefined();
        expect(row.nextTriggerAt - NOW).toBe(PAGE.intervalMinutes * 60_000);
    });

    it("starts the streak over after a check that works", async () => {
        const id = await insertWatcher();

        await check(id, "FAIL");
        await check(id, "FAIL");
        await check(id, "<p>ok</p>");

        const row = await readTrigger(id);

        expect(row.eventState.checkFailures).toBeUndefined();
        expect(row.lastError).toBeUndefined();

        await check(id, "FAIL");

        const stillOn = await readTrigger(id);

        expect(stillOn.enabled).toBe(true);
    });
});

describe("dispatching due watchers", () => {
    it("leases a due watcher, so a duplicate tick schedules its check once", async () => {
        const id = await insertWatcher();

        await harness.run(async (ctx: any) => await ctx.runMutation(dispatchDueEventTriggers, {}));
        await harness.run(async (ctx: any) => await ctx.runMutation(dispatchDueEventTriggers, {}));

        expect(harness.scheduler.list().map((job) => job.args)).toEqual([{ triggerId: id }]);
        const row = await readTrigger(id);

        expect(row.nextTriggerAt).toBe(NOW + EVENT_CHECK_LEASE_MS);
    });

    it("leaves a watcher that is not due, a disabled one and a schedule alone", async () => {
        await insertWatcher({ nextTriggerAt: NOW + 60_000 });
        await insertWatcher({ enabled: false });
        await insertWatcher({ cronExpression: "0 9 * * *", eventSource: undefined, type: "schedule" });

        await harness.run(async (ctx: any) => await ctx.runMutation(dispatchDueEventTriggers, {}));

        expect(harness.scheduler.list()).toEqual([]);
    });

    it("does not dispatch a moment that has fired and is waiting for its run, however long that takes", async () => {
        const id = await insertWatcher({
            eventSource: { at: NOW - 600_000, kind: "time" },
            eventState: { checkedAt: NOW - 600_000, firedAt: NOW - 600_000 },
            nextTriggerAt: undefined,
        });

        await harness.run(async (ctx: any) => await ctx.runMutation(dispatchDueEventTriggers, {}));

        const row = await readTrigger(id);

        expect(harness.scheduler.list()).toEqual([]);
        expect(row.nextTriggerAt).toBeUndefined();
    });

    it("is not starved by due schedules, and starts at most one batch of checks", async () => {
        for (let index = 0; index < 30; index += 1) {
            await insertWatcher({ cronExpression: "0 9 * * *", eventSource: undefined, nextTriggerAt: NOW - 10_000 - index, type: "schedule" });
        }

        const wanted = await insertWatcher({ nextTriggerAt: NOW - 5000 });

        for (let index = 0; index < 30; index += 1) {
            await insertWatcher({ nextTriggerAt: NOW - 1 });
        }

        const result = await harness.run(async (ctx: any) => await ctx.runMutation(dispatchDueEventTriggers, {}));
        const checked = harness.scheduler.list().map((job) => job.args.triggerId);

        expect(result.dispatched).toBe(25);
        expect(checked).toHaveLength(25);
        expect(checked).toContain(wanted);
        expect(noteShardDue).toHaveBeenCalledWith(expect.anything(), NOW, USER);
    });

    it("switches off a legacy event row that has no condition", async () => {
        const id = await insertWatcher({ eventSource: undefined });

        await harness.run(async (ctx: any) => await ctx.runMutation(dispatchDueEventTriggers, {}));

        expect(await readTrigger(id)).toMatchObject({ enabled: false });
        expect(harness.scheduler.list()).toEqual([]);
    });
});

describe("a check that never reports back", () => {
    const dispatch = async (now: number): Promise<void> => {
        vi.setSystemTime(now);
        await harness.run(async (ctx: any) => await ctx.runMutation(dispatchDueEventTriggers, {}));
    };

    it("counts a lapsed lease as a failed check and pauses the watcher on the third, telling its owner once", async () => {
        const id = await insertWatcher();
        let now = NOW;

        await dispatch(now);
        expect(harness.scheduler.list()).toHaveLength(1);

        for (let failure = 1; failure < TRIGGER_PAUSE_AFTER_FAILURES; failure += 1) {
            // The check died: the lease lapses and the next dispatch finds it still stamped.
            now += EVENT_CHECK_LEASE_MS + 1;
            await dispatch(now);

            expect(await readTrigger(id)).toMatchObject({ enabled: true, eventState: { checkFailures: failure } });

            now = nextCheckOf(await readTrigger(id));
            await dispatch(now);
        }

        now += EVENT_CHECK_LEASE_MS + 1;
        await dispatch(now);

        const row = await readTrigger(id);
        const notices = await harness.run(async (ctx: any) => await ctx.db.query("notifications").collect());

        expect(row.enabled).toBe(false);
        expect(row.nextTriggerAt).toBeUndefined();
        expect(row.lastError).toContain("did not finish");
        expect(notices).toHaveLength(1);
    });

    it("counts nothing for a check that reported, however often the watcher is dispatched", async () => {
        const id = await insertWatcher();
        let now = NOW;

        for (let round = 0; round < 4; round += 1) {
            await dispatch(now);
            await check(id, `<p>v${round}</p>`, now);

            const row = await readTrigger(id);

            expect(Object.hasOwn(row.eventState, "leasedAt")).toBe(false);
            expect(Object.hasOwn(row.eventState, "checkFailures")).toBe(false);
            now = row.nextTriggerAt + 1;
        }

        const final = await readTrigger(id);

        expect(final.enabled).toBe(true);
    });
});

describe("the active-watcher cap", () => {
    it("refuses a watcher past the cap, and counts only switched-on event triggers", async () => {
        await insertWatcher({ cronExpression: "0 9 * * *", type: "schedule" });
        await insertWatcher({ enabled: false });

        for (let index = 0; index < MAX_ACTIVE_EVENT_WATCHERS - 1; index += 1) {
            await insertWatcher();
        }

        await expect(harness.run(async (ctx: any) => await assertWatcherCapacity(ctx, USER))).resolves.toBeUndefined();

        await insertWatcher();

        await expect(harness.run(async (ctx: any) => await assertWatcherCapacity(ctx, USER))).rejects.toThrow("switched on at a time");
        await expect(harness.run(async (ctx: any) => await assertWatcherCapacity(ctx, "someone-else"))).resolves.toBeUndefined();
    });
});

describe("the thread scan", () => {
    const insertThread = async (): Promise<string> =>
        await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "T", userId: USER }));
    const insertRow = async (threadId: string, order: number, role: string, extra: Record<string, unknown> = {}): Promise<string> =>
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("messages", {
                    message: { content: [{ text: `${role} ${order}`, type: "text" }], role },
                    order,
                    status: "success",
                    stepOrder: 0,
                    threadId,
                    tool: false,
                    ...extra,
                }),
        );
    const scan = async (threadId: string, after?: { order: number; stepOrder: number }, userId = USER): Promise<any> =>
        await harness.run(async (ctx: any) => await ctx.runQuery(latestThreadReply, { after, now: NOW, threadId, userId }));

    it("takes the tip as the baseline, then reports a reply that landed after it", async () => {
        const threadId = await insertThread();

        await insertRow(threadId, 0, "user", { userId: USER });

        const first = await scan(threadId);

        expect(first).toEqual({ accessible: true, baseline: { order: 0, stepOrder: 0 } });

        await insertRow(threadId, 1, "assistant");

        const second = await scan(threadId, first.baseline);

        expect(second.reply).toMatchObject({ text: "assistant 1" });
        expect(second.baseline).toEqual({ order: 1, stepOrder: 0 });
        const later = await scan(threadId, second.baseline);

        expect(later.reply).toBeUndefined();
    });

    it("takes the newest settled row as the baseline even behind a reply still being written, so older replies never fire", async () => {
        const threadId = await insertThread();
        const rowIds: string[] = [];

        for (let order = 0; order < 25; order += 1) {
            const extra = order % 2 === 0 ? { userId: USER } : {};

            rowIds.push(await insertRow(threadId, order, order % 2 === 0 ? "user" : "assistant", order === 5 ? { status: "pending" } : extra));
        }

        const first = await scan(threadId);

        expect(first).toEqual({ accessible: true, baseline: { order: 24, stepOrder: 0 } });

        // The reply that was being written settles: it, and every reply before the newest row, was there when the watch began.
        await harness.run(async (ctx: any) => await ctx.db.patch(rowIds[5], { status: "success" }));

        const later = await scan(threadId, first.baseline);

        expect(later.reply).toBeUndefined();

        await insertRow(threadId, 25, "assistant");

        const fresh = await scan(threadId, first.baseline);

        expect(fresh.reply).toMatchObject({ text: "assistant 25" });
    });

    it("sees a reply past the sixtieth row of the order the baseline is in, then the later orders", async () => {
        const threadId = await insertThread();

        await insertRow(threadId, 0, "user", { userId: USER });

        let replyId = "";

        for (let step = 1; step <= 69; step += 1) {
            const id = await insertRow(threadId, 0, "assistant", { stepOrder: step, tool: step !== 65 });

            if (step === 65) {
                replyId = id;
            }
        }

        await insertRow(threadId, 1, "assistant", { stepOrder: 0, tool: true });

        const first = await scan(threadId, { order: 0, stepOrder: 0 });

        expect(first.reply).toBeUndefined();
        expect(first.baseline).toEqual({ order: 0, stepOrder: 60 });

        const second = await scan(threadId, first.baseline);

        expect(second.reply).toMatchObject({ id: replyId });
        expect(second.baseline).toEqual({ order: 1, stepOrder: 0 });
    });

    it("is not blocked by a reply stuck in pending since before the stream timeout", async () => {
        const threadId = await insertThread();

        await insertRow(threadId, 0, "user", { userId: USER });
        await insertRow(threadId, 1, "assistant", { status: "pending" });
        await insertRow(threadId, 2, "assistant");

        const result = await harness.run(
            async (ctx: any) => await ctx.runQuery(latestThreadReply, { after: { order: 0, stepOrder: 0 }, now: NOW + 60 * 60_000, threadId, userId: USER }),
        );

        expect(result.reply).toMatchObject({ text: "assistant 2" });
    });

    it("refuses a thread the watcher cannot read", async () => {
        const threadId = await insertThread();

        expect(await scan(threadId, undefined, "a-stranger")).toEqual({ accessible: false });
    });
});
