import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { createPluginSkill } from "../skills/create-skill";
import { createInstallRow, markNeedsRepair, recordCreated, recordIntent } from "./install-steps";
import { ROOT_SHARD_KEY, runInShard } from "../lib/shard-context";
import { markerFor } from "./logic";
import { beginRepairRows } from "./repair-resume";

const OWNER = "owner-a";
const SLUG = "daily-brief";
const HASH = "c".repeat(64);

describe("repair: taking over a stopped install", () => {
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

    it("returns a missing child with its intent row, and bumps the generation so the old action stops", async () => {
        const first = await run(
            async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }),
        );
        const intentId = await run(
            async (context) =>
                await context.runMutation(recordIntent, {
                    contentHash: HASH,
                    entryKey: "skill:ghost",
                    generation: first.generation,
                    installId: first.installId,
                    kind: "skill",
                    userId: OWNER,
                }),
        );

        await run(async (context) => await context.runMutation(markNeedsRepair, { generation: first.generation, installId: first.installId }));

        const begun = await run(async (context) => await beginRepairRows(context, OWNER, SLUG, HASH));

        expect(begun.status).toBe("needs-repair");
        expect(begun.missing).toEqual([{ entryKey: "skill:ghost", intentId, kind: "skill" }]);
        expect(begun.generation).toBe(first.generation + 1);

        await expect(
            run(
                async (context) =>
                    await context.runMutation(recordCreated, { generation: first.generation, installId: first.installId, intentId, itemId: "x" }),
            ),
        ).rejects.toThrow("STALE_LEASE");
    });

    it("finishes with nothing missing when every child exists", async () => {
        const first = await run(
            async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }),
        );
        const intentId = await run(
            async (context) =>
                await context.runMutation(recordIntent, {
                    contentHash: HASH,
                    entryKey: "skill:analyst",
                    generation: first.generation,
                    installId: first.installId,
                    kind: "skill",
                    userId: OWNER,
                }),
        );

        await run(
            async (context) =>
                await context.runMutation(createPluginSkill, {
                    description: "Analyst",
                    instructions: "Analyse.",
                    isPremium: true,
                    name: "Analyst",
                    plan: "premium",
                    pluginInstallId: first.installId,
                    pluginMarker: markerFor(first.installId, "skill:analyst"),
                    slug: "analyst",
                    source: { type: "plugin" as const, version: "1.0.0" },
                    userId: OWNER,
                }),
        );
        await run(async (context) => await context.runMutation(markNeedsRepair, { generation: first.generation, installId: first.installId }));

        const begun = await run(async (context) => await beginRepairRows(context, OWNER, SLUG, HASH));

        expect(begun).toMatchObject({ linked: 1, missing: [], status: "installed" });
        expect(intentId).toBeTruthy();
    });

    it("gives an entry the install never reached its own intent row, and holds the install while the action creates it", async () => {
        const first = await run(
            async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }),
        );

        await run(async (context) => await context.runMutation(markNeedsRepair, { generation: first.generation, installId: first.installId }));

        const entries = [{ contentHash: HASH, entryKey: "skill:late", kind: "skill" as const }];
        const begun = await run(async (context) => await beginRepairRows(context, OWNER, SLUG, HASH, entries));

        expect(begun.missing).toMatchObject([{ entryKey: "skill:late", kind: "skill" }]);

        const install = await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: first.installId } }));

        expect(install).toMatchObject({ generation: first.generation + 1, status: "installing" });
        expect(install?.leaseUntil).toBeGreaterThan(Date.now());

        // A second repair (or an uninstall) cannot start while this one holds the lease.
        await expect(run(async (context) => await beginRepairRows(context, OWNER, SLUG, HASH, entries))).rejects.toThrow("still being installed");
    });

    it("returns the ids of the skills already linked, so a missing group can use them", async () => {
        const first = await run(
            async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }),
        );
        const intentId = await run(
            async (context) =>
                await context.runMutation(recordIntent, {
                    contentHash: HASH,
                    entryKey: "skill:analyst",
                    generation: first.generation,
                    installId: first.installId,
                    kind: "skill",
                    userId: OWNER,
                }),
        );
        const skillId = await run(
            async (context) =>
                await context.runMutation(createPluginSkill, {
                    description: "Analyst",
                    instructions: "Analyse.",
                    isPremium: true,
                    name: "Analyst",
                    plan: "premium",
                    pluginInstallId: first.installId,
                    pluginMarker: markerFor(first.installId, "skill:analyst"),
                    slug: "analyst",
                    source: { type: "plugin" as const, version: "1.0.0" },
                    userId: OWNER,
                }),
        );

        await run(
            async (context) =>
                await context.runMutation(recordCreated, { generation: first.generation, installId: first.installId, intentId, itemId: skillId }),
        );
        await run(async (context) => await context.runMutation(markNeedsRepair, { generation: first.generation, installId: first.installId }));

        const entries = [{ contentHash: HASH, entryKey: "group:1", kind: "group" as const }];
        const begun = await run(async (context) => await beginRepairRows(context, OWNER, SLUG, HASH, entries));

        expect(begun.existing).toEqual([{ entryKey: "skill:analyst", itemId: skillId }]);
        expect(begun.missing).toMatchObject([{ entryKey: "group:1", kind: "group" }]);
    });

    it("accepts the new file for an update that stopped, whose stored hash is still the old file's", async () => {
        const first = await run(
            async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }),
        );

        await run(
            async (context) =>
                await context.db.patch("pluginInstalls", first.installId, { leaseUntil: Date.now() - 1000, status: "updating", targetVersion: "1.1.0" }),
        );

        const entries = [{ contentHash: HASH, entryKey: "skill:extra", kind: "skill" as const }];
        const begun = await run(async (context) => await beginRepairRows(context, OWNER, SLUG, "e".repeat(64), entries));
        const { page } = await run(async (context) => await context.db.pluginItems.findMany({ where: { installId: first.installId } }));

        expect(begun.status).toBe("installed");
        // The new file was not checked against the install, so its entries add no rows.
        expect(page).toStrictEqual([]);
    });

    it("refuses another file for an install that is not updating", async () => {
        const first = await run(
            async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }),
        );

        await run(async (context) => await context.runMutation(markNeedsRepair, { generation: first.generation, installId: first.installId }));

        await expect(run(async (context) => await beginRepairRows(context, OWNER, SLUG, "e".repeat(64)))).rejects.toThrow("not the file");
    });

    it("refuses to begin on the root shard or another person's shard", async () => {
        const first = await run(
            async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }),
        );

        await run(async (context) => await context.runMutation(markNeedsRepair, { generation: first.generation, installId: first.installId }));

        for (const shard of [ROOT_SHARD_KEY, "someone-else"]) {
            await expect(runInShard(shard, async () => await run(async (context) => await beginRepairRows(context, OWNER, SLUG, HASH)))).rejects.toThrow(
                "owner's shard",
            );
        }
    });
});
