import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPluginSkill } from "./create-skill";
import { api } from "../_generated/api";
import schema from "../schema";

const OWNER = "owner-a";
const INSTALL = "install-1";
const MARKER = `${INSTALL}:skill:summary`;

const skillInput = {
    description: "Summarise a note",
    instructions: "Summarise the note in one line.",
    name: "Summary",
    slug: "summary",
};

const pluginInput = {
    ...skillInput,
    isPremium: true,
    pluginInstallId: INSTALL,
    pluginMarker: MARKER,
    source: { type: "plugin" as const, version: "1.0.0" },
    userId: OWNER,
};

describe("plugin skills", () => {
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

    const rowsWithMarker = async () => await harness.run(async (context: any) => (await context.db.skills.findMany({ where: { pluginMarker: MARKER } })).page);

    it("refuses a plugin source through the public create procedure", async () => {
        await expect(
            harness
                .withIdentity({ userId: OWNER } as never)
                .mutation(api.skills.functions.createSkill as never, { ...skillInput, source: { type: "plugin", version: "1.0.0" } } as never),
        ).rejects.toThrow();

        expect(await rowsWithMarker()).toHaveLength(0);
    });

    it("never stores a marker from the public create procedure, even when a caller sends one", async () => {
        await harness
            .withIdentity({ userId: OWNER } as never)
            .mutation(api.skills.functions.createSkill as never, { ...skillInput, source: { type: "editor" }, pluginMarker: MARKER } as never)
            .catch(() => undefined);

        expect(await rowsWithMarker()).toHaveLength(0);
    });

    it("creates the child once, and a second call with the same marker returns the same id and creates nothing", async () => {
        const first = await harness.run(async (context: any) => await context.runMutation(createPluginSkill, pluginInput));
        const second = await harness.run(async (context: any) => await context.runMutation(createPluginSkill, pluginInput));

        expect(second).toBe(first);

        const rows = await rowsWithMarker();

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ pluginInstallId: INSTALL, pluginMarker: MARKER, source: { type: "plugin", version: "1.0.0" }, userId: OWNER });
    });
});
