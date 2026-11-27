import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runInShard } from "../../lib/shard-context";
import { skillRowHash } from "../../plugins/entry-hash";
import { createInstallRow, finishInstall, recordCreated, recordIntent } from "../../plugins/install-steps";
import { markerFor } from "../../plugins/logic";
import { finishUninstallRows, uninstallRows } from "../../plugins/uninstall";
import { removeChild } from "../../plugins/update-apply";
import schema from "../../schema";
import { createPluginSkill } from "../../skills/create-skill";
import { erasePersistentStreamsForUser } from "../gdpr";
import { sweepGroupSkillIndex } from "./skill-index-backfill";

const OWNER = "owner-a";
const SLUG = "daily-brief";
const HASH = "e".repeat(64);
const ANALYST = { description: "Analyst", instructions: "Analyse.", name: "Analyst", slug: "analyst" };

const group = (...skillIds: string[]) => {
    return {
        mode: "round-robin" as const,
        participants: skillIds.map((skillId) => {
            return { addedAt: 1, skillId };
        }),
    };
};

describe("the group-chat skill index", () => {
    let harness: ReturnType<typeof lunoraTest>;

    beforeEach(async () => {
        const { loadAllFunctions } = await import("../../_generated/functions");

        await loadAllFunctions();
        harness = lunoraTest(schema as never);
    });

    afterEach(() => {
        harness.close();
    });

    const run = async <T>(function_: (context: any) => Promise<T>): Promise<T> => await harness.run(async (context: any) => await function_(context));
    const rows = async (skillId?: string) => {
        const { page } = await run(async (context) => await context.db.groupChatSkills.findMany({ where: skillId === undefined ? {} : { skillId } }));

        return page;
    };
    const skillsOf = async () => {
        const all = await rows();

        return all.map((row: any) => row.skillId).toSorted((a: string, b: string) => a.localeCompare(b));
    };
    const sweep = async () => {
        // Each step schedules the next; the harness does not run the scheduler, so a sweep is repeated until the mark is set.
        for (let index = 0; index < 20; index += 1) {
            await run(async (context) => await runInShard(OWNER, async () => await context.runMutation(sweepGroupSkillIndex, {})));

            if (await complete()) {
                return;
            }
        }
    };
    const complete = async () => {
        const state = await run(async (context) => await context.db.groupChatSkillIndex.findFirst({ where: { userId: OWNER } }));

        return state?.completedAt !== undefined;
    };

    /** The plugin's skill, installed and linked, as the install does it. */
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
                    plan: "premium",
                    pluginInstallId: installId,
                    pluginMarker: markerFor(installId, "skill:analyst"),
                    source: { type: "plugin" as const, version: "1.0.0" },
                    userId: OWNER,
                }),
        );

        await run(async (context) => await context.runMutation(recordCreated, { generation: first.generation, installId, intentId, itemId: skillId }));
        await run(async (context) => await context.runMutation(finishInstall, { generation: first.generation, installId }));

        return { generation: first.generation, installId, skillId };
    };

    const manyChats = async (count: number) => {
        await run(async (context) => {
            for (let index = 0; index < count; index += 1) {
                await context.db.insert("threads", { status: "active", title: `Chat ${String(index)}`, userId: OWNER });
            }
        });
    };

    /** The oldest group chat of the owner, then 300 newer plain chats, so a scan of the newest 300 never sees it. */
    const groupBeyondScan = async (skillId: string) => {
        await run(async (context) => {
            await context.db.insert("threads", { groupChat: group(skillId), status: "active", title: "Old panel", updatedAt: 1, userId: OWNER });
        });
        await run(async (context) => {
            for (let index = 0; index < 300; index += 1) {
                await context.db.insert("threads", { status: "active", title: `Chat ${String(index)}`, updatedAt: 10 + index, userId: OWNER });
            }
        });
    };

    const skillExists = async (skillId: string) => (await run(async (context) => await context.db.skills.findFirst({ where: { _id: skillId } }))) !== null;

    it("follows a group chat's insert, participant edit, and delete", async () => {
        const threadId = await run(async (context) => await context.db.insert("threads", { groupChat: group("a", "b"), status: "active", userId: OWNER }));

        expect(await skillsOf()).toStrictEqual(["a", "b"]);

        await run(async (context) => await context.db.patch("threads", threadId, { groupChat: { ...group("b", "c"), synthesizerSkillId: "c" } }));

        expect(await skillsOf()).toStrictEqual(["b", "c"]);

        await run(async (context) => await context.db.patch("threads", threadId, { title: "Renamed", updatedAt: 5 }));

        expect(await rows()).toHaveLength(2);

        await run(async (context) => await context.db.delete("threads", threadId));

        expect(await rows()).toHaveLength(0);
    });

    it("indexes a thread inserted under an explicit id, as the account merge does", async () => {
        await run(async (context) => await context.db.insert("threads", { groupChat: group("a"), status: "active", userId: OWNER }, { allowExplicitId: true }));

        expect(await rows("a")).toHaveLength(1);
    });

    it("marks the owner's index complete once the backfill has walked every thread, and indexes one the triggers missed", async () => {
        await manyChats(120);
        await run(async (context) => {
            await context.db.insert("threads", { groupChat: group("a"), status: "active", userId: OWNER });
        });
        // A group chat from before the index: no rows.
        const stale = await rows();

        for (const row of stale) {
            await run(async (context) => await context.db.delete("groupChatSkills", row._id));
        }

        expect(await complete()).toBe(false);

        await sweep();

        expect(await complete()).toBe(true);
        expect(await rows("a")).toHaveLength(1);
    });

    it("erases the index and its state with the user", async () => {
        await run(async (context) => await context.db.insert("threads", { groupChat: group("a"), status: "active", userId: OWNER }));
        await sweep();

        await run(async (context) => await erasePersistentStreamsForUser(context, OWNER));

        expect(await rows()).toHaveLength(0);
        expect(await run(async (context) => await context.db.groupChatSkillIndex.findFirst({ where: { userId: OWNER } }))).toBeNull();
    });

    it("lets an update remove a dropped skill for an owner with over 300 chats once the index is complete", async () => {
        const { generation, installId, skillId } = await installed();

        await manyChats(301);
        await sweep();

        const removed = await run(
            async (context) => await context.runMutation(removeChild, { entryKey: "skill:analyst", generation, installId, userId: OWNER }),
        );

        expect(removed).toBe(true);
        expect(await skillExists(skillId)).toBe(false);
    });

    it("keeps a skill named by a group chat beyond the newest 300, with the index complete", async () => {
        const { generation, installId, skillId } = await installed();

        await groupBeyondScan(skillId);
        await sweep();

        const removed = await run(
            async (context) => await context.runMutation(removeChild, { entryKey: "skill:analyst", generation, installId, userId: OWNER }),
        );

        expect(removed).toBe(false);
        expect(await skillExists(skillId)).toBe(true);
    });

    it("keeps the bounded scan for an owner with no complete index: over 300 chats, the skill is kept", async () => {
        const { generation, installId, skillId } = await installed();

        await manyChats(301);

        const removed = await run(
            async (context) => await context.runMutation(removeChild, { entryKey: "skill:analyst", generation, installId, userId: OWNER }),
        );

        expect(removed).toBe(false);
        expect(await skillExists(skillId)).toBe(true);
    });

    it("lets an uninstall delete an unused unedited skill for an owner with over 300 chats once the index is complete", async () => {
        const { installId, skillId } = await installed();

        await manyChats(301);
        await sweep();

        const begun = await run(async (context) => await runInShard(OWNER, async () => await uninstallRows(context, OWNER, SLUG)));

        await run(async (context) => await finishUninstallRows(context, installId, begun.generation, { pendingSkills: begun.pendingSkills }));

        expect(await skillExists(skillId)).toBe(false);
    });

    it("refuses an uninstall while a group chat beyond the newest 300 names the plugin's skill, with the index complete", async () => {
        const { skillId } = await installed();

        await groupBeyondScan(skillId);
        await sweep();

        await expect(run(async (context) => await runInShard(OWNER, async () => await uninstallRows(context, OWNER, SLUG)))).rejects.toThrow("Old panel");
    });
});
