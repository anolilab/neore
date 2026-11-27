import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deleteAllForThreadIdAsync } from "../agent/threads";
import { createPluginGroupChat } from "../chat/group/functions";
import schema from "../schema";
import { createPluginSkill } from "../skills/create-skill";
import { skillRowHash } from "./entry-hash";
import { createInstallRow, finishInstall, recordCreated, recordIntent } from "./install-steps";
import { ROOT_SHARD_KEY, runInShard } from "../lib/shard-context";
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

    const run = async <T>(function_: (context: any) => Promise<T>): Promise<T> => await harness.run(async (context: any) => await function_(context));

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
        const { page: links } = await run(async (context) => await context.db.pluginItems.findMany({ where: { installId } }));
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
        const { page: attached } = await run(async (context) => await context.db.skills.findMany({ where: { pluginInstallId: installId } }));

        expect(attached).toHaveLength(0);
    });

    it("refuses on the root shard, where the owner's group chats and skills cannot be seen", async () => {
        await installed();

        await expect(runInShard(ROOT_SHARD_KEY, async () => await run(async (context) => await uninstallRows(context, OWNER, SLUG)))).rejects.toThrow(
            "must run on the owner's shard",
        );
    });

    it("keeps a skill shared beyond its owner, because another person's group chat may use it", async () => {
        const { installId, skillId } = await installed();

        await run(async (context) => await context.db.patch("skills", skillId, { visibility: "public" }));

        const begun = await run(async (context) => await uninstallRows(context, OWNER, SLUG));

        expect(begun.kept).toEqual(["Analyst"]);
        expect(begun.removed).toBe(0);
        expect(await run(async (context) => await context.db.skills.findFirst({ where: { _id: skillId } }))).toMatchObject({
            pluginInstallId: "",
            pluginMarker: "",
        });
        expect(installId).toBe(begun.installId);
    });

    it("refuses to run on a shard that is not the owner's, before it changes anything", async () => {
        const { installId } = await installed();

        await expect(runInShard("someone-else", async () => await run(async (context) => await uninstallRows(context, OWNER, SLUG)))).rejects.toThrow(
            "owner's shard",
        );
        expect(await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: installId } }))).toMatchObject({ status: "installed" });
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
                            plan: "premium",
                            pluginInstallId: installId,
                            pluginMarker: markerFor(installId, `skill:${slug}`),
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
                    plan: "premium",
                    pluginInstallId: installId,
                    pluginMarker: markerFor(installId, "group:panel"),
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
                    plan: "premium",
                    pluginInstallId: installId,
                    pluginMarker: markerFor(installId, "skill:critic"),
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
                    plan: "premium",
                    pluginInstallId: installId,
                    pluginMarker: markerFor(installId, "group:panel"),
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
                    plan: "premium",
                    pluginInstallId: installId,
                    pluginMarker: markerFor(installId, "skill:critic"),
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
                    plan: "premium",
                    pluginInstallId: installId,
                    pluginMarker: markerFor(installId, "group:late"),
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

    it("keeps a group that got a message after the claim, in the delete's own transaction", async () => {
        const { installId, skillId } = await installed();
        const secondSkillId = await run(
            async (context) =>
                await context.runMutation(createPluginSkill, {
                    description: "Critic",
                    instructions: "Critique.",
                    isPremium: true,
                    name: "Critic",
                    plan: "premium",
                    pluginInstallId: installId,
                    pluginMarker: markerFor(installId, "skill:critic"),
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
                    plan: "premium",
                    pluginInstallId: installId,
                    pluginMarker: markerFor(installId, "group:late"),
                    skillIds: [skillId, secondSkillId],
                    title: "Late panel",
                    userId: OWNER,
                }),
        );
        const begun = await run(async (context) => await uninstallRows(context, OWNER, SLUG));

        expect(await run(async (context) => await claimGroupForDelete(context, begun.installId, begun.generation, threadId))).toBe(true);

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

        const page = await run(async (context) => await context.runMutation(deleteAllForThreadIdAsync, { pluginInstallId: begun.installId, threadId }));

        expect(page).toMatchObject({ isDone: true, kept: true });
        expect(await run(async (context) => await context.db.threads.findFirst({ where: { _id: threadId } }))).toMatchObject({
            pluginInstallId: "",
            pluginMarker: "",
        });
        expect(await run(async (context) => await context.db.messages.findFirst({ where: { threadId } }))).not.toBeNull();

        // The kept group still names its skills, so the finish step keeps them and detaches them rather than deleting them.
        expect(begun.pendingSkills).toEqual([skillId]);
        // The keep itself detached the skill the group names, so an action that stops here leaves a state a retry can finish.
        expect(await run(async (context) => await context.db.skills.findFirst({ where: { _id: skillId } }))).toMatchObject({
            pluginInstallId: "",
            pluginMarker: "",
        });

        const finished = await run(
            async (context) =>
                await finishUninstallRows(context, begun.installId, begun.generation, { keptGroups: [threadId], pendingSkills: begun.pendingSkills }),
        );

        expect(finished).toMatchObject({ kept: ["Late panel", "Analyst"], removed: 0 });
        expect(await run(async (context) => await context.db.skills.findFirst({ where: { _id: skillId } }))).toMatchObject({
            pluginInstallId: "",
            pluginMarker: "",
        });
        expect(await run(async (context) => await context.db.skills.findFirst({ where: { _id: secondSkillId } }))).not.toBeNull();
    });

    it("deletes a skill that only a deleted group named, in the finish step", async () => {
        const { installId, skillId } = await installed();
        const secondSkillId = await run(
            async (context) =>
                await context.runMutation(createPluginSkill, {
                    description: "Critic",
                    instructions: "Critique.",
                    isPremium: true,
                    name: "Critic",
                    plan: "premium",
                    pluginInstallId: installId,
                    pluginMarker: markerFor(installId, "skill:critic"),
                    slug: "critic",
                    source: { type: "plugin" as const, version: "1.0.0" },
                    userId: OWNER,
                }),
        );

        await run(
            async (context) =>
                await context.runMutation(createPluginGroupChat, {
                    mode: "round-robin",
                    model: "claude-haiku-5-5",
                    plan: "premium",
                    pluginInstallId: installId,
                    pluginMarker: markerFor(installId, "group:panel"),
                    skillIds: [skillId, secondSkillId],
                    title: "Panel",
                    userId: OWNER,
                }),
        );

        const begun = await run(async (context) => await uninstallRows(context, OWNER, SLUG));

        expect(begun.pendingSkills).toEqual([skillId]);
        expect(await run(async (context) => await context.db.skills.findFirst({ where: { _id: skillId } }))).not.toBeNull();

        const finished = await run(
            async (context) => await finishUninstallRows(context, begun.installId, begun.generation, { pendingSkills: begun.pendingSkills }),
        );

        expect(finished.removed).toBe(1);
        expect(await run(async (context) => await context.db.skills.findFirst({ where: { _id: skillId } }))).toBeNull();
    });

    it("keeps a deferred skill the owner edited or shared while the groups were being deleted", async () => {
        const { installId, skillId } = await installed();
        const secondSkillId = await run(
            async (context) =>
                await context.runMutation(createPluginSkill, {
                    description: "Critic",
                    instructions: "Critique.",
                    isPremium: true,
                    name: "Critic",
                    plan: "premium",
                    pluginInstallId: installId,
                    pluginMarker: markerFor(installId, "skill:critic"),
                    slug: "critic",
                    source: { type: "plugin" as const, version: "1.0.0" },
                    userId: OWNER,
                }),
        );

        await run(
            async (context) =>
                await context.runMutation(createPluginGroupChat, {
                    mode: "round-robin",
                    model: "claude-haiku-5-5",
                    plan: "premium",
                    pluginInstallId: installId,
                    pluginMarker: markerFor(installId, "group:panel"),
                    skillIds: [skillId, secondSkillId],
                    title: "Panel",
                    userId: OWNER,
                }),
        );

        const begun = await run(async (context) => await uninstallRows(context, OWNER, SLUG));

        expect(begun.pendingSkills).toEqual([skillId]);

        await run(async (context) => await context.db.patch("skills", skillId, { instructions: "Edited after begin." }));

        const finished = await run(
            async (context) => await finishUninstallRows(context, begun.installId, begun.generation, { pendingSkills: begun.pendingSkills }),
        );

        expect(finished).toMatchObject({ kept: ["Analyst"], removed: 0 });
        expect(await run(async (context) => await context.db.skills.findFirst({ where: { _id: skillId } }))).toMatchObject({
            instructions: "Edited after begin.",
            pluginInstallId: "",
        });
    });

    it("drives a group's multi-page deletion itself, handing the continuation back instead of scheduling a second chain", async () => {
        const { installId, skillId } = await installed();
        const secondSkillId = await run(
            async (context) =>
                await context.runMutation(createPluginSkill, {
                    description: "Critic",
                    instructions: "Critique.",
                    isPremium: true,
                    name: "Critic",
                    plan: "premium",
                    pluginInstallId: installId,
                    pluginMarker: markerFor(installId, "skill:critic"),
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
                    plan: "premium",
                    pluginInstallId: installId,
                    pluginMarker: markerFor(installId, "group:big"),
                    skillIds: [skillId, secondSkillId],
                    title: "Big panel",
                    userId: OWNER,
                }),
        );

        // More pins than one batch removes: the delete needs a second page.
        await run(async (context) => {
            for (let index = 0; index < 120; index += 1) {
                await context.db.insert("threadPins", { createdAt: 1, messageRole: "user", threadId, updatedAt: 1, userId: OWNER });
            }
        });

        const pages: { isDone: boolean; next?: object }[] = [];
        let next: object | undefined;

        for (;;) {
            const page = await run(async (context) => await context.runMutation(deleteAllForThreadIdAsync, { ...next, pluginInstallId: installId, threadId }));

            pages.push(page);

            if (page.isDone) {
                break;
            }

            next = page.next;
        }

        expect(pages.length).toBeGreaterThan(1);
        expect(pages[0]).toMatchObject({ isDone: false, next: expect.any(Object) });
        expect(await run(async (context) => await context.db.threads.findFirst({ where: { _id: threadId } }))).toBeNull();
        const { page: pins } = await run(async (context) => await context.db.threadPins.findMany({ where: { threadId } }));

        expect(pins).toHaveLength(0);
    });
});
