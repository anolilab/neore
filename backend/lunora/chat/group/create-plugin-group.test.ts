import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../../schema";
import { createPluginSkill } from "../../skills/create-skill";
import { createPluginGroupChat } from "./functions";

const OWNER = "owner-a";
const INSTALL = "install-1";
const GROUP_MARKER = `${INSTALL}:group:panel`;

const skill = (slug: string) => ({
    description: `The ${slug} persona`,
    instructions: `Speak as ${slug}.`,
    name: slug,
    pluginInstallId: INSTALL,
    pluginMarker: `${INSTALL}:skill:${slug}`,
    isPremium: true,
    plan: "premium",
    slug,
    source: { type: "plugin" as const, version: "1.0.0" },
    userId: OWNER,
});

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

    const groupInput = (skillIds: string[]) => ({
        mode: "round-robin" as const,
        model: "claude-haiku-5-5",
        pluginInstallId: INSTALL,
        pluginMarker: GROUP_MARKER,
        plan: "premium",
        skillIds,
        title: "Panel",
        userId: OWNER,
    });

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
});
