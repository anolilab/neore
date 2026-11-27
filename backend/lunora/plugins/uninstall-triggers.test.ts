import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { createPluginTrigger, purgeTriggerExecutions, TRIGGER_RUN_BATCH } from "../triggers/functions";
import { triggerRowHash } from "./entry-hash";
import { createInstallRow, finishInstall, recordCreated, recordIntent } from "./install-steps";
import { markerFor } from "./logic";
import { finishUninstallRows, TRIGGERS_PER_CALL, uninstallRows } from "./uninstall";

// The route table is `.global()` (D1), which the harness cannot store: the deletes are recorded instead.
const routeDeletes = vi.hoisted(() => [] as string[]);

vi.mock("../lib/shard-routes", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/shard-routes")>()),
        deleteShardRoute: async (_context: unknown, kind: string, value: string) => {
            routeDeletes.push(`${kind}:${value}`);
        },
        setShardRoute: async () => undefined,
    };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        rateLimitGuard: async () => undefined,
    };
});

const OWNER = "owner-a";
const SLUG = "daily-brief";
const HASH = "e".repeat(64);

const scheduled = (index: number) => {
    return { cronExpression: "0 9 * * *", model: "claude-haiku-5-5", name: `Daily ${String(index)}`, type: "schedule" as const };
};

