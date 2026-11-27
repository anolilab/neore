import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { createPluginSkill } from "../skills/create-skill";
import { createInstallRow, finishInstall, markNeedsRepair, recordCreated, recordIntent } from "./install-steps";
import { skillRowHash } from "./entry-hash";
import { repairRows } from "./repair";
import { markerFor } from "./logic";
import { ROOT_SHARD_KEY, runInShard } from "../lib/shard-context";

const OWNER = "owner-a";
const HASH = "d".repeat(64);
const SLUG = "daily-brief";

describe("repair", () => {
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

    it("links a child that was created before its link was written, and returns the install to installed", async () => {
        const { generation, installId } = await run(
            async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }),
        );

        const intentId = await run(
            async (context) =>
                await context.runMutation(recordIntent, { contentHash: HASH, entryKey: "skill:analyst", generation, installId, kind: "skill", userId: OWNER }),
        );

        // The crash: the skill is created with its marker, and the process dies before the link is written.
        const skillId = await run(
            async (context) =>
                await context.runMutation(createPluginSkill, {
                    description: "Analyst",
                    instructions: "Analyse.",
                    isPremium: true,
                    name: "Analyst",
                    plan: "premium",
                    pluginInstallId: installId,
                    pluginMarker: markerFor(installId, "skill:analyst"),
                    slug: "analyst",
                    source: { type: "plugin" as const, version: "1.0.0" },
                    userId: OWNER,
                }),
        );

        await run(async (context) => await context.runMutation(markNeedsRepair, { generation, installId }));

        const result = await run(async (context) => await repairRows(context, OWNER, SLUG));

        expect(result).toEqual({ linked: 1, missing: [], status: "installed" });

        const link = await run(async (context) => await context.db.pluginItems.findFirst({ where: { _id: intentId } }));
        const install = await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: installId } }));

        expect(link).toMatchObject({ itemId: skillId, state: "created" });
        expect(install).toMatchObject({ status: "installed" });
    });

    it("stays in needs-repair and names the entry when its child was never created", async () => {
        const { generation, installId } = await run(
            async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }),
        );

        await run(
            async (context) =>
                await context.runMutation(recordIntent, { contentHash: HASH, entryKey: "skill:ghost", generation, installId, kind: "skill", userId: OWNER }),
        );
        await run(async (context) => await context.runMutation(markNeedsRepair, { generation, installId }));

        const result = await run(async (context) => await repairRows(context, OWNER, SLUG));

        expect(result).toEqual({ linked: 0, missing: ["skill:ghost"], status: "needs-repair" });
    });

    it("refuses to repair an install that does not need it", async () => {
        await run(async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }));

        await expect(run(async (context) => await repairRows(context, OWNER, SLUG))).rejects.toThrow("still being installed");
    });

    it("refuses to run on the root shard or another person's shard, where every trigger and group would read as gone", async () => {
        const { generation, installId } = await run(
            async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }),
        );

        await run(async (context) => await context.runMutation(markNeedsRepair, { generation, installId }));

        for (const shard of [ROOT_SHARD_KEY, "someone-else"]) {
            await expect(runInShard(shard, async () => await run(async (context) => await repairRows(context, OWNER, SLUG)))).rejects.toThrow("owner's shard");
        }
    });

    it("sets the target version when finishing an update that was kept for repair", async () => {
        const { generation, installId } = await run(
            async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }),
        );

        await run(async (context) => await context.db.patch("pluginInstalls", installId, { targetVersion: "1.1.0" }));
        await run(async (context) => await context.runMutation(finishInstall, { generation, installId }));

        const install = await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: installId } }));

        expect(install).toMatchObject({ status: "installed", version: "1.1.0" });
        expect(install?.targetVersion).toBeUndefined();
    });

    it("sets the target version when repair finds nothing missing", async () => {
        const { generation, installId } = await run(
            async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }),
        );

        await run(async (context) => await context.runMutation(markNeedsRepair, { generation, installId }));
        await run(async (context) => await context.db.patch("pluginInstalls", installId, { targetVersion: "1.1.0" }));
        await run(async (context) => await repairRows(context, OWNER, SLUG));

        const install = await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: installId } }));

        expect(install).toMatchObject({ status: "installed", version: "1.1.0" });
        expect(install?.targetVersion).toBeUndefined();
    });

    it("refuses an install that finished", async () => {
        const { generation, installId } = await run(
            async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }),
        );

        await run(async (context) => await context.runMutation(finishInstall, { generation, installId }));

        await expect(run(async (context) => await repairRows(context, OWNER, SLUG))).rejects.toThrow("does not need repair");
    });

    it("repairs an install whose action died, once its lease has expired", async () => {
        const { generation, installId } = await run(
            async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }),
        );

        await run(
            async (context) =>
                await context.runMutation(recordIntent, { contentHash: HASH, entryKey: "skill:ghost", generation, installId, kind: "skill", userId: OWNER }),
        );
        await run(async (context) => await context.db.patch("pluginInstalls", installId, { leaseUntil: Date.now() - 1000 }));

        const result = await run(async (context) => await repairRows(context, OWNER, SLUG));

        expect(result).toEqual({ linked: 0, missing: ["skill:ghost"], status: "needs-repair" });
        expect(await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: installId } }))).toMatchObject({
            status: "needs-repair",
        });
    });

    it("puts a row whose child is gone back to intent, so it is created again", async () => {
        const { generation, installId } = await run(
            async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }),
        );
        const intentId = await run(
            async (context) =>
                await context.runMutation(recordIntent, { contentHash: HASH, entryKey: "skill:gone", generation, installId, kind: "skill", userId: OWNER }),
        );

        // Rolled back: the link still says `created`, but no skill carries the marker.
        await run(async (context) => await context.runMutation(recordCreated, { generation, installId, intentId, itemId: "deleted-skill" }));
        await run(async (context) => await context.runMutation(markNeedsRepair, { generation, installId }));

        const result = await run(async (context) => await repairRows(context, OWNER, SLUG));

        expect(result).toEqual({ linked: 0, missing: ["skill:gone"], status: "needs-repair" });

        const link = await run(async (context) => await context.db.pluginItems.findFirst({ where: { _id: intentId } }));

        expect(link).toMatchObject({ state: "intent" });
        expect(link?.itemId).toBeUndefined();
    });
    describe("an update that stopped part-way", () => {
        const ANALYST = { description: "Analyst", instructions: "Analyse.", name: "Analyst", slug: "analyst" };
        const REVISED = { ...ANALYST, instructions: "Analyse in detail." };

        /** An installed plugin with one skill, then a stopped update: pending hash set, lease expired. */
        const stoppedUpdate = async (skillWritten: boolean) => {
            const first = await run(
                async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }),
            );
            const { installId } = first;
            const intentId = await run(
                async (context) =>
                    await context.runMutation(recordIntent, {
                        contentHash: await skillRowHash(ANALYST),
                        entryKey: "skill:analyst",
                        generation: first.generation,
                        installId,
                        kind: "skill",
                        userId: OWNER,
                    }),
            );
            const skillId = await run(
                async (context) =>
                    await context.runMutation(createPluginSkill, {
                        ...ANALYST,
                        isPremium: true,
                        plan: "premium",
                        pluginInstallId: installId,
                        pluginMarker: markerFor(installId, "skill:analyst"),
                        source: { type: "plugin" as const, version: "1.0.0" },
                        userId: OWNER,
                    }),
            );

            await run(async (context) => await context.runMutation(recordCreated, { generation: first.generation, installId, intentId, itemId: skillId }));
            await run(async (context) => await context.runMutation(finishInstall, { generation: first.generation, installId }));

            // The update: the pending hash is set, the skill may or may not have been written, and the process stops.
            await run(async (context) => await context.db.patch("pluginItems", intentId, { pendingHash: await skillRowHash(REVISED) }));

            if (skillWritten) {
                await run(async (context) => await context.db.patch("skills", skillId, { instructions: REVISED.instructions }));
            }

            await run(
                async (context) =>
                    await context.db.patch("pluginInstalls", installId, { leaseUntil: Date.now() - 1000, status: "updating", targetVersion: "1.1.0" }),
            );

            return { installId, intentId };
        };

        it("records a child whose write finished, and returns the install at its old version so the update runs again", async () => {
            const { installId, intentId } = await stoppedUpdate(true);

            const result = await run(async (context) => await repairRows(context, OWNER, SLUG));

            expect(result).toEqual({ linked: 1, missing: [], status: "installed" });

            const link = await run(async (context) => await context.db.pluginItems.findFirst({ where: { _id: intentId } }));
            const install = await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: installId } }));

            expect(link).toMatchObject({ contentHash: await skillRowHash(REVISED), pendingHash: "" });
            expect(install).toMatchObject({ contentHash: HASH, status: "installed", version: "1.0.0" });
            expect(install?.targetVersion).toBeUndefined();
        });

        it("drops the intent of a new child the update never made, and keeps the install at its old version", async () => {
            const { installId } = await stoppedUpdate(true);

            await run(
                async (context) =>
                    await context.db.insert("pluginItems", {
                        contentHash: HASH,
                        createdAt: Date.now(),
                        entryKey: "skill:new",
                        installId,
                        kind: "skill",
                        state: "intent",
                        userId: OWNER,
                    }),
            );

            await run(async (context) => await repairRows(context, OWNER, SLUG));

            const rows = await run(async (context) => (await context.db.pluginItems.findMany({ where: { installId } })).page);

            expect(rows.map((row: { entryKey: string }) => row.entryKey)).toEqual(["skill:analyst"]);
        });

        it("keeps an unresolved pending hash across a second repair", async () => {
            const { installId, intentId } = await stoppedUpdate(false);

            // The person edited the skill: it matches neither the old nor the new content.
            await run(async (context) => {
                const skill = await context.db.skills.findFirst({ where: { pluginMarker: markerFor(installId, "skill:analyst") } });

                await context.db.patch("skills", skill._id, { instructions: "Edited by hand." });
            });

            const first = await run(async (context) => await repairRows(context, OWNER, SLUG));
            const second = await run(async (context) => await repairRows(context, OWNER, SLUG));

            expect(first).toMatchObject({ missing: ["skill:analyst"], status: "needs-repair" });
            expect(second).toMatchObject({ missing: ["skill:analyst"], status: "needs-repair" });
            expect(await run(async (context) => await context.db.pluginItems.findFirst({ where: { _id: intentId } }))).toMatchObject({
                pendingHash: await skillRowHash(REVISED),
            });
        });

        it("clears a pending hash whose write never happened", async () => {
            const { intentId } = await stoppedUpdate(false);

            const result = await run(async (context) => await repairRows(context, OWNER, SLUG));

            expect(result).toEqual({ linked: 1, missing: [], status: "installed" });

            const link = await run(async (context) => await context.db.pluginItems.findFirst({ where: { _id: intentId } }));

            expect(link).toMatchObject({ contentHash: await skillRowHash(ANALYST), pendingHash: "" });
        });

        it("refuses to repair while the update's lease is still live", async () => {
            const { installId } = await stoppedUpdate(true);

            await run(async (context) => await context.db.patch("pluginInstalls", installId, { leaseUntil: Date.now() + 60_000 }));

            await expect(run(async (context) => await repairRows(context, OWNER, SLUG))).rejects.toThrow("still running");
        });
    });
});
