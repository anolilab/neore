import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { createPluginSkill } from "../skills/create-skill";
import { skillRowHash } from "./entry-hash";
import { createInstallRow, finishInstall, recordCreated, recordIntent } from "./install-steps";
import { patchInstallIf } from "./held-install";
import { diffUpdate, markerFor } from "./logic";
import { loadInstalledForUpdate } from "./update";
import { beginUpdate, failUpdate, finishUpdate, removeChild, updateSkillChild } from "./update-apply";

const OWNER = "owner-a";
const SLUG = "daily-brief";
const HASH = "e".repeat(64);
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

    const run = async <T>(function_: (context: any) => Promise<T>): Promise<T> => await harness.run(async (context: any) => await function_(context));

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
                    plan: "premium",
                    pluginInstallId: installId,
                    pluginMarker: markerFor(installId, "skill:analyst"),
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

        const generation = await run(
            async (context) => await context.runMutation(beginUpdate, { expectedGeneration: 1, installId, targetVersion: "1.1.0", userId: OWNER }),
        );

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
            async (context) =>
                await context.runMutation(finishUpdate, { contentHash: await skillRowHash(REVISED), generation, installId, partial: false, version: "1.1.0" }),
        );

        const skill = await run(async (context) => await context.db.skills.findFirst({ where: { _id: skillId } }));
        const link = await run(async (context) => {
            const { page } = await context.db.pluginItems.findMany({ where: { installId } });

            return page[0];
        });
        const install = await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: installId } }));

        expect(skill).toMatchObject({ instructions: REVISED.instructions });
        expect(link).toMatchObject({ contentHash: await skillRowHash(REVISED), pendingHash: "" });
        expect(install).toMatchObject({ status: "installed", version: "1.1.0" });
    });

    it("rewrites nothing while the account is being deleted, so no history row is left behind its sweep", async () => {
        const { installId, skillId } = await installed();
        const generation = await run(
            async (context) => await context.runMutation(beginUpdate, { expectedGeneration: 1, installId, targetVersion: "1.1.0", userId: OWNER }),
        );

        await run(async (context) => await context.db.insert("accountMoves", { createdAt: Date.now(), kind: "erasing", userId: OWNER }));

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
        ).rejects.toThrow("being deleted");

        const skill = await run(async (context) => await context.db.skills.findFirst({ where: { _id: skillId } }));

        expect(skill).not.toMatchObject({ instructions: REVISED.instructions });
    });

    it("records a history revision and advances the version when a plugin update changes the instructions", async () => {
        const { installId, skillId } = await installed();
        const generation = await run(
            async (context) => await context.runMutation(beginUpdate, { expectedGeneration: 1, installId, targetVersion: "1.1.0", userId: OWNER }),
        );

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

        const history = await run(async (context) => {
            const { page } = await context.db.skillHistory.findMany({ where: { skillId } });

            return page;
        });
        const skill = await run(async (context) => await context.db.skills.findFirst({ where: { _id: skillId } }));

        expect(history.map((row: { instructions: string }) => row.instructions)).toContain(REVISED.instructions);
        expect(skill?.currentVersion).toBe(2);
    });

    it("refuses to rewrite a skill the person has edited, and leaves it as it is", async () => {
        const { installId, skillId } = await installed();

        await run(async (context) => await context.db.patch("skills", skillId, { instructions: "Changed by the owner." }));

        const generation = await run(
            async (context) => await context.runMutation(beginUpdate, { expectedGeneration: 1, installId, targetVersion: "1.1.0", userId: OWNER }),
        );

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
        const generation = await run(
            async (context) => await context.runMutation(beginUpdate, { expectedGeneration: 1, installId, targetVersion: "1.1.0", userId: OWNER }),
        );

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

        const generation = await run(
            async (context) => await context.runMutation(beginUpdate, { expectedGeneration: 1, installId, targetVersion: "1.1.0", userId: OWNER }),
        );

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

    it("removes a field the new version drops, so the row matches the hash the link records", async () => {
        const { installId, skillId } = await installed();

        await run(async (context) => await context.db.patch("skills", skillId, { tags: ["old"] }));

        const tagged = await run(async (context) => await context.db.skills.findFirst({ where: { _id: skillId } }));

        await run(async (context) => {
            const { page } = await context.db.pluginItems.findMany({ where: { installId } });
            const [link] = page;

            await context.db.patch("pluginItems", link._id, { contentHash: await skillRowHash(tagged) });
        });

        const generation = await run(
            async (context) => await context.runMutation(beginUpdate, { expectedGeneration: 1, installId, targetVersion: "1.1.0", userId: OWNER }),
        );

        await run(
            async (context) =>
                await context.runMutation(updateSkillChild, {
                    contentHash: await skillRowHash(ANALYST),
                    description: ANALYST.description,
                    entryKey: "skill:analyst",
                    generation,
                    installId,
                    instructions: ANALYST.instructions,
                    name: ANALYST.name,
                    slug: ANALYST.slug,
                    userId: OWNER,
                }),
        );

        const skill = await run(async (context) => await context.db.skills.findFirst({ where: { _id: skillId } }));
        const link = await run(async (context) => {
            const { page } = await context.db.pluginItems.findMany({ where: { installId } });

            return page[0];
        });

        expect(skill?.tags).toBeUndefined();
        expect(await skillRowHash(skill)).toBe(link.contentHash);
    });

    it("failUpdate returns the install to installed at its old version and drops intents left by a rolled-back create", async () => {
        const { installId } = await installed();
        const generation = await run(
            async (context) => await context.runMutation(beginUpdate, { expectedGeneration: 1, installId, targetVersion: "1.1.0", userId: OWNER }),
        );

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
        await run(
            async (context) =>
                await context.runMutation(failUpdate, {
                    contentHash: HASH,
                    createKeys: ["skill:new"],
                    generation,
                    installId,
                    keepForRepair: false,
                    partial: false,
                }),
        );

        const install = await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: installId } }));
        const links = await run(async (context) => {
            const { page } = await context.db.pluginItems.findMany({ where: { installId } });

            return page;
        });

        expect(install).toMatchObject({ status: "installed", version: "1.0.0" });
        expect(links.map((row: { entryKey: string }) => row.entryKey)).toStrictEqual(["skill:analyst"]);
    });

    it("failUpdate keeps the install for repair with the new file's hash when children were left behind", async () => {
        const { installId } = await installed();
        const generation = await run(
            async (context) => await context.runMutation(beginUpdate, { expectedGeneration: 1, installId, targetVersion: "1.1.0", userId: OWNER }),
        );

        await run(
            async (context) =>
                await context.runMutation(failUpdate, { contentHash: HASH, createKeys: [], generation, installId, keepForRepair: true, partial: false }),
        );

        expect(await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: installId } }))).toMatchObject({
            contentHash: HASH,
            status: "needs-repair",
            version: "1.0.0",
        });
    });

    it("failUpdate drops the link of a new child the rollback removed, so the next update plans it as a create", async () => {
        const { installId } = await installed();
        const generation = await run(
            async (context) => await context.runMutation(beginUpdate, { expectedGeneration: 1, installId, targetVersion: "1.1.0", userId: OWNER }),
        );
        const CRITIC = { description: "Critic", instructions: "Critique.", name: "Critic", slug: "critic" };

        const intentId = await run(
            async (context) =>
                await context.runMutation(recordIntent, {
                    contentHash: await skillRowHash(CRITIC),
                    entryKey: "skill:critic",
                    generation,
                    installId,
                    kind: "skill",
                    userId: OWNER,
                }),
        );
        const criticId = await run(
            async (context) =>
                await context.runMutation(createPluginSkill, {
                    ...CRITIC,
                    isPremium: true,
                    plan: "premium",
                    pluginInstallId: installId,
                    pluginMarker: markerFor(installId, "skill:critic"),
                    source: { type: "plugin" as const, version: "1.1.0" },
                    userId: OWNER,
                }),
        );

        await run(async (context) => await context.runMutation(recordCreated, { generation, installId, intentId, itemId: criticId }));
        // The rollback of a later failed create removes the child but cannot touch its link.
        await run(async (context) => await context.db.delete("skills", criticId));
        await run(
            async (context) =>
                await context.runMutation(failUpdate, {
                    contentHash: HASH,
                    createKeys: ["skill:critic"],
                    generation,
                    installId,
                    keepForRepair: false,
                    partial: false,
                }),
        );

        const keys = await run(async (context) => {
            const { page } = await context.db.pluginItems.findMany({ where: { installId } });

            return page.map((row: { entryKey: string }) => row.entryKey);
        });
        const preview = await run(async (context) => await context.runQuery(loadInstalledForUpdate, { pluginSlug: SLUG, userId: OWNER }));

        expect(keys).toStrictEqual(["skill:analyst"]);
        expect(
            diffUpdate(preview.children, [
                { contentHash: await skillRowHash(ANALYST), entryKey: "skill:analyst", kind: "skill" },
                { contentHash: await skillRowHash(CRITIC), entryKey: "skill:critic", kind: "skill" },
            ]),
        ).toContainEqual({ action: "create", entryKey: "skill:critic" });
    });

    it("refuses every step once the lease has expired, and a sharded write once less than a minute is left", async () => {
        const { installId } = await installed();
        const generation = await run(
            async (context) => await context.runMutation(beginUpdate, { expectedGeneration: 1, installId, targetVersion: "1.1.0", userId: OWNER }),
        );
        const remove = async () =>
            await run(async (context) => await context.runMutation(removeChild, { entryKey: "skill:analyst", generation, installId, userId: OWNER }));

        await run(async (context) => await context.db.patch("pluginInstalls", installId, { leaseUntil: Date.now() + 30_000 }));
        await expect(remove()).rejects.toThrow("STALE_LEASE");

        await run(async (context) => await context.db.patch("pluginInstalls", installId, { leaseUntil: Date.now() - 1 }));
        await expect(
            run(async (context) => await context.runMutation(finishUpdate, { contentHash: HASH, generation, installId, partial: false, version: "1.1.0" })),
        ).rejects.toThrow("STALE_LEASE");
    });

    it("refuses to begin an update planned from an older read of the install", async () => {
        const { installId } = await installed();

        await expect(
            run(async (context) => await context.runMutation(beginUpdate, { expectedGeneration: 0, installId, targetVersion: "1.1.0", userId: OWNER })),
        ).rejects.toThrow("Preview it again");
    });

    it("an install-row write is conditional on the generation held: a takeover between the read and the write makes it STALE_LEASE", async () => {
        const { installId } = await installed();
        const generation = await run(
            async (context) => await context.runMutation(beginUpdate, { expectedGeneration: 1, installId, targetVersion: "1.1.0", userId: OWNER }),
        );

        // A repair takes over; the caller still holds the generation it read earlier.
        await run(async (context) => await context.db.patch("pluginInstalls", installId, { generation: generation + 1, status: "needs-repair" }));
        await expect(run(async (context) => await patchInstallIf(context, installId, generation, { status: "installed" }))).rejects.toThrow("STALE_LEASE");

        expect(await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: installId } }))).toMatchObject({
            generation: generation + 1,
            status: "needs-repair",
        });
    });

    it("failUpdate removes only the links of its own attempt, not an intent for a key it did not create", async () => {
        const { installId } = await installed();
        const generation = await run(
            async (context) => await context.runMutation(beginUpdate, { expectedGeneration: 1, installId, targetVersion: "1.1.0", userId: OWNER }),
        );

        for (const entryKey of ["skill:new", "skill:other"]) {
            await run(
                async (context) =>
                    await context.db.insert("pluginItems", {
                        contentHash: HASH,
                        createdAt: Date.now(),
                        entryKey,
                        installId,
                        kind: "skill",
                        state: "intent",
                        userId: OWNER,
                    }),
            );
        }

        await run(
            async (context) =>
                await context.runMutation(failUpdate, {
                    contentHash: HASH,
                    createKeys: ["skill:new"],
                    generation,
                    installId,
                    keepForRepair: false,
                    partial: false,
                }),
        );

        const links = await run(async (context) => {
            const { page } = await context.db.pluginItems.findMany({ where: { installId } });

            return page.map((row: { entryKey: string }) => row.entryKey).toSorted((a: string, b: string) => a.localeCompare(b));
        });

        expect(links).toStrictEqual(["skill:analyst", "skill:other"]);
    });

    it("finishing an install kept for repair makes its target the version in one conditional write, and keeps the generation", async () => {
        const { installId } = await installed();
        const generation = await run(
            async (context) => await context.runMutation(beginUpdate, { expectedGeneration: 1, installId, targetVersion: "1.1.0", userId: OWNER }),
        );

        await run(
            async (context) =>
                await context.runMutation(failUpdate, { contentHash: HASH, createKeys: [], generation, installId, keepForRepair: true, partial: false }),
        );
        await run(async (context) => await context.runMutation(finishInstall, { generation, installId }));

        expect(await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: installId } }))).toMatchObject({
            generation,
            status: "installed",
            targetVersion: "1.1.0",
            version: "1.1.0",
        });
    });

    it("a conditional install write names the status too: a row that went to needs-repair is not written", async () => {
        const { installId } = await installed();

        await run(async (context) => await context.db.patch("pluginInstalls", installId, { status: "needs-repair" }));
        await expect(run(async (context) => await patchInstallIf(context, installId, 1, { status: "updating" }, undefined, "installed"))).rejects.toThrow(
            "STALE_LEASE",
        );
    });

    it("does not rewrite a skill that was made public after install, and keeps it linked so a later update does not create it again", async () => {
        const { installId, skillId } = await installed();

        await run(async (context) => await context.db.patch("skills", skillId, { visibility: "public" }));

        const generation = await run(
            async (context) => await context.runMutation(beginUpdate, { expectedGeneration: 1, installId, targetVersion: "1.1.0", userId: OWNER }),
        );
        const rewritten = await run(
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

        expect(rewritten).toBe(false);
        expect(await run(async (context) => await context.db.skills.findFirst({ where: { _id: skillId } }))).toMatchObject({
            instructions: ANALYST.instructions,
            pluginInstallId: installId,
        });
        const links = await run(async (context) => {
            const { page } = await context.db.pluginItems.findMany({ where: { installId } });

            return page;
        });

        expect(links).toMatchObject([{ entryKey: "skill:analyst", state: "created" }]);
    });

    it("failUpdate adopts a child whose row was written before its link, and marks the install partial", async () => {
        const { installId, skillId } = await installed();
        const generation = await run(
            async (context) => await context.runMutation(beginUpdate, { expectedGeneration: 1, installId, targetVersion: "1.1.0", userId: OWNER }),
        );
        const link = await run(async (context) => {
            const { page } = await context.db.pluginItems.findMany({ where: { installId } });

            return page[0];
        });

        // updateSkillChild stopped after the row patch and before the link patch.
        await run(async (context) => await context.db.patch("pluginItems", link._id, { pendingHash: await skillRowHash(REVISED) }));
        await run(async (context) => await context.db.patch("skills", skillId, { instructions: REVISED.instructions }));
        await run(
            async (context) =>
                await context.runMutation(failUpdate, { contentHash: HASH, createKeys: [], generation, installId, keepForRepair: false, partial: false }),
        );

        expect(await run(async (context) => await context.db.pluginItems.findFirst({ where: { _id: link._id } }))).toMatchObject({
            contentHash: await skillRowHash(REVISED),
            pendingHash: "",
        });
        expect(await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: installId } }))).toMatchObject({
            partial: true,
            status: "installed",
        });
    });

    it("finishUpdate records that a step was skipped, and a complete update clears it", async () => {
        const { installId } = await installed();
        const first = await run(
            async (context) => await context.runMutation(beginUpdate, { expectedGeneration: 1, installId, targetVersion: "1.1.0", userId: OWNER }),
        );

        await run(
            async (context) => await context.runMutation(finishUpdate, { contentHash: HASH, generation: first, installId, partial: true, version: "1.1.0" }),
        );
        expect(await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: installId } }))).toMatchObject({ partial: true });

        const second = await run(
            async (context) => await context.runMutation(beginUpdate, { expectedGeneration: first, installId, targetVersion: "1.2.0", userId: OWNER }),
        );

        await run(
            async (context) => await context.runMutation(finishUpdate, { contentHash: HASH, generation: second, installId, partial: false, version: "1.2.0" }),
        );
        expect(await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: installId } }))).toMatchObject({ partial: false });
    });
});