describe("uninstall of triggers", () => {
    let harness: ReturnType<typeof lunoraTest>;

    beforeEach(async () => {
        routeDeletes.length = 0;

        const { loadAllFunctions } = await import("../_generated/functions");

        await loadAllFunctions();
        harness = lunoraTest(schema as never);
    });

    afterEach(() => {
        harness.close();
    });

    const run = async <T>(function_: (context: any) => Promise<T>): Promise<T> => await harness.run(async (context: any) => await function_(context));

    /** An installed plugin with `count` schedule triggers, each linked at the hash of its content. */
    const installed = async (count: number) => {
        const first = await run(
            async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }),
        );
        const { installId } = first;
        const triggerIds: string[] = [];

        for (let index = 0; index < count; index += 1) {
            const key = `trigger:${String(index)}`;
            const intentId = await run(
                async (context) =>
                    await context.runMutation(recordIntent, {
                        contentHash: await triggerRowHash(scheduled(index)),
                        entryKey: key,
                        generation: first.generation,
                        installId,
                        kind: "trigger",
                        userId: OWNER,
                    }),
            );
            const created = await run(
                async (context) =>
                    await context.runMutation(createPluginTrigger, {
                        ...scheduled(index),
                        plan: "premium",
                        pluginInstallId: installId,
                        pluginMarker: markerFor(installId, key),
                        userId: OWNER,
                    }),
            );

            await run(
                async (context) => await context.runMutation(recordCreated, { generation: first.generation, installId, intentId, itemId: created.triggerId }),
            );
            await run(async (context) => await context.db.patch("triggers", created.triggerId, { enabled: true }));
            triggerIds.push(created.triggerId);
        }

        await run(async (context) => await context.runMutation(finishInstall, { generation: first.generation, installId }));

        return { installId, triggerIds };
    };

    const addRuns = async (triggerId: string, count: number) => {
        for (let index = 0; index < count; index += 1) {
            await run(async (context) => await context.db.insert("triggerExecutions", { startedAt: 1000 + index, status: "completed", triggerId }));
        }
    };

    /** Calls finish until it says it is done, as the action does. */
    const finishAll = async (installId: string, generation: number) => {
        const kept: string[] = [];
        let removed = 0;
        let calls = 0;

        for (let call = 0; call < 20; call += 1) {
            const finished = await run(async (context) => await finishUninstallRows(context, installId, generation, { pendingSkills: [], settled: call > 0 }));

            calls += 1;
            kept.push(...finished.kept);
            removed += finished.removed;

            if (!finished.hasMore) {
                break;
            }
        }

        return { calls, kept, removed };
    };

    it("deletes an unedited trigger with its runs and its webhook route", async () => {
        const { triggerIds } = await installed(1);
        const [triggerId] = triggerIds;

        await addRuns(triggerId!, 3);

        const begun = await run(async (context) => await uninstallRows(context, OWNER, SLUG));

        // Begin only switches it off.
        expect(await run(async (context) => await context.db.triggers.findFirst({ where: { _id: triggerId } }))).toMatchObject({ enabled: false });

        const result = await finishAll(begun.installId, begun.generation);

        expect(result).toMatchObject({ kept: [], removed: 1 });
        expect(await run(async (context) => await context.db.triggers.findFirst({ where: { _id: triggerId } }))).toBeNull();

        const { page: runs } = await run(async (context) => await context.db.triggerExecutions.findMany({ where: { triggerId } }));

        expect(runs).toHaveLength(0);
        expect(routeDeletes).toEqual([`trigger:${triggerId}`]);
        expect(await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: begun.installId } }))).toBeNull();
    });

    it("keeps an edited trigger, switched off and detached, and reports it by name", async () => {
        const { triggerIds } = await installed(2);
        const [edited, untouched] = triggerIds;

        await run(async (context) => await context.db.patch("triggers", edited, { description: "Changed by the owner." }));
        await addRuns(edited!, 2);

        const begun = await run(async (context) => await uninstallRows(context, OWNER, SLUG));
        const result = await finishAll(begun.installId, begun.generation);

        expect(result).toMatchObject({ kept: ["Daily 0"], removed: 1 });
        expect(await run(async (context) => await context.db.triggers.findFirst({ where: { _id: edited } }))).toMatchObject({
            enabled: false,
            pluginInstallId: "",
            pluginMarker: "",
        });
        expect(await run(async (context) => await context.db.triggers.findFirst({ where: { _id: untouched } }))).toBeNull();

        const { page: runs } = await run(async (context) => await context.db.triggerExecutions.findMany({ where: { triggerId: edited } }));

        expect(runs).toHaveLength(2);
        expect(routeDeletes).toEqual([`trigger:${untouched}`]);
    });

    it("deletes more triggers than one call handles over several calls, the install last", async () => {
        const count = TRIGGERS_PER_CALL * 2 + 1;
        const { triggerIds } = await installed(count);
        const begun = await run(async (context) => await uninstallRows(context, OWNER, SLUG));

        const first = await run(async (context) => await finishUninstallRows(context, begun.installId, begun.generation, { pendingSkills: [] }));

        expect(first).toMatchObject({ hasMore: true, removed: TRIGGERS_PER_CALL });
        expect(await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: begun.installId } }))).not.toBeNull();

        const rest = await finishAll(begun.installId, begun.generation);

        expect(rest.removed).toBe(count - TRIGGERS_PER_CALL);

        for (const triggerId of triggerIds) {
            expect(await run(async (context) => await context.db.triggers.findFirst({ where: { _id: triggerId } }))).toBeNull();
        }

        expect(routeDeletes).toHaveLength(count);
        expect(await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: begun.installId } }))).toBeNull();
    });

    it("deletes a trigger with very many runs in one call and leaves the rest to a scheduled purge", async () => {
        const { triggerIds } = await installed(1);
        const [triggerId] = triggerIds;

        await addRuns(triggerId!, 1000);

        const begun = await run(async (context) => await uninstallRows(context, OWNER, SLUG));
        const first = await run(async (context) => await finishUninstallRows(context, begun.installId, begun.generation, { pendingSkills: [] }));

        expect(first).toMatchObject({ removed: 1 });
        expect(await run(async (context) => await context.db.triggers.findFirst({ where: { _id: triggerId } }))).toBeNull();

        const left = async () => {
            const { page } = await run(async (context) => await context.db.triggerExecutions.findMany({ where: { triggerId } }));

            return page.length;
        };

        expect(await left()).toBe(1000 - TRIGGER_RUN_BATCH);
        expect(harness.scheduler.list().map((job) => job.args)).toContainEqual({ triggerId });

        for (let call = 0; call < 10 && (await left()) > 0; call += 1) {
            await run(async (context) => await context.runMutation(purgeTriggerExecutions, { triggerId }));
        }

        expect(await left()).toBe(0);
        expect(await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: begun.installId } }))).toBeNull();
    });
});
