/**
 * `generateExportFile` holds the task suggestions to what the rest of the export leaves under the file's size limit: an account whose other
 * sections nearly fill it still gets its export, with the suggestion history cut and flagged.
 */
import { describe, expect, it } from "vitest";

import { taskSuggestionsExportPageKey } from "../tasks/export-pages";
import { generateExportFile } from "./steps";

type Handler = { handler: (ctx: unknown, args: unknown) => Promise<string> };

const MAX_EXPORT_BYTES = 32 * 1024 * 1024;
const PREFIX = "gdpr-exports/browser-user-1/run-1/";

const suggestion = (index: number) => {
    return { instructions: "x".repeat(100 * 1024), status: "accepted", title: `Idea ${String(index)}` };
};

/** Runs the real action with the sections other than the suggestions replaced by one filler string of `fillerBytes`. */
const runExport = async (fillerBytes: number, pages: unknown[][]) => {
    const objects = new Map<string, string>();
    let written: Blob | undefined;

    for (const [index, rows] of pages.entries()) {
        objects.set(taskSuggestionsExportPageKey(PREFIX, index), JSON.stringify({ taskSuggestions: rows }));
    }

    const ctx = {
        runQuery: async () => {
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
            download: async (key: string) => {
                const text = objects.get(key);

                return text === undefined ? null : { body: new Blob([text]).stream(), size: new Blob([text]).size };
            },
            store: async (_key: string, blob: Blob) => {
                written = blob;
            },
        },
    };

    await (generateExportFile as unknown as Handler).handler(ctx, {
        browserPrefix: PREFIX,
        conversations: "c".repeat(fillerBytes),
        files: {},
        profile: {},
        prompts: {},
        requestId: "request-1",
        settings: {},
        taskSuggestionPages: pages.length,
        userEmail: "user@example.test",
        userId: "user-1",
    });

    // The real store refuses a blob past the limit (`maxSize`), so the size is part of the answer.
    expect(written!.size).toBeLessThanOrEqual(MAX_EXPORT_BYTES);

    return JSON.parse(await written!.text()) as { tasks: { taskSuggestions: unknown[]; taskSuggestionsCut: boolean } };
};

describe("generateExportFile and the task suggestions", () => {
    it("writes every suggestion when the rest of the export leaves room", async () => {
        const rows = [suggestion(1), suggestion(2), suggestion(3)];
        const written = await runExport(1024 * 1024, [rows]);

        expect(written.tasks.taskSuggestions).toHaveLength(3);
        expect(written.tasks.taskSuggestionsCut).toBe(false);
    });

    it("cuts and flags the suggestions, and still writes the export, when the other sections nearly fill the file", async () => {
        // One row to a stored page, and room for about one and a half rows: the history cannot keep its own 8 MiB share, and the cut falls between pages.
        const written = await runExport(MAX_EXPORT_BYTES - 150 * 1024, [[suggestion(1)], [suggestion(2)], [suggestion(3)], [suggestion(4)]]);

        expect(written.tasks.taskSuggestionsCut).toBe(true);
        expect(written.tasks.taskSuggestions).toHaveLength(1);
    });
});
