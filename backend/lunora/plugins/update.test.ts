import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { createPluginSkill } from "../skills/create-skill";
import { skillRowHash } from "./entry-hash";
import { createInstallRow, recordIntent } from "./install-steps";
import { loadInstalledForUpdate } from "./update";
import { markerFor } from "./logic";

const OWNER = "owner-a";
const SLUG = "daily-brief";
const HASH = "e".repeat(64);
const ANALYST = { description: "Analyst", instructions: "Analyse.", name: "Analyst", slug: "analyst" };

describe("update: the installed children and their live hashes", () => {
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

    /** An installed plugin with one skill child whose installed hash is the hash of its row as created. */
    const installWithSkill = async () => {
        const { generation, installId } = await run(
            async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }),
        );
        const storedHash = await skillRowHash(ANALYST);

        await run(
            async (context) =>
                await context.runMutation(recordIntent, {
                    contentHash: storedHash,
                    entryKey: "skill:analyst",
                    generation,
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

        return { generation, installId, skillId, storedHash };
    };

    it("reports a child whose row still matches its installed hash as unchanged", async () => {
        await installWithSkill();

        const installed = await run(async (context) => await context.runQuery(loadInstalledForUpdate, { pluginSlug: SLUG, userId: OWNER }));

        expect(installed).toMatchObject({ status: "installing", version: "1.0.0" });
        expect(installed.children).toEqual([
            expect.objectContaining({
                contentHash: await skillRowHash(ANALYST),
                currentHash: await skillRowHash(ANALYST),
                entryKey: "skill:analyst",
                kind: "skill",
            }),
        ]);
    });

    it("reports a child whose row was edited as edited, so an update keeps it", async () => {
        const { skillId } = await installWithSkill();

        await run(async (context) => await context.db.patch("skills", skillId, { instructions: "Changed by the owner." }));

        const installed = await run(async (context) => await context.runQuery(loadInstalledForUpdate, { pluginSlug: SLUG, userId: OWNER }));

        expect(installed.children[0].currentHash).not.toBe(installed.children[0].contentHash);
    });

    it("reports a child whose row is gone as missing", async () => {
        const { installId } = await installWithSkill();

        await run(
            async (context) =>
                await context.db.delete("skills", (await context.db.skills.findFirst({ where: { pluginMarker: markerFor(installId, "skill:analyst") } }))._id),
        );

        const installed = await run(async (context) => await context.runQuery(loadInstalledForUpdate, { pluginSlug: SLUG, userId: OWNER }));

        expect(installed.children[0].currentHash).toBe("missing");
    });

    it("returns null for a plugin the person does not have", async () => {
        const installed = await run(async (context) => await context.runQuery(loadInstalledForUpdate, { pluginSlug: "nothing", userId: OWNER }));

        expect(installed).toBeNull();
    });
});
