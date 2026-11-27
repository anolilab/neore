import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { createPluginSkill } from "../skills/create-skill";
import { createInstallRow, finishInstall, markNeedsRepair, recordCreated, recordIntent } from "./install-steps";
import { skillRowHash } from "./entry-hash";
import { repairRows } from "./repair";
import { markerFor } from "./logic";

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

    const run = async <T>(fn: (context: any) => Promise<T>): Promise<T> => await harness.run(async (context: any) => await fn(context));

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
                    pluginInstallId: installId,
                    pluginMarker: markerFor(installId, "skill:analyst"),
                    plan: "premium",
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

        await expect(run(async (context) => await repairRows(context, OWNER, SLUG))).rejects.toThrow("does not need repair");
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
                        pluginInstallId: installId,
                        pluginMarker: markerFor(installId, "skill:analyst"),
                        plan: "premium",
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

        it("records a child whose write finished, and returns the install to its target version", async () => {
            const { installId, intentId } = await stoppedUpdate(true);

            const result = await run(async (context) => await repairRows(context, OWNER, SLUG));

            expect(result).toEqual({ linked: 1, missing: [], status: "installed" });

            const link = await run(async (context) => await context.db.pluginItems.findFirst({ where: { _id: intentId } }));
            const install = await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: installId } }));

            expect(link).toMatchObject({ contentHash: await skillRowHash(REVISED), pendingHash: "" });
            expect(install).toMatchObject({ status: "installed", version: "1.1.0" });
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
