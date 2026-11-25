/**
 * The export's grant-revision pages (`agent/gdpr.ts#storeGrantRevisionsExportPage`): a page per workflow step, read in the step's
 * own query and stored under the run's prefix, so the export file is written from every page and never from a budget-cut read.
 */
import { describe, expect, it } from "vitest";

import { browserExportPrefix } from "../browser/export-pages";
import { grantRevisionsExportPageKey } from "./export-pages";
import { storeGrantRevisionsExportPage } from "./gdpr";

type Handler = { handler: (ctx: unknown, args: unknown) => Promise<unknown> };

const USER = "user-reader";
const RUN = "request-1:instance-1";
const KEY = grantRevisionsExportPageKey(browserExportPrefix(USER, RUN), 0);

/** A context whose run-stopped checks answer `stops` in turn and whose page query answers `page`. */
const contextOf = (stops: boolean[], page: { cursor: string | null; revisions: unknown[] }) => {
    const objects = new Map<string, string>();
    const checks = [...stops];
    const ctx = {
        runQuery: async (_reference: unknown, args: Record<string, unknown>) => ("runKey" in args ? checks.shift() : page),
        storage: {
            delete: async (key: string) => objects.delete(key),
            store: async (key: string, blob: Blob) => {
                objects.set(key, await blob.text());
            },
        },
    };

    return { ctx, objects };
};

const store = async (ctx: unknown, key = KEY) => await (storeGrantRevisionsExportPage as unknown as Handler).handler(ctx, { key, runKey: RUN, userId: USER });

describe("storeGrantRevisionsExportPage", () => {
    it("stores the page's revisions and hands back only the next cursor", async () => {
        const revisions = [{ revision: 3, threadId: "thread-1" }];
        const { ctx, objects } = contextOf([false, false], { cursor: "next-1", revisions });

        await expect(store(ctx)).resolves.toStrictEqual({ next: "next-1" });
        expect(JSON.parse(objects.get(KEY)!)).toStrictEqual({ revisions });
    });

    it("names no next cursor after the last page", async () => {
        const { ctx } = contextOf([false, false], { cursor: null, revisions: [] });

        await expect(store(ctx)).resolves.toStrictEqual({});
    });

    it("deletes its page again when the run stopped during the write", async () => {
        const { ctx, objects } = contextOf([false, true], { cursor: null, revisions: [{ revision: 1, threadId: "thread-1" }] });

        await expect(store(ctx)).rejects.toThrow("The export has stopped");
        expect([...objects.keys()]).toStrictEqual([]);
    });

    it("refuses a key outside the user's own export prefix, before it reads or stores anything", async () => {
        const { ctx, objects } = contextOf([false, false], { cursor: null, revisions: [{ revision: 1, threadId: "thread-1" }] });
        const foreign = grantRevisionsExportPageKey(browserExportPrefix("user-other", RUN), 0);

        await expect(store(ctx, foreign)).rejects.toThrow("own export prefix");
        expect([...objects.keys()]).toStrictEqual([]);
    });
});
