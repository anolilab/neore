import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPluginGroupChat } from "../chat/group/functions";
import schema from "../schema";
import { createPluginSkill } from "../skills/create-skill";
import { skillRowHash } from "./entry-hash";
import { createInstallRow, finishInstall, recordCreated, recordIntent } from "./install-steps";
import { markerFor } from "./logic";
import { claimGroupForDelete, finishUninstallRows, uninstallRows } from "./uninstall";

const OWNER = "owner-a";
const SLUG = "daily-brief";
const HASH = "a".repeat(64);
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

        const result = await run(async (context) => {
            const begun = await uninstallRows(context, OWNER, SLUG);

            await finishUninstallRows(context, begun.installId, begun.generation);

            return { kept: begun.kept, removed: begun.removed };
        });

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

        const result = await run(async (context) => {
            const begun = await uninstallRows(context, OWNER, SLUG);

            await finishUninstallRows(context, begun.installId, begun.generation);

            return { kept: begun.kept, removed: begun.removed };
        });

        expect(result.kept).toEqual(["Analyst"]);

        const skill = await run(async (context) => await context.db.skills.findFirst({ where: { _id: skillId } }));

        expect(skill).toMatchObject({ instructions: "Changed by the owner.", pluginInstallId: "", pluginMarker: "" });
        expect(await run(async (context) => (await context.db.skills.findMany({ where: { pluginInstallId: installId } })).page)).toHaveLength(0);
    });

    it("refuses an uninstall of a plugin the person does not have", async () => {
        await expect(run(async (context) => await uninstallRows(context, OWNER, "nothing"))).rejects.toThrow("not installed");
    });
    it("returns the plugin's own empty group chat for deletion, and does not treat it as blocking", async () => {
        const first = await run(
            async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }),
        );
        const { installId } = first;
        await run(async (context) => await context.runMutation(finishInstall, { generation: first.generation, installId }));
        const skillIds: string[] = [];

        for (const slug of ["analyst", "critic"]) {
            skillIds.push(
                await run(
                    async (context) =>
                        await context.runMutation(createPluginSkill, {
                            description: slug,
                            instructions: `Be ${slug}.`,
                            isPremium: true,
                            name: slug,
                            pluginInstallId: installId,
                            pluginMarker: markerFor(installId, `skill:${slug}`),
                            plan: "premium",
                            slug,
                            source: { type: "plugin" as const, version: "1.0.0" },
                            userId: OWNER,
                        }),
                ),
            );
        }

        const { threadId } = await run(
            async (context) =>
                await context.runMutation(createPluginGroupChat, {
                    mode: "round-robin",
                    model: "claude-haiku-5-5",
                    pluginInstallId: installId,
                    pluginMarker: markerFor(installId, "group:panel"),
                    plan: "premium",
                    skillIds,
                    title: "Panel",
                    userId: OWNER,
                }),
        );

        const begun = await run(async (context) => await uninstallRows(context, OWNER, SLUG));

        expect(begun.groups).toEqual([threadId]);
    });

    it("refuses when the plugin's own group chat has messages, before anything is swept", async () => {
        const { installId, skillId } = await installed();
        const otherSkillId = await run(
            async (context) =>
                await context.runMutation(createPluginSkill, {
                    description: "Critic",
                    instructions: "Critique.",
                    isPremium: true,
                    name: "Critic",
                    pluginInstallId: installId,
                    pluginMarker: markerFor(installId, "skill:critic"),
                    plan: "premium",
                    slug: "critic",
                    source: { type: "plugin" as const, version: "1.0.0" },
                    userId: OWNER,
                }),
        );
        const { threadId } = await run(
            async (context) =>
                await context.runMutation(createPluginGroupChat, {
                    mode: "round-robin",
                    model: "claude-haiku-5-5",
                    pluginInstallId: installId,
                    pluginMarker: markerFor(installId, "group:panel"),
                    plan: "premium",
                    skillIds: [skillId, otherSkillId],
                    title: "Panel",
                    userId: OWNER,
                }),
        );

        await run(async (context) => {
            await context.db.insert("messages", {
                message: { content: "hello", role: "user" },
                order: 0,
                status: "success",
                stepOrder: 0,
                text: "hello",
                threadId,
                tool: false,
                userId: OWNER,
            });
        });

        await expect(run(async (context) => await uninstallRows(context, OWNER, SLUG))).rejects.toThrow("has messages");

        const install = await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: installId } }));

        expect(install).toMatchObject({ generation: 1, status: "installed" });
        expect(await run(async (context) => await context.db.skills.findFirst({ where: { _id: skillId } }))).not.toBeNull();
    });

    it("still refuses when someone else's group chat uses a skill of the plugin", async () => {
        const { skillId } = await installed();

        await run(async (context) => {
            await context.db.insert("threads", {
                groupChat: {
                    mode: "round-robin",
                    participants: [{ addedAt: Date.now(), skillId }],
                },
                status: "active",
                title: "Someone else's panel",
                userId: OWNER,
            });
        });

        await expect(run(async (context) => await uninstallRows(context, OWNER, SLUG))).rejects.toThrow("uses a skill of this plugin");
    });

    it("keeps a group that got a message after the begin check, and detaches it rather than deleting it", async () => {
        const { installId, skillId } = await installed();
        const secondSkillId = await run(
            async (context) =>
                await context.runMutation(createPluginSkill, {
                    description: "Critic",
                    instructions: "Critique.",
                    isPremium: true,
                    name: "Critic",
                    pluginInstallId: installId,
                    pluginMarker: markerFor(installId, "skill:critic"),
                    plan: "premium",
                    slug: "critic",
                    source: { type: "plugin" as const, version: "1.0.0" },
                    userId: OWNER,
                }),
        );
        const { threadId } = await run(
            async (context) =>
                await context.runMutation(createPluginGroupChat, {
                    mode: "round-robin",
                    model: "claude-haiku-5-5",
                    pluginInstallId: installId,
                    pluginMarker: markerFor(installId, "group:late"),
                    plan: "premium",
                    skillIds: [skillId, secondSkillId],
                    title: "Late panel",
                    userId: OWNER,
                }),
        );
        const begun = await run(async (context) => await uninstallRows(context, OWNER, SLUG));

        await run(async (context) => {
            await context.db.insert("messages", {
                message: { content: "late", role: "user" },
                order: 0,
                status: "success",
                stepOrder: 0,
                text: "late",
                threadId,
                tool: false,
                userId: OWNER,
            });
        });

        const mayDelete = await run(async (context) => await claimGroupForDelete(context, begun.installId, begun.generation, threadId));

        expect(mayDelete).toBe(false);
        expect(await run(async (context) => await context.db.threads.findFirst({ where: { _id: threadId } }))).toMatchObject({
            pluginInstallId: "",
            pluginMarker: "",
        });
    });
});
