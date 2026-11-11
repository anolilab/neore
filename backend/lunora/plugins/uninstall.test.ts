import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { createPluginSkill } from "../skills/create-skill";
import { skillRowHash } from "./entry-hash";
import { createInstallRow, finishInstall, recordCreated, recordIntent } from "./install-steps";
import { markerFor } from "./logic";
import { uninstallRows } from "./uninstall";

const OWNER = "owner-a";
const SLUG = "daily-brief";
const ANALYST = { description: "Analyst", instructions: "Analyse.", name: "Analyst", slug: "analyst" };

describe("uninstall", () => {
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

    /** An installed plugin with one skill child, created and linked as the install does it. */
    const installed = async () => {
        const first = await run(
            async (context) => await context.runMutation(createInstallRow, { contentHash: "a".repeat(64), pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }),
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

        return { installId, skillId };
    };

    it("removes an unedited skill, its links, and the install", async () => {
        const { installId, skillId } = await installed();

        const result = await run(async (context) => await uninstallRows(context, OWNER, SLUG));

        expect(result.kept).toEqual([]);
        expect(result.removed).toBeGreaterThan(0);

        const skill = await run(async (context) => await context.db.skills.findFirst({ where: { _id: skillId } }));
        const links = await run(async (context) => (await context.db.pluginItems.findMany({ where: { installId } })).page);
        const install = await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: installId } }));

        expect(skill).toBeNull();
        expect(links).toHaveLength(0);
        expect(install).toBeNull();
    });

    it("keeps an edited skill, detached so that no later sweep finds it", async () => {
        const { installId, skillId } = await installed();

        await run(async (context) => await context.db.patch("skills", skillId, { instructions: "Changed by the owner." }));

        const result = await run(async (context) => await uninstallRows(context, OWNER, SLUG));

        expect(result.kept).toEqual(["Analyst"]);

        const skill = await run(async (context) => await context.db.skills.findFirst({ where: { _id: skillId } }));

        expect(skill).toMatchObject({ instructions: "Changed by the owner.", pluginInstallId: "", pluginMarker: "" });
        expect(await run(async (context) => (await context.db.skills.findMany({ where: { pluginInstallId: installId } })).page)).toHaveLength(0);
    });

    it("refuses an uninstall of a plugin the person does not have", async () => {
        await expect(run(async (context) => await uninstallRows(context, OWNER, "nothing"))).rejects.toThrow("not installed");
    });
});
