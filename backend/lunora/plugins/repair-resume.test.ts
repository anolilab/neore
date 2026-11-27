import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { createPluginSkill } from "../skills/create-skill";
import { createInstallRow, markNeedsRepair, recordCreated, recordIntent } from "./install-steps";
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

    const run = async <T>(fn: (context: any) => Promise<T>): Promise<T> => await harness.run(async (context: any) => await fn(context));

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
                    pluginInstallId: first.installId,
                    pluginMarker: markerFor(first.installId, "skill:analyst"),
                    plan: "premium",
                    slug: "analyst",
                    source: { type: "plugin" as const, version: "1.0.0" },
                    userId: OWNER,
                }),
        );
        await run(async (context) => await context.runMutation(markNeedsRepair, { generation: first.generation, installId: first.installId }));

        const begun = await run(async (context) => await beginRepairRows(context, OWNER, SLUG, HASH));

        expect(begun).toMatchObject({ missing: [], status: "installed", linked: 1 });
        expect(intentId).toBeTruthy();
    });
});
