import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { createPluginSkill } from "../skills/create-skill";
import { skillRowHash } from "./entry-hash";
import { createInstallRow, finishInstall, recordCreated, recordIntent } from "./install-steps";
import { markerFor } from "./logic";
import { detachChild, removeChild } from "./update-apply";

const OWNER = "owner-a";
const SLUG = "daily-brief";
const HASH = "f".repeat(64);
const ANALYST = { description: "Analyst", instructions: "Analyse.", name: "Analyst", slug: "analyst" };

describe("an update that removes a child", () => {
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

    /** An installed plugin with one skill child, created and linked as the install does it. */
    const installed = async () => {
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

        return { generation: first.generation, installId, intentId, skillId };
    };

    it("removes an unedited child and its link, so the new version has no trace of it", async () => {
        const { generation, installId, intentId, skillId } = await installed();

        await run(async (context) => await context.runMutation(removeChild, { entryKey: "skill:analyst", generation, installId, userId: OWNER }));

        expect(await run(async (context) => await context.db.skills.findFirst({ where: { _id: skillId } }))).toBeNull();
        expect(await run(async (context) => await context.db.pluginItems.findFirst({ where: { _id: intentId } }))).toBeNull();
    });

    it("refuses to remove a child the person has edited", async () => {
        const { generation, installId, skillId } = await installed();

        await run(async (context) => await context.db.patch("skills", skillId, { instructions: "Changed by the owner." }));

        await expect(
            run(async (context) => await context.runMutation(removeChild, { entryKey: "skill:analyst", generation, installId, userId: OWNER })),
        ).rejects.toThrow("was edited");

        expect(await run(async (context) => await context.db.skills.findFirst({ where: { _id: skillId } }))).toMatchObject({
            instructions: "Changed by the owner.",
        });
    });

    it("detaches an edited child: the person keeps it, with no marker left for a later sweep to find", async () => {
        const { generation, installId, intentId, skillId } = await installed();

        await run(async (context) => await context.db.patch("skills", skillId, { instructions: "Changed by the owner." }));
        await run(async (context) => await context.runMutation(detachChild, { entryKey: "skill:analyst", generation, installId, userId: OWNER }));

        expect(await run(async (context) => await context.db.skills.findFirst({ where: { _id: skillId } }))).toMatchObject({
            instructions: "Changed by the owner.",
            pluginInstallId: "",
            pluginMarker: "",
        });
        expect(await run(async (context) => await context.db.pluginItems.findFirst({ where: { _id: intentId } }))).toMatchObject({ state: "detached" });
    });
});
