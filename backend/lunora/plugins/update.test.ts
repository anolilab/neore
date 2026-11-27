import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { measureDb } from "../../test/db-cost";
import { ROOT_SHARD_KEY, runInShard } from "../lib/shard-context";
import schema from "../schema";
import { createPluginSkill } from "../skills/create-skill";
import { skillRowHash } from "./entry-hash";
import { createInstallRow, recordIntent } from "./install-steps";
import { loadOwnSlugs } from "./repair-resume";
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

    const run = async <T>(function_: (context: any) => Promise<T>): Promise<T> => await harness.run(async (context: any) => await function_(context));

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
                    plan: "premium",
                    pluginInstallId: installId,
                    pluginMarker: markerFor(installId, "skill:analyst"),
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

        const [child] = installed.children;

        expect(child.currentHash).not.toBe(child.contentHash);
    });

    it("reports a child whose row is gone as missing", async () => {
        const { installId } = await installWithSkill();

        await run(async (context) => {
            const row = await context.db.skills.findFirst({ where: { pluginMarker: markerFor(installId, "skill:analyst") } });

            await context.db.delete("skills", row._id);
        });

        const installed = await run(async (context) => await context.runQuery(loadInstalledForUpdate, { pluginSlug: SLUG, userId: OWNER }));

        const [child] = installed.children;

        expect(child.currentHash).toBe("missing");
    });

    it("returns null for a plugin the person does not have", async () => {
        const installed = await run(async (context) => await context.runQuery(loadInstalledForUpdate, { pluginSlug: "nothing", userId: OWNER }));

        expect(installed).toBeNull();
    });

    it("refuses to read the children from another person's shard", async () => {
        await expect(
            runInShard(
                "someone-else",
                async () => await run(async (context) => await context.runQuery(loadInstalledForUpdate, { pluginSlug: SLUG, userId: OWNER })),
            ),
        ).rejects.toThrow("owner's shard");
    });

    it("refuses to read the children on the root shard", async () => {
        await expect(
            runInShard(
                ROOT_SHARD_KEY,
                async () => await run(async (context) => await context.runQuery(loadInstalledForUpdate, { pluginSlug: SLUG, userId: OWNER })),
            ),
        ).rejects.toThrow("owner's shard");
    });

    describe("reads a plugin's skills in pages, not one read a link", () => {
        const SKILLS = 9;

        /** An install with nine linked skills, each created as the install made it. */
        const installWithSkills = async () => {
            const { generation, installId } = await run(
                async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }),
            );

            for (let index = 0; index < SKILLS; index += 1) {
                const fields = { ...ANALYST, name: `Analyst ${index}`, slug: `analyst-${index}` };
                const entryKey = `skill:analyst-${index}`;

                await run(
                    async (context) =>
                        await context.runMutation(recordIntent, {
                            contentHash: await skillRowHash(fields),
                            entryKey,
                            generation,
                            installId,
                            kind: "skill",
                            userId: OWNER,
                        }),
                );
                await run(
                    async (context) =>
                        await context.runMutation(createPluginSkill, {
                            ...fields,
                            isPremium: true,
                            plan: "premium",
                            pluginInstallId: installId,
                            pluginMarker: markerFor(installId, entryKey),
                            source: { type: "plugin" as const, version: "1.0.0" },
                            userId: OWNER,
                        }),
                );
            }

            return { installId };
        };

        /** Marks every link of the install `created`, as the install's own run does once each child exists. */
        const linkAll = async (installId: string) =>
            await run(async (context) => {
                const { page } = await context.db.pluginItems.findMany({ where: { installId } });

                for (const row of page) {
                    await context.db.patch("pluginItems", row._id, { state: "created" });
                }
            });

        it("loads the installed children with one page read of the skills", async () => {
            await installWithSkills();

            const { cost, result } = await measureDb(
                async () => await run(async (context) => await context.runQuery(loadInstalledForUpdate, { pluginSlug: SLUG, userId: OWNER })),
            );

            expect(result.children).toHaveLength(SKILLS);
            expect(result.ownSlugs).toHaveLength(SKILLS);
            expect(result.children.every((child: { contentHash: string; currentHash: string }) => child.currentHash === child.contentHash)).toBe(true);
            expect(cost.byTable.skills).toBeLessThanOrEqual(1);
        });

        it("loads the own slugs with one page read of the skills", async () => {
            const { installId } = await installWithSkills();

            await linkAll(installId);

            const { cost, result } = await measureDb(
                async () => await run(async (context) => await context.runQuery(loadOwnSlugs, { pluginSlug: SLUG, userId: OWNER })),
            );

            expect(result).toHaveLength(SKILLS);
            expect(cost.byTable.skills).toBeLessThanOrEqual(1);
        });
    });
});
