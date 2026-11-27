/** The plugin rows are read within what the ACP sessions leave of the read budget: an endless collector stops, and the section is marked as cut. */
import { describe, expect, it } from "vitest";

import { generateExportFile } from "./steps";
import { PLUGINS_READ_BYTES } from "./read-budget";

type Handler = { handler: (ctx: unknown, args: unknown) => Promise<string> };

describe("generateExportFile and the plugin rows", () => {
    it("charges the plugin reads to the budget, stops at it, and marks the section as cut", async () => {
        let pluginCalls = 0;
        let written: Blob | undefined;
        const ctx = {
            runQuery: async (reference: { __lunoraRef?: string }) => {
                if (String(reference.__lunoraRef).includes("collectPluginsForExport")) {
                    pluginCalls += 1;

                    return { continueCursor: "t:more", installs: [], items: [{ entryKey: "skill:a" }], readBytes: 700 * 1024 };
                }

                // One empty last page, whichever collector asks: every list a collector reads is there and empty.
                return {
                    continueCursor: undefined,
                    cursor: undefined,
                    events: [],
                    feedback: [],
                    follows: [],
                    ids: [],
                    installs: [],
                    isDone: true,
                    items: [],
                    next: undefined,
                    page: [],
                    projects: [],
                    readBytes: 0,
                    revisions: [],
                    rows: [],
                    runs: [],
                    sessions: [],
                    triggers: [],
                };
            },
            storage: {
                download: async () => null,
                store: async (_key: string, blob: Blob) => {
                    written = blob;
                },
            },
        };

        await (generateExportFile as unknown as Handler).handler(ctx, {
            browserPrefix: "gdpr-exports/browser-user-1/run-1/",
            conversations: "",
            files: {},
            profile: {},
            prompts: {},
            requestId: "request-1",
            settings: {},
            userEmail: "user@example.test",
            userId: "user-1",
        });

        const file = JSON.parse(await written!.text()) as { plugins: { items: unknown[]; truncated: boolean } };

        expect(file.plugins.truncated).toBe(true);
        expect(pluginCalls).toBe(Math.ceil(PLUGINS_READ_BYTES / (700 * 1024)));
        expect(file.plugins.items).toHaveLength(pluginCalls);
    });
});
