/**
 * A deleted thread's vector cleanup is retried until it succeeds (`CLEANUP_RETRY`), so an attempt
 * may run after an earlier one, or something else, already removed some of its vectors. It must
 * then still succeed and remove the rest, or the retries would never end.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { deleteThreadVectors } from "./thread-search";

const OWNER = "owner-cleanup";

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("deleteThreadVectors", () => {
    it("succeeds when a vector is already gone, and still removes the others", async () => {
        const remaining = await harness.run(async (ctx) => {
            const insertVector = async () =>
                await ctx.db.insert("embeddings_1024", {
                    model: "m",
                    table: "threads",
                    userId: OWNER,
                    vector: Array.from({ length: 1024 }, (_, index) => (index === 0 ? 1 : 0)),
                });
            const title = await insertVector();
            const summary = await insertVector();

            await ctx.db.delete("embeddings_1024", title);
            await ctx.runMutation(deleteThreadVectors, { vectorIds: [title, summary] });
            // A retry of the same job, after it did succeed, is a no-op.
            await ctx.runMutation(deleteThreadVectors, { vectorIds: [title, summary] });

            return await ctx.db.query("embeddings_1024").collect();
        });

        expect(remaining).toStrictEqual([]);
    });
});
