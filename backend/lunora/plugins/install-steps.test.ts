import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { createInstallRow, deleteInstall, finishInstall, markNeedsRepair, recordCreated, recordIntent } from "./install-steps";

const OWNER = "owner-a";
const HASH = "b".repeat(64);

const start = { contentHash: HASH, pluginSlug: "daily-brief", userId: OWNER, version: "1.0.0" };

describe("install steps", () => {
    let harness: ReturnType<typeof lunoraTest>;

    beforeEach(async () => {
        // The registry is lazy: a function is registered only once its module has been evaluated.
        const { loadAllFunctions } = await import("../_generated/functions");

        await loadAllFunctions();
        harness = lunoraTest(schema as never);
    });

    afterEach(() => {
        harness.close();
    });

    const run = async <T>(fn: (context: any) => Promise<T>): Promise<T> => await harness.run(async (context: any) => await fn(context));

    it("refuses a second install of the same plugin for the same person", async () => {
        await run(async (context) => await context.runMutation(createInstallRow, start));

        await expect(run(async (context) => await context.runMutation(createInstallRow, start))).rejects.toThrow("already installed");
    });

    it("links each child from intent to created, then finishes the install", async () => {
        const { generation, installId } = await run(async (context) => await context.runMutation(createInstallRow, start));

        const intentId = await run(
            async (context) =>
                await context.runMutation(recordIntent, { contentHash: HASH, entryKey: "skill:1", generation, installId, kind: "skill", userId: OWNER }),
        );

        await run(async (context) => await context.runMutation(recordCreated, { generation, installId, intentId, itemId: "skill-row-1" }));
        await run(async (context) => await context.runMutation(finishInstall, { generation, installId }));

        const install = await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: installId } }));
        const link = await run(async (context) => await context.db.pluginItems.findFirst({ where: { _id: intentId } }));

        expect(install).toMatchObject({ generation, status: "installed" });
        expect(link).toMatchObject({ itemId: "skill-row-1", state: "created" });
    });

    it("writes nothing from a stale generation", async () => {
        const { installId } = await run(async (context) => await context.runMutation(createInstallRow, start));

        await expect(
            run(
                async (context) =>
                    await context.runMutation(recordIntent, { contentHash: HASH, entryKey: "skill:1", generation: 2, installId, kind: "skill", userId: OWNER }),
            ),
        ).rejects.toThrow("STALE_LEASE");

        const links = await run(async (context) => (await context.db.pluginItems.findMany({ where: { installId } })).page);

        expect(links).toHaveLength(0);
    });

    it("keeps the rows and marks the install for repair", async () => {
        const { generation, installId } = await run(async (context) => await context.runMutation(createInstallRow, start));

        await run(async (context) => await context.runMutation(markNeedsRepair, { generation, installId }));

        const install = await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: installId } }));

        expect(install).toMatchObject({ status: "needs-repair" });
    });

    it("rolls back: the links and the install are removed", async () => {
        const { generation, installId } = await run(async (context) => await context.runMutation(createInstallRow, start));

        await run(
            async (context) =>
                await context.runMutation(recordIntent, { contentHash: HASH, entryKey: "skill:1", generation, installId, kind: "skill", userId: OWNER }),
        );
        await run(async (context) => await context.runMutation(deleteInstall, { generation, installId }));

        const install = await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: installId } }));
        const links = await run(async (context) => (await context.db.pluginItems.findMany({ where: { installId } })).page);

        expect(install).toBeNull();
        expect(links).toHaveLength(0);
    });
});
