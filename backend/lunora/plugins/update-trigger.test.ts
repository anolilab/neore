import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { patchRow } from "../lib/patch";
import { createPluginTrigger } from "../triggers/functions";
import { triggerRowHash } from "./entry-hash";
import { createInstallRow, finishInstall, recordCreated, recordIntent } from "./install-steps";
import { markerFor } from "./logic";
import { updateTriggerChild } from "./update-apply";

// The route table is `.global()` (D1), which the harness cannot store; routing is not under test here.
const routes = vi.hoisted(() => {
    return { deleted: [] as string[], set: [] as string[] };
});

vi.mock("../lib/shard-routes", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/shard-routes")>()),
        deleteShardRoute: async (_context: unknown, _kind: string, id: string) => {
            routes.deleted.push(id);
        },
        setShardRoute: async (_context: unknown, _kind: string, id: string) => {
            routes.set.push(id);
        },
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
const INSTALL_KEY = "trigger:0";
const DAILY = { cronExpression: "0 9 * * *", model: "claude-haiku-5-5", name: "Daily summary", type: "schedule" as const };
const REVISED = { ...DAILY, cronExpression: "0 10 * * *", name: "Morning summary" };

describe("updating a trigger in place", () => {
    let harness: ReturnType<typeof lunoraTest>;

    beforeEach(async () => {
        const { loadAllFunctions } = await import("../_generated/functions");

        await loadAllFunctions();
        routes.deleted.length = 0;
        routes.set.length = 0;
        harness = lunoraTest(schema as never);
    });

    afterEach(() => {
        harness.close();
    });

    const run = async <T>(function_: (context: any) => Promise<T>): Promise<T> => await harness.run(async (context: any) => await function_(context));

    /** An installed plugin with one schedule trigger, enabled by the person. */
    const installed = async () => {
        const first = await run(
            async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }),
        );
        const { installId } = first;
        const intentId = await run(
            async (context) =>
                await context.runMutation(recordIntent, {
                    contentHash: await triggerRowHash(DAILY),
                    entryKey: INSTALL_KEY,
                    generation: first.generation,
                    installId,
                    kind: "trigger",
                    userId: OWNER,
                }),
        );
        const triggerId = await run(
            async (context) =>
                await context.runMutation(createPluginTrigger, {
                    ...DAILY,
                    plan: "premium",
                    pluginInstallId: installId,
                    pluginMarker: markerFor(installId, INSTALL_KEY),
                    userId: OWNER,
                }),
        );

        await run(
            async (context) => await context.runMutation(recordCreated, { generation: first.generation, installId, intentId, itemId: triggerId.triggerId }),
        );
        await run(async (context) => await context.runMutation(finishInstall, { generation: first.generation, installId }));
        await run(async (context) => await context.db.patch("triggers", triggerId.triggerId, { enabled: true }));

        return { installId, intentId, triggerId: triggerId.triggerId };
    };

    const update = (installId: string, generation: number, contentHash: string) =>
        run(
            async (context) =>
                await context.runMutation(updateTriggerChild, {
                    contentHash,
                    cronExpression: REVISED.cronExpression,
                    entryKey: INSTALL_KEY,
                    generation,
                    installId,
                    model: REVISED.model,
                    name: REVISED.name,
                    type: REVISED.type,
                    userId: OWNER,
                }),
        );

    it("rewrites an unedited trigger, switches it off, and records the new hash", async () => {
        const { installId, intentId, triggerId } = await installed();

        await update(installId, 1, await triggerRowHash(REVISED));

        const trigger = await run(async (context) => await context.db.triggers.findFirst({ where: { _id: triggerId } }));
        const link = await run(async (context) => await context.db.pluginItems.findFirst({ where: { _id: intentId } }));

        expect(trigger).toMatchObject({ cronExpression: "0 10 * * *", enabled: false, name: "Morning summary" });
        expect(link).toMatchObject({ contentHash: await triggerRowHash(REVISED), pendingHash: "" });
    });

    it("refuses to rewrite a trigger the person has edited, and leaves it as it is", async () => {
        const { installId, triggerId } = await installed();

        await run(async (context) => await context.db.patch("triggers", triggerId, { description: "Changed by the owner." }));

        await expect(update(installId, 1, await triggerRowHash(REVISED))).rejects.toThrow("was edited");

        const trigger = await run(async (context) => await context.db.triggers.findFirst({ where: { _id: triggerId } }));

        expect(trigger).toMatchObject({ cronExpression: "0 9 * * *", description: "Changed by the owner.", enabled: true });
    });

    it("drops the due time of the old schedule when the cron changes, so re-enabling cannot fire once on it", async () => {
        const { installId, triggerId } = await installed();

        await run(async (context) => await context.db.patch("triggers", triggerId, { nextTriggerAt: Date.now() + 3_600_000 }));
        await update(installId, 1, await triggerRowHash(REVISED));

        const trigger = await run(async (context) => await context.db.triggers.findFirst({ where: { _id: triggerId } }));

        expect(trigger?.nextTriggerAt).toBeUndefined();
    });

    it("keeps the due time when the update leaves the schedule as it was", async () => {
        const { installId, triggerId } = await installed();
        const due = Date.now() + 3_600_000;

        await run(async (context) => await context.db.patch("triggers", triggerId, { nextTriggerAt: due }));
        await run(
            async (context) =>
                await context.runMutation(updateTriggerChild, {
                    contentHash: await triggerRowHash({ ...DAILY, name: "Renamed" }),
                    cronExpression: DAILY.cronExpression,
                    entryKey: INSTALL_KEY,
                    generation: 1,
                    installId,
                    model: DAILY.model,
                    name: "Renamed",
                    type: DAILY.type,
                    userId: OWNER,
                }),
        );

        const kept = await run(async (context) => await context.db.triggers.findFirst({ where: { _id: triggerId } }));

        expect(kept?.nextTriggerAt).toBe(due);
    });
});

