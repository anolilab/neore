import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { createPluginGroupChat } from "../chat/group/functions";
import { createPluginSkill } from "../skills/create-skill";
import { createInstallRow, finishInstall, markNeedsRepair, recordCreated, recordIntent } from "./install-steps";
import { skillRowHash } from "./entry-hash";
import { DETACH_PER_CALL, repairRows } from "./repair";
import { markerFor } from "./logic";
import { ROOT_SHARD_KEY, runInShard } from "../lib/shard-context";

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

    const run = async <T>(function_: (context: any) => Promise<T>): Promise<T> => await harness.run(async (context: any) => await function_(context));

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
                    plan: "premium",
                    pluginInstallId: installId,
                    pluginMarker: markerFor(installId, "skill:analyst"),
                    slug: "analyst",
                    source: { type: "plugin" as const, version: "1.0.0" },
                    userId: OWNER,
                }),
        );

        await run(async (context) => await context.runMutation(markNeedsRepair, { generation, installId }));

        const result = await run(async (context) => await repairRows(context, OWNER, SLUG));

        expect(result).toEqual({ kept: [], linked: 1, missing: [], moreDropped: false, outdated: false, status: "installed" });

        const link = await run(async (context) => await context.db.pluginItems.findFirst({ where: { _id: intentId } }));
        const install = await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: installId } }));

        expect(link).toMatchObject({ itemId: skillId, state: "created" });
        expect(install).toMatchObject({ status: "installed" });
    });

    it("moves the generation on when it finishes a repair, so the action that stopped can write nothing more", async () => {
        const { generation, installId } = await run(
            async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }),
        );

        await run(async (context) => await context.runMutation(markNeedsRepair, { generation, installId }));
        await run(async (context) => await repairRows(context, OWNER, SLUG));

        // The stopped action wakes up and tries to finish: its generation is no longer the install's.
        await expect(run(async (context) => await context.runMutation(markNeedsRepair, { generation, installId }))).rejects.toThrow("STALE_LEASE");

        const install = await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: installId } }));

        expect(install).toMatchObject({ generation: generation + 1, status: "installed" });
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

        expect(result).toEqual({ kept: [], linked: 0, missing: ["skill:ghost"], moreDropped: false, outdated: false, status: "needs-repair" });
    });

    it("refuses to repair an install that does not need it", async () => {
        await run(async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }));

        await expect(run(async (context) => await repairRows(context, OWNER, SLUG))).rejects.toThrow("still being installed");
    });

    it("refuses to run on the root shard or another person's shard, where every trigger and group would read as gone", async () => {
        const { generation, installId } = await run(
            async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }),
        );

        await run(async (context) => await context.runMutation(markNeedsRepair, { generation, installId }));

        for (const shard of [ROOT_SHARD_KEY, "someone-else"]) {
            await expect(runInShard(shard, async () => await run(async (context) => await repairRows(context, OWNER, SLUG)))).rejects.toThrow("owner's shard");
        }
    });

    it("sets the target version when finishing an update that was kept for repair", async () => {
        const { generation, installId } = await run(
            async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }),
        );

        await run(async (context) => await context.db.patch("pluginInstalls", installId, { targetVersion: "1.1.0" }));
        await run(async (context) => await context.runMutation(finishInstall, { generation, installId }));

        const install = await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: installId } }));

        // The write is one conditional patch, which cannot remove a field: the target is set equal to the version, which reads as none.
        expect(install).toMatchObject({ status: "installed", targetVersion: "1.1.0", version: "1.1.0" });
    });

    it("sets the target version when repair finds nothing missing", async () => {
        const { generation, installId } = await run(
            async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }),
        );

        await run(async (context) => await context.runMutation(markNeedsRepair, { generation, installId }));
        await run(async (context) => await context.db.patch("pluginInstalls", installId, { partial: true, targetVersion: "1.1.0" }));
        await run(async (context) => await repairRows(context, OWNER, SLUG));

        const install = await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: installId } }));

        // The target version reads as none once it equals the version; a removal would replace the whole row, which cannot be conditional.
        // A finished repair has every child its file holds, so the partial mark from the interrupted update goes.
        expect(install).toMatchObject({ partial: false, status: "installed", targetVersion: "1.1.0", version: "1.1.0" });
    });

    it("loses to a claim made after its read, and writes nothing over it", async () => {
        const { generation, installId } = await run(
            async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }),
        );

        await run(async (context) => await context.runMutation(markNeedsRepair, { generation, installId }));

        await expect(
            run(async (context) => {
                // A concurrent uninstall claims the install between repair's read and its write.
                const { patchIf } = context.db;

                context.db.patchIf = async (...args: unknown[]) => {
                    await context.db.patch("pluginInstalls", installId, { generation: generation + 5, status: "uninstalling" });

                    return await patchIf.apply(context.db, args);
                };

                return await repairRows(context, OWNER, SLUG);
            }),
        ).rejects.toThrow("STALE_LEASE");
    });

    it("refuses an install that finished", async () => {
        const { generation, installId } = await run(
            async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }),
        );

        await run(async (context) => await context.runMutation(finishInstall, { generation, installId }));

        await expect(run(async (context) => await repairRows(context, OWNER, SLUG))).rejects.toThrow("does not need repair");
    });

    it("repairs an install whose action died, once its lease has expired", async () => {
        const { generation, installId } = await run(
            async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }),
        );

        await run(
            async (context) =>
                await context.runMutation(recordIntent, { contentHash: HASH, entryKey: "skill:ghost", generation, installId, kind: "skill", userId: OWNER }),
        );
        await run(async (context) => await context.db.patch("pluginInstalls", installId, { leaseUntil: Date.now() - 1000 }));

        const result = await run(async (context) => await repairRows(context, OWNER, SLUG));

        expect(result).toEqual({ kept: [], linked: 0, missing: ["skill:ghost"], moreDropped: false, outdated: false, status: "needs-repair" });
        expect(await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: installId } }))).toMatchObject({
            status: "needs-repair",
        });
    });

    it("puts a row whose child is gone back to intent, so it is created again", async () => {
        const { generation, installId } = await run(
            async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }),
        );
        const intentId = await run(
            async (context) =>
                await context.runMutation(recordIntent, { contentHash: HASH, entryKey: "skill:gone", generation, installId, kind: "skill", userId: OWNER }),
        );

        // Rolled back: the link still says `created`, but no skill carries the marker.
        await run(async (context) => await context.runMutation(recordCreated, { generation, installId, intentId, itemId: "deleted-skill" }));
        await run(async (context) => await context.runMutation(markNeedsRepair, { generation, installId }));

        const result = await run(async (context) => await repairRows(context, OWNER, SLUG));

        expect(result).toEqual({ kept: [], linked: 0, missing: ["skill:gone"], moreDropped: false, outdated: false, status: "needs-repair" });

        const link = await run(async (context) => await context.db.pluginItems.findFirst({ where: { _id: intentId } }));

        expect(link).toMatchObject({ state: "intent" });
        expect(link?.itemId).toBeUndefined();
    });
    describe("an update that stopped part-way", () => {
        const ANALYST = { description: "Analyst", instructions: "Analyse.", name: "Analyst", slug: "analyst" };
        const REVISED = { ...ANALYST, instructions: "Analyse in detail." };

        const repairOnce = async () => await run(async (context) => await repairRows(context, OWNER, SLUG));

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
                        plan: "premium",
                        pluginInstallId: installId,
                        pluginMarker: markerFor(installId, "skill:analyst"),
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

        it("records a child whose write finished, and returns the install at its old version so the update runs again", async () => {
            const { installId, intentId } = await stoppedUpdate(true);

            const result = await run(async (context) => await repairRows(context, OWNER, SLUG));

            expect(result).toEqual({ kept: [], linked: 1, missing: [], moreDropped: false, outdated: true, status: "installed" });

            const link = await run(async (context) => await context.db.pluginItems.findFirst({ where: { _id: intentId } }));
            const install = await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: installId } }));

            expect(link).toMatchObject({ contentHash: await skillRowHash(REVISED), pendingHash: "" });
            expect(install).toMatchObject({ contentHash: HASH, status: "installed", version: "1.0.0" });
            expect(install).toMatchObject({ partial: true, targetVersion: "1.0.0", version: "1.0.0" });
        });

        it("drops the intent of a new child the update never made, and keeps the install at its old version", async () => {
            const { installId } = await stoppedUpdate(true);

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

            await run(async (context) => await repairRows(context, OWNER, SLUG));

            const rows = await run(async (context) => {
                const { page } = await context.db.pluginItems.findMany({ where: { installId } });

                return page;
            });

            expect(rows.map((row: { entryKey: string }) => row.entryKey)).toEqual(["skill:analyst"]);
        });

        it("finishes at the old version when the person restores the child after a stopped update", async () => {
            const { installId } = await stoppedUpdate(false);

            await run(async (context) => {
                const skill = await context.db.skills.findFirst({ where: { pluginMarker: markerFor(installId, "skill:analyst") } });

                await context.db.patch("skills", skill._id, { instructions: "Edited by hand." });
            });
            await repairOnce();

            const stopped = await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: installId } }));

            expect(stopped).toMatchObject({ status: "needs-repair", version: "1.0.0" });
            expect(stopped).toMatchObject({ targetVersion: "1.0.0", version: "1.0.0" });

            // The person puts the skill back to the installed content; the next repair finishes with the file hash's own version.
            await run(async (context) => {
                const skill = await context.db.skills.findFirst({ where: { pluginMarker: markerFor(installId, "skill:analyst") } });

                await context.db.patch("skills", skill._id, { instructions: ANALYST.instructions });
            });
            await repairOnce();

            expect(await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: installId } }))).toMatchObject({
                contentHash: HASH,
                status: "installed",
                version: "1.0.0",
            });
        });

        it("keeps an unresolved pending hash across a second repair", async () => {
            const { installId, intentId } = await stoppedUpdate(false);

            // The person edited the skill: it matches neither the old nor the new content.
            await run(async (context) => {
                const skill = await context.db.skills.findFirst({ where: { pluginMarker: markerFor(installId, "skill:analyst") } });

                await context.db.patch("skills", skill._id, { instructions: "Edited by hand." });
            });

            const first = await run(async (context) => await repairRows(context, OWNER, SLUG));
            const second = await run(async (context) => await repairRows(context, OWNER, SLUG));

            expect(first).toMatchObject({ missing: ["skill:analyst"], status: "needs-repair" });
            expect(second).toMatchObject({ missing: ["skill:analyst"], status: "needs-repair" });
            expect(await run(async (context) => await context.db.pluginItems.findFirst({ where: { _id: intentId } }))).toMatchObject({
                pendingHash: await skillRowHash(REVISED),
            });
        });

        it("clears a pending hash whose write never happened", async () => {
            const { intentId } = await stoppedUpdate(false);

            const result = await run(async (context) => await repairRows(context, OWNER, SLUG));

            expect(result).toEqual({ kept: [], linked: 1, missing: [], moreDropped: false, outdated: true, status: "installed" });

            const link = await run(async (context) => await context.db.pluginItems.findFirst({ where: { _id: intentId } }));

            expect(link).toMatchObject({ contentHash: await skillRowHash(ANALYST), pendingHash: "" });
        });

        it("refuses to repair while the update's lease is still live", async () => {
            const { installId } = await stoppedUpdate(true);

            await run(async (context) => await context.db.patch("pluginInstalls", installId, { leaseUntil: Date.now() + 60_000 }));

            await expect(run(async (context) => await repairRows(context, OWNER, SLUG))).rejects.toThrow("still running");
        });
    });

    describe("children the file no longer holds", () => {
        const install = async () =>
            await run(async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }));

        const linkedSkill = async (first: { generation: number; installId: string }, key: string) => {
            const intentId = await run(
                async (context) =>
                    await context.runMutation(recordIntent, {
                        contentHash: HASH,
                        entryKey: key,
                        generation: first.generation,
                        installId: first.installId,
                        kind: "skill",
                        userId: OWNER,
                    }),
            );
            const skillId = await run(
                async (context) =>
                    await context.runMutation(createPluginSkill, {
                        description: key,
                        instructions: key,
                        isPremium: true,
                        name: key,
                        plan: "premium",
                        pluginInstallId: first.installId,
                        pluginMarker: markerFor(first.installId, key),
                        slug: key.replace(":", "-"),
                        source: { type: "plugin" as const, version: "1.0.0" },
                        userId: OWNER,
                    }),
            );

            await run(
                async (context) =>
                    await context.runMutation(recordCreated, { generation: first.generation, installId: first.installId, intentId, itemId: skillId }),
            );

            return skillId;
        };

        const linkKeys = async (installId: string) => {
            const { page } = await run(async (context) => await context.db.pluginItems.findMany({ where: { installId } }));

            return page.map((row: { entryKey: string }) => row.entryKey);
        };

        it("detaches a dropped child even when the update kept its version", async () => {
            const first = await install();

            await linkedSkill(first, "skill:keep");

            const droppedId = await linkedSkill(first, "skill:drop");

            await run(async (context) => await context.runMutation(markNeedsRepair, { generation: first.generation, installId: first.installId }));

            // The detach takes a call of its own; the next one links and finishes.
            const detached = await run(async (context) => await repairRows(context, OWNER, SLUG, new Set(["skill:keep"])));
            const result = await run(async (context) => await repairRows(context, OWNER, SLUG, new Set(["skill:keep"])));

            expect(detached).toMatchObject({ kept: ["skill:drop"], moreDropped: true, status: "needs-repair" });
            expect(result).toMatchObject({ kept: [], moreDropped: false, status: "installed" });
            expect(await linkKeys(first.installId)).toEqual(["skill:keep"]);
            expect(await run(async (context) => await context.db.skills.findFirst({ where: { _id: droppedId } }))).toMatchObject({ pluginMarker: "" });
        });

        it("drops the link of a dropped group chat whose thread is gone, instead of asking for it again", async () => {
            const first = await install();
            const intentId = await run(
                async (context) =>
                    await context.runMutation(recordIntent, {
                        contentHash: HASH,
                        entryKey: "group:old",
                        generation: first.generation,
                        installId: first.installId,
                        kind: "group",
                        userId: OWNER,
                    }),
            );

            await run(
                async (context) =>
                    await context.runMutation(recordCreated, { generation: first.generation, installId: first.installId, intentId, itemId: "gone-thread" }),
            );
            await run(async (context) => await context.runMutation(markNeedsRepair, { generation: first.generation, installId: first.installId }));

            await run(async (context) => await repairRows(context, OWNER, SLUG, new Set<string>()));
            const result = await run(async (context) => await repairRows(context, OWNER, SLUG, new Set<string>()));

            expect(result).toMatchObject({ missing: [], status: "installed" });
            expect(await linkKeys(first.installId)).toEqual([]);
        });

        it("is partial while a dropped group chat's thread still exists, since the install still holds a group the file lacks", async () => {
            const first = await install();
            const keepId = await linkedSkill(first, "skill:keep");
            const otherId = await linkedSkill(first, "skill:other");
            const { threadId } = await run(
                async (context) =>
                    await context.runMutation(createPluginGroupChat, {
                        mode: "round-robin",
                        model: "claude-haiku-5-5",
                        plan: "premium",
                        pluginInstallId: first.installId,
                        pluginMarker: markerFor(first.installId, "group:old"),
                        skillIds: [keepId, otherId],
                        title: "Old panel",
                        userId: OWNER,
                    }),
            );
            const intentId = await run(
                async (context) =>
                    await context.runMutation(recordIntent, {
                        contentHash: HASH,
                        entryKey: "group:old",
                        generation: first.generation,
                        installId: first.installId,
                        kind: "group",
                        userId: OWNER,
                    }),
            );

            await run(
                async (context) =>
                    await context.runMutation(recordCreated, { generation: first.generation, installId: first.installId, intentId, itemId: threadId }),
            );
            await run(async (context) => await context.runMutation(markNeedsRepair, { generation: first.generation, installId: first.installId }));

            const file = new Map([
                ["skill:keep", HASH],
                ["skill:other", HASH],
            ]);
            const result = await run(async (context) => await repairRows(context, OWNER, SLUG, new Set(file.keys()), file));

            expect(result).toMatchObject({ status: "installed" });
            expect(await linkKeys(first.installId)).toContain("group:old");
            expect(await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: first.installId } }))).toMatchObject({
                partial: true,
            });
        });

        it("handles a bounded number of dropped children per call and says when more remain", async () => {
            const first = await install();

            for (let index = 0; index < DETACH_PER_CALL + 2; index += 1) {
                await linkedSkill(first, `skill:s${String(index)}`);
            }

            await run(async (context) => await context.runMutation(markNeedsRepair, { generation: first.generation, installId: first.installId }));

            const one = await run(async (context) => await repairRows(context, OWNER, SLUG, new Set<string>()));

            expect(one).toMatchObject({ moreDropped: true, status: "needs-repair" });
            expect(one.kept).toHaveLength(DETACH_PER_CALL);

            const two = await run(async (context) => await repairRows(context, OWNER, SLUG, new Set<string>()));
            const three = await run(async (context) => await repairRows(context, OWNER, SLUG, new Set<string>()));

            // A call that detached anything ends there, so the last two children are followed by a call that finishes.
            expect(two).toMatchObject({ moreDropped: true, status: "needs-repair" });
            expect(two.kept).toHaveLength(2);
            expect(three).toMatchObject({ kept: [], moreDropped: false, status: "installed" });
        });
    });
});
