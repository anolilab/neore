import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { createPluginSkill } from "../skills/create-skill";
import { skillRowHash } from "./entry-hash";
import { pluginForSelection } from "./export";
import { createInstallRow, finishInstall, recordCreated, recordIntent } from "./install-steps";
import { markerFor } from "./logic";
import { loadInstalledForUpdate } from "./update";

const OWNER = "owner-a";
const SLUG = "daily-brief";
const HASH = "e".repeat(64);
const skillOf = (name: string) => {
    return { description: name, instructions: `Be ${name}.`, name, slug: name };
};

describe("the plugin queries over linked children", () => {
    let harness: ReturnType<typeof lunoraTest>;

    beforeEach(async () => {
        const { loadAllFunctions } = await import("../_generated/functions");

        await loadAllFunctions();
        harness = lunoraTest(schema as never);
    });

    afterEach(() => {
        harness.close();
    });

    const run = async <T>(function_: (context: any) => Promise<T>): Promise<T> => await harness.run(async (context: any) => await function_(context));

    /** An installed plugin with one linked skill per name. */
    const installed = async (names: string[]) => {
        const first = await run(
            async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }),
        );
        const { installId } = first;
        const skillIds: string[] = [];

        for (const name of names) {
            const intentId = await run(
                async (context) =>
                    await context.runMutation(recordIntent, {
                        contentHash: await skillRowHash(skillOf(name)),
                        entryKey: `skill:${name}`,
                        generation: first.generation,
                        installId,
                        kind: "skill",
                        userId: OWNER,
                    }),
            );
            const skillId = await run(
                async (context) =>
                    await context.runMutation(createPluginSkill, {
                        ...skillOf(name),
                        isPremium: true,
                        plan: "premium",
                        pluginInstallId: installId,
                        pluginMarker: markerFor(installId, `skill:${name}`),
                        source: { type: "plugin" as const, version: "1.0.0" },
                        userId: OWNER,
                    }),
            );

            await run(async (context) => await context.runMutation(recordCreated, { generation: first.generation, installId, intentId, itemId: skillId }));
            skillIds.push(skillId);
        }

        await run(async (context) => await context.runMutation(finishInstall, { generation: first.generation, installId }));

        return { installId, skillIds };
    };

    const select = async (skillIds: string[]) =>
        await run(async (context) => await context.runQuery(pluginForSelection, { groupChatIds: [], skillIds, triggerIds: [], userId: OWNER }));

    it("exports a complete private install as the plugin's file", async () => {
        const { skillIds } = await installed(["analyst"]);

        expect(await select(skillIds)).toMatchObject({ slug: SLUG, version: "1.0.0" });
    });

    it("exports as a plain bundle when a skill was shared beyond its owner", async () => {
        const { skillIds } = await installed(["analyst"]);

        await run(async (context) => await context.db.patch("skills", skillIds[0], { visibility: "public" }));

        expect(await select(skillIds)).toBeNull();
    });

    it("exports as a plain bundle while the install is marked partial", async () => {
        const { installId, skillIds } = await installed(["analyst"]);

        await run(async (context) => await context.db.patch("pluginInstalls", installId, { partial: true }));

        expect(await select(skillIds)).toBeNull();
    });

    it("reads each skill once when it loads the install for an update", async () => {
        await installed(["a", "b", "c"]);

        const reads = await run(async (context) => {
            let count = 0;
            const real = context.db.skills.findFirst.bind(context.db.skills);

            context.db.skills.findFirst = async (query: never) => {
                count += 1;

                return await real(query);
            };

            await context.runQuery(loadInstalledForUpdate, { pluginSlug: SLUG, userId: OWNER });

            return count;
        });

        // One read per skill link: the row gives the hash, the slug and the visibility.
        expect(reads).toBe(3);
    });
});