const HOOK = {
    filters: [{ op: "equals" as const, path: "action", value: "opened" }],
    model: "claude-haiku-5-5",
    name: "Hook",
    type: "webhook" as const,
    webhookSignatureScheme: "timestamped" as const,
};

describe("rewriting a trigger of any type", () => {
    let harness: ReturnType<typeof lunoraTest>;

    beforeEach(async () => {
        const { loadAllFunctions } = await import("../_generated/functions");

        await loadAllFunctions();
        routes.deleted.length = 0;
        routes.set.length = 0;
        harness = lunoraTest(schema as never);
    });

    afterEach(() => {
        harness.close();
    });

    const run = async <T>(function_: (context: any) => Promise<T>): Promise<T> => await harness.run(async (context: any) => await function_(context));

    /** An installed plugin with one trigger of the given content, as install creates it. */
    const installedWith = async (content: Record<string, unknown>) => {
        const first = await run(
            async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }),
        );
        const { installId } = first;
        const intentId = await run(
            async (context) =>
                await context.runMutation(recordIntent, {
                    contentHash: await triggerRowHash(content as never),
                    entryKey: INSTALL_KEY,
                    generation: first.generation,
                    installId,
                    kind: "trigger",
                    userId: OWNER,
                }),
        );
        const created = await run(
            async (context) =>
                await context.runMutation(createPluginTrigger, {
                    ...content,
                    plan: "premium",
                    pluginInstallId: installId,
                    pluginMarker: markerFor(installId, INSTALL_KEY),
                    userId: OWNER,
                } as never),
        );

        await run(
            async (context) => await context.runMutation(recordCreated, { generation: first.generation, installId, intentId, itemId: created.triggerId }),
        );
        await run(async (context) => await context.runMutation(finishInstall, { generation: first.generation, installId }));
        await run(async (context) => await context.db.patch("triggers", created.triggerId, { enabled: true }));

        return { installId, intentId, triggerId: created.triggerId as string };
    };

    const rewrite = (installId: string, content: Record<string, any>) =>
        run(
            async (context) =>
                await context.runMutation(updateTriggerChild, {
                    ...content,
                    contentHash: await triggerRowHash(content as never),
                    entryKey: INSTALL_KEY,
                    generation: 1,
                    installId,
                    userId: OWNER,
                } as never),
        );

    const triggers = async () => {
        const { page } = await run(async (context) => await context.db.triggers.findMany({ where: { userId: OWNER } }));

        return page as any[];
    };

    it("rewrites a webhook in place: same id, secret and route, filters stored as creation stores them", async () => {
        const { installId, triggerId } = await installedWith(HOOK);
        const [before] = await triggers();
        const revised = {
            ...HOOK,
            filters: [{ op: "exists" as const, path: "pull_request" }],
            inputTemplate: "Review {{payload}}",
            name: "Renamed hook",
        };

        const result = await rewrite(installId, revised);
        const after = await triggers();

        expect(result.webhookSecret).toBeUndefined();
        expect(after).toHaveLength(1);
        expect(after[0]).toMatchObject({
            _id: triggerId,
            enabled: false,
            filters: revised.filters,
            inputTemplate: "Review {{payload}}",
            name: "Renamed hook",
            webhookSignatureScheme: "timestamped",
        });
        expect(after[0].webhookSecret).toBe(before.webhookSecret);
        expect(routes.deleted).toStrictEqual([]);
        expect(await triggerRowHash(after[0])).toBe(await triggerRowHash(revised));
    });

    it("replaces a webhook whose signature scheme changes, with a new secret returned once, since the scheme is fixed with the secret", async () => {
        const { installId, triggerId } = await installedWith(HOOK);
        const [before] = await triggers();
        const revised = { ...HOOK, name: "Native hook", webhookSignatureScheme: "native" as const };

        const result = await rewrite(installId, revised);
        const after = await triggers();

        expect(typeof result.webhookSecret).toBe("string");
        expect(after).toHaveLength(1);
        expect(after[0]._id).not.toBe(triggerId);
        expect(after[0]).toMatchObject({ pluginMarker: markerFor(installId, INSTALL_KEY), webhookSignatureScheme: "native" });
        expect(after[0].webhookSecret).not.toBe(before.webhookSecret);
        expect(await triggerRowHash(after[0])).toBe(await triggerRowHash(revised));
    });

    it("drops the filters a new version leaves out of a webhook", async () => {
        const { installId } = await installedWith(HOOK);
        const revised = { ...HOOK, filters: undefined, name: "No filters" };

        await rewrite(installId, revised);

        const [after] = await triggers();

        expect(after.filters).toBeUndefined();
        expect(await triggerRowHash(after)).toBe(await triggerRowHash(revised));
    });

    it("refuses a webhook template that could render past the prompt limit, as creation does", async () => {
        const { installId, triggerId } = await installedWith(HOOK);

        await expect(rewrite(installId, { ...HOOK, inputTemplate: `{{payload}} ${"{{payload}} ".repeat(400)}` })).rejects.toThrow();

        const [after] = await triggers();

        expect(after).toMatchObject({ _id: triggerId, enabled: true });
    });

    it("keeps an edited webhook as it is", async () => {
        const { installId, triggerId } = await installedWith(HOOK);

        await run(async (context) => await context.db.patch("triggers", triggerId, { description: "Changed by the owner." }));
        await expect(rewrite(installId, { ...HOOK, name: "Renamed hook" })).rejects.toThrow("was edited");

        const [after] = await triggers();

        expect(after).toMatchObject({ description: "Changed by the owner.", enabled: true, name: "Hook" });
    });

    it("turns a schedule into a webhook in one step: old row gone, new row marked and routed, secret returned once", async () => {
        const { installId, intentId, triggerId } = await installedWith(DAILY);

        await run(
            async (context) => await context.db.insert("triggerExecutions", { startedAt: Date.now(), status: "running", triggerId, userId: OWNER } as never),
        );

        const result = await rewrite(installId, HOOK);
        const after = await triggers();
        const executions = await run(async (context) => await context.db.triggerExecutions.findMany({ where: { triggerId } }));
        const link = await run(async (context) => await context.db.pluginItems.findFirst({ where: { _id: intentId } }));

        expect(typeof result.webhookSecret).toBe("string");
        expect(after).toHaveLength(1);
        expect(after[0]._id).not.toBe(triggerId);
        expect(after[0]).toMatchObject({ enabled: false, pluginInstallId: installId, pluginMarker: markerFor(installId, INSTALL_KEY), type: "webhook" });
        expect(after[0].cronExpression).toBeUndefined();
        expect(executions.page).toHaveLength(0);
        expect(routes.deleted).toContain(triggerId);
        expect(routes.set).toContain(after[0]._id);
        expect(link).toMatchObject({ contentHash: await triggerRowHash(HOOK), itemId: after[0]._id, pendingHash: "" });
        expect(await triggerRowHash(after[0])).toBe(await triggerRowHash(HOOK));
    });

    it("turns a webhook into a schedule, and leaves an edited webhook alone when the type changes", async () => {
        const { installId, triggerId } = await installedWith(HOOK);

        await run(async (context) => await context.db.patch("triggers", triggerId, { description: "Changed by the owner." }));
        await expect(rewrite(installId, DAILY)).rejects.toThrow("was edited");
        const [unchanged] = await triggers();

        expect(unchanged._id).toBe(triggerId);

        // Back to the installed content: the description the owner added is removed again.
        await run(async (context) => await patchRow(context.db, "triggers", unchanged, { description: undefined }));

        const result = await rewrite(installId, DAILY);
        const [after] = await triggers();

        expect(result.webhookSecret).toBeUndefined();
        expect(after).toMatchObject({ cronExpression: DAILY.cronExpression, type: "schedule" });
        expect(after.webhookSecret).toBeUndefined();
        expect(routes.deleted).toContain(triggerId);
    });

    it("rewrites nothing while the account is being deleted", async () => {
        const { installId } = await installedWith(DAILY);

        await run(async (context) => await context.db.insert("accountMoves", { createdAt: Date.now(), kind: "erasing", userId: OWNER }));
        await expect(rewrite(installId, HOOK)).rejects.toThrow("being deleted");
    });
});
