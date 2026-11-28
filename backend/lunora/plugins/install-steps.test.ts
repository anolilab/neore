import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ROOT_SHARD_KEY, runInShard } from "../lib/shard-context";
import schema from "../schema";
import { removeImportedItem } from "../skills/bundle";
import { createInstallRow, deleteInstall, finishInstall, markNeedsRepair, recordCreated, recordIntent } from "./install-steps";

const OWNER = "owner-a";
const HASH = "b".repeat(64);

const installRow = { contentHash: HASH, generation: 1, installedAt: 0, pluginSlug: "daily-brief", status: "installed", updatedAt: 0, version: "1.0.0" };
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

    const run = async <T>(function_: (context: any) => Promise<T>): Promise<T> => await harness.run(async (context: any) => await function_(context));

    it("refuses a second install of the same plugin for the same person", async () => {
        await run(async (context) => await context.runMutation(createInstallRow, start));

        await expect(run(async (context) => await context.runMutation(createInstallRow, start))).rejects.toThrow("already installed");
    });

    it("holds one install per person and plugin in a slot row the database keeps unique", async () => {
        const { installId } = await run(async (context) => await context.runMutation(createInstallRow, start));

        const slot = { createdAt: 0, installId: "x", pluginSlug: "daily-brief" };
        const { page } = await run(async (context) => await context.db.pluginInstallSlots.findMany({}));

        expect(page).toHaveLength(1);
        expect(page[0]).toMatchObject({ installId, pluginSlug: "daily-brief", userId: OWNER });
        await expect(run(async (context) => await context.db.insert("pluginInstallSlots", { ...slot, userId: OWNER }))).rejects.toMatchObject({
            kind: "unique",
        });
        await run(async (context) => await context.db.insert("pluginInstallSlots", { ...slot, userId: "owner-b" }));
    });

    it("lets a reinstall through a slot that names an install that is gone", async () => {
        await run(async (context) => await context.db.insert("pluginInstalls", { ...installRow, userId: OWNER }));
        const installs = await run(async (context) => await context.db.pluginInstalls.findMany({}));

        await run(
            async (context) =>
                await context.db.insert("pluginInstallSlots", { createdAt: 0, installId: installs.page[0]._id, pluginSlug: "daily-brief", userId: OWNER }),
        );
        await run(async (context) => await context.db.delete("pluginInstalls", installs.page[0]._id));
        // The slot names an install that is gone: a leftover, so a reinstall goes through.
        await run(async (context) => await context.runMutation(createInstallRow, start));

        const { page } = await run(async (context) => await context.db.pluginInstallSlots.findMany({}));

        expect(page).toHaveLength(1);
    });

    it("refuses while a slot of an unfinished create is younger than the lease, and takes it over once older", async () => {
        await run(async (context) => await context.db.insert("pluginInstallSlots", { createdAt: Date.now(), pluginSlug: "daily-brief", userId: OWNER }));

        await expect(run(async (context) => await context.runMutation(createInstallRow, start))).rejects.toThrow("already installed");

        await run(async (context) => {
            const { page } = await context.db.pluginInstallSlots.findMany({});

            await context.db.patch("pluginInstallSlots", page[0]._id, { createdAt: 0 });
        });

        const created = await run(async (context) => await context.runMutation(createInstallRow, start));
        const { page } = await run(async (context) => await context.db.pluginInstallSlots.findMany({}));

        expect(page).toHaveLength(1);
        expect(page[0].installId).toBe(created.installId);
    });

    it("deletes the slot with the install on a rollback", async () => {
        const { generation, installId } = await run(async (context) => await context.runMutation(createInstallRow, start));

        await run(async (context) => await context.runMutation(deleteInstall, { generation, installId }));

        const { page } = await run(async (context) => await context.db.pluginInstallSlots.findMany({}));

        expect(page).toHaveLength(0);
    });

    it("keeps a child when the rollback that deletes it no longer holds the install", async () => {
        const { generation, installId } = await run(async (context) => await context.runMutation(createInstallRow, start));
        const skillId = await run(
            async (context) => await context.db.insert("skills", { description: "d", instructions: "i", name: "Kept", slug: "kept", userId: OWNER }),
        );

        const outcome = await run(
            async (context) =>
                await context.runMutation(removeImportedItem, { id: skillId, kind: "skill", lease: { generation: generation + 1, installId }, userId: OWNER }),
        );
        const skill = await run(async (context) => await context.db.skills.findFirst({ where: { _id: skillId } }));

        expect(outcome).toStrictEqual({ kept: true, leaseLost: true });
        expect(skill).not.toBeNull();
    });

    it("refuses to start an install on the root shard or another person's shard", async () => {
        for (const shard of [ROOT_SHARD_KEY, "someone-else"]) {
            await expect(runInShard(shard, async () => await run(async (context) => await context.runMutation(createInstallRow, start)))).rejects.toThrow(
                "owner's shard",
            );
        }
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

        const links = await run(async (context) => {
            const { page } = await context.db.pluginItems.findMany({ where: { installId } });

            return page;
        });

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
        const links = await run(async (context) => {
            const { page } = await context.db.pluginItems.findMany({ where: { installId } });

            return page;
        });

        expect(install).toBeNull();
        expect(links).toHaveLength(0);
    });
});
