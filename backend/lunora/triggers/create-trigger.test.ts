import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { api } from "../_generated/api";
import schema from "../schema";
import { createPluginTrigger } from "./functions";

const OWNER = "owner-a";
const INSTALL = "install-1";
const MARKER = `${INSTALL}:trigger:daily`;

const pluginInput = {
    cronExpression: "0 9 * * *",
    model: "claude-haiku-5-5",
    name: "Daily summary",
    pluginInstallId: INSTALL,
    pluginMarker: MARKER,
    plan: "premium",
    type: "schedule" as const,
    userId: OWNER,
};

describe("plugin triggers", () => {
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

    const rowsWithMarker = async () =>
        await harness.run(
            async (context: any) =>
                await context.db
                    .query("triggers")
                    .withIndex("by_plugin_marker", (q: any) => q.eq("pluginMarker", MARKER))
                    .collect(),
        );

    // PENDING: this public-call check cannot run in this harness yet. The call fails at sign-in before its validators run, so a pass proves nothing. Redo it with the authz suite's registry setup (authz-regressions.test.ts).
    it.todo("keeps a public trigger from carrying a plugin marker", async () => {
        await harness
            .withIdentity({ userId: OWNER } as never)
            .mutation(api.triggers.functions.createTrigger as never, { ...pluginInput, pluginMarker: MARKER } as never)
            .catch(() => undefined);

        expect(await rowsWithMarker()).toHaveLength(0);
    });

    it("creates the trigger once, disabled, and a second call with the same marker returns the same id", async () => {
        const first = await harness.run(async (context: any) => await context.runMutation(createPluginTrigger, pluginInput));
        const second = await harness.run(async (context: any) => await context.runMutation(createPluginTrigger, pluginInput));

        expect(second).toEqual(first);

        const rows = await rowsWithMarker();

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ enabled: false, pluginInstallId: INSTALL, pluginMarker: MARKER, userId: OWNER });
    });
});
