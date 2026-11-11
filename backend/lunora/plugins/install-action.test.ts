import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { schemaWithShardedTables } from "../skills/../lib/test-schema";
import { installPlugin, previewPlugin } from "./install-action";
import { bodyHash } from "./logic";

const OWNER = "owner-a";

/** A plugin with no items: the install path without any child creates. The hash is the body's, which is empty. */
const headerOnly = (contentHash: string) => `---\nbundle: 2\nname: Daily brief\nplugin: daily-brief\npluginVersion: 1.0.0\ncontentHash: ${contentHash}\n---\n`;

// PENDING: these action tests cannot run in this harness yet. Actions need the authz suite's registry setup (authz-regressions.test.ts); until then they are pending, not passing.
describe("plugin install action", () => {
    let harness: ReturnType<typeof lunoraTest>;
    let hash: string;

    beforeEach(async () => {
        // The registry is lazy: a function is registered only once its module has been evaluated.
        const { loadAllFunctions } = await import("../_generated/functions");

        await loadAllFunctions();
        harness = lunoraTest(schemaWithShardedTables(["pluginInstalls", "pluginItems"]) as never);
        hash = await bodyHash(headerOnly("0".repeat(64)));
    });

    afterEach(() => {
        harness.close();
    });

    const as = () => harness.withIdentity({ userId: OWNER } as never);

    it.todo("previews the file and returns the hash of its body", async () => {
        const preview = await as().action(previewPlugin as never, { markdown: headerOnly(hash) } as never);

        expect(preview).toMatchObject({ contentHash: hash, items: [], pluginSlug: "daily-brief", pluginVersion: "1.0.0" });
    });

    it.todo("refuses an install whose hash is not the previewed one, and writes nothing", async () => {
        await expect(as().action(installPlugin as never, { contentHash: "c".repeat(64), markdown: headerOnly(hash) } as never)).rejects.toThrow("previewed");

        const installs = await harness.run(async (context: any) => (await context.db.pluginInstalls.findMany({ where: { userId: OWNER } })).page);

        expect(installs).toHaveLength(0);
    });

    it.todo("installs a plugin once, and refuses a second install of it", async () => {
        const args = { contentHash: hash, markdown: headerOnly(hash) };

        await as().action(installPlugin as never, args as never);

        const installs = await harness.run(async (context: any) => (await context.db.pluginInstalls.findMany({ where: { userId: OWNER } })).page);

        expect(installs).toHaveLength(1);
        expect(installs[0]).toMatchObject({ pluginSlug: "daily-brief", status: "installed" });

        await expect(as().action(installPlugin as never, args as never)).rejects.toThrow("already installed");
    });
});
