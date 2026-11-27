import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../../schema";
import { createPluginSkill } from "../../skills/create-skill";
import { createPluginGroupChat } from "./functions";

const OWNER = "owner-a";
const INSTALL = "install-1";
const GROUP_MARKER = `${INSTALL}:group:panel`;

const skill = (slug: string) => {
    return {
        description: `The ${slug} persona`,
        instructions: `Speak as ${slug}.`,
        isPremium: true,
        name: slug,
        plan: "premium",
        pluginInstallId: INSTALL,
        pluginMarker: `${INSTALL}:skill:${slug}`,
        slug,
        source: { type: "plugin" as const, version: "1.0.0" },
        userId: OWNER,
    };
};

describe("plugin group chats", () => {
    let harness: ReturnType<typeof lunoraTest>;

    beforeEach(async () => {
        // The registry is lazy: a function is registered only once its module has been evaluated.
        const { loadAllFunctions } = await import("../../_generated/functions");

        await loadAllFunctions();
        harness = lunoraTest(schema as never);
    });

    afterEach(() => {
        harness.close();
    });

    const groupInput = (skillIds: string[]) => {
        return {
            mode: "round-robin" as const,
            model: "claude-haiku-5-5",
            plan: "premium",
            pluginInstallId: INSTALL,
            pluginMarker: GROUP_MARKER,
            skillIds,
            title: "Panel",
            userId: OWNER,
        };
    };

    const groupsWithMarker = async () =>
        await harness.run(
            async (context: any) =>
                await context.db
                    .query("threads")
                    .withIndex("by_plugin_marker", (q: any) => q.eq("pluginMarker", GROUP_MARKER))
                    .collect(),
        );

    it("creates the group once, and a second call with the same marker returns the same thread and creates nothing", async () => {
        const first = await harness.run(async (context: any) => {
            const a = await context.runMutation(createPluginSkill, skill("analyst"));
            const b = await context.runMutation(createPluginSkill, skill("critic"));

            return await context.runMutation(createPluginGroupChat, groupInput([a, b]));
        });

        const second = await harness.run(async (context: any) => {
            const skills = await context.db.skills.findMany({ where: { userId: OWNER } });
            const ids = skills.page.map((row: any) => row._id);

            return await context.runMutation(createPluginGroupChat, groupInput(ids));
        });

        expect(second).toEqual(first);

        const rows = await groupsWithMarker();

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ pluginInstallId: INSTALL, pluginMarker: GROUP_MARKER, userId: OWNER });
    });

    it("points the group found by its marker at the skills it is given now, after a repair recreated one", async () => {
        const { a, b, c } = await harness.run(async (context: any) => {
            const first = await context.runMutation(createPluginSkill, skill("analyst"));
            const second = await context.runMutation(createPluginSkill, skill("critic"));

            await context.runMutation(createPluginGroupChat, groupInput([first, second]));
            await context.db.delete("skills", second);

            return { a: first, b: second, c: await context.runMutation(createPluginSkill, skill("critic-again")) };
        });

        await harness.run(async (context: any) => await context.runMutation(createPluginGroupChat, groupInput([a, c])));

        const [group] = await groupsWithMarker();

        expect(group.groupChat.participants.map((participant: any) => participant.skillId)).toEqual([a, c]);
        expect(group.groupChat.participants.some((participant: any) => participant.skillId === b)).toBe(false);
    });
});
