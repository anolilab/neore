import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { createPluginSkill } from "../skills/create-skill";
import { createInstallRow, markNeedsRepair, recordIntent } from "./install-steps";
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
            async (context) => await context.runMutation(recordIntent, { entryKey: "skill:analyst", generation, installId, kind: "skill", userId: OWNER }),
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

        await run(async (context) => await context.runMutation(recordIntent, { entryKey: "skill:ghost", generation, installId, kind: "skill", userId: OWNER }));
        await run(async (context) => await context.runMutation(markNeedsRepair, { generation, installId }));

        const result = await run(async (context) => await repairRows(context, OWNER, SLUG));

        expect(result).toEqual({ linked: 0, missing: ["skill:ghost"], status: "needs-repair" });
    });

    it("refuses to repair an install that does not need it", async () => {
        await run(async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }));

        await expect(run(async (context) => await repairRows(context, OWNER, SLUG))).rejects.toThrow("does not need repair");
    });
});
