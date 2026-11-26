import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { createPluginSkill } from "../skills/create-skill";
import { skillRowHash } from "./entry-hash";
import { createInstallRow, finishInstall, recordCreated, recordIntent } from "./install-steps";
import { markerFor } from "./logic";
import { beginUpdate, finishUpdate, updateSkillChild } from "./update-apply";

const OWNER = "owner-a";
const SLUG = "daily-brief";
const ANALYST = { description: "Analyst", instructions: "Analyse.", name: "Analyst", slug: "analyst" };
const REVISED = { ...ANALYST, instructions: "Analyse in detail." };

describe("applying an update", () => {
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
            async (context) => await context.runMutation(createInstallRow, { contentHash: "f".repeat(64), pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }),
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

    it("rewrites an unedited skill in place, links the new hash, and returns the install to installed at the new version", async () => {
        const { installId, skillId } = await installed();

        const generation = await run(async (context) => await context.runMutation(beginUpdate, { installId, targetVersion: "1.1.0", userId: OWNER }));

        await run(
            async (context) =>
                await context.runMutation(updateSkillChild, {
                    contentHash: await skillRowHash(REVISED),
                    description: REVISED.description,
                    entryKey: "skill:analyst",
                    generation,
                    installId,
                    instructions: REVISED.instructions,
                    name: REVISED.name,
                    slug: REVISED.slug,
                    userId: OWNER,
                }),
        );
        await run(
            async (context) => await context.runMutation(finishUpdate, { contentHash: await skillRowHash(REVISED), generation, installId, version: "1.1.0" }),
        );

        const skill = await run(async (context) => await context.db.skills.findFirst({ where: { _id: skillId } }));
        const link = await run(async (context) => (await context.db.pluginItems.findMany({ where: { installId } })).page[0]);
        const install = await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: installId } }));

        expect(skill).toMatchObject({ instructions: REVISED.instructions });
        expect(link).toMatchObject({ contentHash: await skillRowHash(REVISED), pendingHash: "" });
        expect(install).toMatchObject({ status: "installed", version: "1.1.0" });
    });

    it("refuses to rewrite a skill the person has edited, and leaves it as it is", async () => {
        const { installId, skillId } = await installed();

        await run(async (context) => await context.db.patch("skills", skillId, { instructions: "Changed by the owner." }));

        const generation = await run(async (context) => await context.runMutation(beginUpdate, { installId, targetVersion: "1.1.0", userId: OWNER }));

        await expect(
            run(
                async (context) =>
                    await context.runMutation(updateSkillChild, {
                        contentHash: await skillRowHash(REVISED),
                        description: REVISED.description,
                        entryKey: "skill:analyst",
                        generation,
                        installId,
                        instructions: REVISED.instructions,
                        name: REVISED.name,
                        slug: REVISED.slug,
                        userId: OWNER,
                    }),
            ),
        ).rejects.toThrow("was edited");

        const skill = await run(async (context) => await context.db.skills.findFirst({ where: { _id: skillId } }));

        expect(skill).toMatchObject({ instructions: "Changed by the owner." });
    });

    it("refuses a planned slug that is reserved, and writes nothing to the skill or its link", async () => {
        const { installId, skillId } = await installed();
        const generation = await run(async (context) => await context.runMutation(beginUpdate, { installId, targetVersion: "1.1.0", userId: OWNER }));

        await expect(
            run(
                async (context) =>
                    await context.runMutation(updateSkillChild, {
                        contentHash: await skillRowHash({ ...REVISED, slug: "clear" }),
                        description: REVISED.description,
                        entryKey: "skill:analyst",
                        generation,
                        installId,
                        instructions: REVISED.instructions,
                        name: REVISED.name,
                        slug: "clear",
                        userId: OWNER,
                    }),
            ),
        ).rejects.toThrow("reserved");

        const skill = await run(async (context) => await context.db.skills.findFirst({ where: { _id: skillId } }));
        const { page: links } = await run(async (context) => await context.db.pluginItems.findMany({ where: { installId } }));
        const link = links[0];

        expect(skill).toMatchObject({ slug: "analyst" });
        // An unset pending hash and an empty one both mean "no update in progress".
        expect(link?.pendingHash ?? "").toBe("");
    });

    it("refuses a planned slug that another skill of the person holds by the time the update writes", async () => {
        const { installId, skillId } = await installed();

        // A skill another request created after the preview read the person's slugs.
        await run(
            async (context) =>
                await context.runMutation(createPluginSkill, {
                    ...ANALYST,
                    isPremium: true,
                    name: "Taken",
                    plan: "premium",
                    pluginInstallId: installId,
                    pluginMarker: markerFor(installId, "skill:other"),
                    slug: "taken",
                    source: { type: "plugin" as const, version: "1.0.0" },
                    userId: OWNER,
                }),
        );

        const generation = await run(async (context) => await context.runMutation(beginUpdate, { installId, targetVersion: "1.1.0", userId: OWNER }));

        await expect(
            run(
                async (context) =>
                    await context.runMutation(updateSkillChild, {
                        contentHash: await skillRowHash({ ...REVISED, slug: "taken" }),
                        description: REVISED.description,
                        entryKey: "skill:analyst",
                        generation,
                        installId,
                        instructions: REVISED.instructions,
                        name: REVISED.name,
                        slug: "taken",
                        userId: OWNER,
                    }),
            ),
        ).rejects.toThrow("already exists");

        const skill = await run(async (context) => await context.db.skills.findFirst({ where: { _id: skillId } }));

        expect(skill).toMatchObject({ slug: "analyst" });
    });
});
