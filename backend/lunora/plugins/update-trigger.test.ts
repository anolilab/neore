import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { createPluginTrigger } from "../triggers/functions";
import { triggerRowHash } from "./entry-hash";
import { createInstallRow, finishInstall, recordCreated, recordIntent } from "./install-steps";
import { markerFor } from "./logic";
import { updateTriggerChild } from "./update-apply";

// The route table is `.global()` (D1), which the harness cannot store; routing is not under test here.
vi.mock("../lib/shard-routes", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/shard-routes")>()),
        deleteShardRoute: async () => undefined,
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
const INSTALL_KEY = "trigger:0";
const DAILY = { cronExpression: "0 9 * * *", model: "claude-haiku-5-5", name: "Daily summary", type: "schedule" as const };
const REVISED = { ...DAILY, cronExpression: "0 10 * * *", name: "Morning summary" };

describe("updating a trigger in place", () => {
    let harness: ReturnType<typeof lunoraTest>;

    beforeEach(async () => {
        const { loadAllFunctions } = await import("../_generated/functions");

        await loadAllFunctions();
        harness = lunoraTest(schema as never);
    });

    afterEach(() => {
        harness.close();
    });

    const run = async <T>(fn: (context: any) => Promise<T>): Promise<T> => await harness.run(async (context: any) => await fn(context));

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

        expect(trigger).toMatchObject({ cronExpression: "0 9 * * *", enabled: true, description: "Changed by the owner." });
    });
});
